import { expect, test } from "bun:test";

import {
    admitModel,
    type AdmissionStep,
} from "../../src/model/admission.ts";
import type { CatalogModel } from "../../src/model/catalog-shape.ts";
import {
    ProviderFailureError,
    type ProviderFailure,
} from "../../src/model/provider-failure.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ModelStream,
    type ModelStreamEvent,
} from "../../src/model/types.ts";

const SENTINEL = "vera-admission-ok";

type ScriptedReply =
    | { readonly kind: "text"; readonly text: string; readonly responseModel?: string }
    | { readonly kind: "tool_call"; readonly name: string }
    | { readonly kind: "failure"; readonly failure: ProviderFailure };

/** Replays one reply per stream call, recording each request as it goes. */
function scriptedAdapter(script: readonly ScriptedReply[]): {
    readonly adapter: ModelAdapter;
    readonly requests: ModelRequest[];
} {
    const remaining = [...script];
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            const reply = remaining.shift();
            if (reply === undefined) {
                throw new Error("admission probed more than the script allows");
            }
            return replyStream(reply, request.model);
        },
    };
    return { adapter, requests };
}

function replyStream(reply: ScriptedReply, model: string): ModelStream {
    const message: AssistantMessage = reply.kind === "failure"
        ? {
            role: "assistant",
            content: [],
            source: { provider: "scripted", api: "scripted", model },
            usage: emptyUsage(),
            stopReason: "error",
            errorMessage: reply.failure.message,
        }
        : {
            role: "assistant",
            content: [reply.kind === "text"
                ? { type: "text", text: reply.text }
                : {
                    type: "tool_call",
                    id: "call-1",
                    name: reply.name,
                    input: { value: "ok" },
                }],
            source: {
                provider: "scripted",
                api: "scripted",
                model,
                ...(reply.kind === "text" && reply.responseModel !== undefined
                    ? { responseModel: reply.responseModel }
                    : {}),
            },
            usage: emptyUsage(),
            stopReason: reply.kind === "text" ? "stop" : "tool_use",
        };
    const events: ModelStreamEvent[] = [
        { type: "start" },
        reply.kind === "failure"
            ? {
                type: "error",
                error: new ProviderFailureError(reply.failure, undefined),
                message,
            }
            : { type: "done", message },
    ];
    return {
        async *[Symbol.asyncIterator]() {
            yield* events;
        },
        result: () => Promise.resolve(message),
    };
}

function catalogModel(): CatalogModel {
    return {
        id: "probe-model",
        label: "Probe model",
        levels: [
            { id: "high", label: "High" },
            { id: "low", label: "Low" },
        ],
    };
}

function userActionFailure(statusCode: number): ProviderFailure {
    return {
        kind: "invalid_request",
        resolution: "user_action",
        message: "the provider rejected the request",
        statusCode,
    };
}

function retryFailure(): ProviderFailure {
    return {
        kind: "timeout",
        resolution: "retry",
        message: "the provider timed out",
    };
}

test("every level verifies, and the response model is recorded verbatim", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "text", text: SENTINEL, responseModel: "probe-model-v2" },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
    ]);
    const steps: AdmissionStep[] = [];

    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: catalogModel(),
        onStep: (step) => steps.push(step),
        now: () => new Date("2026-08-01T00:00:00.000Z"),
    });

    expect(verdict).toEqual({
        status: "added",
        verification: {
            verified_at: "2026-08-01T00:00:00.000Z",
            response_model: "probe-model-v2",
            levels: [
                { vera_effort: "high", provider_effort: "high" },
                { vera_effort: "low", provider_effort: "low" },
            ],
            checked: "user_key",
        },
        droppedLevels: [],
    });
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual(["high", "low", "high"]);
    expect(steps.map((step) => `${step.step}:${step.status}`)).toEqual([
        "level:high:running",
        "level:high:passed",
        "level:low:running",
        "level:low:passed",
        "tool_call:running",
        "tool_call:passed",
    ]);
});

test("a level the key cannot use is dropped without failing the admission", async () => {
    const { adapter } = scriptedAdapter([
        { kind: "failure", failure: userActionFailure(400) },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
    ]);

    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: catalogModel(),
    });

    expect(verdict).toMatchObject({
        status: "added",
        droppedLevels: ["high"],
    });
    if (verdict.status !== "added") throw new Error("expected added");
    expect(verdict.verification.levels).toEqual([
        { vera_effort: "low", provider_effort: "low" },
    ]);
});

test("a model that answers in text instead of a tool call is incompatible", async () => {
    const { adapter } = scriptedAdapter([
        { kind: "text", text: SENTINEL },
        { kind: "text", text: SENTINEL },
        { kind: "text", text: "I would call a tool if I could." },
    ]);

    expect(await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: catalogModel(),
    })).toEqual({
        status: "incompatible",
        reason: "did not call the probe tool",
    });
});

test("a provider rejection of the tool probe is incompatible with its status", async () => {
    const { adapter } = scriptedAdapter([
        { kind: "text", text: SENTINEL },
        { kind: "text", text: SENTINEL },
        { kind: "failure", failure: userActionFailure(400) },
    ]);

    expect(await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: catalogModel(),
    })).toEqual({
        status: "incompatible",
        reason: "the provider rejected the request",
        statusCode: 400,
    });
});

test("two retry-shaped failures end the admission with nothing recorded", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "failure", failure: retryFailure() },
        { kind: "failure", failure: retryFailure() },
    ]);

    expect(await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: catalogModel(),
    })).toEqual({
        status: "unavailable",
        reason: "the provider timed out",
    });
    // The first level's probe burned both attempts; no later check ran.
    expect(requests).toHaveLength(2);
});

test("one retry-shaped failure is retried and the admission still succeeds", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "failure", failure: retryFailure() },
        { kind: "text", text: SENTINEL },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
    ]);

    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: catalogModel(),
    });

    expect(verdict).toMatchObject({ status: "added", droppedLevels: [] });
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual(["high", "high", "low", "high"]);
});

test("a model with no catalog levels runs one plain text probe", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
    ]);

    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
    });

    expect(verdict).toMatchObject({
        status: "added",
        verification: { levels: [] },
    });
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual([undefined, undefined]);
});
