import {
    BoxRenderable,
    TextAttributes,
    TextRenderable,
    type Renderable,
    type RenderContext,
} from "@opentui/core";

import {
    attachRowPointer,
    centeredDialogSurface,
    DIALOG_CARD_PADDING,
    dialogFooterNode,
    dialogGroupHeaderNode,
    dialogHeaderNode,
    dialogOptionRow,
} from "./dialog-chrome.ts";
import { dialogBoxHeight, listWindowRows, listWindowSlice } from "./list-window.ts";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";

/**
 * A card that draws a header, a block of already-laid-out lines, and a footer.
 *
 * Shared by the Work tab and the search overlay because both decide their own
 * text: their models return the exact strings, columns and pointers, and the
 * only thing left is which colour each line takes. A surface that needs the
 * windowed list, group headings and mouse rows of a picker uses the picker
 * chrome instead; this is for the two that lay themselves out.
 *
 * It is built from the same pieces as the pickers: a centered card, a header
 * carrying its own esc hint, a highlight bar on the selected row, and a muted
 * footer. Only the lines between the header and the footer are the surface's
 * own.
 */

export type LinesViewTone = "text" | "muted" | "accent";

export interface LinesViewLine {
    readonly text: string;
    readonly tone?: LinesViewTone;
    /**
     * What the surface calls this line when the mouse lands on it. Absent on a
     * line there is nothing to select, so a click on a heading or a blank does
     * nothing rather than picking whatever is nearest.
     */
    readonly rowId?: string;
    /** Draws the highlight bar, the same one every picker's cursor draws. */
    readonly selected?: boolean;
}

export interface LinesViewState {
    readonly title: string;
    /** Follows the title on the right of the header; "esc" when omitted. */
    readonly hint?: string;
    readonly lines: readonly LinesViewLine[];
    /**
     * Which line the cursor is on, so a list too long for the card scrolls
     * with it. Absent on a list with no cursor, which simply shows its top.
     */
    readonly cursorLine?: number;
    readonly footer: string;
}

export interface LinesView {
    /** The card, for focus and for the wheel. */
    readonly box: BoxRenderable;
    /** The full-screen flex parent that keeps the card centered. */
    readonly surface: BoxRenderable;
    /**
     * Told which line the mouse hovered or clicked, by the id the surface put
     * on it. The card knows where its lines are drawn; only the surface knows
     * what selecting one means.
     */
    pointer?: LinesViewPointer;
    /**
     * Columns a line may occupy inside the card, which is narrower than the
     * terminal by the card's margins and padding. Callers lay out against this
     * and not `renderer.width`, or the box clips the right-hand column off
     * every row it draws.
     */
    contentWidth(): number;
    /**
     * Draws the card as a column down the left edge wide enough for `columns`
     * of row, or centres it again when given nothing.
     *
     * The rows are unchanged: a rail is where the same lines are drawn, not a
     * second list.
     */
    setRail(columns: number | undefined): void;
    /**
     * The screen columns the rail occupies, padding included, or nothing while
     * the surface is a centred card.
     *
     * What stands beside the rail is held off by this much, so the two never
     * overlap and neither has to know the other's padding.
     */
    railColumns(): number | undefined;
    /**
     * Keeps the surface above bottom chrome whose height changes at runtime.
     * The composer grows with both typed text and the status rows below it, so
     * a fixed reservation eventually paints a rail across the input frame.
     */
    setBottomInset(rows: number): void;
    /**
     * How many list rows the card or rail can show right now, the same count
     * `update` windows around the cursor. Movement keys that jump a half page
     * read this rather than inventing a second measurement.
     */
    visibleRows(): number;
    update(state: LinesViewState): void;
}

export interface LinesViewOptions {
    /** False for a rail that lives directly on the app's shared ground. */
    readonly panelBackground?: boolean;
    /** A single edge separating a rail from the content beside it. */
    readonly railDivider?: boolean;
}

export interface LinesViewPointer {
    readonly hover?: (rowId: string) => void;
    readonly activate?: (rowId: string) => void;
}

const CARD_WIDTH_FRACTION = 0.9;
/** The rows a centered card leaves above itself. */
const CARD_TOP_MARGIN = 3;
/**
 * The rows at the bottom the card centres itself above rather than across.
 *
 * The composer's own rows say what the session is answering as, and a card
 * drawn over them reads as two surfaces fighting. These cards are the two tall
 * ones, so unlike a picker they would reach the composer if they centred on
 * the whole screen.
 */
const COMPOSER_RESERVE = 9;
/**
 * Rows the card spends on itself: its padding, the header and the blank line
 * under it, and the two-line footer. Less than a picker's, which also budgets
 * for a search field these cards do not have.
 */
const CARD_CHROME_HEIGHT = 7;

/**
 * How far a rail holds its rows off its own edges.
 *
 * A rail is as narrow as its widest row, so the four columns a centred card
 * spends on each side would come straight out of the titles.
 */
const RAIL_PADDING = 1;
/** The rail's own equivalent of `CARD_CHROME_HEIGHT`, one row less padding. */
const RAIL_CHROME_HEIGHT = 6;
/** The row a rail starts on: the blank one the screen keeps above everything. */
const RAIL_TOP_MARGIN = 1;

/**
 * Read per draw, never captured: the theme constants are rebound when the
 * theme changes, so a table built at module load would paint the old colours
 * for the rest of the session.
 */
function toneColor(tone: LinesViewTone | undefined): string {
    if (tone === "muted") return TUI_MUTED;
    return tone === "accent" ? TUI_ACCENT : TUI_TEXT;
}

export function createTuiLinesView(
    renderer: RenderContext,
    id: string,
    options: LinesViewOptions = {},
): LinesView {
    let nodes: Renderable[] = [];
    let bottomInset = COMPOSER_RESERVE;
    let rail: number | undefined;
    const box = new BoxRenderable(renderer, {
        id,
        border: false,
        borderColor: TUI_ELEMENT,
        focusedBorderColor: TUI_ELEMENT,
        ...(options.panelBackground === false
            ? {}
            : { backgroundColor: TUI_PANEL }),
        width: `${CARD_WIDTH_FRACTION * 100}%`,
        height: "auto",
        paddingLeft: DIALOG_CARD_PADDING,
        paddingRight: DIALOG_CARD_PADDING,
        paddingTop: 2,
        paddingBottom: 1,
        focusable: true,
    });
    const surface = centeredDialogSurface(renderer, `${id}-surface`, box, {
        registerCard: options.railDivider !== true,
    });
    surface.paddingBottom = COMPOSER_RESERVE;
    const applyBottomInset = (): void => {
        // A dock owns the full height beside the chat column. A centred card
        // still clears the composer because it floats over that column.
        surface.paddingBottom = rail === undefined ? bottomInset : 0;
    };

    const view: LinesView = {
        box,
        surface,
        contentWidth(): number {
            if (rail !== undefined) return rail;
            return Math.max(
                20,
                Math.floor(renderer.width * CARD_WIDTH_FRACTION)
                    - DIALOG_CARD_PADDING * 2,
            );
        },
        railColumns(): number | undefined {
            return rail === undefined ? undefined : rail + RAIL_PADDING * 2;
        },
        setBottomInset(rows): void {
            bottomInset = Math.max(0, rows);
            applyBottomInset();
        },
        visibleRows(): number {
            return listWindowRows(
                dialogBoxHeight(
                    renderer,
                    rail === undefined ? CARD_TOP_MARGIN : RAIL_TOP_MARGIN,
                ) - bottomInset,
                rail === undefined ? CARD_CHROME_HEIGHT : RAIL_CHROME_HEIGHT,
            );
        },
        setRail(columns): void {
            if (rail === columns) return;
            rail = columns;
            applyBottomInset();
            if (columns === undefined) {
                box.border = false;
                surface.width = "100%";
                surface.alignItems = "center";
                surface.justifyContent = "center";
                box.width = `${CARD_WIDTH_FRACTION * 100}%`;
                box.height = "auto";
                box.paddingLeft = DIALOG_CARD_PADDING;
                box.paddingRight = DIALOG_CARD_PADDING;
                box.paddingTop = 2;
                return;
            }
            // The surface stops at the rail's own right edge rather than
            // covering the screen: what stands beside a rail is still readable
            // and still takes the mouse, which is the difference between a rail
            // and a card.
            surface.width = columns + RAIL_PADDING * 2;
            box.border = options.railDivider === true ? ["right"] : false;
            surface.alignItems = "stretch";
            surface.justifyContent = "flex-start";
            box.width = "100%";
            box.height = "100%";
            box.paddingLeft = RAIL_PADDING;
            box.paddingRight = RAIL_PADDING;
            box.paddingTop = 1;
        },
        update(state): void {
            for (const node of nodes) node.destroyRecursively();
            nodes = [];
            const add = (node: Renderable): void => {
                nodes.push(node);
                box.add(node);
            };
            const muted = (text: string): void => {
                add(new TextRenderable(renderer, {
                    content: text,
                    fg: TUI_MUTED,
                    width: "100%",
                    height: 1,
                }));
            };
            add(options.panelBackground === false
                ? groundHeaderNode(
                    renderer,
                    state.title,
                    state.hint ?? "esc",
                )
                : dialogHeaderNode(renderer, state.title, state.hint ?? "esc"));
            muted("");
            // The card is a fixed height, so a longer list is windowed around
            // the cursor rather than cut at the top: a row the arrows can
            // reach has to be a row the card can show.
            const room = listWindowRows(
                dialogBoxHeight(
                    renderer,
                    rail === undefined ? CARD_TOP_MARGIN : RAIL_TOP_MARGIN,
                ) - bottomInset,
                rail === undefined ? CARD_CHROME_HEIGHT : RAIL_CHROME_HEIGHT,
            );
            const above = state.lines.length > room
                ? Math.max(0, Math.min(
                    (state.cursorLine ?? 0) - Math.floor(room / 2),
                    state.lines.length - room,
                ))
                : 0;
            const visible = listWindowSlice(
                state.lines,
                state.cursorLine ?? 0,
                room,
            );
            if (above > 0) muted(`… ${above} above`);
            for (const line of visible) {
                add(lineNode(
                    renderer,
                    view,
                    line,
                    options.panelBackground === false,
                ));
            }
            const below = state.lines.length - above - visible.length;
            if (below > 0) muted(`… ${below} below`);
            add(dialogFooterNode(renderer, state.footer));
        },
    };
    return view;
}

/**
 * One line as the shared chrome draws it: a group heading, a selectable row
 * carrying the picker highlight bar, or plain muted text.
 */
function lineNode(
    renderer: RenderContext,
    view: LinesView,
    line: LinesViewLine,
    transparent: boolean,
): Renderable {
    if (line.rowId === undefined) {
        return line.tone === "accent" && line.text.length > 0
            ? dialogGroupHeaderNode(renderer, line.text, false)
            : new TextRenderable(renderer, {
                content: line.text,
                fg: toneColor(line.tone),
                width: "100%",
                height: 1,
            });
    }
    const rowId = line.rowId;
    const pointer = {
        ...(view.pointer?.hover === undefined ? {} : {
            onHover: () => view.pointer?.hover?.(rowId),
        }),
        ...(view.pointer?.activate === undefined ? {} : {
            onSelect: () => view.pointer?.activate?.(rowId),
        }),
    };
    if (transparent && line.selected !== true) {
        const row = new BoxRenderable(renderer, {
            width: "100%",
            height: 1,
        });
        attachRowPointer(row, pointer);
        row.add(new TextRenderable(renderer, {
            content: line.text,
            fg: toneColor(line.tone),
            width: "100%",
            height: 1,
        }));
        return row;
    }
    return dialogOptionRow(renderer, {
        label: line.text,
        active: line.selected === true,
        ...pointer,
    });
}

/** Header chrome on the app ground: structure without a filled panel band. */
function groundHeaderNode(
    renderer: RenderContext,
    title: string,
    hint: string,
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
        attributes: TextAttributes.BOLD,
    }));
    header.add(new TextRenderable(renderer, {
        content: hint,
        fg: TUI_MUTED,
    }));
    return header;
}
