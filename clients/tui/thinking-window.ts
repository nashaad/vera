import { BoxRenderable, fg, Renderable, RGBA, StyledText, TextRenderable } from "@opentui/core";
import type { CliRenderer, OptimizedBuffer } from "@opentui/core";

import { tuiBrailleSpinner } from "./activity-pulse.ts";
import type { TuiTextTranscriptEntry } from "./state.ts";
import type { TuiLiveReasoningRows } from "./theme-preference.ts";
import {
    LIVE_THINKING_ELLIPSIS,
    plainReasoningSummary,
    TUI_MUTED,
} from "./state.ts";

// Enough text to fill the widest pane at the most rows; older text is cut first.
const TAIL_CHARACTERS = 4_000;
export const ELLIPSIS_COLUMNS = LIVE_THINKING_ELLIPSIS.length + 1;
const RAIL = "│";

interface ThinkingWindowParts {
    readonly gutter: ThinkingGutterRenderable;
    readonly body: TailTextRenderable;
}

const windowParts = new WeakMap<BoxRenderable, ThinkingWindowParts>();

// Draws the last rows of its wrapped text instead of the first.
class TailTextRenderable extends TextRenderable {
    protected override renderSelf(
        buffer: Parameters<TextRenderable["renderSelf"]>[0],
    ): void {
        const bottom = this.maxScrollY;
        if (this._scrollY !== bottom) {
            this._scrollY = bottom;
            this.updateViewportOffset();
        }
        super.renderSelf(buffer);
    }
}

// One rail per shown row, with the mark on the newest; wrapped rows count as rows.
class ThinkingGutterRenderable extends Renderable {
    mark = LIVE_THINKING_ELLIPSIS;

    constructor(renderer: CliRenderer, id: string, private readonly body: TailTextRenderable) {
        super(renderer, { id, width: ELLIPSIS_COLUMNS, flexShrink: 0 });
    }

    protected override renderSelf(buffer: OptimizedBuffer): void {
        const color = RGBA.fromHex(TUI_MUTED);
        const rows = this.body.visible
            ? Math.max(1, Math.min(this.body.virtualLineCount, this.body.height))
            : 1;
        for (let row = 0; row < rows - 1; row++) {
            buffer.drawText(RAIL, this.x, this.y + row, color);
        }
        buffer.drawText(this.mark, this.x, this.y + rows - 1, color);
    }
}

export function liveReasoningHeight(rows: Exclude<TuiLiveReasoningRows, "all">): number {
    return Math.max(1, rows);
}

export function createTuiThinkingWindow(
    renderer: CliRenderer,
    id: string,
    entry: TuiTextTranscriptEntry,
    marginTop: number,
    rows: TuiLiveReasoningRows,
): BoxRenderable {
    const box = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "row",
        marginTop,
    });
    const body = new TailTextRenderable(renderer, {
        id: `${id}-body`,
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        wrapMode: "word",
        overflow: "hidden",
        selectable: true,
    });
    const gutter = new ThinkingGutterRenderable(renderer, `${id}-gutter`, body);
    box.add(gutter);
    box.add(body);
    windowParts.set(box, { gutter, body });
    updateTuiThinkingWindow(box, entry, rows);
    return box;
}

export function updateTuiThinkingWindow(
    node: BoxRenderable,
    entry: TuiTextTranscriptEntry,
    rows: TuiLiveReasoningRows,
): void {
    const parts = windowParts.get(node);
    if (parts === undefined) return;
    const height = rows === "all" ? "auto" : liveReasoningHeight(rows);
    node.height = height;
    parts.body.height = height;
    parts.body.visible = rows !== 0;
    parts.body.content = rows === 0
        ? ""
        : new StyledText([fg(TUI_MUTED)(liveReasoningText(entry.text, rows === "all"))]);
}

// The mark is padded to the ellipsis width so the reasoning text never shifts.
export function animateTuiThinkingWindow(node: BoxRenderable, frame: number): void {
    const parts = windowParts.get(node);
    if (parts === undefined) return;
    parts.gutter.mark = tuiBrailleSpinner(frame).padEnd(LIVE_THINKING_ELLIPSIS.length);
    parts.gutter.requestRender();
}

export function liveReasoningText(text: string, whole: boolean): string {
    return plainReasoningSummary(whole ? text : text.slice(-TAIL_CHARACTERS))
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .join("\n");
}
