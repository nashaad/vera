import { BoxRenderable, TextRenderable, StyledText, fg, type Renderable, type RenderContext } from "@opentui/core";
import { dialogActionRow, dialogHeaderNode, dialogFooterNode, dialogGroupHeaderNode, dialogOptionRow, dialogOptionRows, dialogRowPointer, type DialogRowPointer, createDialogSearchNode, updateDialogSearchNode } from "./dialog-chrome.ts";
import { dialogSearchHeight } from "./dialog-search.ts";
import { modelDetailHeight, modelDetailNode, modelPaneSplit, pickerContentWidth } from "./settings-picker-model.ts";
import { browseScopeCaption, browseScopeLabel, browseWindow, browseMoreText, emptyModelBrowse } from "./model-browse.ts";
import { formatListedPrice } from "../../src/model/listed-rates.ts";
import { TUI_ACCENT, TUI_DANGER, TUI_ELEMENT, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./state.ts";
import type { ModelBrowseSection, TuiSettingsPickerOption, TuiSettingsPickerState, TuiPickerTipLine } from "./settings-picker-types.ts";
import { mixHex } from "./theme.ts";

function listedRate(value: number | undefined): string {
    if (value === undefined) return "-";
    const rounded = value > 0 && value < 0.01 ? Number(value.toPrecision(2)) : Number(value.toFixed(2));
    const full = `$${rounded}`;
    return full.length <= 9 ? full : `$${value.toExponential(2)}`;
}

function modelStatus(option: TuiSettingsPickerOption, initialModel: string | undefined): string {
    return option.unavailable ? "unavailable" : option.value === initialModel ? "current" : option.hiddenByDefault ? "hidden" : "";
}

/** Same glyphs as the favorites rows: \u2713 verified, - not probed, \u2717 probe failed. */
function modelVerifiedMark(option: TuiSettingsPickerOption): string {
    if (option.verificationError !== undefined) return "\u2717";
    if (option.unverified === false || option.pooledRank !== undefined && option.unverified !== true) return "\u2713";
    return "-";
}

/** One cell per column: WA Score, Input, Output, verified glyph, status letter. */
function modelColumnCells(option: TuiSettingsPickerOption | undefined, initialModel: string | undefined): string[] {
    if (option === undefined) return ["WA Score", "Input", "Output", "Vf", "St"];
    // One letter: U unavailable, C current, H hidden.
    return [String(option.waScore ?? "-"), listedRate(option.pricing?.input), listedRate(option.pricing?.output),
        modelVerifiedMark(option), modelStatus(option, initialModel).slice(0, 1).toUpperCase()];
}

/** Each column is as wide as its widest cell across every model, so widths hold still while scrolling. */
export function modelColumnWidths(options: readonly TuiSettingsPickerOption[], initialModel?: string): number[] {
    const rows = options.filter((option) => option.section === undefined).map((option) => modelColumnCells(option, initialModel));
    const widths = modelColumnCells(undefined, initialModel).map((header, column) =>
        Math.max(Bun.stringWidth(header), ...rows.map((cells) => Bun.stringWidth(cells[column]!))));
    // No row has a status, so the column and its header go.
    if (rows.every((cells) => cells[4] === "")) widths[4] = 0;
    return widths;
}

export function modelPriceColumns(option: TuiSettingsPickerOption | undefined, widths: readonly number[], initialModel?: string): string {
    const cells = modelColumnCells(option, initialModel);
    const numbers = cells.slice(0, 3).map((cell, column) => cell.padStart(widths[column]!)).join("  ");
    const verified = `${numbers}  ${cells[3]!.padStart(widths[3]!)}`;
    return widths[4] === 0 ? `  ${verified}` : `  ${verified}  ${cells[4]!.padEnd(widths[4]!)}`;
}

const MODEL_COLUMN_LEGENDS = [
    "Vf  \u2713 verified  - not probed  \u2717 probe failed",
    "St  C current  U unavailable  H hidden",
];

/** The two lines join into one where the width allows it, so the list keeps a row. */
export function modelColumnLegend(width: number): string[] {
    const joined = MODEL_COLUMN_LEGENDS.join("   ");
    return Bun.stringWidth(joined) <= width ? [joined] : MODEL_COLUMN_LEGENDS;
}

function wrapWords(content: string, width: number): string[] {
    const lines: string[] = [];
    for (const word of content.split(" ")) {
        const last = lines.at(-1);
        if (last !== undefined && Bun.stringWidth(`${last} ${word}`) <= width) lines[lines.length - 1] = `${last} ${word}`;
        else lines.push(word);
    }
    return lines;
}

function columnLabel(label: string, width: number): string {
    if (Bun.stringWidth(label) <= width) return label;
    let clipped = "";
    for (const character of label) {
        if (Bun.stringWidth(clipped + character) > width - 1) break;
        clipped += character;
    }
    return `${clipped.trimEnd()}…`;
}

/** The label keeps about twenty columns once the number columns take their share. */
const BROWSE_SPLIT_MIN_LIST_WIDTH = 50;

export function modelBrowseRows(renderer: RenderContext): number {
    return Math.max(1, renderer.height - dialogSearchHeight(renderer) - 19);
}

export function renderModelBrowse(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiSettingsPickerState,
    nodes: Renderable[],
    search: ReturnType<typeof createDialogSearchNode> | undefined,
    pointer: DialogRowPointer | undefined,
    railInset: number,
    scroll: { top: number } | undefined,
    onSection: ((section: ModelBrowseSection) => void) | undefined,
    onAction: ((section: ModelBrowseSection) => void) | undefined,
    tip?: string | TuiPickerTipLine,
): void {
    const tipLine = typeof tip === "string" ? { tone: "tip" as const, text: tip } : tip;
    const tipRows = tipLine?.text ? 2 : 0;
    // The caption takes the gap above the search box, so it costs no list row.
    const caption = state.query.trim() === "" ? browseScopeCaption(state.tab) : undefined;
    const width = pickerContentWidth(renderer, state, railInset);
    const detailed = state.browseView === "detailed";
    const candidateSplit = detailed ? modelPaneSplit(renderer, state, railInset) : undefined;
    const split = candidateSplit !== undefined && candidateSplit.listWidth >= BROWSE_SPLIT_MIN_LIST_WIDTH
        ? candidateSplit : undefined;
    const listWidth = split?.listWidth ?? width;
    const columns = detailed && listWidth >= BROWSE_SPLIT_MIN_LIST_WIDTH && modelBrowseRows(renderer) >= 3;
    // A caption too wide for one line wraps, and the list gives up the rows it takes.
    const captionRows = caption === undefined ? 0 : wrapWords(caption, width).length;
    // Columns without their legend are unreadable, so the legend always comes
    // with them; only the gap above it gives way when the list is short.
    const legend = columns ? modelColumnLegend(width) : [];
    const rowsWithoutLegend = Math.max(1, modelBrowseRows(renderer) + (columns ? 2 : 0)
        - (columns && state.browseNotice !== undefined ? 1 : 0) - tipRows - Math.max(0, captionRows - 1));
    const legendGap = rowsWithoutLegend - legend.length - 1 >= 10;
    const legendRows = legend.length + (legendGap ? 1 : 0);
    const maximumRows = Math.max(1, rowsWithoutLegend - legendRows);
    const window = browseWindow(state, maximumRows - (columns ? 1 : 0), scroll?.top);
    // Every scope gets the same height: a short list pads rather than shrinking the dialog.
    const listRows = maximumRows;
    const detailRows = split === undefined || listRows >= maximumRows ? 0
        : Math.max(modelDetailHeight(state, split.detailWidth), ...state.options.map((_, selectedIndex) =>
            modelDetailHeight({ ...state, selectedIndex }, split.detailWidth)));
    const summaryRows = columns ? 0 : 2;
    const room = split === undefined ? Math.min(maximumRows, listRows)
        : Math.min(maximumRows + summaryRows, Math.max(listRows + summaryRows, detailRows));
    box.height = "auto";
    box.paddingTop = 1;
    const add = (node: Renderable) => { box.add(node); nodes.push(node); };
    const text = (content: string, height = 1) => new TextRenderable(renderer, {
        content, height, width: "100%", fg: TUI_MUTED, selectable: false, wrapMode: "none", overflow: "hidden",
    });
    const action = (section: ModelBrowseSection, label: string) => {
        const active = state.modelFocus === section;
        add(dialogActionRow(renderer, label, active, section === "view", () => onAction?.(section)));
    };
    const scope = state.query.trim()
        ? "Search all connected models"
        : state.tab === "all" ? "All connected models" : browseScopeLabel(state.tab);
    // Ctrl+G is the only way to change scope, so it belongs next to the scope it changes.
    const scopeHint = state.query.trim() ? "esc" : "Ctrl+G scope · esc";
    add(dialogHeaderNode(renderer, `${state.title ?? "Switch model"} · ${scope}`, scopeHint));
    if (caption !== undefined) add(text(wrapWords(caption, width).join("\n"), captionRows));
    if (search !== undefined) {
        updateDialogSearchNode(search, state.query, "Search models", true, state.queryCursor);
        search.box.marginTop = caption === undefined ? 1 : 0;
        search.box.marginBottom = 1;
        box.add(search.box);
    }
    const filters = [state.browseProvider, state.browseAvailableOnly ? "available" : undefined,
        state.browsePricedOnly ? "known price" : undefined, state.browseImagesOnly ? "images" : undefined,
        state.intelligenceCutoff && state.intelligenceCutoff !== "any" ? `score >= ${state.intelligenceCutoff}` : undefined].filter(Boolean);
    if (filters.length > 0) add(text(filters.join(" · ")));
    const body = new BoxRenderable(renderer, { width: "100%", height: room, flexDirection: "row", flexShrink: 0 });
    const list = new BoxRenderable(renderer, { width: listWidth, height: room, flexDirection: "column", flexShrink: 0 });
    list.onMouseDown = () => onSection?.("list");
    body.add(list);
    add(body);
    const widths = modelColumnWidths(state.options, state.initialModel);
    const priceMeta = (option?: TuiSettingsPickerOption) => modelPriceColumns(option, widths, state.initialModel);
    if (columns) list.add(dialogOptionRow(renderer, { label: "", active: false, meta: priceMeta() }));
    if (scroll !== undefined) scroll.top = window.top;
    if (window.rows.length === 0) list.add(text(emptyModelBrowse(state), 2));
    for (const row of window.rows) {
        if (row.heading !== undefined) { list.add(dialogGroupHeaderNode(renderer, `▼ ${row.heading}`, false)); continue; }
        if (row.more !== undefined) { list.add(text(browseMoreText(row.more, listWidth))); continue; }
        if (row.option === undefined) { list.add(text("")); continue; }
        const option = row.option;
        const status = modelStatus(option, state.initialModel);
        const label = `${option.section === undefined ? "" : "▶ "}${option.pooledRank === undefined ? "" : "* "}${option.label}`;
        const meta = option.section !== undefined ? "" : columns ? priceMeta(option) : status;
        const content = {
            label: columns && option.section === undefined ? columnLabel(label, listWidth - Bun.stringWidth(meta)) : label,
            active: row.index === state.selectedIndex,
            current: option.value === state.initialModel,
            dimmed: state.modelFocus !== "list",
            ...(option.section === undefined ? {} : { heading: true }),
            meta,
            ...dialogRowPointer(pointer, row.index),
        };
        list.add(columns ? dialogOptionRow(renderer, content) : dialogOptionRows(renderer, [content], listWidth)[0]!);
    }
    if (split !== undefined) body.add(modelDetailNode(renderer, state, split.detailWidth, room));
    const addSummary = (node: Renderable) => split === undefined ? add(node) : list.add(node);
    const selected = state.options[state.selectedIndex];
    if (!columns) {
        const price = text(state.browseNotice ?? (selected?.model === undefined ? "" : selected.pricing === undefined
            ? "Price unavailable" : `${formatListedPrice(selected.pricing)} input/output per 1M tokens`));
        price.marginTop = 1;
        addSummary(price);
    } else if (state.browseNotice !== undefined) {
        add(text(state.browseNotice));
    }
    if (legend.length > 0) {
        const node = text(legend.map((line) => columnLabel(line, width)).join("\n"), legend.length);
        node.marginTop = legendGap ? 1 : 0;
        add(node);
    }
    add(new TextRenderable(renderer, {
        content: "─".repeat(width), height: 1, width: "100%", selectable: false,
        fg: mixHex(TUI_PANEL, TUI_TEXT, 0.30), wrapMode: "none", overflow: "hidden",
    }));
    action("filters", "Filter and sort");
    action("providers", "Connect provider");
    action("more", "Manage models");
    const focusedAction = state.modelFocus === "filters" ? "filter and sort"
        : state.modelFocus === "providers" ? "connect provider" : "manage models";
    const hint = state.modelFocus === "search" ? "Type to search · ←→ cursor"
        : state.modelFocus === "list"
        ? `↑↓ choose · ⏎ ${selected?.pooledRank === undefined ? "favorite" : "unfavorite"} · Space fold/unfold`
        : `⏎ ${focusedAction}`;
    const navigation = [
        `Ctrl+G scope · Ctrl+K ${selected?.model === undefined ? "manage models" : "manage highlighted model"} · Tab sections · Esc back`,
        "Ctrl+G scope · Ctrl+K manage highlighted · Tab sections · Esc",
        "Ctrl+G scope · Ctrl+K model · Tab sections · Esc",
        "Ctrl+G · Ctrl+K · Tab sections · Esc",
    ].find((line) => Bun.stringWidth(line) <= width) ?? "Ctrl+G Ctrl+K Tab Esc";
    const footer = dialogFooterNode(renderer, `${hint}\n${navigation}`);
    footer.height = 2;
    footer.marginTop = 1;
    add(footer);
    if (tipLine?.text) {
        const label = tipLine.tone === "tip" ? "Tip" : "Not set";
        add(new TextRenderable(renderer, {
            content: new StyledText([
                fg(tipLine.tone === "tip" ? TUI_ACCENT : TUI_DANGER)(`${label} `),
                fg(TUI_MUTED)(columnLabel(tipLine.text, Math.max(1, width - label.length - 1))),
            ]),
            width: "100%", height: 1, marginTop: 1, selectable: false,
        }));
    }
}
