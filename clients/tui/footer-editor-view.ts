import {
    bg,
    BoxRenderable,
    fg,
    StyledText,
    TextRenderable,
    type RenderContext,
    type TextChunk,
} from "@opentui/core";

import { centeredDialogSurface, dialogHeaderNode, updateDialogHeaderTitle } from "./dialog-chrome.ts";
import {
    footerEditorFit,
    footerEditorFocusedItem,
    footerMisfits,
    type FooterEditorState,
} from "./footer-editor.ts";
import { chunksWidth, type FooterFit, type FooterItemFate } from "./footer-fit.ts";
import {
    FOOTER_ITEM_LABELS,
    FOOTER_LOCKED_SHOWN,
    FOOTER_ROWS,
    FOOTER_SLOTS_PER_ROW,
    FOOTER_STANDARD_COLUMNS,
    FOOTER_STANDARD_TERMINAL,
    footerItemShown,
    footerRowCount,
    type FooterItemId,
} from "./footer-layout.ts";
import { TUI_ACCENT, TUI_ELEMENT, TUI_MUTED, TUI_NOTICE, TUI_PANEL, TUI_SELECTION_TEXT, TUI_TEXT } from "./palette.ts";
import { statusChunkColor, type TuiStatusChunk } from "./status.ts";
import { tuiThemeProperties, type TuiThemeBinding } from "./theme-bindings.ts";

export interface FooterEditorView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    update(state: FooterEditorState): void;
}

const SLOTS_HINT = "↑↓←→ slot · enter pick up · space hide · esc save";
const CARRY_HINT = "↑↓←→ move · enter put down · esc undo";
const PREVIEW_HINT = "←→ idle or working · ↓ slots · esc save";
const RESET_HINT = "enter reset · ↑ slots · esc save";
const FIELD_COLUMNS = 11;
const CELL_COLUMNS = FOOTER_STANDARD_COLUMNS / FOOTER_SLOTS_PER_ROW;
// Horizontal padding inside the card, both sides.
const CARD_PADDING = 4;
const CANVAS_INDENT = 2;
export const FOOTER_EDITOR_CARD_COLUMNS = FOOTER_STANDARD_COLUMNS + CANVAS_INDENT + CARD_PADDING;

export function footerEditorHint(state: FooterEditorState): string {
    if (state.carry !== undefined) return CARRY_HINT;
    if (state.field === "preview") return PREVIEW_HINT;
    if (state.field === "reset") return RESET_HINT;
    return SLOTS_HINT;
}

export function footerEditorTitle(state: FooterEditorState): string {
    return state.carry === undefined ? "Footer layout" : `Footer layout › moving ${FOOTER_ITEM_LABELS[state.carry.item]}`;
}

// Colours are read per call so a theme change shows on the next frame.
export function footerEditorBody(state: FooterEditorState): { readonly chunks: TextChunk[]; readonly lines: number } {
    const fit = footerEditorFit(state);
    const misfits = footerMisfits(state.layout, state.seed);
    const indent = fg(TUI_MUTED)(" ".repeat(CANVAS_INDENT));
    const lines: TextChunk[][] = [
        previewRow(state),
        [],
        ...canvasLines(state, fit, footerEditorFocusedItem(state)),
        [],
        [indent, fg(TUI_MUTED)(`Drawn at ${FOOTER_STANDARD_TERMINAL} columns. Higher numbers give way first.`)],
        [],
        ...gridLines(state, misfits),
        [],
        [indent, ...details(state, fit, misfits)],
        [],
        [fg(TUI_ACCENT)(state.field === "reset" ? "❯ " : "  "), fg(state.field === "reset" ? TUI_TEXT : TUI_MUTED)("Reset to default")],
    ];
    return { chunks: joinLines(lines), lines: lines.length };
}

function joinLines(lines: readonly TextChunk[][]): TextChunk[] {
    const chunks: TextChunk[] = [];
    lines.forEach((line, index) => {
        if (index > 0) chunks.push(fg(TUI_TEXT)("\n"));
        chunks.push(...line);
    });
    return chunks;
}

function previewRow(state: FooterEditorState): TextChunk[] {
    const active = state.field === "preview" && state.carry === undefined;
    return [
        fg(TUI_ACCENT)(active ? "❯ " : "  "),
        fg(active ? TUI_TEXT : TUI_MUTED)("Preview".padEnd(FIELD_COLUMNS)),
        fg(active ? TUI_ACCENT : TUI_MUTED)("‹ "),
        fg(active ? TUI_TEXT : TUI_MUTED)(state.preview),
        fg(active ? TUI_ACCENT : TUI_MUTED)(" ›"),
    ];
}

// The numbered slots, four to a row, with the cursor's cell lit.
function gridLines(state: FooterEditorState, misfits: ReadonlySet<FooterItemId>): TextChunk[][] {
    const lines: TextChunk[][] = [];
    const focused = state.field === "slots" || state.carry !== undefined;
    for (let row = 0; row < FOOTER_ROWS; row += 1) {
        const line: TextChunk[] = [fg(TUI_MUTED)(" ".repeat(CANVAS_INDENT))];
        for (let column = 0; column < FOOTER_SLOTS_PER_ROW; column += 1) {
            const slot = row * FOOTER_SLOTS_PER_ROW + column;
            const item = state.layout.slots[slot] ?? null;
            const number = String(slot + 1).padStart(2);
            const label = item === null ? "·" : FOOTER_ITEM_LABELS[item];
            const text = `${number} ${label}`.padEnd(CELL_COLUMNS);
            if (focused && slot === state.slot) {
                line.push(bg(TUI_ACCENT)(fg(TUI_SELECTION_TEXT)(text)));
                continue;
            }
            const color = item === null || !footerItemShown(state.layout, item)
                ? TUI_MUTED
                : misfits.has(item) ? TUI_NOTICE : TUI_TEXT;
            line.push(fg(TUI_MUTED)(number), fg(color)(text.slice(number.length)));
        }
        lines.push(line);
    }
    return lines;
}

// One line about the focused slot: what is in it and how it fares.
function details(state: FooterEditorState, fit: FooterFit, misfits: ReadonlySet<FooterItemId>): TextChunk[] {
    if (state.field === "preview" && state.carry === undefined) {
        return [fg(TUI_MUTED)("The example footer idle, or mid-turn.")];
    }
    if (state.field === "reset" && state.carry === undefined) {
        return [fg(TUI_MUTED)("Puts every item back in its default slot, shown always.")];
    }
    const item = state.layout.slots[state.slot] ?? null;
    if (item === null) return [fg(TUI_MUTED)(`Slot ${state.slot + 1} is empty.`)];
    const note = itemNote(state, item, fit.fates.get(item), misfits.has(item));
    return [
        fg(TUI_TEXT)(`Slot ${state.slot + 1}: ${FOOTER_ITEM_LABELS[item]}`),
        ...(note === undefined ? [] : [fg(TUI_MUTED)(" · "), fg(note.warn ? TUI_NOTICE : TUI_MUTED)(note.text)]),
    ];
}

function itemNote(
    state: FooterEditorState,
    item: FooterItemId,
    fate: FooterItemFate | undefined,
    misfit: boolean,
): { readonly text: string; readonly warn: boolean } | undefined {
    if (misfit) return { text: `left out at ${FOOTER_STANDARD_TERMINAL}`, warn: true };
    if (FOOTER_LOCKED_SHOWN.has(item) && fate !== "shortened") return { text: "can't hide", warn: false };
    switch (fate) {
        case "shortened":
            return { text: "shortened", warn: false };
        case "hidden":
            return { text: "hidden", warn: false };
        case "empty":
            return { text: state.preview === "idle" ? "shows while working" : "shows while idle", warn: false };
        default:
            return undefined;
    }
}

// The footer at the standard width on an element background. Rows it does
// not use are dashed so a move onto them is visible.
function canvasLines(state: FooterEditorState, fit: FooterFit, highlight: FooterItemId | undefined): TextChunk[][] {
    const lines: TextChunk[][] = [];
    const indent = fg(TUI_MUTED)(" ".repeat(CANVAS_INDENT));
    const used = footerRowCount(state.layout);
    for (let row = 0; row < FOOTER_ROWS; row += 1) {
        if (row >= used) {
            lines.push([indent, fg(TUI_ELEMENT)("╌".repeat(FOOTER_STANDARD_COLUMNS))]);
            continue;
        }
        const chunks = fit.rows[row] ?? [];
        const padded: TuiStatusChunk[] = [
            ...chunks,
            { text: " ".repeat(Math.max(0, FOOTER_STANDARD_COLUMNS - chunksWidth(chunks))), tone: "muted" },
        ];
        // An empty item still holds its width; lighting that space draws a bare block.
        const span = highlight === undefined || fit.fates.get(highlight) === "empty" ? undefined : fit.spans.get(highlight);
        lines.push([indent, ...paintRow(padded, span !== undefined && span.row === row + 1 ? span : undefined)]);
    }
    return lines;
}

function paintRow(chunks: readonly TuiStatusChunk[], lit: { readonly start: number; readonly end: number } | undefined): TextChunk[] {
    const out: TextChunk[] = [];
    let column = 0;
    for (const chunk of chunks) {
        let run = "";
        let runLit = false;
        const flush = (): void => {
            if (run.length === 0) return;
            out.push(runLit
                ? bg(TUI_ACCENT)(fg(TUI_SELECTION_TEXT)(run))
                : bg(TUI_ELEMENT)(fg(statusChunkColor(chunk))(run)));
            run = "";
        };
        for (const character of chunk.text) {
            const inside = lit !== undefined && column >= lit.start && column < lit.end;
            if (inside !== runLit) {
                flush();
                runLit = inside;
            }
            run += character;
            column += Bun.stringWidth(character);
        }
        flush();
    }
    return out;
}

export function createFooterEditorView(renderer: RenderContext): FooterEditorView {
    const header = dialogHeaderNode(renderer, "Footer layout");
    const body = new TextRenderable(renderer, {
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: 1,
        wrapMode: "none",
        marginTop: 1,
    });
    const hint = new TextRenderable(renderer, {
        content: SLOTS_HINT,
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        wrapMode: "none",
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "footer-editor",
        border: false,
        backgroundColor: TUI_PANEL,
        width: FOOTER_EDITOR_CARD_COLUMNS,
        height: "auto",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
    });
    box.add(header);
    box.add(body);
    box.add(hint);
    const surface = centeredDialogSurface(renderer, "footer-editor-surface", box);
    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(hint, { fg: "muted" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        update(state): void {
            box.width = Math.max(1, Math.min(renderer.width - 2, FOOTER_EDITOR_CARD_COLUMNS));
            updateDialogHeaderTitle(header, footerEditorTitle(state));
            const drawn = footerEditorBody(state);
            body.content = new StyledText(drawn.chunks);
            body.height = drawn.lines;
            hint.content = state.refused === undefined
                ? new StyledText([fg(TUI_MUTED)(footerEditorHint(state))])
                : new StyledText([fg(TUI_NOTICE)(state.refused)]);
        },
    };
}
