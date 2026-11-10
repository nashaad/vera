import { expect, test } from "bun:test";
import {
    CacheMissSessions,
    CacheMissTracker,
    DEFAULT_CACHE_WARNING,
    cacheWarningSettings,
    type CacheWarningSettings,
    type CallUsage,
} from "../../extensions/cache/cache-misses.ts";

const SETTINGS: CacheWarningSettings = { windowCalls: 20, minShare: 0.25, minTokens: 250_000 };
const SECOND = 1_000;
const START = 1_000_000;

function call(overrides: Partial<CallUsage>): CallUsage {
    return { provider: "deepseek", model: "deepseek-flash", inputTokens: 150_000, cachedInputTokens: 105_000, at: START, ...overrides };
}

test("settings default when config is missing and parse each key", () => {
    expect(cacheWarningSettings(null)).toEqual(DEFAULT_CACHE_WARNING);
    expect(cacheWarningSettings({})).toEqual({ windowCalls: 20, minShare: 0.25, minTokens: 250_000 });
    expect(cacheWarningSettings({ window_calls: 5, min_share: 0.5, min_tokens: 10 })).toEqual({ windowCalls: 5, minShare: 0.5, minTokens: 10 });
    expect(cacheWarningSettings({ min_share: 0 })).toEqual({ ...DEFAULT_CACHE_WARNING, minShare: 0 });
});

test("settings reject bad values by naming the key", () => {
    expect(() => cacheWarningSettings({ window_calls: -1 })).toThrow("window_calls must be a whole number, 0 or more");
    expect(() => cacheWarningSettings({ window_calls: 1.5 })).toThrow("window_calls must be a whole number, 0 or more");
    expect(() => cacheWarningSettings({ window_calls: "20" })).toThrow("window_calls must be a whole number, 0 or more");
    expect(() => cacheWarningSettings({ min_tokens: -1 })).toThrow("min_tokens must be a whole number, 0 or more");
    expect(() => cacheWarningSettings({ min_tokens: 2.5 })).toThrow("min_tokens must be a whole number, 0 or more");
    expect(() => cacheWarningSettings({ min_share: 1.5 })).toThrow("min_share must be a number from 0 to 1");
    expect(() => cacheWarningSettings({ min_share: -0.1 })).toThrow("min_share must be a number from 0 to 1");
    expect(() => cacheWarningSettings({ min_share: "0.2" })).toThrow("min_share must be a number from 0 to 1");
});

test("settings reject a config that is not an object", () => {
    expect(() => cacheWarningSettings("x")).toThrow("vera.cache config must be an object");
    expect(() => cacheWarningSettings([1])).toThrow("vera.cache config must be an object");
});

test("a healthy run that re-reads about 5% of a growing prefix never warns", () => {
    const tracker = new CacheMissTracker(SETTINGS);
    let previous = 150_000;
    for (let index = 0; index < 100; index++) {
        const input = 150_000 + 1_000 * index;
        const cached = index === 0 ? 100_000 : previous - Math.round(previous * 0.05);
        expect(tracker.observe(call({ inputTokens: input, cachedInputTokens: cached, at: START + index * SECOND }))).toBeUndefined();
        previous = input;
    }
});

test("@core a broken run warns once, on the call that fills the window", () => {
    const tracker = new CacheMissTracker(SETTINGS);
    const warnings: { index: number; value: unknown }[] = [];
    for (let index = 0; index < 40; index++) {
        const warning = tracker.observe(call({ at: START + index * SECOND }));
        if (warning !== undefined) warnings.push({ index, value: warning });
    }
    expect(warnings).toEqual([{ index: 20, value: {
        calls: 20,
        rereadTokens: 900_000,
        inputTokens: 3_000_000,
        provider: "deepseek",
        model: "deepseek-flash",
    } }]);
});

test("a drop below 70% of the previous input is not counted", () => {
    const tracker = new CacheMissTracker({ windowCalls: 2, minShare: 0.25, minTokens: 1 });
    expect(tracker.observe(call({ at: START }))).toBeUndefined();
    expect(tracker.observe(call({ at: START + SECOND }))).toBeUndefined();
    // Not counted: the window stays at one call, though this one alone would have warned.
    expect(tracker.observe(call({ inputTokens: 100_000, cachedInputTokens: 0, at: START + 2 * SECOND }))).toBeUndefined();
    expect(tracker.observe(call({ inputTokens: 100_000, cachedInputTokens: 0, at: START + 3 * SECOND })))
        .toMatchObject({ calls: 2, rereadTokens: 145_000, inputTokens: 250_000 });
});

test("a call more than 5 minutes after the previous one is not counted", () => {
    const tracker = new CacheMissTracker({ windowCalls: 2, minShare: 0.25, minTokens: 1 });
    expect(tracker.observe(call({ at: START }))).toBeUndefined();
    expect(tracker.observe(call({ at: START + SECOND }))).toBeUndefined();
    // Not counted: six minutes later, so this one alone would have warned.
    expect(tracker.observe(call({ cachedInputTokens: 0, at: START + SECOND + 6 * 60 * SECOND }))).toBeUndefined();
    expect(tracker.observe(call({ cachedInputTokens: 0, at: START + SECOND + 6 * 60 * SECOND + SECOND })))
        .toMatchObject({ calls: 2 });
});

test("a provider that never reports cached tokens never warns", () => {
    const tracker = new CacheMissTracker(SETTINGS);
    for (let index = 0; index < 50; index++) {
        expect(tracker.observe(call({ cachedInputTokens: 0, at: START + index * SECOND }))).toBeUndefined();
    }
});

test("a model change clears the window", () => {
    const tracker = new CacheMissTracker({ windowCalls: 3, minShare: 0.25, minTokens: 1 });
    const at = (index: number) => START + index * SECOND;
    expect(tracker.observe(call({ at: at(0) }))).toBeUndefined();
    expect(tracker.observe(call({ at: at(1) }))).toBeUndefined();
    expect(tracker.observe(call({ at: at(2) }))).toBeUndefined();
    // Model change: this call is not counted, and the next two B calls start a fresh window.
    expect(tracker.observe(call({ model: "other-model", at: at(3) }))).toBeUndefined();
    expect(tracker.observe(call({ model: "other-model", at: at(4) }))).toBeUndefined();
    expect(tracker.observe(call({ model: "other-model", at: at(5) }))).toBeUndefined();
    expect(tracker.observe(call({ model: "other-model", at: at(6) }))).toMatchObject({ calls: 3, model: "other-model" });
});

test("any setting at 0 turns the warning off", () => {
    const off: CacheWarningSettings[] = [
        { ...SETTINGS, windowCalls: 0 },
        { ...SETTINGS, minShare: 0 },
        { ...SETTINGS, minTokens: 0 },
    ];
    for (const settings of off) {
        const tracker = new CacheMissTracker(settings);
        for (let index = 0; index < 40; index++) {
            expect(tracker.observe(call({ at: START + index * SECOND }))).toBeUndefined();
        }
    }
});

test("sessions evict the least recently used tracker past capacity", () => {
    const sessions = new CacheMissSessions(SETTINGS, 2);
    const a = sessions.tracker("a");
    const b = sessions.tracker("b");
    expect(sessions.tracker("a")).toBe(a);
    const c = sessions.tracker("c");
    expect(sessions.tracker("a")).toBe(a);
    expect(sessions.tracker("c")).toBe(c);
    expect(sessions.tracker("b")).not.toBe(b);
});
