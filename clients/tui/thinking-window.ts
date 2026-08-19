import { BoxRenderable, fg, StyledText, TextRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import type { TuiTextTranscriptEntry } from "./state.ts";
import { LIVE_THINKING_ELLIPSIS, renderTuiEntry, TUI_MUTED } from "./state.ts";

const windowBody = new WeakMap<BoxRenderable, TextRenderable>();

/**
 * The bounded region reasoning still arriving is drawn into.
 *
 * A column rather than one text block, because the ellipsis at each end is
 * centred and the reasoning under it is not: the marks belong to the window
 * and the text belongs to the model.
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
    box.add(ellipsis(renderer, `${id}-top`));
    const body = new TextRenderable(renderer, {
        id: `${id}-body`,
        content: renderTuiEntry(entry),
        width: "100%",
        // Reasoning still arriving is clipped at the right edge rather than
        // wrapped, so its window is as many rows as it is lines.
        wrapMode: "none",
        overflow: "hidden",
        selectable: true,
    });
    box.add(body);
    box.add(ellipsis(renderer, `${id}-bottom`));
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

function ellipsis(renderer: CliRenderer, id: string): TextRenderable {
    return new TextRenderable(renderer, {
        id,
        content: new StyledText([fg(TUI_MUTED)(LIVE_THINKING_ELLIPSIS)]),
        alignSelf: "center",
        flexShrink: 0,
    });
}
