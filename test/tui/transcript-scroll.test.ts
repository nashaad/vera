import { expect, test } from "bun:test";
import { tuiTranscriptAtBottom } from "../../clients/tui/transcript-scroll.ts";

test("the transcript treats the last visible row as the bottom", () => {
    expect(tuiTranscriptAtBottom(49, 100, 50)).toBe(true);
    expect(tuiTranscriptAtBottom(48, 100, 50)).toBe(false);
});

test("a transcript shorter than its viewport is already at the bottom", () => {
    expect(tuiTranscriptAtBottom(0, 20, 50)).toBe(true);
});
