import {
    BoxRenderable,
    fg,
    type MouseEvent,
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

// Each row reserves leading columns so a current-choice marker and the row
// label line up on the same column whether or not the marker is present. The
// gutter is written into the content rather than set as padding: text nodes
// lay their content out from column zero, so only the card's own padding sets
// the left margin every line shares.
export const DIALOG_GUTTER_WIDTH = 3;

/** The gutter as literal columns, for the nodes that carry no leading chunk. */
export const DIALOG_GUTTER = " ".repeat(DIALOG_GUTTER_WIDTH);

// The card chrome that surrounds a variable-height row list: the header line,
// the three-line search block, the footer with its separating blank line, and
// the card's own top padding.
export const DIALOG_CHROME_HEIGHT = 9;

// Below this height an overlay cannot spare a row. The question overlay draws
// the same line for its own height cap, so "short" means one thing in the TUI
// rather than two.
export const DIALOG_SHORT_TERMINAL_HEIGHT = 10;

/**
 * How far above the bottom a bottom-anchored overlay sits.
 *
 * The status line is drawn over these overlays (`zIndex: 30` against their 20),
 * so an overlay flush at the bottom loses its final row, which is where its key
 * hints live. Clearing that row costs a row of overlay height, and on a short
 * terminal the row comes out of the content: the question being asked scrolls
 * off before its own hints do. That trade is worth it with room to spare and
 * not worth it without, so short terminals keep the collision and keep the
 * content.
 *
 * Overlays re-read this on update, not on resize: `RenderContext` exposes no
 * resize hook, and the adjacent `maxHeight` short-terminal rule already works
 * this way. So a terminal resized across the threshold with an overlay already
 * open keeps the old offset until that overlay next updates.
 */
export function dialogBottomOffset(renderer: RenderContext): number {
    return renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT ? 1 : 2;
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

export function dialogSearchNode(
    renderer: RenderContext,
    query: string,
    placeholder = "Search",
): TextRenderable {
    const typed = query.length > 0;
    return new TextRenderable(renderer, {
        content: new StyledText([
            fg(TUI_MUTED)("⌕  "),
            fg(typed ? TUI_TEXT : TUI_MUTED)(typed ? query : placeholder),
            // A block caret keeps the line reading as a live input rather than
            // a static label once the query empties out again.
            fg(TUI_ACCENT)("▏"),
        ]),
        width: "100%",
        height: 3,
        paddingTop: 1,
    });
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
    // number). Accent-toned unless the row is active.
    readonly leading?: string;
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
    const labelWidth = Math.max(
        0,
        ...contents.map((content) => content.label.length),
    );
    const metaWidth = Math.max(
        0,
        ...contents.map((content) =>
            content.meta === undefined ? 0 : metaLength(content.meta)
        ),
    );
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
        label: content.label.padEnd(labelWidth),
        ...(budget === undefined || content.description === undefined
            ? {}
            : { description: clipped(content.description, budget) }),
        // The column is padded to one width so it reads as a column. Rows
        // without a meta value keep none, since a blank column is not a fact.
        ...(content.meta === undefined ? {} : {
            meta: [
                {
                    text: " ".repeat(
                        META_GAP + metaWidth - metaLength(content.meta),
                    ),
                },
                ...metaParts(content.meta),
            ],
        }),
    }));
}

/** The two spaces `dialogOptionRow` puts between the label and description. */
const DESCRIPTION_GAP = 2;

/** The gap that keeps the description off the meta column. */
const META_GAP = 2;

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
    const row = new BoxRenderable(renderer, {
        width: "100%",
        height: content.wrap ? "auto" : 1,
        flexDirection: "row",
        backgroundColor: background,
    });
    // Every dialog row in the TUI is built here, so pointer support is one
    // wiring rather than one per overlay. A row without handlers behaves
    // exactly as it did before.
    attachRowPointer(row, content);
    // The gutter is drawn on every row, marker or not, so a row's label starts
    // on the same column whichever it is.
    row.add(new TextRenderable(renderer, {
        content: new StyledText([
            fg(accent)((content.leading ?? "").padEnd(DIALOG_GUTTER_WIDTH)),
        ]),
        bg: background,
        flexShrink: 0,
    }));
    const labelChunks: TextChunk[] = [fg(label)(content.label)];
    if (content.description !== undefined) {
        labelChunks.push(fg(detail)(`  ${content.description}`));
    }
    row.add(new TextRenderable(renderer, {
        content: new StyledText(labelChunks),
        bg: background,
        attributes: content.active ? 1 : 0,
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
