import { expect, test } from "bun:test";

import {
    TUI_TRANSCRIPT_EVICT_BUFFER,
    TUI_TRANSCRIPT_MATERIALIZE_BUFFER,
    tuiTranscriptEntriesEquivalent,
    tuiTranscriptEntryIsVisible,
    tuiTranscriptEntryStreams,
    tuiTranscriptEvictableRows,
    tuiTranscriptNeedsEarlierEntries,
    tuiTranscriptPrependRange,
    tuiTranscriptReusableTail,
    tuiTranscriptTailRange,
} from "../../clients/tui/transcript-window.ts";
import {
    appendTuiThought,
    applyAgentUpdate,
    createTuiState,
    LIVE_THINKING_ROWS,
    renderTuiEntry,
    type TuiState,
    type TuiTranscriptEntry,
} from "../../clients/tui/state.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

/**
 * An update as a caller writes it, before the sequence number the transport
 * stamps on. Distributive on purpose: `AgentUpdate` is a discriminated union,
 * and omitting a key across it as a whole would keep only the shared ones.
 */
type UnsequencedUpdate = AgentUpdate extends infer U
    ? U extends AgentUpdate ? Omit<U, "seq"> : never
    : never;

/**
 * What a working turn does to the height of the transcript it is being drawn
 * into. The view is pinned to the bottom while a turn runs, so a stretch that
 * grows and then gives the rows back moves everything above it by that much,
 * twice, every time it happens.
 */
function liveTranscriptRows(state: TuiState): number {
    return state.entries.filter(tuiTranscriptEntryIsVisible).reduce(
        (rows, entry: TuiTranscriptEntry) => {
            // A header draws its folded preview beside or beneath itself, so
            // the rendered form is what the viewport actually gets — the
            // stored text alone would miss a preview that took its own row.
            if (entry.kind === "thinking") return rows + LIVE_THINKING_ROWS;
            const drawn = renderTuiEntry(entry).chunks
                .map((chunk) => chunk.text)
                .join("");
            return rows + drawn.split("\n").length;
        },
        0,
    );
}

/** Replays a turn and reports the largest drop in height it caused. */
function worstMidTurnShrink(updates: readonly UnsequencedUpdate[]): number {
    let state = createTuiState();
    let previous = liveTranscriptRows(state);
    let worst = 0;
    let seq = 0;
    for (const update of updates) {
        state = applyAgentUpdate(state, {
            ...update,
            seq: (seq += 1),
        } as AgentUpdate);
        const rows = liveTranscriptRows(state);
        worst = Math.max(worst, previous - rows);
        previous = rows;
    }
    return worst;
}

test("a batch of tool calls never gives back the rows it took", () => {
    const updates: UnsequencedUpdate[] = [
        { type: "user_prompt", content: "go" },
    ];
    // Three fan-outs of six calls each: every batch used to appear as a row
    // per call and go behind its header together when the last one landed.
    for (let round = 0; round < 3; round += 1) {
        for (let call = 0; call < 6; call += 1) {
            updates.push({
                type: "tool_started",
                tool: "read",
                args: { path: `/work/r${round}-f${call}.ts` },
            });
        }
        for (let call = 0; call < 6; call += 1) {
            updates.push({
                type: "tool_finished",
                tool: "read",
                output: `contents of r${round}-f${call}`,
            });
        }
    }

    expect(worstMidTurnShrink(updates)).toBe(0);
});

test("reasoning that settles into its summary costs the view no height", () => {
    let state = createTuiState();
    let seq = 0;
    const apply = (update: UnsequencedUpdate) => {
        state = applyAgentUpdate(state, {
            ...update,
            seq: (seq += 1),
        } as AgentUpdate);
    };

    apply({ type: "user_prompt", content: "go" });
    let previous = liveTranscriptRows(state);
    let worst = 0;
    const measure = () => {
        const rows = liveTranscriptRows(state);
        worst = Math.max(worst, previous - rows);
        previous = rows;
    };

    // Reasoning, then a call, three times over. The live row used to grow to
    // its window and hand every row of it back the moment the phase ended.
    for (let round = 0; round < 3; round += 1) {
        for (let line = 0; line < 12; line += 1) {
            apply({
                type: "assistant_thinking",
                text: `reasoning ${round} line ${line}\n`,
            });
            measure();
        }
        // The turn loop ends the phase when the next call starts, which is
        // what replaces the live row with its one-row summary.
        state = appendTuiThought(state, 11.3);
        measure();
        apply({
            type: "tool_started",
            tool: "read",
            args: { path: `/work/f${round}.ts` },
        });
        measure();
        apply({
            type: "tool_finished",
            tool: "read",
            output: "line one\nline two\nline three",
        });
        measure();
    }

    // One row, and only because consecutive stretches deliberately report as
    // one summary above the calls they precede: the live row at the bottom
    // goes away into a row that already exists further up. That is a single
    // row settling, not a window of them being handed back.
    expect(worst).toBeLessThanOrEqual(1);
});

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

test("only the last assistant of a working turn streams", () => {
    const entries: TuiTranscriptEntry[] = [
        { kind: "user", text: "ask" },
        { kind: "assistant", text: "first" },
        { kind: "assistant", text: "live" },
    ];
    expect(tuiTranscriptEntryStreams(entries, 1, true)).toBe(false);
    expect(tuiTranscriptEntryStreams(entries, 2, true)).toBe(true);
    expect(tuiTranscriptEntryStreams(entries, 2, false)).toBe(false);
    expect(tuiTranscriptEntryStreams(entries, 0, true)).toBe(false);
});

test("a delivered history keeps the finished answer and drops the live row", () => {
    const previous: TuiTranscriptEntry[] = [
        { kind: "user", text: "ask" },
        { kind: "thinking", text: "weighing it" },
        { kind: "assistant", text: "here is the answer" },
    ];
    const next: TuiTranscriptEntry[] = [
        { kind: "user", text: "ask", entryId: "u1" },
        { kind: "thought", text: "Reasoning: 1.2s", seconds: 1.2 },
        { kind: "assistant", text: "here is the answer", entryId: "a1" },
    ];
    expect(tuiTranscriptEntriesEquivalent(previous[2], next[2])).toBe(true);
    expect(tuiTranscriptReusableTail({
        previous,
        next,
        previousStart: 0,
        previousEnd: 3,
    })).toBe(1);
});

test("a rebuilt prompt still matches the echo the composer already showed", () => {
    expect(tuiTranscriptEntriesEquivalent(
        { kind: "user", text: "hello there" },
        { kind: "user", text: "hello there", entryId: "stored" },
    )).toBe(true);
    expect(tuiTranscriptReusableTail({
        previous: [
            { kind: "user", text: "hello there" },
            { kind: "assistant", text: "hi" },
        ],
        next: [
            { kind: "user", text: "hello there", entryId: "stored" },
            { kind: "assistant", text: "hi", entryId: "a1" },
        ],
        previousStart: 0,
        previousEnd: 2,
    })).toBe(2);
});
