import {
    BoxRenderable,
    fg,
    type MouseEvent,
    parseColor,
    type Renderable,
    StyledText,
    type TextChunk,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";

// Shared building blocks for Vera's overlay dialogs. Every picker/dialog is an
// unbordered card: a bold title with an "esc" affordance, an optional search
// line, highlight-bar rows, and a muted footer of key hints. Keeping these in
// one place means the model picker, theme picker, question, approval, and
// rewind dialogs stay visually identical instead of drifting apart.

// Rows start on the card's own left padding. A row's leading text, when it has
// any, is content: a fold arrow, a connected tick, a session's time column. No
// row reserves columns for a marker it may never draw, so a title, a search
// line and a list of rows all begin on the same column.
export const DIALOG_GUTTER_WIDTH = 0;

/** Kept for the nodes that align themselves against a row's leading text. */
export const DIALOG_GUTTER = "";

// How many rows a card spends on chrome rather than on rows: the header, the
// three-line search block, the footer and the blank line above it, and the
// card's own top padding. Cards size themselves from their content, so this is
// only the row budget a list windows itself to, never a card's height.
export const DIALOG_CHROME_HEIGHT = 9;

/** How far a card holds its content off its own left and right edges. */
export const DIALOG_CARD_PADDING = 4;

// One stacking contract for every modal surface. Conversation chrome stays
// below the scrim, and every active card stays above it; individual dialogs do
// not negotiate z-order with the status band or with one another.
export const DIALOG_BACKGROUND_Z_INDEX = 4;
export const DIALOG_SCRIM_Z_INDEX = 10;
export const DIALOG_CARD_Z_INDEX = 20;
/** Foreground attenuation for conversation chrome behind an active modal. */
export const DIALOG_BACKGROUND_OPACITY = 0.35;

// Below this height an overlay cannot spare a row. The question overlay draws
// the same line for its own height cap, so "short" means one thing in the TUI
// rather than two.
export const DIALOG_SHORT_TERMINAL_HEIGHT = 10;

/**
 * How far above the bottom a bottom-anchored overlay sits.
 *
 * Bottom-anchored cards hold one row above the terminal edge when room allows,
 * keeping their final hint row clear of terminal chrome. On a short terminal
 * that row has to stay with the content instead, so short terminals use the
 * smaller offset.
 *
 * Overlays re-read this on update, not on resize: `RenderContext` exposes no
 * resize hook, and the adjacent `maxHeight` short-terminal rule already works
 * this way. So a terminal resized across the threshold with an overlay already
 * open keeps the old offset until that overlay next updates.
 */
export function dialogBottomOffset(renderer: RenderContext): number {
    return renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT ? 1 : 2;
}

/** Full-screen flex surface that keeps a variable-height dialog card centered. */
export function centeredDialogSurface(
    renderer: RenderContext,
    id: string,
    card: BoxRenderable,
): BoxRenderable {
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

export function dialogHeaderNode(
    renderer: RenderContext,
    title: string,
    hint = "esc",
): BoxRenderable {
    const header = new BoxRenderable(renderer, {
        width: "100%",
        height: 1,
        flexDirection: "row",
        justifyContent: "space-between",
    });
    header.add(new TextRenderable(renderer, {
        content: title,
        fg: TUI_TEXT,
        attributes: 1,
    }));
    header.add(new TextRenderable(renderer, {
        content: hint,
        fg: TUI_MUTED,
    }));
    return header;
}

/**
 * The search line of a dialog. It parks the terminal's own cursor on the caret
 * cell, so the caret blinks the way the terminal draws it everywhere else, and
 * hides it again when the dialog goes away.
 */
class DialogSearchRenderable extends TextRenderable {
    caretColumn = 0;

    protected override renderSelf(
        buffer: Parameters<TextRenderable["renderSelf"]>[0],
    ): void {
        super.renderSelf(buffer);
        // One-based: the terminal counts its own cursor from column and row 1.
        this._ctx.setCursorPosition(this.x + this.caretColumn + 1, this.y + 1, true);
    }

    protected override destroySelf(): void {
        this._ctx.setCursorPosition(0, 0, false);
        super.destroySelf();
    }
}

export function dialogSearchNode(
    renderer: RenderContext,
    query: string,
    placeholder = "Search",
    // A view that holds nothing to filter still draws the field, so moving on
    // and off it does not shift the rest of the card. It parks no caret: a
    // blinking cursor is what says a field takes typing.
    live = true,
): TextRenderable {
    const typed = query.length > 0;
    if (!live) {
        return new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_MUTED)(placeholder)]),
            width: "100%",
            height: 2,
            marginTop: 1,
        });
    }
    renderer.setCursorStyle({
        style: "block",
        blinking: true,
        color: parseColor(TUI_ACCENT),
    });
    const node = new DialogSearchRenderable(renderer, {
        content: new StyledText([
            typed ? fg(TUI_TEXT)(query) : fg(TUI_MUTED)(placeholder),
        ]),
        width: "100%",
        height: 2,
        // A blank line above and below: the search line is the card's second
        // thing to read, not a subtitle stuck to the title.
        marginTop: 1,
    });
    // On an empty field the caret sits on the first letter of the placeholder,
    // which is what makes the line read as a live input without a magnifier or
    // a bar to explain it.
    node.caretColumn = query.length;
    return node;
}

export function dialogFooterNode(
    renderer: RenderContext,
    hint: string,
): TextRenderable {
    // marginTop, not paddingTop: these text nodes lay their content out from
    // the first line of the box, so padding would put the blank line under the
    // hints rather than above them. The margin also collapses first when the
    // card runs short, which keeps the hints on screen.
    return new TextRenderable(renderer, {
        content: hint,
        fg: TUI_MUTED,
        width: "100%",
        height: 2,
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

/**
 * One run of the meta column. A tone rather than a color: rows do not pick
 * palette entries, so an affirmative fact reads the same here as everywhere
 * else and still flips for contrast on the highlighted row.
 */
export interface DialogMetaPart {
    readonly text: string;
    readonly tone?: "detail" | "positive";
}

/** A plain meta string is the whole column in the detail tone. */
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
    // Fixed gutter text before the label (a current-choice dot, a choice
    // number, a group name). Accent-toned unless the row is active, or muted
    // when the gutter names something the eye should pass over.
    readonly leading?: string;
    readonly leadingTone?: "accent" | "muted";
    // A blank line above the row, for lists that separate runs of rows with a
    // gap rather than a heading.
    readonly spaced?: boolean;
    // A one- or two-cell mark that hangs in the card's left padding: the dot on
    // the choice in effect, a section's fold arrow, a provider's tick. It sits
    // outside the flow, so a list where only one row is marked still starts
    // every label on the column the title and the search line start on.
    readonly marker?: string;
    // Follows the label inline in the muted tone.
    readonly description?: string;
    // Right-aligned trailing column in the muted tone (e.g. a provider name).
    // A list of parts lets one fact in the column carry its own tone.
    readonly meta?: DialogMeta;
    readonly active: boolean;
    readonly current?: boolean;
    // Alternating band, for lists long enough that blank separators would cost
    // more rows than they earn. Ignored while the row is active.
    readonly tint?: boolean;
    // Wrapping rows grow to fit their label; the highlight bar covers every
    // wrapped line. Non-wrapping rows stay one line and clip.
    readonly wrap?: boolean;
    // Two-line card instead of a row: the label on its own line and the meta
    // column on the next, still right-aligned. For lists whose meta column
    // carries several facts, where one line packs the two into a width that
    // reads as a wall.
    readonly card?: boolean;
    // A click on the row. Rows are the only thing an overlay does, so a click
    // means the same as moving the cursor here and pressing ⏎ rather than a
    // separate "select, then confirm" step.
    readonly onSelect?: () => void;
    // The pointer entering the row. Moving the highlight under the pointer is
    // what makes the row look clickable, since these dialogs have no other
    // hover state.
    readonly onHover?: () => void;
}

/**
 * What an overlay does with the pointer, in the overlay's own row indices.
 *
 * Views take one of these and hand it to their rows; they never see a
 * `MouseEvent`. `activate` means the same as ⏎ on that row and `hover` the same
 * as moving the cursor to it, so a surface only has to say which index a row
 * is, not what clicking one means.
 */
export interface DialogRowPointer {
    readonly activate?: (index: number) => void;
    readonly hover?: (index: number) => void;
}

/**
 * The `onSelect`/`onHover` pair for one row, ready to spread into its content.
 */
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

/**
 * The same wiring for a row a surface built itself rather than through
 * `dialogOptionRow` (the theme picker draws its own palette swatches). Handlers
 * live in one place either way, so pointer behaviour cannot drift between the
 * two kinds of row.
 */
export function attachDialogRowPointer(
    row: Renderable,
    pointer: DialogRowPointer | undefined,
    index: number,
): void {
    attachRowPointer(row, dialogRowPointer(pointer, index));
}

function attachRowPointer(
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
        // `over` also fires when a newly opened or rebuilt row appears beneath
        // a stationary pointer. Using it would move a fresh picker's cursor
        // away from index zero before the user moves the mouse.
        row.onMouseMove = (event: MouseEvent) => {
            event.stopPropagation();
            if (!pointerMoved(event.x, event.y)) {
                return;
            }
            handlers.onHover?.();
        };
    }
}

/**
 * Whether the pointer itself moved, as opposed to a row moving under it.
 *
 * These lists window around the cursor, so a hover that moves the cursor
 * re-centres the window and slides a different row beneath a pointer that never
 * moved. That row reports a hover of its own, moving the cursor again: the
 * highlight runs away, several rows per row the user actually travelled. Only
 * the first hover at a given position is the user's, so the rest are dropped.
 *
 * One module-level position rather than one per row: there is a single pointer,
 * and rows are rebuilt on every render, so per-row state would reset exactly
 * when the loop is running.
 */
let lastHoverX: number | undefined;
let lastHoverY: number | undefined;

/**
 * Forget where the pointer was.
 *
 * The tracker is process-wide because the pointer is. That is right for the
 * TUI, which has one of each, and wrong for a test file, where the position
 * left by one test would suppress the first hover of the next.
 */
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

/**
 * Build a group of rows with one shared label column. Dialogs can pass their
 * whole option list here, so descriptions remain readable when labels vary in
 * length without each picker inventing its own padding.
 */
export function dialogOptionRows(
    renderer: RenderContext,
    contents: readonly DialogRowContent[],
    contentWidth?: number,
): BoxRenderable[] {
    // A card row spends a whole line on its label and another on its meta, so
    // neither column is sized against the other.
    if (contents.some((content) => content.card === true)) {
        return contents.map((content) => dialogOptionRow(renderer, {
            ...content,
            ...(contentWidth === undefined
                ? {}
                : { label: clipped(content.label, contentWidth) }),
            // Left under the label, not right-aligned: the two lines are a
            // name and what is known about it, and a column pushed to the far
            // edge reads as belonging to the row above it.
            ...(content.meta === undefined || contentWidth === undefined
                ? {}
                : {
                    meta: clippedMeta(
                        metaParts(content.meta),
                        contentWidth,
                        false,
                    ),
                }),
        }));
    }
    const widestLabel = Math.max(
        0,
        ...contents.map((content) => content.label.length),
    );
    const widestMeta = Math.max(
        0,
        ...contents.map((content) =>
            content.meta === undefined ? 0 : metaLength(content.meta)
        ),
    );
    // Neither column shrinks on its own: the layout takes any overflow out of
    // the label, mid-word and without an ellipsis, and then cuts whatever meta
    // still hangs off the right edge. So both columns are sized here. The name
    // is what a row is picked on, so it keeps its share of a narrow pane even
    // when the meta column would rather have it.
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
    // Without a width the description simply runs until the layout clips it,
    // which is what it did before rows carried a meta column: the two met with
    // no gap, and a sentence sheared mid-word against a provider name reads as
    // one mangled word rather than as two columns.
    const budget = contentWidth === undefined
        ? undefined
        : contentWidth - labelWidth - DESCRIPTION_GAP
            - (metaWidth === 0 ? 0 : metaWidth + META_GAP);
    return contents.map((content) => dialogOptionRow(renderer, {
        ...content,
        label: clipped(content.label, labelWidth).padEnd(labelWidth),
        ...(budget === undefined || content.description === undefined
            ? {}
            : { description: clipped(content.description, budget) }),
        // The column is padded to one width so it reads as a column. Rows
        // without a meta value keep none, since a blank column is not a fact.
        ...(content.meta === undefined ? {} : {
            meta: clippedMeta(metaParts(content.meta), metaWidth),
        }),
    }));
}

/**
 * One row's meta column, clipped to the column and padded to its right edge.
 * Parts are dropped from the end so a fact is either whole or gone, and the
 * last one kept carries the ellipsis when it had to be cut.
 */
function clippedMeta(
    parts: readonly DialogMetaPart[],
    width: number,
    pad = true,
): readonly DialogMetaPart[] {
    const kept: DialogMetaPart[] = [];
    let used = 0;
    let cut = false;
    for (const part of parts) {
        const room = width - used;
        if (room <= 0) {
            cut = true;
            break;
        }
        if (part.text.length <= room) {
            kept.push(part);
            used += part.text.length;
            continue;
        }
        // The first part that does not fit takes the ellipsis and ends the
        // column: a part after a cut would read as though nothing was lost.
        const text = clipped(part.text, room);
        cut = true;
        if (text.length > 0) {
            kept.push({ ...part, text });
            used += text.length;
        }
        break;
    }
    // A column cut on a part boundary is still a column with facts missing, so
    // it says so the same way a cut mid-word does.
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

/** The two spaces `dialogOptionRow` puts between the label and description. */
const DESCRIPTION_GAP = 2;

/** The gap that keeps the description off the meta column. */
const META_GAP = 2;

/** The share of a narrow row the label column keeps from the meta column. */
const LABEL_SHARE = 0.4;

function clipped(text: string, budget: number): string {
    if (budget <= 0) {
        return "";
    }
    return text.length <= budget
        ? text
        : `${text.slice(0, budget - 1).trimEnd()}…`;
}

export function dialogOptionRow(
    renderer: RenderContext,
    content: DialogRowContent,
): BoxRenderable {
    const background = content.active
        ? TUI_ACCENT
        : content.tint === true
            ? TUI_ELEMENT
            : TUI_PANEL;
    const label = content.active
        ? TUI_BACKGROUND
        : content.current
            ? TUI_ACCENT
            : TUI_TEXT;
    const accent = content.active ? TUI_BACKGROUND : TUI_ACCENT;
    const detail = content.active ? TUI_BACKGROUND : TUI_MUTED;
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
    // Every dialog row in the TUI is built here, so pointer support is one
    // wiring rather than one per overlay. A row without handlers behaves
    // exactly as it did before.
    attachRowPointer(row, content);
    addMarker(renderer, row, content.marker, TUI_ACCENT);
    // Only when there is leading text to draw: an empty text node still takes
    // a column, which would push every label one off the title above it.
    if (content.leading !== undefined && content.leading.length > 0) {
        row.add(new TextRenderable(renderer, {
            content: new StyledText([
                fg(content.leadingTone === "muted" ? detail : accent)(
                    content.leading,
                ),
            ]),
            bg: background,
            flexShrink: 0,
        }));
    }
    const labelChunks: TextChunk[] = [fg(label)(content.label)];
    if (content.description !== undefined) {
        labelChunks.push(fg(detail)(`  ${content.description}`));
    }
    row.add(new TextRenderable(renderer, {
        content: new StyledText(labelChunks),
        bg: background,
        attributes: content.active || content.current === true ? 1 : 0,
        flexGrow: 1,
        flexShrink: 1,
        ...(content.wrap
            ? { wrapMode: "word" as const }
            : { wrapMode: "none" as const, overflow: "hidden" as const }),
    }));
    if (content.meta !== undefined) {
        // The active row paints its whole width in the accent, so every tone
        // collapses to the background color there: a green on accent is the
        // one combination in this column that cannot be read.
        const positive = content.active ? TUI_BACKGROUND : TUI_SUCCESS;
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


/**
 * A card row: the label on one line, what is known about it on the next, and
 * a blank line to the card below. Two lines rather than one so the facts read
 * as facts instead of as a wall against the name.
 */
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
        // The blank line to the next card sits inside this box, painted in
        // the panel colour, so the highlight ends with the facts.
        backgroundColor: TUI_PANEL,
    });
    attachRowPointer(card, content);
    addMarker(renderer, card, content.marker, TUI_ACCENT);
    card.add(cardLine(renderer, background, accent, content.leading ?? "", [
        fg(label)(content.label),
        ...(content.description === undefined
            ? []
            : [fg(detail)(`  ${content.description}`)]),
    ], content.active || content.current === true ? 1 : 0));
    if (content.meta !== undefined) {
        // The active row paints its whole width in the accent, so every tone
        // collapses to the background color there.
        const positive = content.active ? TUI_BACKGROUND : TUI_SUCCESS;
        card.add(cardLine(renderer, background, accent, "", [
            ...metaParts(content.meta).map((part) =>
                fg(part.tone === "positive" ? positive : detail)(part.text)
            ),
        ], 0));
    }
    return card;
}

/**
 * The hanging mark, drawn in the padding to the left of the label column. It
 * sits outside the row's box, so it stays on the panel colour even while the
 * row is highlighted and keeps the accent the rest of the gutter uses.
 */
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

/**
 * One line of a card: the gutter, then the line's own chunks. A box holding
 * the text rather than the text alone, because a text node paints only the
 * cells it fills and the highlight has to reach the card's edge.
 */
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
