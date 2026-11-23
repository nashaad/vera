import { expect, test } from "bun:test";

import { mergeNewChatPrefill } from "../../clients/ui/src/composer/newChatPrefill.ts";

test("an empty composer takes the prefill alone", () => {
    expect(mergeNewChatPrefill("", "/vera-help")).toBe("/vera-help");
});

test("a whitespace-only composer counts as empty", () => {
    expect(mergeNewChatPrefill("  \n", "/vera-help")).toBe("/vera-help");
});

test("a typed draft stays after the prefilled command", () => {
    expect(mergeNewChatPrefill("summarize this folder", "/deploy")).toBe("/deploy summarize this folder");
});

test("the draft keeps its own whitespace and line breaks", () => {
    expect(mergeNewChatPrefill(" first\nsecond ", "/plan")).toBe("/plan  first\nsecond ");
});
