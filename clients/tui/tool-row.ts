import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { RenderContext } from "@opentui/core";

import type { TuiTextTranscriptEntry } from "./state.ts";
import { TUI_MUTED, tuiToolRowText } from "./state.ts";

const rowText = new WeakMap<BoxRenderable, TextRenderable>();
const rowGutter = new WeakMap<
    BoxRenderable,
    { box: BoxRenderable; marker: TextRenderable }
>();
const CONNECTOR_BORDER = {
    topLeft: "│",
    topRight: "",
    bottomLeft: "│",
    bottomRight: "",
    horizontal: "",
    vertical: "│",
    topT: "",
    bottomT: "",
    leftT: "",
    rightT: "",
    cross: "",
};

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
    const gutter = rowGutter.get(node);
    if (gutter !== undefined) {
        const connected = entry.prefix === "  │ ";
        gutter.box.customBorderChars = connected
            ? CONNECTOR_BORDER
            : undefined;
        gutter.box.border = connected ? ["left"] : false;
        gutter.box.visible = connected;
        gutter.marker.visible = !connected;
        gutter.marker.content = connected
            ? ""
            : (entry.prefix ?? "").slice(2);
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
    const gutter = new BoxRenderable(renderer, {
        id: `${id}-gutter`,
        width: 4,
        position: "relative",
        flexShrink: 0,
    });
    const connector = new BoxRenderable(renderer, {
        id: `${id}-gutter-connector`,
        position: "absolute",
        left: 2,
        width: 2,
        height: "100%",
        border: ["left"],
        borderColor: TUI_MUTED,
        customBorderChars: CONNECTOR_BORDER,
        visible: entry.prefix === "  │ ",
    });
    const marker = new TextRenderable(renderer, {
        id: `${id}-gutter-marker`,
        position: "absolute",
        left: 2,
        content: entry.prefix === "  │ "
            ? ""
            : (entry.prefix ?? "").slice(2),
        fg: TUI_MUTED,
        selectable: true,
        visible: entry.prefix !== "  │ ",
    });
    gutter.add(connector);
    gutter.add(marker);
    row.add(gutter);
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
    rowGutter.set(row, { box: connector, marker });
    return row;
}
