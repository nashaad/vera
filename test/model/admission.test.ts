import { expect, test } from "bun:test";

import {
    admitModel,
    type AdmissionStep,
} from "../../src/model/admission.ts";
import type { CatalogModel } from "../../src/model/catalog-shape.ts";
import { deepSeekCatalogModels } from "../../src/model/deepseek-catalog.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
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
    | { readonly kind: "empty_length" }
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
            content: reply.kind === "empty_length" ? [] : [reply.kind === "text"
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
            stopReason: reply.kind === "text" ? "stop"
                : reply.kind === "empty_length" ? "length" : "tool_use",
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

function imageRefusalFailure(): ProviderFailure {
    return {
        kind: "invalid_request",
        resolution: "user_action",
        message: "this model does not support image input",
        statusCode: 400,
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
        { kind: "text", text: "ok" },
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

    const seen = "2026-08-01T00:00:00.000Z";
    expect(verdict).toEqual({
        status: "added",
        learned: {
            "efforts.high": {
                ok: true,
                seen,
                wire: "high",
                checked: "user_key",
            },
            "efforts.low": {
                ok: true,
                seen,
                wire: "low",
                checked: "user_key",
            },
            probe: {
                ok: true,
                seen,
                checked: "user_key",
                wire: "probe-model-v2",
            },
            tools: { ok: true, seen, checked: "user_key" },
            images: { ok: true, seen, checked: "user_key" },
        },
        droppedLevels: [],
    });
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual(["high", "low", "high", "high"]);
    expect(steps.map((step) => `${step.step}:${step.status}`)).toEqual([
        "level:high:running",
        "level:high:passed",
        "level:low:running",
        "level:low:passed",
        "tool_call:running",
        "tool_call:passed",
        "image:running",
        "image:passed",
    ]);
});

test("an accepted max probe with empty length-limited output stays supported", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "empty_length" },
        { kind: "text", text: SENTINEL, responseModel: "verified-model" },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "text", text: "ok" },
    ]);
    const steps: AdmissionStep[] = [];
    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: {
            id: "probe-model", label: "Probe model",
            levels: [{ id: "max", label: "Max" }, { id: "high", label: "High" }],
        },
        onStep: (step) => steps.push(step),
    });

    expect(verdict.status).toBe("added");
    if (verdict.status !== "added") throw new Error("expected added");
    expect(verdict.droppedLevels).toEqual([]);
    expect(verdict.learned["efforts.max"]).toMatchObject({ ok: true, wire: "max" });
    expect(verdict.learned["efforts.high"]).toMatchObject({ ok: true, wire: "high" });
    expect(verdict.learned.probe).toMatchObject({ ok: true, wire: "verified-model" });
    expect(steps.map((step) => `${step.step}:${step.status}`)).toContain("level:max:passed");
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual(["max", "high", "high", "high"]);
    expect(requests.every((request) => request.maxTokens === 2_048)).toBe(true);
});

test("DeepSeek reasoning-only length output is accepted through the real adapter", async () => {
    const requests: Record<string, unknown>[] = [];
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "deepseek",
        model: "deepseek-flash",
        approval_mode: "ask",
    }, {
        env: { DEEPSEEK_API_KEY: "fake-deepseek-key" },
        imageSupport: () => true,
        fetch: async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            requests.push(body);
            const toolProbe = Array.isArray(body.tools) && body.tools.length > 0;
            const maxProbe = body.reasoning_effort === "max" && !toolProbe;
            const delta = toolProbe
                ? { role: "assistant", tool_calls: [{
                    index: 0, id: "call-1", type: "function",
                    function: { name: "admission_probe", arguments: '{"value":"ok"}' },
                }] }
                : maxProbe
                    ? { role: "assistant", reasoning_content: "Thinking" }
                    : { role: "assistant", content: SENTINEL };
            const chunk = (value: unknown, finish: string | null) =>
                `data: ${JSON.stringify({ id: "c1", model: "deepseek-flash", choices: [{
                    index: 0, delta: value, finish_reason: finish,
                }] })}\n\n`;
            return new Response(
                chunk(delta, null) + chunk({}, toolProbe ? "tool_calls" : maxProbe ? "length" : "stop")
                    + "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } },
            );
        },
    });
    const catalogModel = deepSeekCatalogModels().find((row) => row.id === "deepseek-flash");
    if (catalogModel === undefined) throw new Error("missing DeepSeek Flash catalog model");
    const verdict = await admitModel({
        adapter, provider: "deepseek", model: "deepseek-flash", catalogModel,
    });

    expect(verdict.status).toBe("added");
    if (verdict.status !== "added") throw new Error("expected added");
    expect(verdict.droppedLevels).toEqual([]);
    expect(verdict.learned["efforts.max"]).toMatchObject({ ok: true, wire: "max" });
    expect(verdict.learned["efforts.high"]).toMatchObject({ ok: true, wire: "high" });
    expect(requests.map((body) => body.reasoning_effort)).toEqual(["max", "high", "high", "high"]);
    expect(requests.every((body) => body.max_tokens === 2_048)).toBe(true);
});

test("a 400 refusal still drops max without failing the admission", async () => {
    const { adapter } = scriptedAdapter([
        { kind: "failure", failure: userActionFailure(400) },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "text", text: "ok" },
    ]);
    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: {
            id: "probe-model", label: "Probe model",
            levels: [{ id: "max", label: "Max" }, { id: "high", label: "High" }],
        },
    });

    expect(verdict.status).toBe("added");
    if (verdict.status !== "added") throw new Error("expected added");
    expect(verdict.droppedLevels).toEqual(["max"]);
    expect(verdict.learned["efforts.max"]).toMatchObject({
        ok: false, error: "the provider rejected the request",
    });
    expect(verdict.learned["efforts.high"]).toMatchObject({ ok: true, wire: "high" });
});

test("accepted levels use the no-effort probe when none returns the sentinel", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "empty_length" },
        { kind: "text", text: "unrelated response" },
        { kind: "text", text: SENTINEL, responseModel: "fallback-model" },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "text", text: "ok" },
    ]);
    const steps: AdmissionStep[] = [];
    const verdict = await admitModel({
        adapter, provider: "scripted", model: "probe-model", catalogModel: catalogModel(),
        onStep: (step) => steps.push(step),
    });

    expect(verdict.status).toBe("added");
    if (verdict.status !== "added") throw new Error("expected added");
    expect(verdict.droppedLevels).toEqual([]);
    expect(verdict.learned["efforts.high"]).toMatchObject({ ok: true, wire: "high" });
    expect(verdict.learned["efforts.low"]).toMatchObject({ ok: true, wire: "low" });
    expect(verdict.learned.probe).toMatchObject({ ok: true, wire: "fallback-model" });
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual(["high", "low", undefined, undefined, undefined]);
    expect(steps.map((step) => `${step.step}:${step.status}`)).toContain("response:passed");
});

test("admission fails when neither level nor no-effort probes return the sentinel", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "empty_length" },
        { kind: "text", text: "unrelated response" },
        { kind: "empty_length" },
    ]);
    const steps: AdmissionStep[] = [];
    const verdict = await admitModel({
        adapter, provider: "scripted", model: "probe-model", catalogModel: catalogModel(),
        onStep: (step) => steps.push(step),
    });

    expect(verdict).toEqual({
        status: "incompatible", reason: "returned unexpected text for the probe prompt",
    });
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual(["high", "low", undefined]);
    expect(steps.map((step) => `${step.step}:${step.status}`)).toEqual([
        "level:high:running", "level:high:passed", "level:low:running", "level:low:passed",
        "response:running", "response:failed",
    ]);
});

test("a level the key cannot use is dropped without failing the admission", async () => {
    const { adapter } = scriptedAdapter([
        { kind: "failure", failure: userActionFailure(400) },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "text", text: "ok" },
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
    expect(verdict.learned["efforts.low"]).toMatchObject({
        ok: true,
        wire: "low",
    });
    expect(verdict.learned["efforts.high"]).toMatchObject({ ok: false });
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
        { kind: "text", text: "ok" },
    ]);

    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: catalogModel(),
    });

    expect(verdict).toMatchObject({ status: "added", droppedLevels: [] });
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual(["high", "high", "low", "high", "high"]);
});

test("a model the catalog has never seen is not given a fabricated effort map", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "text", text: "ok" },
    ]);

    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
    });

    expect(verdict).toMatchObject({ status: "added" });
    if (verdict.status !== "added") throw new Error("expected added");
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual([undefined, undefined, undefined]);
    expect(Object.keys(verdict.learned).sort()).toEqual([
        "images",
        "probe",
        "tools",
    ]);
    expect(
        Object.keys(verdict.learned).some((key) => key.startsWith("efforts.")),
    ).toBe(false);
});

test("a model without levels still needs the no-effort sentinel", async () => {
    const { adapter, requests } = scriptedAdapter([{ kind: "empty_length" }]);
    const steps: AdmissionStep[] = [];
    const verdict = await admitModel({
        adapter, provider: "scripted", model: "probe-model",
        onStep: (step) => steps.push(step),
    });

    expect(verdict).toEqual({
        status: "incompatible", reason: "returned unexpected text for the probe prompt",
    });
    expect(requests.map((request) => request.reasoningEffort)).toEqual([undefined]);
    expect(steps.map((step) => `${step.step}:${step.status}`))
        .toEqual(["response:running", "response:failed"]);
});

test("a model the catalog knows is probed only at its own levels", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "text", text: SENTINEL },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "text", text: "ok" },
    ]);

    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: catalogModel(),
    });

    expect(verdict).toMatchObject({ status: "added" });
    expect(requests.map((request) => request.reasoningEffort))
        .toEqual(["high", "low", "high", "high"]);
});

test("a catalog level outside the ladder is never probed", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "text", text: SENTINEL },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "text", text: "ok" },
    ]);
    const steps: AdmissionStep[] = [];

    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: {
            id: "probe-model",
            label: "Probe model",
            levels: [
                { id: "ultra", label: "Ultra" },
                { id: "xhigh", label: "Extra high" },
                { id: "none", label: "None" },
                { id: "medium", label: "Medium" },
            ],
        },
        onStep: (step) => steps.push(step),
        now: () => new Date("2026-08-01T00:00:00.000Z"),
    });

    expect(requests.map((request) => request.reasoningEffort))
        .toEqual(["xhigh", "medium", "xhigh", "xhigh"]);
    expect(steps.map((step) => step.label)).toContain("Reasoning xhigh");
    expect(steps.map((step) => step.label)).not.toContain("Reasoning Ultra");
    expect(verdict.status).toBe("added");
    if (verdict.status === "added") {
        expect(Object.keys(verdict.learned)).toEqual([
            "efforts.xhigh",
            "efforts.medium",
            "images",
            "probe",
            "tools",
        ]);
    }
});

test("a model that refuses the image still enters the pool, with the refusal recorded", async () => {
    const { adapter, requests } = scriptedAdapter([
        { kind: "text", text: SENTINEL },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "failure", failure: imageRefusalFailure() },
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

    // Text-only is a capability the pool records, not grounds for refusal.
    expect(verdict).toMatchObject({ status: "added" });
    if (verdict.status !== "added") throw new Error("expected added");
    expect(verdict.learned.images).toMatchObject({ ok: false });
    expect(steps.map((step) => `${step.step}:${step.status}`))
        .toContain("image:failed");
    // The probe sends a real image rather than asking about one.
    expect(requests.at(-1)?.messages.at(0)?.content)
        .toContainEqual(expect.objectContaining({ type: "image" }));
});

test("a rejection that never names images records no image fact", async () => {
    const { adapter } = scriptedAdapter([
        { kind: "text", text: SENTINEL },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "failure", failure: userActionFailure(400) },
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

    // The fact is written once and outlives every later attempt, so a refusal
    // that says nothing about images must leave it unstated.
    expect(verdict).toMatchObject({ status: "added" });
    if (verdict.status !== "added") throw new Error("expected added");
    expect(verdict.learned.images).toBeUndefined();
    expect(steps.map((step) => `${step.step}:${step.status}`))
        .toContain("image:skipped");
});

test("an outage during the image probe records no image fact at all", async () => {
    const { adapter } = scriptedAdapter([
        { kind: "text", text: SENTINEL },
        { kind: "text", text: SENTINEL },
        { kind: "tool_call", name: "admission_probe" },
        { kind: "failure", failure: retryFailure() },
        { kind: "failure", failure: retryFailure() },
    ]);
    const steps: AdmissionStep[] = [];

    const verdict = await admitModel({
        adapter,
        provider: "scripted",
        model: "probe-model",
        catalogModel: catalogModel(),
        onStep: (step) => steps.push(step),
    });

    // An outage is not a fact about the model, so nothing is written and the
    // admission that already succeeded still stands.
    expect(verdict).toMatchObject({ status: "added" });
    if (verdict.status !== "added") throw new Error("expected added");
    expect(verdict.learned.images).toBeUndefined();
    expect(steps.map((step) => `${step.step}:${step.status}`))
        .toContain("image:skipped");
});
