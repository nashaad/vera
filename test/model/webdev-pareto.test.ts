import { expect, test } from "bun:test";

import { paretoKeys } from "../../src/model/webdev-pareto.ts";

test("a lower-score model at the same or higher price does not get P", () => {
    const keys = paretoKeys([
        { key: "front", score: 1600, output: 1 },
        { key: "worse", score: 1000, output: 5 },
    ]);
    expect(keys.has("front")).toBe(true);
    expect(keys.has("worse")).toBe(false);
});

test("a higher-score more expensive model on the front does get P", () => {
    const keys = paretoKeys([
        { key: "cheap", score: 1400, output: 1 },
        { key: "dear", score: 1600, output: 15 },
    ]);
    expect(keys.has("cheap")).toBe(true);
    expect(keys.has("dear")).toBe(true);
});

test("a model within 25 points of the front gets P", () => {
    const keys = paretoKeys([
        { key: "front", score: 1600, output: 15 },
        { key: "near", score: 1575, output: 15 },
    ]);
    expect(keys.has("near")).toBe(true);
});

test("a model 26 points below the front does not get P", () => {
    const keys = paretoKeys([
        { key: "front", score: 1600, output: 15 },
        { key: "far", score: 1574, output: 15 },
    ]);
    expect(keys.has("far")).toBe(false);
});

test("missing score or missing output rate never gets P", () => {
    expect(paretoKeys([
        { key: "score-only", score: 1600, output: Number.NaN },
    ]).size).toBe(0);
    expect(paretoKeys([]).size).toBe(0);
});

test("equal score and equal output may both keep P", () => {
    const keys = paretoKeys([
        { key: "a", score: 1500, output: 3 },
        { key: "b", score: 1500, output: 3 },
    ]);
    expect(keys.has("a")).toBe(true);
    expect(keys.has("b")).toBe(true);
});
