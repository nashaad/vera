import { expect, test } from "bun:test";

import { estimateDeepSeekUsd } from "../../src/annex/deepseek-pricing.ts";

const tokens = {
    inputTokens: 1_000_000,
    cachedInputTokens: 200_000,
    outputTokens: 500_000,
};

test("DeepSeek Flash and Pro use their peak and off-peak rates", () => {
    const peak = "2026-11-16T02:00:00Z";
    const offPeak = "2026-11-16T05:00:00Z";
    expect(estimateDeepSeekUsd("deepseek-flash", peak, tokens)).toBeCloseTo(0.8412, 10);
    expect(estimateDeepSeekUsd("deepseek-flash", offPeak, tokens)).toBeCloseTo(0.4206, 10);
    expect(estimateDeepSeekUsd("deepseek-v4-pro", peak, tokens)).toBeCloseTo(3.0448, 10);
    expect(estimateDeepSeekUsd("deepseek-v4-pro", offPeak, tokens)).toBeCloseTo(1.5224, 10);
});

test("DeepSeek peak windows start inclusive and end exclusive in UTC", () => {
    const dates = [
        ["2026-11-16T00:59:59Z", 0.4206],
        ["2026-11-16T01:00:00Z", 0.8412],
        ["2026-11-16T03:59:59Z", 0.8412],
        ["2026-11-16T04:00:00Z", 0.4206],
        ["2026-11-16T05:59:59Z", 0.4206],
        ["2026-11-16T06:00:00Z", 0.8412],
        ["2026-11-16T09:59:59Z", 0.8412],
        ["2026-11-16T10:00:00Z", 0.4206],
        ["2026-11-16T03:00:00+02:00", 0.8412],
    ] as const;
    for (const [timestamp, expected] of dates) {
        expect(estimateDeepSeekUsd("deepseek-flash", timestamp, tokens)).toBeCloseTo(expected, 10);
    }
});

test("weekends use off-peak rates even during weekday peak hours", () => {
    for (const timestamp of [
        "2026-11-13T10:00:00Z",
        "2026-11-14T02:00:00Z",
        "2026-11-15T07:00:00Z",
        "2026-11-16T00:59:59Z",
    ]) {
        expect(estimateDeepSeekUsd("deepseek-flash", timestamp, tokens)).toBeCloseTo(0.4206, 10);
    }
});

test("cache hits and misses use separate rates and writes use the miss rate", () => {
    expect(estimateDeepSeekUsd("deepseek-flash", "2026-11-16T02:00:00Z", {
        ...tokens,
        cacheWriteInputTokens: 300_000,
    })).toBeCloseTo(0.8412, 10);
    expect(estimateDeepSeekUsd("deepseek-flash", "2026-11-16T02:00:00Z", {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
    })).toBeCloseTo(0.006, 10);
    expect(estimateDeepSeekUsd("deepseek-flash", "2026-11-16T02:00:00Z", {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
    })).toBeCloseTo(0.30, 10);
});

test("retired Flash ids use Flash prices", () => {
    for (const model of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
        expect(estimateDeepSeekUsd(model, "2026-11-16T02:00:00Z", tokens)).toBeCloseTo(0.8412, 10);
    }
});

test("unknown models and invalid timestamps stay unpriced; zero tokens cost zero", () => {
    expect(estimateDeepSeekUsd("deepseek-chat", "2026-11-16T02:00:00Z", tokens)).toBeUndefined();
    expect(estimateDeepSeekUsd("deepseek-flash", "invalid", tokens)).toBeUndefined();
    expect(estimateDeepSeekUsd("deepseek-flash", "2026-11-16T02:00:00Z", {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
    })).toBe(0);
});
