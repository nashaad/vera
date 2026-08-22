import type { TuiTranscriptEntry } from "./state.ts";

export const TUI_TRANSCRIPT_INITIAL_WINDOW = 48;
export const TUI_TRANSCRIPT_MATERIALIZE_BATCH = 24;
export const TUI_TRANSCRIPT_MATERIALIZE_BUFFER = 2;
/**
 * Materialized rows kept above the viewport before any are released, in
 * viewports. It has to stay clear of `TUI_TRANSCRIPT_MATERIALIZE_BUFFER` by
 * more than a batch is tall, or the row the reader just crossed would be
 * released and rebuilt on alternate frames.
 */
export const TUI_TRANSCRIPT_EVICT_BUFFER = 6;

export interface TuiTranscriptRange {
    readonly start: number;
    readonly end: number;
}

export function tuiTranscriptTailRange(
    entryCount: number,
    windowSize = TUI_TRANSCRIPT_INITIAL_WINDOW,
): TuiTranscriptRange {
    const end = Math.max(0, entryCount);
    return {
        start: Math.max(0, end - Math.max(1, windowSize)),
        end,
    };
}

export function tuiTranscriptPrependRange(
    materializedStart: number,
    batchSize = TUI_TRANSCRIPT_MATERIALIZE_BATCH,
): TuiTranscriptRange {
    const end = Math.max(0, materializedStart);
    return {
        start: Math.max(0, end - Math.max(1, batchSize)),
        end,
    };
}

/**
 * How many materialized rows above the viewport may be released.
 *
 * The spacer stands for every entry before the window, so the materialized
 * rows above the viewport are what is left of `scrollTop` once the spacer is
 * taken off. Everything within the buffer stays.
 */
export function tuiTranscriptEvictableRows(input: {
    readonly scrollTop: number;
    readonly viewportHeight: number;
    readonly spacerHeight: number;
    readonly bufferViewports?: number;
}): number {
    const buffer = Math.max(1, input.viewportHeight)
        * Math.max(0, input.bufferViewports ?? TUI_TRANSCRIPT_EVICT_BUFFER);
    return Math.max(
        0,
        input.scrollTop - Math.max(0, input.spacerHeight) - buffer,
    );
}

export function tuiTranscriptNeedsEarlierEntries(input: {
    readonly materializedStart: number;
    readonly scrollTop: number;
    readonly viewportHeight: number;
    readonly spacerTop: number;
    readonly spacerHeight: number;
    readonly bufferViewports?: number;
}): boolean {
    if (input.materializedStart <= 0 || input.spacerHeight <= 0) {
        return false;
    }

    if (input.scrollTop <= 0) {
        return true;
    }

    const buffer = Math.max(1, input.viewportHeight)
        * Math.max(0, input.bufferViewports ?? TUI_TRANSCRIPT_MATERIALIZE_BUFFER);
    const materializedEdge = input.spacerTop + input.spacerHeight;
    if (input.scrollTop <= input.spacerTop + 1) {
        return true;
    }
    return input.scrollTop <= materializedEdge
        && input.scrollTop + Math.max(1, input.viewportHeight) + buffer
            >= materializedEdge;
}

/**
 * Whether an entry is laid out at all.
 *
 * A completed tool row folded behind its group header draws nothing, so it
 * occupies no rows for a spacer to stand in for.
 */
export function tuiTranscriptEntryIsVisible(
    entry: TuiTranscriptEntry | undefined,
): boolean {
    if (entry === undefined) return false;
    return entry.kind !== "tool" || entry.hidden !== true;
}
