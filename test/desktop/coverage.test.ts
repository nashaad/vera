import { expect, test } from "bun:test";

import type { CoveragePhase } from "../../clients/ui/src/pages/coverage-data.ts";
import {
    coverageCounts,
    filterPhases,
    segmentPercent,
    STATUS_LABELS,
    windowPercent,
} from "../../clients/ui/src/pages/coverage.ts";

const phases: readonly CoveragePhase[] = [
    {
        name: "Start",
        items: [
            { text: "Open a session", status: "window" },
            { text: "Pick a model", status: "partial", note: "Models only" },
        ],
    },
    {
        name: "Run",
        items: [
            { text: "Stream a turn", status: "window" },
            { text: "Attach a shell", status: "terminal", note: "Terminal" },
        ],
    },
    {
        name: "Sync",
        items: [{ text: "Sync history", status: "host" }],
    },
];

test("@core counts every status and the total, and filtering drops phases left empty", () => {
    expect(coverageCounts(phases)).toEqual({ window: 2, partial: 1, terminal: 1, host: 1, total: 5 });

    expect(filterPhases(phases, "window")).toEqual([
        { name: "Start", items: [{ text: "Open a session", status: "window" }] },
        { name: "Run", items: [{ text: "Stream a turn", status: "window" }] },
    ]);
    expect(filterPhases(phases, "host")).toEqual([
        { name: "Sync", items: [{ text: "Sync history", status: "host" }] },
    ]);
});

test("the window percent rounds and is 0 when there are no behaviors", () => {
    expect(windowPercent(coverageCounts(phases))).toBe(40);
    expect(windowPercent(coverageCounts([{ name: "Two", items: [
        { text: "a", status: "window" },
        { text: "b", status: "window" },
        { text: "c", status: "host" },
    ] }]))).toBe(67);
    expect(windowPercent(coverageCounts([]))).toBe(0);
    expect(segmentPercent(coverageCounts([]), "partial")).toBe(0);
});

test("the segment percent is each status share of the total", () => {
    const counts = coverageCounts(phases);
    expect(segmentPercent(counts, "window")).toBe(40);
    expect(segmentPercent(counts, "partial")).toBe(20);
    expect(STATUS_LABELS.host).toBe("Not served");
});

test("all keeps every phase in order", () => {
    expect(filterPhases(phases, "all")).toEqual(phases);
});
