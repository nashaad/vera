import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { RenderContext } from "@opentui/core";

import type { TuiTranscriptEntry } from "./state.ts";
import { renderTuiEntry, TUI_NOTICE } from "./state.ts";

interface TuiNoticeCardParts {
    readonly marker: TextRenderable;
    readonly text: TextRenderable;
}

const cardParts = new WeakMap<BoxRenderable, TuiNoticeCardParts>();

const NOTICE_MARKER = "•";

export function createTuiNoticeCard(
    renderer: RenderContext,
    id: string,
    entry: TuiTranscriptEntry,
    marginTop: number,
): BoxRenderable {
    const band = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "row",
        marginTop,
    });
    const marker = new TextRenderable(renderer, {
        id: `${id}-marker`,
        content: NOTICE_MARKER,
        fg: TUI_NOTICE,
        width: 1,
        flexShrink: 0,
    });
    band.add(marker);
    const body = new BoxRenderable(renderer, {
        id: `${id}-body`,
        flexGrow: 1,
        flexShrink: 1,
        flexDirection: "column",
        paddingLeft: 1,
    });
    band.add(body);
    const text = new TextRenderable(renderer, {
        id: `${id}-text`,
        content: renderTuiEntry(entry),
        width: "100%",
        wrapMode: "word",
        selectable: true,
    });
    body.add(text);
    cardParts.set(band, { marker, text });
    return band;
}

export function updateTuiNoticeCard(
    node: BoxRenderable,
    entry: TuiTranscriptEntry,
): boolean {
    const parts = cardParts.get(node);
    if (parts === undefined) return false;
    parts.text.content = renderTuiEntry(entry);
    return true;
}

export function repaintTuiNoticeCard(node: BoxRenderable): void {
    const parts = cardParts.get(node);
    if (parts === undefined) return;
    parts.marker.fg = TUI_NOTICE;
}
