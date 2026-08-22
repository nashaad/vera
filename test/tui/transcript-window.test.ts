import { expect, test } from "bun:test";

import {
    TUI_TRANSCRIPT_EVICT_BUFFER,
    TUI_TRANSCRIPT_MATERIALIZE_BUFFER,
    tuiTranscriptEntryIsVisible,
    tuiTranscriptEvictableRows,
    tuiTranscriptNeedsEarlierEntries,
    tuiTranscriptPrependRange,
    tuiTranscriptTailRange,
} from "../../clients/tui/transcript-window.ts";

test("the initial range keeps only the transcript tail", () => {
    expect(tuiTranscriptTailRange(12, 48)).toEqual({ start: 0, end: 12 });
    expect(tuiTranscriptTailRange(80, 48)).toEqual({ start: 32, end: 80 });
});

test("materialization takes a bounded batch from the earlier edge", () => {
    expect(tuiTranscriptPrependRange(80, 24)).toEqual({ start: 56, end: 80 });
    expect(tuiTranscriptPrependRange(10, 24)).toEqual({ start: 0, end: 10 });
});

test("the earlier window is requested at the top or near its spacer edge", () => {
    expect(tuiTranscriptNeedsEarlierEntries({
        materializedStart: 10,
        scrollTop: 0,
        viewportHeight: 20,
        spacerTop: 1,
        spacerHeight: 500,
    })).toBe(true);
    expect(tuiTranscriptNeedsEarlierEntries({
        materializedStart: 10,
        scrollTop: 450,
        viewportHeight: 20,
        spacerTop: 1,
        spacerHeight: 500,
    })).toBe(true);
    expect(tuiTranscriptNeedsEarlierEntries({
        materializedStart: 10,
        scrollTop: 100,
        viewportHeight: 20,
        spacerTop: 1,
        spacerHeight: 500,
    })).toBe(false);
    expect(tuiTranscriptNeedsEarlierEntries({
        materializedStart: 10,
        scrollTop: 600,
        viewportHeight: 20,
        spacerTop: 1,
        spacerHeight: 500,
    })).toBe(false);
    expect(tuiTranscriptNeedsEarlierEntries({
        materializedStart: 0,
        scrollTop: 0,
        viewportHeight: 20,
        spacerTop: 1,
        spacerHeight: 500,
    })).toBe(false);
});

test("nothing is released while the window sits within the buffer", () => {
    expect(tuiTranscriptEvictableRows({
        scrollTop: 100,
        viewportHeight: 20,
        spacerHeight: 0,
    })).toBe(0);
    expect(tuiTranscriptEvictableRows({
        scrollTop: 1000,
        viewportHeight: 20,
        spacerHeight: 950,
    })).toBe(0);
});

test("rows past the buffer are released, and the spacer does not count", () => {
    // 400 rows above the viewport, 6 viewports of 20 rows kept.
    expect(tuiTranscriptEvictableRows({
        scrollTop: 400,
        viewportHeight: 20,
        spacerHeight: 0,
    })).toBe(280);
    expect(tuiTranscriptEvictableRows({
        scrollTop: 700,
        viewportHeight: 20,
        spacerHeight: 300,
    })).toBe(280);
});

test("the release buffer clears the materialize buffer by a wide margin", () => {
    expect(TUI_TRANSCRIPT_EVICT_BUFFER)
        .toBeGreaterThan(TUI_TRANSCRIPT_MATERIALIZE_BUFFER * 2);
});

test("a folded tool row occupies nothing for a spacer to stand in for", () => {
    expect(tuiTranscriptEntryIsVisible({
        kind: "tool",
        text: "read /work/file.ts",
        hidden: true,
    })).toBe(false);
    expect(tuiTranscriptEntryIsVisible({
        kind: "tool",
        text: "read /work/file.ts",
    })).toBe(true);
    expect(tuiTranscriptEntryIsVisible({ kind: "user", text: "hello" }))
        .toBe(true);
    expect(tuiTranscriptEntryIsVisible(undefined)).toBe(false);
});
