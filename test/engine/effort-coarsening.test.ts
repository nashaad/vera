import { expect, test } from "bun:test";

import type { EffortMap } from "../../src/model/effort-ladder.ts";
import { requestModelWithRecovery } from "../../src/engine/recovery.ts";
import {
    preflightEffort,
    type ModelEffortCoarsened,
} from "../../src/engine/effort-coarsening.ts";
import type { EffortPool, ModelRef } from "../../src/model/effort-pool.ts";
import type { LearnedFact } from "../../src/model/pool-file.ts";
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import type {
    AssistantMessage,
    ModelAdapter,
    ModelRequest,
} from "../../src/model/types.ts";

const FULL_EFFORTS = {
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
};

/**
 * An in-memory pool: the file-backed one is covered by its own tests, and
 * these assert what coarsening does with the answers, not where they come
 * from.
 */
function fakePool(
    efforts: EffortMap,
    onRecord: (ref: ModelRef, key: string, fact: LearnedFact) => void,
): EffortPool {
    const forbidden = new Set<string>();
    return {
        resolveEffort(_ref, requested) {
            const resolved: Record<string, string | null | undefined> = {};
            for (const [level, wire] of Object.entries(efforts)) {
                resolved[level] = forbidden.has(level) ? null : wire;
            }
            const providerEffort = resolved[requested];
            return {
                requested,
                ...(typeof providerEffort === "string"
                    ? { providerEffort }
                    : {}),
                efforts: resolved,
            };
        },
        resolveImageSupport: () => undefined,
        recordLearned(ref, key, fact) {
            if (key.startsWith("efforts.")) {
                forbidden.add(key.slice("efforts.".length));
            }
            onRecord(ref, key, fact);
        },
    };
}

function message(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        source: { provider: "cerebras", api: "openai-chat-completions", model: "m" },
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
        },
    };
}

/**
 * Refuses every level named in `refuse` the way a provider does, then answers.
 * Records the effort of each attempt so a test can assert what went on the wire.
 */
function refusingAdapter(refuse: readonly string[]): ModelAdapter & {
    readonly attempts: string[];
} {
    const attempts: string[] = [];
    return {
        attempts,
        stream(request: ModelRequest) {
            const stream = new ModelEventStream();
            const effort = request.reasoningEffort ?? "";
            attempts.push(effort);
            queueMicrotask(() => {
                if (refuse.includes(effort)) {
                    const error = new ProviderFailureError({
                        kind: "invalid_request",
                        resolution: "user_action",
                        statusCode: 400,
                        message:
                            `Invalid value: '${effort}'. reasoning_effort is not `
                            + "supported for this model",
                    }, undefined);
                    stream.push({ type: "start" });
                    stream.push({
                        type: "error",
                        error,
                        message: {
                            ...message(""),
                            stopReason: "error",
                            errorMessage: error.message,
                        },
                    });
                    return;
                }
                stream.push({ type: "start" });
                stream.push({ type: "done", message: message("ok") });
            });
            return stream;
        },
    };
}

interface Harness {
    readonly adapter: ModelAdapter & { readonly attempts: string[] };
    readonly notices: ModelEffortCoarsened[];
    readonly learned: { ref: ModelRef; key: string; fact: LearnedFact }[];
    run(requested: string): Promise<AssistantMessage>;
}

function harness(
    refuse: readonly string[],
    efforts: EffortMap = FULL_EFFORTS,
): Harness {
    const adapter = refusingAdapter(refuse);
    const notices: ModelEffortCoarsened[] = [];
    const learned: { ref: ModelRef; key: string; fact: LearnedFact }[] = [];
    const pool = fakePool(
        efforts,
        (ref, key, fact) => learned.push({ ref, key, fact }),
    );
    return {
        adapter,
        notices,
        learned,
        run: (requested: string) => requestModelWithRecovery(
            adapter,
            {
                provider: "cerebras",
                model: "m",
                reasoningEffort: requested,
                systemPrompt: "",
                messages: [],
                tools: [],
            } as unknown as ModelRequest,
            {
                onEvent: () => {},
                onRetry: () => {},
                onFallback: () => {},
                coarsening: { pool, now: () => new Date("2026-08-06T00:00:00Z") },
                onCoarsened: (event) => notices.push(event),
            },
        ),
    };
}

test("a supported level is sent verbatim and never remapped", async () => {
    const active = harness([]);
    const result = await active.run("xhigh");

    expect(active.adapter.attempts).toEqual(["xhigh"]);
    expect(active.notices).toEqual([]);
    expect(active.learned).toEqual([]);
    expect(result.stopReason).toBe("stop");
});

test("off is sent as its own level rather than folded into minimal", async () => {
    const active = harness([]);
    await active.run("off");
    expect(active.adapter.attempts).toEqual(["off"]);
});

test("a refused level coarsens one step and the retry succeeds", async () => {
    const active = harness(["xhigh"]);
    const result = await active.run("xhigh");

    expect(active.adapter.attempts).toEqual(["xhigh", "high"]);
    expect(result.stopReason).toBe("stop");
});

test("the coarsening notice names the level asked for and the level used", async () => {
    const active = harness(["xhigh"]);
    await active.run("xhigh");

    expect(active.notices).toEqual([{
        model: "m",
        requested: "xhigh",
        using: "high",
        reason: expect.stringContaining("reasoning_effort is not supported"),
    }]);
});

test("the refusal is recorded as a dated learned fact", async () => {
    const active = harness(["xhigh"]);
    await active.run("xhigh");

    expect(active.learned).toEqual([{
        ref: { provider: "cerebras", model: "m" },
        key: "efforts.xhigh",
        fact: {
            ok: false,
            seen: "2026-08-06",
            error: expect.stringContaining("reasoning_effort is not supported"),
        },
    }]);
});

test("repeated refusals walk down the ladder rather than retrying a dead level", async () => {
    const active = harness(["xhigh", "high"]);
    await active.run("xhigh");

    expect(active.adapter.attempts).toEqual(["xhigh", "high", "medium"]);
    expect(active.notices.map((notice) => notice.using)).toEqual(["high", "medium"]);
});

test("a model with nowhere left to coarsen fails rather than looping", async () => {
    const active = harness(["high"], { high: "high" });
    const result = await active.run("high");

    expect(active.adapter.attempts).toEqual(["high"]);
    expect(active.notices).toEqual([]);
    expect(result.stopReason).toBe("error");
});

test("coarsening stays off when no pool is wired in", async () => {
    const adapter = refusingAdapter(["xhigh"]);
    const result = await requestModelWithRecovery(
        adapter,
        {
            provider: "cerebras",
            model: "m",
            reasoningEffort: "xhigh",
            systemPrompt: "",
            messages: [],
            tools: [],
        } as unknown as ModelRequest,
        { onEvent: () => {}, onRetry: () => {}, onFallback: () => {} },
    );

    expect(adapter.attempts).toEqual(["xhigh"]);
    expect(result.stopReason).toBe("error");
});

test("a level the pool forbids is moved before the request goes out", () => {
    const pool = fakePool({ ...FULL_EFFORTS, xhigh: null }, () => {});

    expect(preflightEffort(pool, { provider: "p", model: "m" }, "xhigh"))
        .toEqual({
            requested: "xhigh",
            using: "high",
            reason: expect.any(String),
        });
});

test("a supported level is sent verbatim, with no pre-flight fold", () => {
    const pool = fakePool(FULL_EFFORTS, () => {});

    expect(preflightEffort(pool, { provider: "p", model: "m" }, "xhigh"))
        .toBeUndefined();
});

test("a level nothing knows about is left exactly as asked", () => {
    const pool = fakePool({ high: "high" }, () => {});

    expect(preflightEffort(pool, { provider: "p", model: "m" }, "xhigh"))
        .toBeUndefined();
});

test("a forbidden level with no neighbour sends no level at all", () => {
    const pool = fakePool({ xhigh: null }, () => {});

    const preflight = preflightEffort(pool, { provider: "p", model: "m" }, "xhigh");
    expect(preflight?.requested).toBe("xhigh");
    expect(preflight?.using).toBeUndefined();
});

test("a learned rejection is quoted as the reason it was not sent", () => {
    const pool = fakePool(FULL_EFFORTS, () => {});
    pool.recordLearned(
        { provider: "p", model: "m" },
        "efforts.xhigh",
        { ok: false, seen: "2026-08-06", error: "unsupported effort" },
    );

    expect(preflightEffort(pool, { provider: "p", model: "m" }, "xhigh"))
        .toMatchObject({ using: "high" });
});

test("an adapter's own effort substitution is reported, not swallowed", async () => {
    const reported: unknown[] = [];
    const adapter: ModelAdapter = {
        stream(request): ModelEventStream {
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            stream.push({
                type: "effort_substituted",
                requested: request.reasoningEffort ?? "",
                using: "medium",
                reason: 'the model does not offer effort "xhigh"',
            });
            stream.push({ type: "done", message: message("done") });
            return stream;
        },
    };

    const answer = await requestModelWithRecovery(
        adapter,
        { provider: "faux", model: "m", reasoningEffort: "xhigh", messages: [] },
        {
            onEvent: () => {},
            onRetry: () => {},
            onFallback: () => {},
            onEffortSubstituted: (substituted) => reported.push(substituted),
        },
    );

    expect(answer.stopReason).toBe("stop");
    expect(reported).toEqual([{
        model: "m",
        requested: "xhigh",
        using: "medium",
        reason: 'the model does not offer effort "xhigh"',
    }]);
});
