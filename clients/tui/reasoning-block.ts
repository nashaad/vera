import { BoxRenderable, fg, Renderable, RGBA, StyledText, TextRenderable } from "@opentui/core";
import type { CliRenderer, OptimizedBuffer } from "@opentui/core";

import { openedReasoningText, renderTuiEntry, TUI_MUTED, type TuiTranscriptEntry } from "./state.ts";
import { RAIL } from "./thinking-window.ts";

// The rail and one space; the opened text starts after them.
const RAIL_COLUMNS = 2;

interface ReasoningBlockParts {
    readonly header: TextRenderable;
    readonly opened: BoxRenderable;
    readonly body: TextRenderable;
}

const blockParts = new WeakMap<BoxRenderable, ReasoningBlockParts>();

// Draws one rail per wrapped row, so a long paragraph keeps its rail on every row.
class ReasoningRailRenderable extends Renderable {
    constructor(renderer: CliRenderer, id: string, private readonly body: TextRenderable) {
        super(renderer, { id, width: RAIL_COLUMNS, flexShrink: 0 });
    }

    protected override renderSelf(buffer: OptimizedBuffer): void {
        const color = RGBA.fromHex(TUI_MUTED);
        const rows = Math.max(1, Math.min(this.body.virtualLineCount, this.body.height));
        for (let row = 0; row < rows; row += 1) {
            buffer.drawText(RAIL, this.x, this.y + row, color);
        }
    }
}

export function createTuiReasoningBlock(
    renderer: CliRenderer,
    id: string,
    entry: TuiTranscriptEntry,
    marginTop: number,
): BoxRenderable {
    const block = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "column",
        marginTop,
    });
    const header = new TextRenderable(renderer, {
        id: `${id}-header`,
        width: "100%",
        wrapMode: "word",
        selectable: true,
    });
    const opened = new BoxRenderable(renderer, {
        id: `${id}-opened`,
        width: "100%",
        flexDirection: "row",
        marginTop: 1,
    });
    const body = new TextRenderable(renderer, {
        id: `${id}-body`,
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        wrapMode: "word",
        selectable: true,
    });
    opened.add(new ReasoningRailRenderable(renderer, `${id}-rail`, body));
    opened.add(body);
    block.add(header);
    block.add(opened);
    blockParts.set(block, { header, opened, body });
    updateTuiReasoningBlock(block, entry);
    return block;
}

export function updateTuiReasoningBlock(node: BoxRenderable, entry: TuiTranscriptEntry): void {
    const parts = blockParts.get(node);
    if (parts === undefined) return;
    parts.header.content = renderTuiEntry(entry);
    const text = openedReasoningText(entry);
    parts.opened.visible = text.length > 0;
    parts.body.content = new StyledText([fg(TUI_MUTED)(text)]);
}
