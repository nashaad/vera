import { expect, test } from "bun:test";

import {
    BUNDLED_COMPACTION_STRATEGIES,
    bindCompaction,
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
