export const TUI_TRANSCRIPT_INITIAL_WINDOW = 48;
export const TUI_TRANSCRIPT_MATERIALIZE_BATCH = 24;
export const TUI_TRANSCRIPT_MATERIALIZE_BUFFER = 2;

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
