import {
    BoxRenderable,
    TextRenderable,
    type Renderable,
    type RenderContext,
} from "@opentui/core";

import {
    centeredDialogSurface,
    DIALOG_CARD_PADDING,
    dialogFooterNode,
    dialogGroupHeaderNode,
    dialogHeaderNode,
    dialogOptionRow,
} from "./dialog-chrome.ts";
import { dialogBoxHeight, listWindowRows, listWindowSlice } from "./list-window.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./state.ts";

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
    update(state: LinesViewState): void;
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
): LinesView {
    let nodes: Renderable[] = [];
    const box = new BoxRenderable(renderer, {
        id,
        border: false,
        backgroundColor: TUI_PANEL,
        width: `${CARD_WIDTH_FRACTION * 100}%`,
        height: "auto",
        paddingLeft: DIALOG_CARD_PADDING,
        paddingRight: DIALOG_CARD_PADDING,
        paddingTop: 2,
        paddingBottom: 1,
        focusable: true,
    });
    const surface = centeredDialogSurface(renderer, `${id}-surface`, box);
    surface.paddingBottom = COMPOSER_RESERVE;

    const view: LinesView = {
        box,
        surface,
        contentWidth(): number {
            return Math.max(
                20,
                Math.floor(renderer.width * CARD_WIDTH_FRACTION)
                    - DIALOG_CARD_PADDING * 2,
            );
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
            add(dialogHeaderNode(renderer, state.title, state.hint ?? "esc"));
            muted("");
            // The card is a fixed height, so a longer list is windowed around
            // the cursor rather than cut at the top: a row the arrows can
            // reach has to be a row the card can show.
            const room = listWindowRows(
                dialogBoxHeight(renderer, CARD_TOP_MARGIN) - COMPOSER_RESERVE,
                CARD_CHROME_HEIGHT,
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
                add(lineNode(renderer, view, line));
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
    return dialogOptionRow(renderer, {
        label: line.text,
        active: line.selected === true,
        ...(view.pointer?.hover === undefined ? {} : {
            onHover: () => view.pointer?.hover?.(rowId),
        }),
        ...(view.pointer?.activate === undefined ? {} : {
            onSelect: () => view.pointer?.activate?.(rowId),
        }),
    });
}
