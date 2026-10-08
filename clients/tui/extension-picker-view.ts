import { BoxRenderable, TextRenderable, type Renderable, type RenderContext } from "@opentui/core";
import {
    dialogActionRow, dialogFooterNode, dialogHeaderNode, dialogOptionRow, dialogRowPointer,
    updateDialogSearchNode, type DialogRowPointer, type createDialogSearchNode,
    DIALOG_CARD_PADDING, DIALOG_HEADER_HEIGHT,
} from "./dialog-chrome.ts";
import { dialogSearchHeight } from "./dialog-search.ts";
import { listWindowSlice } from "./list-window.ts";
import { TUI_ELEMENT, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./state.ts";
import { mixHex } from "./theme.ts";
import type { TuiExtensionPickerRow, TuiExtensionPickerState } from "./settings-picker-types.ts";

type PickerLine =
    | { readonly kind: "option"; readonly index: number; readonly row: TuiExtensionPickerRow }
    | { readonly kind: "divider" }
    | { readonly kind: "space" }
    | { readonly kind: "heading"; readonly text: string };

export function extensionPickerButtons(state: TuiExtensionPickerState) {
    return state.extensionActions.filter((action) => action.button);
}

export function renderExtensionPicker(
    renderer: RenderContext, box: BoxRenderable, state: TuiExtensionPickerState,
    nodes: Renderable[], search: ReturnType<typeof createDialogSearchNode> | undefined,
    pointer: DialogRowPointer | undefined, railInset: number,
): void {
    const menu = state.layout === "menu";
    const full = state.size === "full";
    const compact = renderer.height < 30;
    const width = menu && !full ? Math.min(64, renderer.width - 4) : Math.floor((renderer.width - railInset) * 0.96);
    const contentWidth = Math.max(1, width - DIALOG_CARD_PADDING * 2);
    const add = (node: Renderable): void => { box.add(node); nodes.push(node); };
    const text = (content: string, height = 1) => new TextRenderable(renderer, {
        content, height, width: "100%", fg: TUI_MUTED, selectable: false, wrapMode: "word", flexShrink: 0,
    });
    box.width = width;
    box.height = "auto";
    box.paddingTop = compact ? 0 : 1;
    add(dialogHeaderNode(renderer, state.title));
    if (state.searchable && search) {
        updateDialogSearchNode(search, state.query, state.searchPlaceholder ?? "Search", state.searchFocused === true, state.queryCursor);
        search.box.marginTop = compact ? 0 : 1;
        search.box.marginBottom = 1;
        search.box.onMouseDown = () => { pointer?.hover?.(-1); search.editor.focus(); };
        box.add(search.box);
    }
    const subtitle = state.subtitle ? wrapLines(state.subtitle, contentWidth).slice(0, 4) : [];
    if (subtitle.length) {
        const notice = text(subtitle.join("\n"), subtitle.length);
        notice.marginTop = state.searchable || compact ? 0 : 1;
        notice.marginBottom = compact ? 0 : 1;
        add(notice);
    }
    const buttons = extensionPickerButtons(state);
    const selected = state.extensionRows.find((row) => row.id === state.options[state.selectedIndex]?.value);
    const detailWidth = Math.max(28, Math.floor(contentWidth * (full ? 0.3 : 0.4)));
    const split = !menu && contentWidth - detailWidth - 3 >= 30;
    const details = (lines: readonly string[], width: number): string[] => lines.filter((line) => !compact || line.length > 0).flatMap((line) => wrapLines(line, width));
    const detailLines = details(selected?.details ?? [], split ? detailWidth : contentWidth);
    const helperHeight = split ? 0 : Math.min(6, Math.max(0, ...state.extensionRows.map((row) => details(row.details ?? [], contentWidth).length)));
    const chrome = DIALOG_HEADER_HEIGHT + (compact ? 1 : 2) + 3 + (state.searchable ? dialogSearchHeight(renderer) + (compact ? 1 : 2) : 0)
        + (subtitle.length ? subtitle.length + (compact ? 0 : state.searchable ? 1 : 2) : 0)
        + (buttons.length ? buttons.length + 2 : 0) + (helperHeight ? helperHeight + 1 : 0);
    const room = Math.max(1, renderer.height - chrome - 2);
    const rows = pickerLines(state);
    const isOption = (line: PickerLine): boolean => line.kind === "option";
    const cursor = rows.findIndex((line) => line.kind === "option" && line.index === state.selectedIndex);
    const scrolling = rows.length > room;
    const bodyRoom = Math.max(1, room - (scrolling ? 1 : 0));
    const visible = listWindowSlice(rows, cursor, bodyRoom);
    const bodyHeight = full ? bodyRoom : Math.max(1, Math.min(bodyRoom, Math.max(visible.length, split ? detailLines.length : 0)));
    const body = new BoxRenderable(renderer, { width: "100%", height: bodyHeight, flexDirection: "row", flexShrink: 0 });
    const listWidth = split ? contentWidth - detailWidth - 3 : contentWidth;
    const list = new BoxRenderable(renderer, { width: listWidth, height: bodyHeight, flexDirection: "column", flexShrink: 0, paddingRight: split ? 2 : 0 });
    body.add(list);
    add(body);
    if (!visible.length) list.add(text("No matching providers"));
    for (const line of visible) {
        if (line.kind === "divider") {
            const divider = text(` ${"╌".repeat(Math.max(1, listWidth - (split ? 4 : 2)))}`);
            divider.fg = mixHex(TUI_PANEL, TUI_TEXT, 0.30);
            list.add(divider);
            continue;
        }
        if (line.kind === "space") {
            list.add(text(""));
            continue;
        }
        if (line.kind === "heading") {
            list.add(text(` ${line.text}`));
            continue;
        }
        const { index, row } = line;
        list.add(dialogOptionRow(renderer, {
            label: row.label, meta: row.meta,
            active: index === state.selectedIndex,
            dimmed: state.searchFocused || state.focusedButton !== undefined,
            leading: " ",
            ...dialogRowPointer(pointer, index),
        }));
    }
    if (split) {
        const detail = new BoxRenderable(renderer, { width: detailWidth + 3, height: bodyHeight, flexDirection: "row", flexShrink: 0 });
        detail.add(new TextRenderable(renderer, { content: Array(bodyHeight).fill("│").join("\n"), width: 3, height: bodyHeight, fg: TUI_ELEMENT }));
        const prose = text(detailLines.slice(0, bodyHeight).join("\n"), bodyHeight);
        prose.width = detailWidth;
        prose.fg = TUI_TEXT;
        detail.add(prose);
        body.add(detail);
    } else if (helperHeight) {
        const helper = text(detailLines.slice(0, helperHeight).join("\n"), helperHeight);
        helper.marginTop = 1;
        add(helper);
    }
    if (scrolling) {
        const start = rows.indexOf(visible[0]!);
        const above = rows.slice(0, start).filter(isOption).length;
        const below = rows.slice(start + visible.length).filter(isOption).length;
        add(text(`↑ ${above} above · ↓ ${below} below`));
    }
    if (buttons.length) {
        const rule = text("─".repeat(contentWidth));
        rule.fg = mixHex(TUI_PANEL, TUI_TEXT, 0.30);
        rule.marginTop = 1;
        add(rule);
        buttons.forEach((button, index) => {
            const actionPointer = dialogRowPointer(pointer, -index - 2);
            add(dialogActionRow(renderer, button.label, state.focusedButton === index, false,
                actionPointer.onSelect, actionPointer.onHover));
        });
    }
    const focused = state.focusedButton === undefined ? undefined : buttons[state.focusedButton];
    const hint = focused ? `⏎ ${focused.label.toLowerCase()}` : state.searchFocused ? "Type to search · ←→ cursor" : "↑↓ choose · ⏎ open";
    const footer = dialogFooterNode(renderer, `${hint}\n${buttons.length || state.searchable ? "Tab sections · " : ""}Esc back`);
    footer.height = 2;
    add(footer);
}

// A heading replaces the group rule and gets a blank line above it, except at the top.
function pickerLines(state: TuiExtensionPickerState): PickerLine[] {
    const lines: PickerLine[] = [];
    let previous: TuiExtensionPickerRow | undefined;
    state.options.forEach((option, index) => {
        const row = state.extensionRows.find((candidate) => candidate.id === option.value)!;
        const fresh = row.heading !== previous?.heading || row.group !== previous?.group;
        const heading = row.heading !== undefined && fresh ? row.heading : undefined;
        if (heading !== undefined) {
            if (index > 0) lines.push({ kind: "space" });
            lines.push({ kind: "heading", text: heading });
        } else if (index > 0 && row.group !== previous?.group) {
            lines.push({ kind: "divider" });
        }
        lines.push({ kind: "option", index, row });
        previous = row;
    });
    return lines;
}

function wrapLines(text: string, width: number): string[] {
    if (!text) return [""];
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/)) {
        if (line && Bun.stringWidth(`${line} ${word}`) > width) { lines.push(line); line = ""; }
        line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    return lines;
}
