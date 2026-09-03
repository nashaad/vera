import { expect, test } from "bun:test";

import {
    BUNDLED_COMPACTION_STRATEGIES,
    bindCompaction,
    bindRemoteCompaction,
    compactionWireSpec,
} from "../../src/engine/compaction-binding.ts";
import { FULL_SUMMARY_STRATEGY_ID } from
    "../../src/engine/compaction-full-summary.ts";
import type { ResolvedCompactionProfile } from
    "../../src/config/model-catalog.ts";
import type { ModelAdapter } from "../../src/model/types.ts";

const adapter = {} as ModelAdapter;

function profile(
    overrides: Partial<ResolvedCompactionProfile> = {},
): ResolvedCompactionProfile {
    return {
        strategy: FULL_SUMMARY_STRATEGY_ID,
        routes: { summarizer: "summarizer" },
        slots: { summarizer: [{ name: "small", model: "test-model" }] },
        ...overrides,
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

    expect(bound?.strategy.id).toBe(FULL_SUMMARY_STRATEGY_ID);
    expect(Object.keys(bound?.models ?? {})).toEqual(["summarizer"]);
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
    expect(Object.keys(bound?.models ?? {})).toEqual(["summarizer"]);
    expect(bound?.strategy.id).toBe(FULL_SUMMARY_STRATEGY_ID);
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

    expect(bound?.diagnostics).toMatchObject({
        catalogEntry: "assigned",
        model: "assigned-model",
    });
    expect(bound?.diagnostics?.route).toBeUndefined();
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

    expect(bound?.diagnostics).toMatchObject({
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

    expect(bound?.diagnostics).toMatchObject({
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

    expect(restored?.strategy.id).toBe(bound?.strategy.id);
    expect(Object.keys(restored?.models ?? {})).toEqual(["summarizer"]);
    expect(restored?.trigger).toEqual(bound?.trigger);
    expect(restored?.targetTokens).toBe(10_000);
    expect(restored?.diagnostics).toEqual(bound?.diagnostics);
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
