import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core";
import type { RenderContext } from "@opentui/core";

import type { TuiTranscriptEntry } from "./state.ts";
import { renderTuiEntry, TUI_DANGER } from "./state.ts";
import { setTextContent } from "./text-content.ts";

interface TuiErrorRowParts {
    readonly marker: TextRenderable;
    readonly text: TextRenderable;
}

const rowParts = new WeakMap<BoxRenderable, TuiErrorRowParts>();

const ERROR_MARKER = "×";

export function createTuiErrorRow(
    renderer: RenderContext,
    id: string,
    entry: TuiTranscriptEntry,
    marginTop: number,
): BoxRenderable {
    const row = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "row",
        marginTop,
    });
    const marker = new TextRenderable(renderer, {
        id: `${id}-marker`,
        content: ERROR_MARKER,
        fg: TUI_DANGER,
        attributes: TextAttributes.BOLD,
        width: 1,
        flexShrink: 0,
    });
    row.add(marker);
    const body = new BoxRenderable(renderer, {
        id: `${id}-body`,
        flexGrow: 1,
        flexShrink: 1,
        flexDirection: "column",
        paddingLeft: 1,
    });
    row.add(body);
    const text = new TextRenderable(renderer, {
        id: `${id}-text`,
        content: renderTuiEntry(entry),
        width: "100%",
        wrapMode: "word",
        selectable: true,
    });
    body.add(text);
    rowParts.set(row, { marker, text });
    return row;
}

export function tuiErrorRowText(node: BoxRenderable): TextRenderable | undefined {
    return rowParts.get(node)?.text;
}

export function updateTuiErrorRow(
    node: BoxRenderable,
    entry: TuiTranscriptEntry,
): boolean {
    const parts = rowParts.get(node);
    if (parts === undefined) return false;
    setTextContent(parts.text, renderTuiEntry(entry));
    return true;
}

export function repaintTuiErrorRow(node: BoxRenderable): void {
    const parts = rowParts.get(node);
    if (parts === undefined) return;
    parts.marker.fg = TUI_DANGER;
}
