import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import type { TuiTextTranscriptEntry } from "./state.ts";
import { renderTuiEntry } from "./state.ts";

const windowBody = new WeakMap<BoxRenderable, TextRenderable>();

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
