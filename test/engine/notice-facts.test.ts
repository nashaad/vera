import { expect, test } from "bun:test";

import { isNoticeFacts } from "../../src/engine/notice-facts.ts";

test("notice facts accept finite numbers, booleans and short single-line strings", () => {
    expect(isNoticeFacts({ calls: 3, warm: true, model: "faux/test", ratio: 0.5 })).toBe(true);
    expect(isNoticeFacts({})).toBe(true);
    expect(isNoticeFacts({ text: "a".repeat(200) })).toBe(true);
});

test("notice facts reject non-object shapes", () => {
    expect(isNoticeFacts(null)).toBe(false);
    expect(isNoticeFacts(undefined)).toBe(false);
    expect(isNoticeFacts("calls")).toBe(false);
    expect(isNoticeFacts([1, 2])).toBe(false);
    expect(isNoticeFacts({ nested: { calls: 1 } })).toBe(false);
    expect(isNoticeFacts({ items: [1] })).toBe(false);
    expect(isNoticeFacts({ empty: null })).toBe(false);
});

test("notice facts reject non-finite numbers, long strings, and control characters", () => {
    expect(isNoticeFacts({ calls: Number.NaN })).toBe(false);
    expect(isNoticeFacts({ calls: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isNoticeFacts({ text: "a".repeat(201) })).toBe(false);
    expect(isNoticeFacts({ text: "first\nsecond" })).toBe(false);
    expect(isNoticeFacts({ text: "tab\there" })).toBe(false);
});

test("notice facts cap the entry count and the key shape", () => {
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`k${index}`, index]));
    const seventeen = { ...sixteen, k16: 16 };
    expect(isNoticeFacts(sixteen)).toBe(true);
    expect(isNoticeFacts(seventeen)).toBe(false);
    expect(isNoticeFacts({ Bad: 1 })).toBe(false);
    expect(isNoticeFacts({ "has-dash": 1 })).toBe(false);
    expect(isNoticeFacts({ "": 1 })).toBe(false);
    expect(isNoticeFacts({ ["k".repeat(65)]: 1 })).toBe(false);
});
