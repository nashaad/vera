import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import type { TuiTextTranscriptEntry } from "./state.ts";
import { renderTuiEntry } from "./state.ts";

const windowBody = new WeakMap<BoxRenderable, TextRenderable>();

/**
 * The single row reasoning still arriving is drawn into.
 *
 * One row, and one row whatever arrives: this sits in a transcript pinned to
 * its bottom, so any row it takes beyond the settled summary's one is a row
 * the whole scrollback jumps by when the phase ends. The mark that says there
 * is more rides the text itself rather than taking rows above and below it.
 */
export function createTuiThinkingWindow(
    renderer: CliRenderer,
    id: string,
    entry: TuiTextTranscriptEntry,
    marginTop: number,
): BoxRenderable {
    const box = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "column",
        marginTop,
    });
    const body = new TextRenderable(renderer, {
        id: `${id}-body`,
        content: renderTuiEntry(entry),
        width: "100%",
        // Reasoning still arriving is clipped at the right edge rather than
        // wrapped, so the row stays one row however long the line runs.
        wrapMode: "none",
        overflow: "hidden",
        selectable: true,
    });
    box.add(body);
    windowBody.set(box, body);
    return box;
}

export function updateTuiThinkingWindow(
    node: BoxRenderable,
    entry: TuiTextTranscriptEntry,
): void {
    const body = windowBody.get(node);
    if (body === undefined) return;
    body.content = renderTuiEntry(entry);
}

