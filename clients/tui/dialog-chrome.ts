import { refreshDialogHeaders } from "./dialog-header.ts";
export { dialogHeaderNode, updateDialogHeaderTitle, configureDialogHeaders, DIALOG_HEADER_HEIGHT } from "./dialog-header.ts";
import { refreshDialogSearch } from "./dialog-search.ts";
export { createDialogSearchNode, updateDialogSearchNode, configureDialogSearch } from "./dialog-search.ts";
import {
    bold,
    BoxRenderable,
    fg,
    type MouseEvent,
    type Renderable,
    StyledText,
    type TextChunk,
    TextareaRenderable,
    TextRenderable,
    underline,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_SELECTION_TEXT,
    TUI_TEXT,
} from "./palette.ts";
import {
    createTuiSingleLineTextarea,
    syncTuiSingleLineTextarea,
} from "./single-line-editor.ts";

export const DIALOG_GUTTER_WIDTH = 0;

export const DIALOG_GUTTER = "";

export function dialogChipNode(renderer: RenderContext, label: string, active: boolean, dropdown = false): TextRenderable {
    const content = ` › ${label}${dropdown ? " ▾" : ""} `;
    return new TextRenderable(renderer, {
        content: new StyledText([
            fg(active ? TUI_SELECTION_TEXT : TUI_MUTED)(" ›"),
            fg(active ? TUI_SELECTION_TEXT : TUI_TEXT)(content.slice(2)),
        ]),
        width: Bun.stringWidth(content), height: 1, flexShrink: 0, selectable: false,
        fg: active ? TUI_SELECTION_TEXT : TUI_TEXT,
        bg: active ? TUI_ACCENT : TUI_ELEMENT, attributes: 1,
    });
}

export const DIALOG_CHROME_HEIGHT = 13;

export function dialogActionRow(
    renderer: RenderContext, label: string, active: boolean, dropdown = false,
    onSelect?: () => void, onHover?: () => void, meta?: string,
): BoxRenderable {
    const node = dialogChipNode(renderer, label, active, dropdown);
    node.flexGrow = 1;
    node.width = "auto";
    const control = new BoxRenderable(renderer, {
        width: "100%", height: 1, flexDirection: "row",
        backgroundColor: active ? TUI_ACCENT : TUI_ELEMENT,
    });
    control.add(node);
    if (meta !== undefined && meta.length > 0) {
        control.add(new TextRenderable(renderer, {
            content: `${meta} `,
            width: Bun.stringWidth(meta) + 1, height: 1, flexShrink: 0, selectable: false,
            fg: active ? TUI_SELECTION_TEXT : TUI_MUTED,
            bg: active ? TUI_ACCENT : TUI_ELEMENT,
        }));
    }
    node.onMouseDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        renderer.clearSelection();
        onSelect?.();
    };
    node.onMouseMove = () => onHover?.();
    return control;
}

export const DIALOG_CARD_PADDING = 4;

export const DIALOG_BACKGROUND_Z_INDEX = 4;
export const DIALOG_SCRIM_Z_INDEX = 10;
export const DIALOG_CARD_Z_INDEX = 20;

export const DIALOG_SHORT_TERMINAL_HEIGHT = 10;

export const APP_PADDING_TOP = 1;
export const APP_PADDING_BOTTOM = 1;

const dialogCards = new Set<BoxRenderable>();
export function dialogBottomOffset(renderer: RenderContext): number {
    return renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT ? 1 : 2;
}

export function dialogInsetTop(renderer: RenderContext): number {
    return APP_PADDING_TOP;
}

export function dialogInsetBottomOffset(renderer: RenderContext): number {
    if (renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT) return 1;
    return Math.min(5, Math.max(2, Math.floor(renderer.height / 8) + 1));
}

export function centeredDialogSurface(
    renderer: RenderContext,
    id: string,
    card: BoxRenderable,
    options: { readonly registerCard?: boolean } = {},
): BoxRenderable {
    if (options.registerCard !== false) registerDialogCard(card);
    const surface = new BoxRenderable(renderer, {
        id,
        border: false,
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: DIALOG_CARD_Z_INDEX,
        alignItems: "center",
        justifyContent: "center",
        visible: false,
    });
    surface.add(card);
    return surface;
}

function applyDialogCardChrome(card: BoxRenderable): void {
    card.border = false;
}

export function registerDialogCard(card: BoxRenderable): void {
    dialogCards.add(card);
    card.once("destroyed", () => dialogCards.delete(card));
    applyDialogCardChrome(card);
}

export function refreshDialogChrome(): void {
    for (const card of dialogCards) {
        if (!card.isDestroyed) applyDialogCardChrome(card);
    }
    refreshDialogHeaders();
    refreshDialogSearch();
}

export const DIALOG_BUTTON_LINES = 3;

export const DIALOG_BUTTON_CHEVRON = "\u203a";

export interface DialogButtonOptions {
    readonly label: string;
    readonly width: number;
    readonly focused: boolean;
    /** A door: the button opens something rather than doing it. */
    readonly opens?: boolean;
}

/**
 * The outlined button. Every button-shaped control uses this one, so a second
 * outline never appears. Menus, pickers and choice strips stay compact rows.
 */
export function dialogButtonNode(
    renderer: RenderContext,
    options: DialogButtonOptions,
): BoxRenderable {
    const border = options.focused ? TUI_ACCENT : TUI_MUTED;
    const box = new BoxRenderable(renderer, {
        width: options.width,
        height: DIALOG_BUTTON_LINES,
        flexShrink: 0,
        border: true,
        // The doubled edge is the focus marker a monochrome terminal still reads.
        borderStyle: options.focused ? "double" : "single",
        borderColor: border,
        focusedBorderColor: border,
        shouldFill: false,
        backgroundColor: TUI_PANEL,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
    });
    box.add(new TextRenderable(renderer, {
        content: options.label,
        fg: options.focused ? TUI_ACCENT : TUI_TEXT,
        bg: TUI_PANEL,
        flexGrow: 1,
        flexShrink: 1,
        wrapMode: "none",
    }));
    if (options.opens === true) {
        box.add(new TextRenderable(renderer, {
            content: DIALOG_BUTTON_CHEVRON,
            fg: options.focused ? TUI_ACCENT : TUI_MUTED,
            bg: TUI_PANEL,
            flexShrink: 0,
        }));
    }
    return box;
}

export function createDialogTextFieldNode(
    renderer: RenderContext,
    id: string,
    placeholder: string,
): TextareaRenderable {
    return createTuiSingleLineTextarea(renderer, {
        id,
        placeholder,
        backgroundColor: TUI_PANEL,
        height: 2,
        marginTop: 1,
    });
}

export function updateDialogTextFieldNode(
    node: TextareaRenderable,
    value: string,
    placeholder: string,
    live = true,
    cursor = value.length,
): void {
    node.placeholder = placeholder;
    node.textColor = TUI_TEXT;
    node.focusedTextColor = TUI_TEXT;
    node.backgroundColor = TUI_PANEL;
    node.focusedBackgroundColor = TUI_PANEL;
    node.cursorColor = TUI_ACCENT;
    node.placeholderColor = TUI_MUTED;
    syncTuiSingleLineTextarea(node, value, cursor);
    if (!live) node.blur();
}

export function dialogFooterNode(
    renderer: RenderContext,
    hint: string,
): TextRenderable {
    return new TextRenderable(renderer, {
        content: hint,
        fg: TUI_MUTED,
        width: "100%",
        height: Math.max(2, hint.split("\n").length + 1),
        marginTop: 1,
    });
}

export function dialogGroupHeaderNode(
    renderer: RenderContext,
    label: string,
    spaced: boolean,
): TextRenderable {
    return new TextRenderable(renderer, {
        content: `${DIALOG_GUTTER}${label}`,
        fg: TUI_ACCENT,
        attributes: 1,
        width: "100%",
        height: 1,
        ...(spaced ? { marginTop: 1 } : {}),
    });
}

/** A group heading that can fold, so its marker sits where the folded row's marker sits. */
export function dialogGroupHeaderRow(
    renderer: RenderContext,
    label: string,
    marker: string,
): BoxRenderable {
    const row = new BoxRenderable(renderer, {
        width: "100%",
        height: 1,
        flexDirection: "row",
    });
    row.add(new TextRenderable(renderer, {
        content: `${DIALOG_GUTTER}${label}`,
        fg: TUI_ACCENT,
        attributes: 1,
        width: "100%",
        height: 1,
    }));
    addMarker(renderer, row, marker, TUI_ACCENT);
    return row;
}

export interface DialogMetaPart {
    readonly text: string;
    readonly tone?: "detail" | "positive";
    /** A fixed column: half of one says nothing, so it goes whole or not at all. */
    readonly atomic?: boolean;
}

export type DialogMeta = string | readonly DialogMetaPart[];

function metaParts(meta: DialogMeta): readonly DialogMetaPart[] {
    return typeof meta === "string" ? [{ text: meta }] : meta;
}

function metaLength(meta: DialogMeta): number {
    return typeof meta === "string"
        ? meta.length
        : meta.reduce((total, part) => total + part.text.length, 0);
}

export interface DialogRowContent {
    readonly label: string;
    readonly background?: string;
    readonly leading?: string;
    readonly leadingTone?: "accent" | "muted" | "positive";
    readonly spaced?: boolean;
    readonly marker?: string;
    readonly description?: string;
    /** Muted text right after the label, inside the label column rather than aligned past it. */
    readonly note?: string;
    /** Lets a view find the label again to animate it without a full redraw. */
    readonly labelId?: string;
    readonly emphasis?: { readonly start: number; readonly length: number };
    readonly meta?: DialogMeta;
    readonly active: boolean;
    /** The cursor of a section that does not hold the keyboard. It stays visible, because what it points at is what another section is acting on, but it gives up the accent so only one fill on the card reads as focus. */
    readonly dimmed?: boolean;
    readonly current?: boolean;
    /** A group heading rendered as a row. It keeps the accent; a current row does not. */
    readonly heading?: boolean;
    readonly tint?: boolean;
    readonly wrap?: boolean;
    readonly card?: boolean;
    readonly onSelect?: () => void;
    readonly onHover?: () => void;
}

function labelWithEmphasis(
    label: string,
    color: string,
    emphasis: { readonly start: number; readonly length: number } | undefined,
): TextChunk[] {
    if (emphasis === undefined || emphasis.length <= 0) {
        return [fg(color)(label)];
    }
    const start = Math.max(0, Math.min(emphasis.start, label.length));
    const end = Math.min(label.length, start + emphasis.length);
    if (end <= start) return [fg(color)(label)];
    return [
        ...(start > 0 ? [fg(color)(label.slice(0, start))] : []),
        underline(bold(fg(color)(label.slice(start, end)))),
        ...(end < label.length ? [fg(color)(label.slice(end))] : []),
    ];
}

export interface DialogRowPointer {
    readonly activate?: (index: number) => void;
    readonly hover?: (index: number) => void;
}

export function dialogRowPointer(
    pointer: DialogRowPointer | undefined,
    index: number,
): Pick<DialogRowContent, "onSelect" | "onHover"> {
    if (pointer === undefined) {
        return {};
    }
    return {
        ...(pointer.activate === undefined
            ? {}
            : { onSelect: () => pointer.activate?.(index) }),
        ...(pointer.hover === undefined
            ? {}
            : { onHover: () => pointer.hover?.(index) }),
    };
}

export function attachDialogRowPointer(
    row: Renderable,
    pointer: DialogRowPointer | undefined,
    index: number,
): void {
    attachRowPointer(row, dialogRowPointer(pointer, index));
}

export function attachRowPointer(
    row: Renderable,
    handlers: Pick<DialogRowContent, "onSelect" | "onHover">,
): void {
    if (handlers.onSelect !== undefined) {
        row.onMouseDown = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            handlers.onSelect?.();
        };
    }
    if (handlers.onHover !== undefined) {
        row.onMouseMove = (event: MouseEvent) => {
            event.stopPropagation();
            if (!pointerMoved(event.x, event.y)) {
                return;
            }
            handlers.onHover?.();
        };
    }
}

let lastHoverX: number | undefined;
let lastHoverY: number | undefined;

export function resetDialogPointerTracking(): void {
    lastHoverX = undefined;
    lastHoverY = undefined;
}

function pointerMoved(x: number, y: number): boolean {
    if (x === lastHoverX && y === lastHoverY) {
        return false;
    }
    lastHoverX = x;
    lastHoverY = y;
    return true;
}

export function dialogOptionRows(
    renderer: RenderContext,
    contents: readonly DialogRowContent[],
    contentWidth?: number,
): BoxRenderable[] {
    const inline = contents.filter((content) => content.card !== true);
    const widestLabel = Math.max(
        0,
        ...inline.map((content) => labelWithNote(content).length),
    );
    const widestMeta = Math.max(
        0,
        ...inline.map((content) =>
            content.meta === undefined ? 0 : metaLength(content.meta)
        ),
    );
    const labelWidth = contentWidth === undefined ? widestLabel : Math.min(
        widestLabel,
        Math.max(
            Math.min(widestLabel, Math.floor(contentWidth * LABEL_SHARE)),
            contentWidth - (widestMeta === 0 ? 0 : widestMeta + META_GAP),
        ),
    );
    const metaWidth = contentWidth === undefined || widestMeta === 0
        ? widestMeta
        : Math.max(0, Math.min(widestMeta, contentWidth - labelWidth - META_GAP));
    const budget = contentWidth === undefined
        ? undefined
        : contentWidth - labelWidth - DESCRIPTION_GAP
            - (metaWidth === 0 ? 0 : metaWidth + META_GAP);
    return contents.map((content) => {
        if (content.card === true) {
            return dialogOptionRow(renderer, {
                ...content,
                ...(contentWidth === undefined
                    ? {}
                    : { label: clipped(content.label, contentWidth) }),
                ...(content.meta === undefined || contentWidth === undefined
                    ? {}
                    : {
                        meta: clippedMeta(
                            metaParts(content.meta),
                            contentWidth,
                            false,
                        ),
                    }),
            });
        }
        const fitted = clipped(labelWithNote(content), labelWidth).padEnd(labelWidth);
        const labelEnd = Math.min(content.label.length, fitted.length);
        const notePart = fitted.slice(labelEnd);
        return dialogOptionRow(renderer, {
            ...content,
            label: content.note === undefined ? fitted : fitted.slice(0, labelEnd),
            ...(content.note === undefined ? {} : { note: notePart }),
            ...(budget === undefined || budget < DESCRIPTION_MINIMUM
                    || content.description === undefined
                ? {}
                : { description: clipped(content.description, budget) }),
            ...(content.meta === undefined ? {} : {
                meta: clippedMeta(metaParts(content.meta), metaWidth),
            }),
        });
    });
}

function labelWithNote(content: DialogRowContent): string {
    return content.note === undefined ? content.label : `${content.label} ${content.note}`;
}

function clippedMeta(
    parts: readonly DialogMetaPart[],
    width: number,
    pad = true,
): readonly DialogMetaPart[] {
    const kept: DialogMetaPart[] = [];
    let used = 0;
    for (const part of parts) {
        const room = width - used;
        if (room <= 0) {
            break;
        }
        if (part.text.length <= room) {
            kept.push(part);
            used += part.text.length;
            continue;
        }
        if (part.atomic === true) {
            break;
        }
        const text = clipped(part.text, room);
        if (text.length > 0) {
            kept.push({ ...part, text });
            used += text.length;
        }
        break;
    }
    const cut = parts.map((part) => part.text).join("").slice(used).trim().length > 0;
    const last = kept.at(-1);
    if (cut && last !== undefined && !last.text.endsWith("…")) {
        const trimmed = last.text.trimEnd();
        const text = used < width
            ? `${trimmed}…`
            : `${trimmed.slice(0, Math.max(0, trimmed.length - 1))}…`;
        kept[kept.length - 1] = { ...last, text };
        used += text.length - last.text.length;
    }
    return pad
        ? [{ text: " ".repeat(META_GAP + width - used) }, ...kept]
        : kept;
}

const DESCRIPTION_GAP = 2;

/** Narrower than this and a description is only its own ellipsis. */
const DESCRIPTION_MINIMUM = 4;

const META_GAP = 2;

const LABEL_SHARE = 0.4;

/** Fit parts into a fixed column, keeping fixed sub-columns whole. */
export function clipDialogMetaParts(
    parts: readonly DialogMetaPart[],
    width: number,
): readonly DialogMetaPart[] {
    return clippedMeta(parts, width, false);
}

/** How wide the meta column can get once the labels have taken their share. */
export function dialogMetaRoom(
    contentWidth: number,
    widestLabel: number,
): number {
    return Math.max(
        0,
        contentWidth
            - Math.min(widestLabel, Math.floor(contentWidth * LABEL_SHARE))
            - META_GAP,
    );
}

function clipped(text: string, budget: number): string {
    if (budget <= 0) {
        return "";
    }
    if (text.length <= budget) {
        return text;
    }
    const trimmed = text.trimEnd();
    return trimmed.length <= budget
        ? trimmed
        : `${text.slice(0, budget - 1).trimEnd()}…`;
}

export function dialogOptionRow(
    renderer: RenderContext,
    content: DialogRowContent,
): BoxRenderable {
    const lit = content.active && content.dimmed !== true;
    const background = lit
        ? TUI_ACCENT
        : content.active || content.tint === true
            ? TUI_ELEMENT
            : content.background ?? TUI_PANEL;
    // Group headings own the accent. A current row carries the word "current",
    // so tinting it too made the two read alike.
    const label = lit
        ? TUI_SELECTION_TEXT
        : content.heading === true
        ? TUI_ACCENT
        : TUI_TEXT;
    const accent = lit ? TUI_SELECTION_TEXT : TUI_ACCENT;
    const detail = lit ? TUI_SELECTION_TEXT : TUI_MUTED;
    if (content.card === true) {
        return cardRow(renderer, content, { background, label, accent, detail });
    }
    const row = new BoxRenderable(renderer, {
        width: "100%",
        height: content.wrap ? "auto" : 1,
        flexDirection: "row",
        backgroundColor: background,
        ...(content.spaced === true ? { marginTop: 1 } : {}),
    });
    attachRowPointer(row, content);
    addMarker(renderer, row, content.marker, TUI_ACCENT);
    if (content.leading !== undefined && content.leading.length > 0) {
        const leadingColor = content.leadingTone === "muted"
            ? detail
            : content.leadingTone === "positive"
            ? lit ? TUI_SELECTION_TEXT : TUI_SUCCESS
            : accent;
        row.add(new TextRenderable(renderer, {
            content: new StyledText([
                fg(leadingColor)(content.leading),
            ]),
            bg: background,
            flexShrink: 0,
        }));
    }
    const labelChunks: TextChunk[] = labelWithEmphasis(
        content.label,
        label,
        content.emphasis,
    );
    if (content.note !== undefined) {
        labelChunks.push(fg(detail)(content.note));
    }
    if (content.description !== undefined) {
        labelChunks.push(fg(detail)(`  ${content.description}`));
    }
    row.add(new TextRenderable(renderer, {
        ...(content.labelId === undefined ? {} : { id: content.labelId }),
        content: new StyledText(labelChunks),
        bg: background,
        attributes: content.active || content.current === true || content.heading === true ? 1 : 0,
        flexGrow: 1,
        flexShrink: 1,
        ...(content.wrap
            ? { wrapMode: "word" as const }
            : { wrapMode: "none" as const, overflow: "hidden" as const }),
    }));
    if (content.meta !== undefined) {
        const positive = content.active ? TUI_SELECTION_TEXT : TUI_SUCCESS;
        row.add(new TextRenderable(renderer, {
            content: new StyledText(metaParts(content.meta).map((part) =>
                fg(part.tone === "positive" ? positive : detail)(part.text)
            )),
            bg: background,
            flexShrink: 0,
        }));
    }
    return row;
}

function cardRow(
    renderer: RenderContext,
    content: DialogRowContent,
    colors: {
        readonly background: string;
        readonly label: string;
        readonly accent: string;
        readonly detail: string;
    },
): BoxRenderable {
    const { background, label, accent, detail } = colors;
    const card = new BoxRenderable(renderer, {
        width: "100%",
        height: content.meta === undefined ? 2 : 3,
        flexDirection: "column",
        backgroundColor: TUI_PANEL,
    });
    attachRowPointer(card, content);
    addMarker(renderer, card, content.marker, TUI_ACCENT);
    card.add(cardLine(renderer, background, accent, content.leading ?? "", [
        fg(label)(content.label),
        ...(content.description === undefined
            ? []
            : [fg(detail)(`  ${content.description}`)]),
    ], content.active || content.current === true || content.heading === true ? 1 : 0));
    if (content.meta !== undefined) {
        const positive = content.active ? TUI_SELECTION_TEXT : TUI_SUCCESS;
        card.add(cardLine(renderer, background, accent, "", [
            ...metaParts(content.meta).map((part) =>
                fg(part.tone === "positive" ? positive : detail)(part.text)
            ),
        ], 0));
    }
    return card;
}

function addMarker(
    renderer: RenderContext,
    row: BoxRenderable,
    marker: string | undefined,
    accent: string,
): void {
    if (marker === undefined || marker.length === 0) {
        return;
    }
    row.add(new TextRenderable(renderer, {
        content: new StyledText([fg(accent)(marker)]),
        position: "absolute",
        left: -(marker.length + 1),
        top: 0,
    }));
}

function cardLine(
    renderer: RenderContext,
    background: string,
    accent: string,
    leading: string,
    chunks: readonly TextChunk[],
    attributes: number,
): BoxRenderable {
    const line = new BoxRenderable(renderer, {
        width: "100%",
        height: 1,
        flexDirection: "row",
        backgroundColor: background,
    });
    if (leading.length > 0) {
        line.add(new TextRenderable(renderer, {
            content: new StyledText([fg(accent)(leading)]),
            bg: background,
            flexShrink: 0,
        }));
    }
    line.add(new TextRenderable(renderer, {
        content: new StyledText([...chunks]),
        bg: background,
        attributes,
        flexGrow: 1,
        flexShrink: 1,
        wrapMode: "none",
        overflow: "hidden",
    }));
    return line;
}
