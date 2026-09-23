import { BoxRenderable, fg, StyledText, TextRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

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

interface ThinkingWindowParts {
    readonly ellipsis: TextRenderable;
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
    const ellipsis = new TextRenderable(renderer, {
        id: `${id}-ellipsis`,
        width: ELLIPSIS_COLUMNS,
        flexShrink: 0,
        content: new StyledText([fg(TUI_MUTED)(LIVE_THINKING_ELLIPSIS)]),
        selectable: false,
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
    box.add(ellipsis);
    box.add(body);
    windowParts.set(box, { ellipsis, body });
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
    const mark = tuiBrailleSpinner(frame).padEnd(LIVE_THINKING_ELLIPSIS.length);
    parts.ellipsis.content = new StyledText([fg(TUI_MUTED)(mark)]);
}

export function liveReasoningText(text: string, whole: boolean): string {
    return plainReasoningSummary(whole ? text : text.slice(-TAIL_CHARACTERS))
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .join("\n");
}
