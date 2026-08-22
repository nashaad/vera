import { expect, test } from "bun:test";

import {
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
