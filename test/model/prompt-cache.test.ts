import { expect, test } from "bun:test";

import {
    cacheRetention,
    PROMPT_CACHE_KEY_MAX_LENGTH,
    promptCacheKey,
} from "../../src/model/prompt-cache.ts";

test("retention defaults to short", () => {
    expect(cacheRetention({})).toBe("short");
    expect(cacheRetention({ cacheRetention: "long" })).toBe("long");
});

test("a short key passes through unchanged", () => {
    expect(promptCacheKey({ cacheKey: "crow-session-1" })).toBe("crow-session-1");
});

test("a long key is clamped to the limit in code points", () => {
    const key = promptCacheKey({ cacheKey: "c".repeat(100) });
    expect(key).toBe("c".repeat(PROMPT_CACHE_KEY_MAX_LENGTH));
});

test("the clamp never splits a surrogate pair", () => {
    const key = promptCacheKey({ cacheKey: "a" + "🏴‍☠️🐦‍⬛".repeat(40) })!;
    expect(Array.from(key)).toHaveLength(PROMPT_CACHE_KEY_MAX_LENGTH);
    expect(key).toBe(Array.from(key).join(""));
    expect(/[\uD800-\uDBFF]$/.test(key)).toBe(false);
});

test("no retention or no key means no key is sent", () => {
    expect(promptCacheKey({})).toBeUndefined();
    expect(promptCacheKey({ cacheKey: "" })).toBeUndefined();
    expect(promptCacheKey({ cacheKey: "crow", cacheRetention: "none" })).toBeUndefined();
    expect(promptCacheKey({ cacheKey: "crow", cacheRetention: "long" })).toBe("crow");
});
