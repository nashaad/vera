import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { RenderContext } from "@opentui/core";

import type { TuiTextTranscriptEntry } from "./state.ts";
import { TUI_MUTED, tuiToolRowText } from "./state.ts";

const rowText = new WeakMap<BoxRenderable, TextRenderable>();

/**
 * Rewrites a row in place. A repeated call raises the count on the row already
 * on screen, and rebuilding the node instead would move it to the end of the
 * transcript.
 */
export function updateTuiToolRow(
    node: BoxRenderable,
    entry: TuiTextTranscriptEntry,
): void {
    const text = rowText.get(node);
    if (text !== undefined) {
        text.content = tuiToolRowText(entry);
    }
}

/**
 * One call under its group header. The gutter is its own column, so a row that
 * wraps, or a command that spans lines, hangs under itself rather than falling
 * back to the left edge of the transcript.
 */
export function createTuiToolRow(
    renderer: RenderContext,
    id: string,
    entry: TuiTextTranscriptEntry,
    marginTop: number,
): BoxRenderable {
    const row = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "row",
        marginTop,
    });
    row.add(new TextRenderable(renderer, {
        id: `${id}-gutter`,
        content: entry.prefix ?? "",
        fg: TUI_MUTED,
        flexShrink: 0,
        selectable: true,
    }));
    const text = new TextRenderable(renderer, {
        id: `${id}-text`,
        content: tuiToolRowText(entry),
        fg: TUI_MUTED,
        flexGrow: 1,
        wrapMode: "word",
        selectable: true,
    });
    row.add(text);
    rowText.set(row, text);
    return row;
}
