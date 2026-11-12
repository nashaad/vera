import { expect, test } from "bun:test";

import {
    BUNDLED_COMPACTION_STRATEGIES,
    DEFAULT_COMPACTION_LADDER,
    bindCompaction,
    bindRemoteCompaction,
    compactionWireSpec,
    unboundWireStrategy,
} from "../../src/engine/compaction-binding.ts";
import { FULL_SUMMARY_STRATEGY_ID } from
    "../../src/engine/compaction-full-summary.ts";
import { DROP_OLDEST_STRATEGY_ID } from
    "../../src/engine/compaction-drop-oldest.ts";
import type {
    ResolvedCompactionProfile,
    ResolvedCompactionRung,
} from "../../src/config/model-catalog.ts";
import type { ModelAdapter } from "../../src/model/types.ts";

const adapter = {} as ModelAdapter;

type ProfileOverrides = Partial<Omit<ResolvedCompactionProfile, "ladder">>
    & Partial<ResolvedCompactionRung>;

function profile(overrides: ProfileOverrides = {}): ResolvedCompactionProfile {
    const {
        strategy = FULL_SUMMARY_STRATEGY_ID,
        routes = { summarizer: "summarizer" },
        slots = { summarizer: [{ name: "small", model: "test-model" }] },
        timeout_ms,
        ...block
    } = overrides;
    return {
        ...block,
        ladder: [{
            strategy,
            routes,
            slots,
            ...(timeout_ms === undefined ? {} : { timeout_ms }),
        }],
    } as ResolvedCompactionProfile;
}

test("an unconfigured session compacts on the model it is already running", () => {
    // A session that fills its window has to compact whether or not anyone
    // configured it to. A catalog route is the better answer, not a required
    // one.
    const bound = bindCompaction(
        undefined,
        adapter,
        { model: "test-model" },
        BUNDLED_COMPACTION_STRATEGIES,
    );

    expect(bound?.rungs.map((rung) => rung.strategy.id)).toEqual([
        FULL_SUMMARY_STRATEGY_ID,
        DROP_OLDEST_STRATEGY_ID,
    ]);
    expect(Object.keys(bound?.rungs[0].models ?? {})).toEqual(["summarizer"]);
    expect(bound?.rungs[1]?.models).toEqual({});
});

test("the default ladder binds on the assignment path, with drop-oldest always bound", () => {
    const bound = bindCompaction(
        undefined,
        adapter,
        { model: "test-model" },
        BUNDLED_COMPACTION_STRATEGIES,
        [{ name: "assigned", provider: "openrouter", model: "assigned-model" }],
    );

    expect(bound?.rungs.map((rung) => rung.strategy.id)).toEqual([
        FULL_SUMMARY_STRATEGY_ID,
        DROP_OLDEST_STRATEGY_ID,
    ]);
    expect(Object.keys(bound?.rungs[0].models ?? {})).toEqual(["summarizer"]);
    expect(bound?.rungs[1]?.models).toEqual({});
});

test("bindDefault binds DEFAULT_COMPACTION_LADDER in order on the session model when there is no profile or assignment", async () => {
    const calls: string[] = [];
    const recording = {
        stream(request: { readonly provider?: string; readonly model: string }) {
            calls.push(`${request.provider ?? ""}/${request.model}`);
            throw new Error("recorded");
        },
    } as unknown as ModelAdapter;
    const bound = bindCompaction(
        undefined,
        recording,
        { provider: "faux", model: "session-model" },
        BUNDLED_COMPACTION_STRATEGIES,
    );

    expect(bound?.rungs.map((rung) => rung.strategy.id)).toEqual([
        ...DEFAULT_COMPACTION_LADDER,
    ]);
    expect(bound?.rungs[0]?.diagnostics).toEqual({
        strategy: FULL_SUMMARY_STRATEGY_ID,
        provider: "faux",
        model: "session-model",
    });
    expect(bound?.rungs[1]?.diagnostics).toEqual({
        strategy: DROP_OLDEST_STRATEGY_ID,
    });
    const summarizer = bound?.rungs[0]?.models.summarizer;
    await summarizer?.(
        { systemPrompt: "", messages: [], maxTokens: 16 },
        new AbortController().signal,
    ).catch(() => undefined);
    expect(calls).toEqual(["faux/session-model"]);
});

test("a session with no model of its own binds nothing", () => {
    expect(bindCompaction(
        undefined,
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    )).toBeUndefined();
});

test("a bound profile exposes exactly the slots the strategy declared", () => {
    const bound = bindCompaction(
        profile(),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    );

    expect(bound).toBeDefined();
    expect(Object.keys(bound?.rungs[0].models ?? {})).toEqual(["summarizer"]);
    expect(bound?.rungs[0].strategy.id).toBe(FULL_SUMMARY_STRATEGY_ID);
});

test("an unknown strategy binds nothing rather than a strategy of its choosing", () => {
    expect(bindCompaction(
        profile({ strategy: "other/thing" }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    ))
        .toBeUndefined();
});

test("a declared slot with no route binds nothing", () => {
    // The alternative is discovering the missing model at the moment the
    // window fills, which is the worst time to find out.
    expect(bindCompaction(
        profile({ slots: {} }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    )).toBeUndefined();
});

test("the compaction assignment outranks a route the profile names for a slot", () => {
    const bound = bindCompaction(
        profile({
            slots: {
                summarizer: [{
                    name: "routed",
                    provider: "openrouter",
                    model: "routed-model",
                }],
            },
        }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
        [{ name: "assigned", provider: "openrouter", model: "assigned-model" }],
    );

    expect(bound?.rungs[0].diagnostics).toMatchObject({
        catalogEntry: "assigned",
        model: "assigned-model",
    });
    expect(bound?.rungs[0].diagnostics?.route).toBeUndefined();
});

test("an assignment binds without a compaction profile", () => {
    // Defaults writes the assignment, not a compaction profile. The session
    // model is the fallback only when nothing is assigned.
    const bound = bindCompaction(
        undefined,
        adapter,
        { provider: "openrouter", model: "session-model" },
        BUNDLED_COMPACTION_STRATEGIES,
        [{ name: "assigned", provider: "openrouter", model: "assigned-model" }],
    );

    expect(bound?.rungs[0].diagnostics).toMatchObject({
        catalogEntry: "assigned",
        model: "assigned-model",
    });
});

test("a catalog fallback is the model shown for the bound summarizer", () => {
    const bound = bindCompaction(
        profile({ slots: {} }),
        adapter,
        { provider: "openrouter", model: "session-model" },
        BUNDLED_COMPACTION_STRATEGIES,
        [{
            name: "fallback",
            provider: "openrouter",
            model: "fallback-model",
        }],
    );

    expect(bound?.rungs[0].diagnostics).toMatchObject({
        provider: "openrouter",
        model: "fallback-model",
    });
});

test("a profile with no trigger keys binds no trigger, so defaults apply", () => {
    const bound = bindCompaction(
        profile(),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    );

    expect(bound?.trigger).toBeUndefined();
    expect(bound?.targetTokens).toBeUndefined();
});

test("configured trigger bounds reach the scheduler", () => {
    const bound = bindCompaction(
        profile({
            trigger_fraction: 0.2,
            trigger_tokens: 30_000,
            target_tokens: 10_000,
        }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    );

    expect(bound?.trigger).toEqual({ fraction: 0.2, tokens: 30_000 });
    expect(bound?.targetTokens).toBe(10_000);
});

test("config overrides replace the profile's trigger and the engine's own sizing", () => {
    const bound = bindCompaction(
        profile({ trigger_fraction: 0.8, trigger_tokens: 90_000 }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
        undefined,
        {
            triggerFraction: 0.3,
            postCompactionTargetFraction: 0.2,
            summaryWordCap: 250,
        },
    );

    // The fraction is replaced and the token bound is left alone: an override
    // touches what it names, so a configured bound does not disappear
    // because a different one was moved.
    expect(bound?.trigger).toEqual({ fraction: 0.3, tokens: 90_000 });
    expect(bound?.postCompactionTargetFraction).toBe(0.2);
    expect(bound?.summaryWordCap).toBe(250);
});

test("no overrides leaves a bound profile untouched", () => {
    const plain = bindCompaction(
        profile({ trigger_fraction: 0.8 }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    );

    expect(plain?.trigger).toEqual({ fraction: 0.8 });
    expect(plain?.postCompactionTargetFraction).toBeUndefined();
    expect(plain?.summaryWordCap).toBeUndefined();
});

test("overrides retune the compaction of a session with no profile", () => {
    // The case a numbers-only config block exists for: nobody routed a
    // summarizer, but the session still compacts, and the numbers still say
    // when and how far.
    const bound = bindCompaction(
        undefined,
        adapter,
        { model: "test-model" },
        BUNDLED_COMPACTION_STRATEGIES,
        undefined,
        {
            triggerFraction: 0.6,
            triggerTokens: 40_000,
            targetTokens: 12_000,
            postCompactionTargetFraction: 0.3,
            summaryWordCap: 400,
            retainedUserTurns: 5,
        },
    );

    expect(bound?.trigger).toEqual({ fraction: 0.6, tokens: 40_000 });
    expect(bound?.targetTokens).toBe(12_000);
    expect(bound?.postCompactionTargetFraction).toBe(0.3);
    expect(bound?.summaryWordCap).toBe(400);
    expect(bound?.retainedUserTurns).toBe(5);
});

test("an override may raise a token bound the profile already set", () => {
    const bound = bindCompaction(
        profile({
            trigger_fraction: 0.8,
            trigger_tokens: 90_000,
            target_tokens: 10_000,
            retained_user_turns: 2,
        }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
        undefined,
        { triggerTokens: 50_000, targetTokens: 20_000, retainedUserTurns: 4 },
    );

    expect(bound?.trigger).toEqual({ fraction: 0.8, tokens: 50_000 });
    expect(bound?.targetTokens).toBe(20_000);
    expect(bound?.retainedUserTurns).toBe(4);
});

test("every rung of a configured ladder binds, in the order it was declared", () => {
    const dropRung: ResolvedCompactionRung = {
        strategy: DROP_OLDEST_STRATEGY_ID,
        routes: {},
        slots: {},
    };
    const summaryRung: ResolvedCompactionRung = {
        strategy: FULL_SUMMARY_STRATEGY_ID,
        routes: {},
        slots: { summarizer: [{ name: "small", provider: "faux", model: "test" }] },
    };
    const bound = bindCompaction(
        { ladder: [dropRung, summaryRung, dropRung] },
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    );

    expect(bound?.rungs.map((rung) => rung.strategy.id)).toEqual([
        DROP_OLDEST_STRATEGY_ID,
        FULL_SUMMARY_STRATEGY_ID,
        DROP_OLDEST_STRATEGY_ID,
    ]);
    expect(Object.keys(bound?.rungs[1]?.models ?? {})).toEqual(["summarizer"]);
});

test("a rung naming an unknown strategy fails the whole binding", () => {
    const summaryRung: ResolvedCompactionRung = {
        strategy: FULL_SUMMARY_STRATEGY_ID,
        routes: {},
        slots: { summarizer: [{ name: "small", provider: "faux", model: "test" }] },
    };
    const unknownRung: ResolvedCompactionRung = {
        strategy: "other/thing",
        routes: {},
        slots: {},
    };
    expect(bindCompaction(
        { ladder: [summaryRung, unknownRung] },
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    )).toBeUndefined();
});

test("a rung's reasoning effort reaches that rung's calls and no other", async () => {
    const efforts: (string | undefined)[] = [];
    const recording = {
        stream(request: { readonly reasoningEffort?: string }) {
            efforts.push(request.reasoningEffort);
            throw new Error("recorded");
        },
    } as unknown as ModelAdapter;
    const bound = bindCompaction(
        {
            ladder: [
                {
                    strategy: FULL_SUMMARY_STRATEGY_ID,
                    routes: {},
                    slots: {
                        summarizer: [{
                            name: "first",
                            provider: "faux",
                            model: "first-model",
                            reasoning_effort: "low",
                        }],
                    },
                    reasoning_effort: "high",
                },
                {
                    strategy: FULL_SUMMARY_STRATEGY_ID,
                    routes: {},
                    slots: {
                        summarizer: [{
                            name: "second",
                            provider: "faux",
                            model: "second-model",
                            reasoning_effort: "low",
                        }],
                    },
                },
                {
                    strategy: FULL_SUMMARY_STRATEGY_ID,
                    routes: {},
                    slots: {
                        summarizer: [{
                            name: "third",
                            provider: "faux",
                            model: "third-model",
                        }],
                    },
                },
            ],
        },
        recording,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    );
    const signal = new AbortController().signal;
    for (const rung of bound?.rungs ?? []) {
        await rung.models.summarizer?.(
            { systemPrompt: "", messages: [], maxTokens: 16 },
            signal,
        ).catch(() => undefined);
    }

    expect(efforts).toEqual(["high", "low", undefined]);
});

test("a bound compaction round-trips through the worker wire spec", () => {
    const bound = bindCompaction(
        profile({
            trigger_fraction: 0.2,
            trigger_tokens: 30_000,
            target_tokens: 10_000,
        }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    );
    expect(bound).toBeDefined();
    const restored = bindRemoteCompaction(
        compactionWireSpec(bound!),
        () => async () => ({ text: "ok", model: "test" }),
    );

    expect(restored?.rungs).toHaveLength(1);
    expect(restored?.rungs[0].strategy.id).toBe(bound?.rungs[0].strategy.id);
    expect(Object.keys(restored?.rungs[0].models ?? {})).toEqual(["summarizer"]);
    expect(restored?.trigger).toEqual(bound?.trigger);
    expect(restored?.targetTokens).toBe(10_000);
    expect(restored?.rungs[0].diagnostics).toEqual(bound?.rungs[0].diagnostics);
});

test("a ladder crosses the wire rung by rung, with each rung's effort and timeout", () => {
    const bound = bindCompaction(
        {
            ladder: [
                {
                    strategy: FULL_SUMMARY_STRATEGY_ID,
                    routes: {},
                    slots: {
                        summarizer: [{
                            name: "first",
                            provider: "faux",
                            model: "first-model",
                        }],
                    },
                    reasoning_effort: "high",
                    timeout_ms: 5_000,
                },
                {
                    strategy: DROP_OLDEST_STRATEGY_ID,
                    routes: {},
                    slots: {},
                },
            ],
        },
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    );
    const spec = compactionWireSpec(bound!);
    expect(spec.rungs?.map((rung) => rung.strategyId)).toEqual([
        FULL_SUMMARY_STRATEGY_ID,
        DROP_OLDEST_STRATEGY_ID,
    ]);
    expect(spec.rungs?.[0]).toMatchObject({
        reasoningEffort: "high",
        timeoutMs: 5_000,
    });

    const calls: [number, string][] = [];
    const restored = bindRemoteCompaction(spec, (rung, slot) => {
        calls.push([rung, slot]);
        return async () => ({ text: "ok", model: "test" });
    });
    expect(restored?.rungs.map((rung) => rung.strategy.id)).toEqual([
        FULL_SUMMARY_STRATEGY_ID,
        DROP_OLDEST_STRATEGY_ID,
    ]);
    expect(restored?.rungs[0]).toMatchObject({
        reasoningEffort: "high",
        timeoutMs: 5_000,
    });
    expect(calls).toEqual([[0, "summarizer"]]);
});

test("a spec from a host that predates rungs binds its top level as the only rung", () => {
    const calls: [number, string][] = [];
    const restored = bindRemoteCompaction(
        { strategyId: FULL_SUMMARY_STRATEGY_ID, slots: ["summarizer"] },
        (rung, slot) => {
            calls.push([rung, slot]);
            return async () => ({ text: "ok", model: "test" });
        },
    );
    expect(restored?.rungs.map((rung) => rung.strategy.id)).toEqual([
        FULL_SUMMARY_STRATEGY_ID,
    ]);
    expect(calls).toEqual([[0, "summarizer"]]);
});

test("the first wire rung this build cannot bind is the one named", () => {
    const spec = {
        strategyId: FULL_SUMMARY_STRATEGY_ID,
        slots: ["summarizer"],
        rungs: [
            { strategyId: FULL_SUMMARY_STRATEGY_ID, slots: ["summarizer"] },
            { strategyId: "ext/custom", slots: ["summarizer"] },
        ],
    };
    expect(unboundWireStrategy(spec)).toBe("ext/custom");
    expect(bindRemoteCompaction(
        spec,
        () => async () => ({ text: "ok", model: "test" }),
    )).toBeUndefined();
});

test("an unknown strategy on the wire binds nothing", () => {
    expect(bindRemoteCompaction(
        { strategyId: "other/thing", slots: ["summarizer"] },
        () => async () => ({ text: "ok", model: "test" }),
    )).toBeUndefined();
});

test("a missing slot on the wire binds nothing", () => {
    expect(bindRemoteCompaction(
        { strategyId: FULL_SUMMARY_STRATEGY_ID, slots: [] },
        () => async () => ({ text: "ok", model: "test" }),
    )).toBeUndefined();
});

test("the summarizer guard reads the window from the catalog it is bound with", async () => {
    // A model the built-in table does not know still has a window the
    // host discovered; the guard must refuse a request that cannot fit it.
    const slots = {
        summarizer: [{
            name: "small",
            provider: "openai" as const,
            model: "catalog-only-model",
        }],
    };
    const request = {
        systemPrompt: "summarize",
        messages: [{
            role: "user" as const,
            content: [{ type: "text" as const, text: "x".repeat(40_000) }],
        }],
    };
    const signal = new AbortController().signal;

    const windowed = bindCompaction(
        profile({ slots }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
        undefined,
        undefined,
        [{ provider: "openai", model: "catalog-only-model", contextWindow: 1_000 }],
    );
    const summarize = windowed?.rungs[0].models.summarizer;
    if (summarize === undefined) throw new Error("summarizer is not bound");
    await expect(summarize(request, signal)).rejects.toThrow(/skipped/);

    const unwindowed = bindCompaction(
        profile({ slots }),
        adapter,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
        undefined,
        undefined,
        [],
    );
    const unknown = unwindowed?.rungs[0].models.summarizer;
    if (unknown === undefined) throw new Error("summarizer is not bound");
    const error = await unknown(request, signal).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("skipped");
});

test("the default ladder is the summary rung followed by drop-oldest", () => {
    expect(DEFAULT_COMPACTION_LADDER).toEqual([
        FULL_SUMMARY_STRATEGY_ID,
        DROP_OLDEST_STRATEGY_ID,
    ]);
});
