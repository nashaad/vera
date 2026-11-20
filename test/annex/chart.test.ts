import { expect, test } from "bun:test";

import {
    areaPath,
    axisMoney,
    axisTicks,
    bucketAxisLabel,
    bucketRangeLabel,
    chartBands,
    chartScale,
    chartSeries,
    labelIndices,
    monotonePath,
    nearestIndex,
    niceMax,
    OTHER_KEY,
} from "../../clients/annex/chart.ts";
import type { UsageModelRow } from "../../src/annex/usage-report.ts";

test("niceMax rounds up to a readable axis step", () => {
    expect(niceMax(0.01)).toBe(0.01);
    expect(niceMax(0.8)).toBe(1);
    expect(niceMax(2.1)).toBe(4);
    expect(niceMax(7.4)).toBe(10);
    expect(niceMax(100)).toBe(100);
    expect(niceMax(0)).toBe(0.01);
});

test("axisTicks is zero, half and the rounded peak", () => {
    expect(axisTicks(niceMax(7.4))).toEqual([0, 5, 10]);
});

test("axisMoney keeps short labels and small values readable", () => {
    expect(axisMoney(0)).toBe("$0");
    expect(axisMoney(1)).toBe("$1");
    expect(axisMoney(2.5)).toBe("$2.5");
    expect(axisMoney(0.05)).toBe("$0.05");
    expect(axisMoney(0.5)).toBe("$0.5");
});

test("axisMoney keeps sub-cent ticks distinct instead of collapsing to $0", () => {
    expect(axisMoney(0.001)).toBe("$0.001");
    expect(axisMoney(0.002)).toBe("$0.002");
    expect(axisMoney(0.0005)).toBe("$0.0005");
    expect(axisMoney(0.00025)).toBe("$0.00025");
    const labels = axisTicks(niceMax(0.002)).map(axisMoney);
    expect(labels).toEqual(["$0", "$0.001", "$0.002"]);
});

test("labelIndices picks first, middle and last without repeats", () => {
    expect(labelIndices(0)).toEqual([]);
    expect(labelIndices(1)).toEqual([0]);
    expect(labelIndices(2)).toEqual([0, 1]);
    expect(labelIndices(3)).toEqual([0, 1, 2]);
    expect(labelIndices(30)).toEqual([0, 14, 29]);
});

test("nearestIndex snaps a pointer ratio to a bucket", () => {
    expect(nearestIndex(0, 0.4)).toBe(0);
    expect(nearestIndex(1, 0.9)).toBe(0);
    expect(nearestIndex(5, -1)).toBe(0);
    expect(nearestIndex(5, 2)).toBe(4);
    expect(nearestIndex(5, 0.24)).toBe(1);
    expect(nearestIndex(5, 0.26)).toBe(1);
    expect(nearestIndex(5, 0.51)).toBe(2);
});

test("chartScale puts zero on the baseline and the peak at the top", () => {
    const scale = chartScale(500, 10, 7.4, 200);
    expect(scale.max).toBe(10);
    expect(scale.plotWidth).toBe(454);
    expect(scale.plotHeight).toBe(168);
    expect(scale.x(0)).toBe(44);
    expect(scale.x(9)).toBe(498);
    expect(scale.y(0)).toBe(176);
    expect(scale.y(10)).toBe(8);
    expect(scale.y(5)).toBe(92);
});

test("chartScale centres a single bucket", () => {
    const scale = chartScale(500, 1, 3, 200);
    expect(scale.x(0)).toBe(44 + 454 / 2);
});

test("bucket labels follow the bucket size", () => {
    const point = { start: "2026-11-10", end: "2026-11-16", spend: 1, byModel: [] };
    expect(bucketAxisLabel(point, "day")).toBe("Nov 10");
    expect(bucketAxisLabel(point, "week")).toBe("Nov 10");
    expect(bucketAxisLabel(point, "month")).toBe("Nov 2026");
    expect(bucketRangeLabel(point, "day")).toBe("Nov 10");
    expect(bucketRangeLabel(point, "week")).toBe("Nov 10 to Nov 16");
});

test("month ranges clip to the window and name both years at a boundary", () => {
    const partial = { start: "2026-11-01", end: "2026-11-19", spend: 1, byModel: [] };
    expect(bucketRangeLabel(partial, "month")).toBe("Nov 1 to Nov 19");
    const crossYear = { start: "2025-12-29", end: "2026-01-04", spend: 1, byModel: [] };
    expect(bucketRangeLabel(crossYear, "week"))
        .toBe("Dec 29, 2025 to Jan 4, 2026");
});

function curvePoints(path: string): { x: number; y: number }[] {
    return [...path.matchAll(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g)].map((match) => {
        const [x, y] = match[0].split(",").map(Number);
        return { x: x!, y: y! };
    });
}

test("monotone path never overshoots a segment's endpoint values", () => {
    const xs = [0, 10, 20, 30];
    const ys = [100, 20, 90, 40];
    const points = curvePoints(monotonePath(xs, ys));
    // One anchor plus three coordinate pairs per cubic segment.
    expect(points.length).toBe(1 + 3 * 3);
    for (let segment = 0; segment < 3; segment += 1) {
        const low = Math.min(ys[segment]!, ys[segment + 1]!);
        const high = Math.max(ys[segment]!, ys[segment + 1]!);
        const controls = points.slice(1 + segment * 3, 3 + segment * 3);
        expect(controls.length).toBe(2);
        for (const point of controls) {
            expect(point.y).toBeGreaterThanOrEqual(low - 1e-9);
            expect(point.y).toBeLessThanOrEqual(high + 1e-9);
        }
    }
});

test("area path closes over the baseline or the lower edge", () => {
    const base = areaPath([0, 10, 20], [100, 60, 80], undefined, 100);
    expect(base.startsWith("M0,100")).toBe(true);
    expect(base.endsWith("Z")).toBe(true);
    expect(base).toContain("L20,100L0,100");

    const band = areaPath([0, 10, 20], [100, 60, 80], [110, 90, 100], 100);
    expect(band).toContain("L20,100");
    expect(band).not.toContain("L0,100");
    expect(band.endsWith("Z")).toBe(true);
});

function modelRow(
    provider: string,
    model: string,
    spend: number,
    kind: UsageModelRow["kind"] = "reported",
): UsageModelRow {
    return {
        provider,
        model,
        calls: 1,
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        spend,
        share: 0,
        kind,
        tools: [],
    };
}

test("chart series list every route and tone only the top three spend", () => {
    const models = [
        modelRow("a", "one", 5),
        modelRow("b", "two", 3),
        modelRow("c", "three", 1),
        modelRow("d", "four", 0.5),
        modelRow("u", "unpriced", 0, "unpriced"),
    ];
    const series = chartSeries(models);
    expect(series.map((row) => [row.key, row.tone])).toEqual([
        ["a/one", "m0"],
        ["b/two", "m1"],
        ["c/three", "m2"],
        ["d/four", "rest"],
        ["u/unpriced", "rest"],
    ]);
});

test("a zero-spend route never takes a tone or adds an Other band", () => {
    const models = [
        modelRow("a", "one", 4),
        modelRow("b", "two", 1),
        modelRow("u", "unpriced", 0, "unpriced"),
    ];
    expect(chartSeries(models).map((row) => row.tone))
        .toEqual(["m0", "m1", "rest"]);
    const timeline = [{
        start: "2026-11-10",
        end: "2026-11-10",
        spend: 2,
        byModel: [{ provider: "a", model: "one", spend: 2 }],
    }];
    expect(chartBands(timeline, models).bands.map((band) => band.key))
        .toEqual(["a/one", "b/two"]);
});

test("chart bands draw priced spend only and keep Other coherent", () => {
    const models = [
        modelRow("a", "one", 5),
        modelRow("b", "two", 3),
        modelRow("c", "three", 1),
        modelRow("d", "four", 0.5),
        modelRow("u", "unpriced", 0, "unpriced"),
    ];
    const timeline = [{
        start: "2026-11-10",
        end: "2026-11-10",
        spend: 4.5,
        byModel: [
            { provider: "a", model: "one", spend: 2 },
            { provider: "b", model: "two", spend: 1 },
            { provider: "c", model: "three", spend: 1 },
            { provider: "d", model: "four", spend: 0.5 },
        ],
    }];
    const { bands, totals } = chartBands(timeline, models);
    expect(bands.map((band) => band.key))
        .toEqual(["a/one", "b/two", "c/three", OTHER_KEY]);
    expect(bands[3]!.label).toBe("Other (1)");
    expect(bands[3]!.values).toEqual([0.5]);
    expect(totals).toEqual([4.5]);
});
