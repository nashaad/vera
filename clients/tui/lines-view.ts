import {
    BoxRenderable,
    TextRenderable,
    type Renderable,
    type RenderContext,
} from "@opentui/core";

import {
    attachRowPointer,
    DIALOG_CARD_Z_INDEX,
} from "./dialog-chrome.ts";
import { listWindowRows, listWindowSlice } from "./list-window.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./state.ts";

/**
 * A card that draws a header, a block of already-laid-out lines, and a footer.
 *
 * Shared by the Work tab and the search overlay because both decide their own
 * text: their models return the exact strings, columns and pointers, and the
 * only thing left is which colour each line takes. A surface that needs the
 * windowed list, group headings and mouse rows of a picker uses the picker
 * chrome instead; this is for the two that lay themselves out.
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
}

export interface LinesViewState {
    readonly title: string;
    readonly lines: readonly LinesViewLine[];
    /**
     * Which line the cursor is on, so a list too long for the card scrolls
     * with it. Absent on a list with no cursor, which simply shows its top.
     */
    readonly cursorLine?: number;
    readonly footer: string;
}

export interface LinesView {
    readonly box: BoxRenderable;
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

const CARD_LEFT_FRACTION = 0.04;
const CARD_WIDTH_FRACTION = 0.92;
const CARD_PADDING = 4;
const CARD_HEIGHT_FRACTION = 0.9;
/** Title, its blank line, the two markers, the footer and its blank line. */
const CARD_CHROME_LINES = 6;

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
        position: "absolute",
        top: 1,
        left: `${CARD_LEFT_FRACTION * 100}%`,
        width: `${CARD_WIDTH_FRACTION * 100}%`,
        height: "90%",
        zIndex: DIALOG_CARD_Z_INDEX,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        focusable: true,
        visible: false,
    });

    const view: LinesView = {
        box,
        contentWidth(): number {
            return Math.max(
                20,
                Math.floor(renderer.width * CARD_WIDTH_FRACTION) - CARD_PADDING,
            );
        },
        update(state): void {
            for (const node of nodes) node.destroy();
            nodes = [];
            const add = (
                text: string,
                color: string,
                rowId?: string,
            ): void => {
                const node = new TextRenderable(renderer, {
                    content: text,
                    fg: color,
                    width: "100%",
                    height: 1,
                });
                if (rowId !== undefined) {
                    attachRowPointer(node, {
                        ...(view.pointer?.hover === undefined ? {} : {
                            onHover: () => view.pointer?.hover?.(rowId),
                        }),
                        ...(view.pointer?.activate === undefined ? {} : {
                            onSelect: () => view.pointer?.activate?.(rowId),
                        }),
                    });
                }
                nodes.push(node);
                box.add(node);
            };
            add(state.title, TUI_ACCENT);
            add("", TUI_MUTED);
            // The card is a fixed height, so a longer list is windowed around
            // the cursor rather than cut at the top: a row the arrows can
            // reach has to be a row the card can show.
            const room = listWindowRows(
                Math.floor(renderer.height * CARD_HEIGHT_FRACTION),
                CARD_CHROME_LINES,
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
            if (above > 0) add(`… ${above} above`, TUI_MUTED);
            for (const line of visible) {
                add(line.text, toneColor(line.tone), line.rowId);
            }
            const below = state.lines.length - above - visible.length;
            if (below > 0) add(`… ${below} below`, TUI_MUTED);
            add("", TUI_MUTED);
            add(state.footer, TUI_MUTED);
        },
    };
    return view;
}
