import type { TuiTranscriptEntry } from "./state.ts";

export const TUI_TRANSCRIPT_INITIAL_WINDOW = 48;
export const TUI_TRANSCRIPT_MATERIALIZE_BATCH = 24;
export const TUI_TRANSCRIPT_MATERIALIZE_BUFFER = 2;
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

export function tuiTranscriptEntryIsVisible(
    entry: TuiTranscriptEntry | undefined,
): boolean {
    if (entry === undefined) return false;
    return entry.kind !== "tool" || entry.hidden !== true;
}

/** Whether this row is the answer still arriving. OpenTUI leaves the trailing markdown block unstable while `streaming` is on. */
export function tuiTranscriptEntryStreams(
    entries: readonly TuiTranscriptEntry[],
    index: number,
    working: boolean,
): boolean {
    if (!working) return false;
    if (entries[index]?.kind !== "assistant") return false;
    for (let later = index + 1; later < entries.length; later += 1) {
        if (entries[later]?.kind === "assistant") return false;
    }
    return true;
}

export function tuiTranscriptEntriesEquivalent(
    left: TuiTranscriptEntry | undefined,
    right: TuiTranscriptEntry | undefined,
): boolean {
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    if (left.kind !== right.kind) return false;
    if (left.kind === "diff" && right.kind === "diff") {
        return left.path === right.path
            && left.patch === right.patch
            && left.text === right.text;
    }
    if (left.kind === "diff" || right.kind === "diff") return false;
    return left.text === right.text
        && left.tool === right.tool
        && left.header === right.header
        && left.command === right.command
        && left.seconds === right.seconds
        && left.reasoning === right.reasoning
        && left.hidden === right.hidden
        && left.active === right.active
        && left.result === right.result
        && left.repeat === right.repeat
        && left.prefix === right.prefix;
}

export function tuiTranscriptReusableTail(input: {
    readonly previous: readonly (TuiTranscriptEntry | undefined)[];
    readonly next: readonly TuiTranscriptEntry[];
    readonly previousStart: number;
    readonly previousEnd: number;
}): number {
    const previousCount = Math.max(0, input.previousEnd - input.previousStart);
    const reusable = Math.min(previousCount, input.next.length);
    let kept = 0;
    while (kept < reusable) {
        const previous = input.previous[input.previousEnd - 1 - kept];
        const next = input.next[input.next.length - 1 - kept];
        if (!tuiTranscriptEntriesEquivalent(previous, next)) break;
        kept += 1;
    }
    return kept;
}
