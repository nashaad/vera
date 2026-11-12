import { expect, test } from "bun:test";

import {
    contextFraction,
    createContextSizeLevelTracker,
} from "../../src/host/agent-registry/context-size-levels.ts";

test("a new session fires every crossed level once, in ascending order", () => {
    const tracker = createContextSizeLevelTracker(0);
    expect(tracker.observe([0.9, 0.5, 0.7], 80, 100)).toEqual([0.5, 0.7]);
});

test("the same measurement does not fire a level again", () => {
    const tracker = createContextSizeLevelTracker(0);
    expect(tracker.observe([0.5], 60, 100)).toEqual([0.5]);
    expect(tracker.observe([0.5], 60, 100)).toEqual([]);
    expect(tracker.observe([0.5], 80, 100)).toEqual([]);
});

test("dropping below a level arms it again", () => {
    const tracker = createContextSizeLevelTracker(0);
    expect(tracker.observe([0.5], 80, 100)).toEqual([0.5]);
    expect(tracker.observe([0.5], 40, 100)).toEqual([]);
    expect(tracker.observe([0.5], 60, 100)).toEqual([0.5]);
});

test("a larger window lowers the fraction and arms levels again", () => {
    const tracker = createContextSizeLevelTracker(0);
    expect(tracker.observe([0.5], 800, 1_000)).toEqual([0.5]);
    expect(tracker.observe([0.5], 600, 100_000)).toEqual([]);
    expect(tracker.observe([0.5], 60_000, 100_000)).toEqual([0.5]);
});

test("duplicate levels fire once", () => {
    const tracker = createContextSizeLevelTracker(0);
    expect(tracker.observe([0.5, 0.5], 60, 100)).toEqual([0.5]);
});

test("a measurement without a usable capacity is not checked", () => {
    const tracker = createContextSizeLevelTracker(0);
    expect(tracker.observe([0.5], 60, undefined)).toEqual([]);
    expect(tracker.observe([0.5], 60, 0)).toEqual([]);
    expect(tracker.observe([0.5], 60, 100)).toEqual([0.5]);
});

test("a seeded fraction is the baseline instead of zero", () => {
    const tracker = createContextSizeLevelTracker(contextFraction(60, 100));
    expect(tracker.observe([0.5, 0.7], 65, 100)).toEqual([]);
    expect(tracker.observe([0.5, 0.7], 75, 100)).toEqual([0.7]);
});

test("a level added while context is above it waits for a re-cross", () => {
    const tracker = createContextSizeLevelTracker(0);
    expect(tracker.observe([], 60, 100)).toEqual([]);
    expect(tracker.observe([0.5], 70, 100)).toEqual([]);
    expect(tracker.observe([0.5], 40, 100)).toEqual([]);
    expect(tracker.observe([0.5], 60, 100)).toEqual([0.5]);
});
