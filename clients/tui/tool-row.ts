import {
    BoxRenderable,
    fg,
    StyledText,
    TextRenderable,
} from "@opentui/core";
import type { RenderContext } from "@opentui/core";

import { tuiKeyHint } from "./keymap.ts";
import type { TuiTextTranscriptEntry } from "./state.ts";
import {
    renderTuiEntry,
    renderTuiToolRowContent,
    TUI_MUTED,
    TUI_TEXT,
} from "./state.ts";

const rowText = new WeakMap<BoxRenderable, TextRenderable>();
const rowGutter = new WeakMap<
    BoxRenderable,
    { box: BoxRenderable; marker: TextRenderable }
>();
const headerParts = new WeakMap<
    BoxRenderable,
    {
        header: TextRenderable;
        hint: TextRenderable;
        preview: BoxRenderable[];
    }
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

export function updateTuiToolHeader(
    node: BoxRenderable,
    entry: TuiTextTranscriptEntry,
): void {
    const parts = headerParts.get(node);
    if (parts === undefined) return;
    parts.header.content = renderTuiEntry({
        ...entry,
        hint: false,
        detailPreview: undefined,
    });
    parts.hint.content = entry.hint === true
        ? new StyledText([
            fg(TUI_MUTED)(`  ${tuiKeyHint("toggle_tool_details")}`),
        ])
        : "";
    for (const row of parts.preview) row.destroyRecursively();
    parts.preview.length = 0;
    for (const line of entry.detailPreview?.split("\n") ?? []) {
        const row = createCompactPreviewRow(node, line);
        parts.preview.push(row);
        node.add(row);
    }
}

export function createTuiToolHeader(
    renderer: RenderContext,
    id: string,
    entry: TuiTextTranscriptEntry,
    marginTop: number,
): BoxRenderable {
    const node = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "column",
        marginTop,
    });
    const line = new BoxRenderable(renderer, {
        id: `${id}-line`,
        width: "100%",
        flexDirection: "row",
    });
    const header = new TextRenderable(renderer, {
        id: `${id}-header`,
        flexGrow: 1,
        wrapMode: "none",
        truncate: true,
        selectable: true,
    });
    const hint = new TextRenderable(renderer, {
        id: `${id}-hint`,
        flexShrink: 0,
        selectable: true,
    });
    headerParts.set(node, { header, hint, preview: [] });
    line.add(header);
    line.add(hint);
    node.add(line);
    updateTuiToolHeader(node, entry);
    return node;
}

function createCompactPreviewRow(
    parent: BoxRenderable,
    line: string,
): BoxRenderable {
    const id = `${parent.id}-preview-${headerParts.get(parent)?.preview.length ?? 0}`;
    const row = new BoxRenderable(parent.ctx, {
        id,
        width: "100%",
        flexDirection: "row",
    });
    const prefixed = /^(  [│└] )(.*)$/.exec(line);
    const gutter = new TextRenderable(parent.ctx, {
        id: `${id}-gutter`,
        width: 4,
        flexShrink: 0,
        content: prefixed?.[1] ?? "    ",
        fg: TUI_MUTED,
        selectable: true,
    });
    const text = new TextRenderable(parent.ctx, {
        id: `${id}-text`,
        content: prefixed?.[2] ?? line.slice(4),
        fg: prefixed?.[1] === "  │ " ? TUI_TEXT : TUI_MUTED,
        flexGrow: 1,
        wrapMode: "none",
        truncate: true,
        selectable: true,
    });
    row.add(gutter);
    row.add(text);
    return row;
}

export function updateTuiToolRow(
    node: BoxRenderable,
    entry: TuiTextTranscriptEntry,
): void {
    const text = rowText.get(node);
    if (text !== undefined) {
        text.content = renderTuiToolRowContent(entry);
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
        content: renderTuiToolRowContent(entry),
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
