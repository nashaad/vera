import { expect, test } from "bun:test";

import {
    isTranscriptSelection,
    selectionSpeaker,
    type SelectionEntryNode,
    type SelectionTreeNode,
    type TranscriptSelection,
} from "../../clients/tui/selection.ts";

const entry: SelectionEntryNode = {
    parent: null,
    x: 2,
    y: 3,
    width: 20,
    height: 2,
};

const markdownChild: SelectionTreeNode = { parent: entry };

test("TUI selection accepts selectable children inside one transcript entry", () => {
    const selection: TranscriptSelection = {
        anchor: { x: 3, y: 3 },
        focus: { x: 12, y: 4 },
        selectedRenderables: [markdownChild],
    };

    expect(isTranscriptSelection(selection, [entry])).toBe(true);
});

test("TUI selection accepts a drag ending just outside transcript entries", () => {
    const selection: TranscriptSelection = {
        anchor: { x: 3, y: 3 },
        focus: { x: 12, y: 7 },
        selectedRenderables: [markdownChild],
    };

    expect(isTranscriptSelection(selection, [entry])).toBe(true);
});

test("TUI selection rejects selected text from outside transcript entries", () => {
    const composerNode: SelectionTreeNode = { parent: null };
    const selection: TranscriptSelection = {
        anchor: { x: 3, y: 3 },
        focus: { x: 12, y: 4 },
        selectedRenderables: [markdownChild, composerNode],
    };

    expect(isTranscriptSelection(selection, [entry])).toBe(false);
});

const seatBlock: SelectionTreeNode = { parent: null };
const seatChild: SelectionTreeNode = { parent: seatBlock };

const sources = [
    { node: entry as SelectionTreeNode, speaker: "agent" },
    { node: seatBlock, speaker: "frosty" },
];

test("a selection is attributed to the block it sits inside", () => {
    expect(selectionSpeaker({
        anchor: { x: 0, y: 0 },
        focus: { x: 4, y: 0 },
        selectedRenderables: [seatChild],
    }, sources)).toBe("frosty");
});

test("a selection spanning two speakers is attributed to neither", () => {
    expect(selectionSpeaker({
        anchor: { x: 0, y: 0 },
        focus: { x: 4, y: 9 },
        selectedRenderables: [seatChild, markdownChild],
    }, sources)).toBeUndefined();
});

test("a selection outside every block has no speaker", () => {
    expect(selectionSpeaker({
        anchor: { x: 0, y: 0 },
        focus: { x: 4, y: 0 },
        selectedRenderables: [{ parent: null }],
    }, sources)).toBeUndefined();
});

test("an empty selection has no speaker", () => {
    expect(selectionSpeaker({
        anchor: { x: 0, y: 0 },
        focus: { x: 0, y: 0 },
        selectedRenderables: [],
    }, sources)).toBeUndefined();
});
