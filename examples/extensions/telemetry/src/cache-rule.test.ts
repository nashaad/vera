import { describe, expect, test } from "bun:test";

import {
    CacheMissSessions,
    CacheMissRule,
    CONTINUITY_MS,
    DEFAULT_CACHE_MISS,
    type CallUsage,
} from "./cache-rule.ts";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

function call(overrides: Partial<CallUsage> = {}): CallUsage {
    return {
        provider: "rookery",
        model: "crow-test",
        inputTokens: 20_000,
        cachedInputTokens: 1_500,
        at: T0 + 30_000,
        ...overrides,
    };
}

/** A first call that teaches the rule the provider reports cached tokens. */
function seeded(rule: CacheMissRule, first: Partial<CallUsage> = {}): CacheMissRule {
    rule.observe(call({ at: T0, cachedInputTokens: 18_000, ...first }));
    return rule;
}

describe("CacheMissRule", () => {
    test("fires when a call re-reads the previous prompt from the cache", () => {
        const rule = seeded(new CacheMissRule(DEFAULT_CACHE_MISS));
        expect(rule.observe(call())).toEqual({
            previous_input_tokens: 20_000,
            previous_cached_input_tokens: 18_000,
            reread_tokens: 18_500,
            gap_ms: 30_000,
        });
    });

    test("stays quiet when more than five minutes passed", () => {
        const rule = seeded(new CacheMissRule(DEFAULT_CACHE_MISS));
        expect(rule.observe(call({ at: T0 + CONTINUITY_MS + 1 }))).toBeUndefined();
    });

    test("stays quiet at exactly the continuity horizon", () => {
        const rule = seeded(new CacheMissRule(DEFAULT_CACHE_MISS));
        expect(rule.observe(call({ at: T0 + CONTINUITY_MS }))).toBeUndefined();
    });

    test("stays quiet when compaction cut the input", () => {
        const rule = seeded(new CacheMissRule(DEFAULT_CACHE_MISS));
        expect(rule.observe(call({ inputTokens: 10_000, cachedInputTokens: 200 }))).toBeUndefined();
    });

    test("stays quiet while the provider has never reported a cached token", () => {
        const rule = new CacheMissRule(DEFAULT_CACHE_MISS);
        rule.observe(call({ at: T0, cachedInputTokens: 0 }));
        expect(rule.observe(call({ cachedInputTokens: 0 }))).toBeUndefined();
    });

    test("counts the call that first reports cache, then keeps the provider", () => {
        const rule = new CacheMissRule(DEFAULT_CACHE_MISS);
        rule.observe(call({ at: T0, cachedInputTokens: 0 }));
        expect(rule.observe(call({ cachedInputTokens: 18_000 }))).toBeUndefined();
        expect(rule.observe(call({ at: T0 + 60_000, cachedInputTokens: 0 }))).toBeDefined();
    });

    test("stays quiet on a small prompt even when every input token was re-read", () => {
        const rule = new CacheMissRule(DEFAULT_CACHE_MISS);
        rule.observe(call({ at: T0, inputTokens: 3_000, cachedInputTokens: 200 }));
        expect(rule.observe(call({ inputTokens: 3_000, cachedInputTokens: 50 }))).toBeUndefined();
    });

    test("stays quiet when the re-read share is too small", () => {
        const rule = seeded(new CacheMissRule(DEFAULT_CACHE_MISS), { cachedInputTokens: 15_000 });
        // 9,000 tokens is over the floor but under half of a 20,000-token prompt.
        expect(rule.observe(call({ cachedInputTokens: 11_000 }))).toBeUndefined();
    });

    test("compares only the same provider and model", () => {
        const rule = seeded(new CacheMissRule(DEFAULT_CACHE_MISS));
        expect(rule.observe(call({ model: "another" }))).toBeUndefined();
        const second = seeded(new CacheMissRule(DEFAULT_CACHE_MISS));
        expect(second.observe(call({ provider: "gullery" }))).toBeUndefined();
    });

    test("applies per call, not once per conversation", () => {
        const rule = seeded(new CacheMissRule(DEFAULT_CACHE_MISS));
        expect(rule.observe(call())).toBeDefined();
        expect(rule.observe(call({ at: T0 + 60_000 }))).toBeDefined();
    });

    test("a call without input does not replace the call before it", () => {
        const rule = seeded(new CacheMissRule(DEFAULT_CACHE_MISS));
        expect(rule.observe(call({ inputTokens: 0, cachedInputTokens: 0, at: T0 + 10_000 }))).toBeUndefined();
        expect(rule.observe(call({ at: T0 + 40_000 }))?.gap_ms).toBe(40_000);
    });

    test("honours custom thresholds", () => {
        const rule = seeded(new CacheMissRule({ min_reread_tokens: 30_000, min_share: 0.9 }));
        expect(rule.observe(call())).toBeUndefined();
    });
});

describe("CacheMissSessions", () => {
    test("keeps one rule per session", () => {
        const sessions = new CacheMissSessions(DEFAULT_CACHE_MISS);
        expect(sessions.rule("a").observe(call({ at: T0, cachedInputTokens: 18_000 }))).toBeUndefined();
        expect(sessions.rule("b").observe(call())).toBeUndefined();
        expect(sessions.rule("a").observe(call())).toBeDefined();
    });

    test("evicts the least recently used session", () => {
        const sessions = new CacheMissSessions(DEFAULT_CACHE_MISS, 1);
        sessions.rule("a").observe(call({ at: T0, cachedInputTokens: 18_000 }));
        sessions.rule("b").observe(call({ at: T0, cachedInputTokens: 18_000 }));
        expect(sessions.rule("a").observe(call())).toBeUndefined();
    });
});
