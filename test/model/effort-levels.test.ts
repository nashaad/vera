import { expect, test } from "bun:test";

import { poolEffortLevels } from "../../src/model/effort-levels.ts";
import type { EffortPool } from "../../src/model/effort-pool.ts";

function poolWith(efforts: Record<string, string | null>): EffortPool {
    return {
        resolveEffort: (_ref, requested) => ({ requested, efforts }),
        resolveImageSupport: () => undefined,
        recordLearned: () => undefined,
    };
}

test("resolved levels arrive most capable first, with their wire strings", () => {
    const levels = poolEffortLevels({
        provider: "openrouter",
        pool: poolWith({ low: "low", high: "high", medium: "medium" }),
        cacheDir: "/nonexistent",
    })("anthropic/claude-haiku-4.5", "medium");

    expect(levels).toEqual({
        supportedEfforts: ["high", "medium", "low"],
        providerEfforts: { high: "high", medium: "medium", low: "low" },
    });
});

test("a forbidden level is not offered as one the model supports", () => {
    const levels = poolEffortLevels({
        provider: "openrouter",
        pool: poolWith({ off: null, low: "low", high: "high" }),
        cacheDir: "/nonexistent",
    })("provider/model", "off");

    expect(levels?.supportedEfforts).toEqual(["high", "low"]);
});

test("a model with no known levels answers nothing, leaving the gap open", () => {
    expect(poolEffortLevels({
        provider: "openrouter",
        pool: poolWith({}),
        cacheDir: "/nonexistent",
    })("provider/model", "medium")).toBeUndefined();
});
