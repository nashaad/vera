import { expect, test } from "bun:test";
import { heapMedianBefore, leastSquaresSlope, parseHeapSamples, parseVmmapSummary } from "./measure.ts";

test("parseVmmapSummary reads the DIRTY column of each region type", () => {
    const source = [
        "REGION TYPE                    VIRTUAL   RESIDENT    DIRTY  SWAPPED",
        "VM_ALLOCATE                    1.2G      2.0M        1.8M   0K",
        "IOAccelerator                  128.0M    54.1M       54.1M  0K",
        "MALLOC_SMALL                   40.0M     20.0M       19.5M  0K",
    ].join("\n");
    const dirty = parseVmmapSummary(source);
    expect(dirty.get("VM_ALLOCATE")).toBe(Math.round(1.8 * 1024 * 1024));
    expect(dirty.get("IOAccelerator")).toBe(Math.round(54.1 * 1024 * 1024));
});

test("leastSquaresSlope fits a flat series to zero growth", () => {
    const fit = leastSquaresSlope([[1, 100], [2, 100], [3, 100], [4, 100]]);
    expect(fit.slope).toBe(0);
    expect(fit.growth).toBe(0);
});

test("leastSquaresSlope reports growth across the measured turns", () => {
    const fit = leastSquaresSlope([[10, 1000], [20, 2000], [30, 3000]]);
    expect(fit.slope).toBeCloseTo(100, 6);
    expect(fit.growth).toBeCloseTo(2000, 6);
});

test("parseHeapSamples skips blank and partially written lines", () => {
    const text = [
        JSON.stringify({ at: 1000, heapUsed: 100, gcMs: 2 }),
        "",
        "{\"at\": 1500, \"heap",
        JSON.stringify({ at: 2000, heapUsed: 120, gcMs: 3 }),
    ].join("\n");
    expect(parseHeapSamples(text)).toEqual([
        { at: 1000, heapUsed: 100, gcMs: 2 },
        { at: 2000, heapUsed: 120, gcMs: 3 },
    ]);
});

test("heapMedianBefore takes the median of the latest samples at or before the turn end", () => {
    const samples = [
        { at: 1000, heapUsed: 100, gcMs: 2 },
        { at: 1500, heapUsed: 900, gcMs: 2 },
        { at: 2000, heapUsed: 120, gcMs: 4 },
        { at: 2500, heapUsed: 130, gcMs: 9 },
    ];
    expect(heapMedianBefore(samples, 2000, 3)).toEqual({ at: 2000, heapUsed: 120, gcMs: 2 });
    expect(heapMedianBefore(samples, 2600, 3)).toEqual({ at: 2500, heapUsed: 130, gcMs: 4 });
    expect(heapMedianBefore(samples, 1600, 3)).toEqual({ at: 1500, heapUsed: 500, gcMs: 2 });
    expect(heapMedianBefore(samples, 999, 3)).toBeUndefined();
});
