import { describe, expect, test } from "bun:test";

import {
    coarsenOneStep,
    EFFORT_LADDER,
    effortWentStale,
    supportedLevels,
} from "../../src/model/effort-ladder.ts";

const FULL = {
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
};

test("off is its own rung, distinct from minimal", () => {
    expect(EFFORT_LADDER).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]);
});

test("a forbidden level is not offered as a target", () => {
    expect(supportedLevels({ ...FULL, xhigh: null })).not.toContain("xhigh");
});

test("a level the map never mentions is not offered as a target", () => {
    expect(supportedLevels({ low: "low", high: "high" })).toEqual(["low", "high"]);
});

test("coarsening steps down one rung on a full ladder", () => {
    expect(coarsenOneStep("xhigh", FULL)).toEqual({
        level: "high",
        providerEffort: "high",
    });
});

test("coarsening skips forbidden rungs to the nearest supported neighbour", () => {
    expect(coarsenOneStep("xhigh", { ...FULL, high: null, medium: null })).toEqual({
        level: "low",
        providerEffort: "low",
    });
});

test("coarsening carries the provider wire string, not the vera word", () => {
    expect(coarsenOneStep("minimal", { off: "none", minimal: "minimal" })).toEqual({
        level: "off",
        providerEffort: "none",
    });
});

test("a forbidden off coarsens upward, since nothing sits below it", () => {
    expect(coarsenOneStep("off", { ...FULL, off: null })).toEqual({
        level: "minimal",
        providerEffort: "minimal",
    });
});

test("an already refused level is never offered again", () => {
    expect(coarsenOneStep("xhigh", FULL, new Set(["high"]))).toEqual({
        level: "medium",
        providerEffort: "medium",
    });
});

test("a model with only the requested level has nowhere to coarsen", () => {
    expect(coarsenOneStep("high", { high: "high" })).toBeUndefined();
});

test("a level outside the ladder never guesses a neighbour", () => {
    expect(coarsenOneStep("ultra", FULL)).toBeUndefined();
});

describe("effortWentStale", () => {
    test("an unset effort asks nothing", () => {
        expect(effortWentStale(["low", "high"], undefined)).toBe(false);
    });

    test("an effort the new model still offers asks nothing", () => {
        expect(effortWentStale(["low", "medium", "high"], "high")).toBe(false);
    });

    test("an effort the new model dropped has to be asked again", () => {
        expect(effortWentStale(["low", "medium"], "max")).toBe(true);
    });

    test("a model with no levels leaves any effort stale", () => {
        expect(effortWentStale([], "high")).toBe(true);
    });
});
