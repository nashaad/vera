import { expect, test } from "bun:test";

import { bindCompaction } from "../../src/engine/compaction-binding.ts";
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

test("no configured profile means no compaction, not a default one", () => {
    expect(bindCompaction(undefined, adapter)).toBeUndefined();
});

test("a bound profile exposes exactly the slots the strategy declared", () => {
    const bound = bindCompaction(profile(), adapter);

    expect(bound).toBeDefined();
    expect(Object.keys(bound?.models ?? {})).toEqual(["summarizer"]);
    expect(bound?.strategy.id).toBe(FULL_SUMMARY_STRATEGY_ID);
});

test("an unknown strategy binds nothing rather than a strategy of its choosing", () => {
    expect(bindCompaction(profile({ strategy: "other/thing" }), adapter))
        .toBeUndefined();
});

test("a declared slot with no route binds nothing", () => {
    // The alternative is discovering the missing model at the moment the
    // window fills, which is the worst time to find out.
    expect(bindCompaction(profile({ slots: {} }), adapter)).toBeUndefined();
});
