import { BoxRenderable, TextRenderable, StyledText, fg, type Renderable, type RenderContext } from "@opentui/core";
import { dialogActionRow, dialogHeaderNode, dialogFooterNode, dialogGroupHeaderNode, dialogOptionRow, dialogOptionRows, dialogRowPointer, type DialogRowPointer, createDialogSearchNode, updateDialogSearchNode } from "./dialog-chrome.ts";
import { dialogSearchHeight } from "./dialog-search.ts";
import { modelDetailHeight, modelDetailNode, modelPaneSplit, pickerContentWidth } from "./settings-picker-model.ts";
import { browseWindow, browseMoreText, emptyModelBrowse } from "./model-browse.ts";
import { formatListedPrice } from "../../src/model/listed-rates.ts";
import { TUI_ACCENT, TUI_DANGER, TUI_ELEMENT, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./state.ts";
import type { ModelBrowseSection, TuiSettingsPickerOption, TuiSettingsPickerState, TuiPickerTipLine } from "./settings-picker-types.ts";
import { mixHex } from "./theme.ts";

export function modelPriceColumns(option?: TuiSettingsPickerOption): string {
    const rate = (value: number | undefined): string => {
        if (value === undefined) return "?";
        const rounded = value > 0 && value < 0.01 ? Number(value.toPrecision(2)) : Number(value.toFixed(2));
        const full = `$${rounded}`;
        return full.length <= 9 ? full : `$${value.toExponential(2)}`;
    };
    const input = option === undefined ? "Input" : rate(option.pricing?.input);
    const output = option === undefined ? "Output" : rate(option.pricing?.output);
    return `${input.padStart(9)} ${output.padStart(9)}`;
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

export function modelSwitchRows(renderer: RenderContext): number {
    return Math.max(1, renderer.height - dialogSearchHeight(renderer) - 19);
}

export function renderModelSwitch(
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
    const width = pickerContentWidth(renderer, state, railInset);
    const detailed = state.browseView === "detailed";
    const candidateSplit = detailed ? modelPaneSplit(renderer, state, railInset) : undefined;
    const split = candidateSplit !== undefined && candidateSplit.listWidth >= 59
        ? candidateSplit : undefined;
    const listWidth = split?.listWidth ?? width;
    const columns = detailed && listWidth >= 59 && modelSwitchRows(renderer) >= 3;
    const maximumRows = Math.max(1, modelSwitchRows(renderer) + (columns ? 2 : 0)
        - (columns && state.browseNotice !== undefined ? 1 : 0) - tipRows);
    const window = browseWindow(state, maximumRows - (columns ? 1 : 0), scroll?.top);
    const listRows = Math.max(2, window.rows.length) + (columns ? 1 : 0);
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
    const scope = state.query.trim() ? "Search all connected models" : state.tab === "all" ? "All connected models" : "Favorites";
    add(dialogHeaderNode(renderer, `${state.title ?? "Switch model"} · ${scope}`));
    if (search !== undefined) {
        updateDialogSearchNode(search, state.query, "Search models", true, state.queryCursor);
        search.box.marginTop = 1;
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
    const statusWidth = 15;
    const priceMeta = (option?: TuiSettingsPickerOption, status = "Status") => {
        const score = option === undefined ? "WA Score" : String(option.waScore ?? "?");
        return `  ${score.padStart(8)} ${modelPriceColumns(option)} ${status.padEnd(statusWidth)}`;
    };
    if (columns) list.add(dialogOptionRow(renderer, { label: "", active: false, meta: priceMeta() }));
    if (scroll !== undefined) scroll.top = window.top;
    if (window.rows.length === 0) list.add(text(emptyModelBrowse(state), 2));
    for (const row of window.rows) {
        if (row.heading !== undefined) { list.add(dialogGroupHeaderNode(renderer, `▼ ${row.heading}`, false)); continue; }
        if (row.more !== undefined) { list.add(text(browseMoreText(row.more, listWidth))); continue; }
        if (row.option === undefined) { list.add(text("")); continue; }
        const option = row.option;
        const status = option.unavailable ? "unavailable" : option.value === state.initialModel ? "current" : option.hiddenByDefault ? "hidden" : "";
        const label = `${option.section === undefined ? "" : "▶ "}${option.pooledRank === undefined ? "" : "* "}${option.label}`;
        const meta = option.section !== undefined ? "" : columns ? priceMeta(option, status) : status;
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
        `Ctrl+G favorites/all · Ctrl+K ${selected?.model === undefined ? "manage models" : "manage highlighted model"} · Tab sections · Esc back`,
        "^g fav/all · ^k manage highlighted · Tab sections · Esc",
        "^g all · ^k highlighted · Tab sections · Esc",
        "^g all · ^k model actions · Esc",
    ].find((line) => Bun.stringWidth(line) <= width) ?? "^g ^k Tab Esc";
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
