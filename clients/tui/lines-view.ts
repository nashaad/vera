import {
    bold,
    BoxRenderable,
    fg,
    StyledText,
    TextAttributes,
    TextRenderable,
    underline,
    type Renderable,
    type RenderContext,
} from "@opentui/core";

import {
    attachRowPointer,
    centeredDialogSurface,
    DIALOG_BACKGROUND_Z_INDEX,
    DIALOG_CARD_Z_INDEX,
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
    TUI_INPUT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";
import {
    createTuiSingleLineTextarea,
    insertTuiSingleLinePaste,
    syncTuiSingleLineTextarea,
    tuiTextareaKey,
    type TuiTextEditorKey,
} from "./single-line-editor.ts";

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

export type LinesViewTone = "text" | "muted" | "accent" | "heading";

export interface LinesViewLine {
    readonly text: string;
    readonly tone?: LinesViewTone;
    /** A separately toned prefix that is also present at the start of text. */
    readonly leading?: {
        readonly text: string;
        readonly tone: "positive";
    };
    /**
     * What the surface calls this line when the mouse lands on it. Absent on a
     * line there is nothing to select, so a click on a heading or a blank does
     * nothing rather than picking whatever is nearest.
     */
    readonly rowId?: string;
    /** Draws the highlight bar, the same one every picker's cursor draws. */
    readonly selected?: boolean;
    /**
     * A run of the line drawn heavier than the rest, given as a start column
     * and a length. What a surface uses it for is its own: search marks the
     * text that matched, so the eye lands on the reason the row is listed.
     */
    readonly emphasis?: { readonly start: number; readonly length: number };
}

export interface LinesViewFooterRow {
    readonly label: string;
    readonly value: string;
}

/** A compact text control drawn at the right edge of a rail header. */
export interface LinesViewHeaderAction {
    readonly id: string;
    readonly text: string;
}

export interface LinesViewState {
    readonly title: string;
    /** A separately toned prefix that is also present at the start of title. */
    readonly titleLeading?: {
        readonly text: string;
        readonly tone: "accent";
    };
    /** Follows the title on the right of the header; "esc" when omitted. */
    readonly hint?: string;
    /** Clickable rail controls. Text remains meaningful without colour. */
    readonly headerActions?: readonly LinesViewHeaderAction[];
    /**
     * Text the surface is being typed into, drawn in a bordered box between
     * the header and the list.
     *
     * Chrome around the input rather than a line in the list: a surface that
     * types is the same kind of place as the composer and is framed the same
     * way, and the list stays a list of results.
     */
    readonly input?: {
        readonly text: string;
        readonly cursor?: number;
        readonly placeholder?: string;
    };
    readonly lines: readonly LinesViewLine[];
    /**
     * Which line the cursor is on, so a list too long for the card scrolls
     * with it. Absent on a list with no cursor, which simply shows its top.
     */
    readonly cursorLine?: number;
    readonly footer: string;
    /** Optional label/value presentation for a footer that reads as a table. */
    readonly footerTable?: readonly LinesViewFooterRow[];
    /** Softer title colour when the surface is visible but not focused. */
    readonly dimmed?: boolean;
    /**
     * Whether this surface owns the keyboard right now.
     *
     * A rail is drawn beside the chat rather than over it, so nothing about
     * being on screen says which of the two a key would reach. Its rule and
     * its edge are drawn heavier while it does, which reads without colour.
     */
    readonly focused?: boolean;
}

export interface LinesView {
    /** The card, for focus and for the wheel. */
    readonly box: BoxRenderable;
    /** The full-screen flex parent that keeps the card centered. */
    readonly surface: BoxRenderable;
    focus(): void;
    handleInputKey(key: TuiTextEditorKey): boolean;
    insertInputPaste(text: string): boolean;
    inputText(): string;
    inputCursor(): number;
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
    /**
     * False for a surface that sits on the app's shared ground. A filled
     * panel is the default, and a docked rail that should read as its own
     * column keeps it on.
     */
    readonly panelBackground?: boolean;
    /** A single edge separating a rail from the content beside it. */
    readonly railDivider?: boolean;
    /**
     * How far a rail holds its rows off its own edges. OpenCode's session
     * sidebar uses two columns; the default stays one so a centred card that
     * later docks does not suddenly eat title space.
     */
    readonly railPadding?: number;
    /**
     * A card that keeps the height its list may window to, rather than
     * shrinking to the rows it happens to have.
     *
     * For a surface whose list changes under the person's hands: a card that
     * grows a row per keystroke moves its own header, its footer and every row
     * already read. The rows it can show are the same either way; this is only
     * whether the frame around them holds still.
     */
    readonly fillHeight?: boolean;
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
/**
 * Rail header, the rule and blank row under it, edge padding, and the rule
 * above its fixed help block.
 */
const RAIL_CHROME_HEIGHT = 8;
/** The row a rail starts on: the blank one the screen keeps above everything. */
const RAIL_TOP_MARGIN = 1;

/**
 * The input field: the row typed into, with a band of tint above and below.
 *
 * The tint is the frame. A border would draw a second rule inside a card that
 * already has one, and the field reads as its own place without it.
 */
const INPUT_BOX_ROWS = 3;
/** The field plus the blank row that separates it from the list under it. */
const INPUT_BLOCK_ROWS = INPUT_BOX_ROWS + 1;

/** Rows the state's help block will take. */
function footerContentRows(state: LinesViewState): number {
    return Math.max(
        1,
        state.footerTable?.length ?? state.footer.split("\n").length,
    );
}

/**
 * Read per draw, never captured: the theme constants are rebound when the
 * theme changes, so a table built at module load would paint the old colours
 * for the rest of the session.
 */
function toneColor(tone: LinesViewTone | undefined): string {
    if (tone === "muted") return TUI_MUTED;
    if (tone === "accent") return TUI_ACCENT;
    return TUI_TEXT;
}

export function createTuiLinesView(
    renderer: RenderContext,
    id: string,
    options: LinesViewOptions = {},
): LinesView {
    let nodes: Renderable[] = [];
    let inputActive = false;
    let bottomInset = COMPOSER_RESERVE;
    let rail: number | undefined;
    let footerRows = 1;
    /**
     * Rows the list does not get. The base counts one help row, so a block of
     * any other height costs the difference.
     */
    let inputRows = 0;
    const chromeRows = (): number =>
        (rail === undefined ? CARD_CHROME_HEIGHT : RAIL_CHROME_HEIGHT)
        + footerRows - 1 + inputRows;
    const railPadding = options.railPadding ?? RAIL_PADDING;
    /** The height a centred card's list is windowed to, rail aside. */
    const cardHeight = (): number =>
        dialogBoxHeight(
            renderer,
            rail === undefined ? CARD_TOP_MARGIN : RAIL_TOP_MARGIN,
        ) - (rail === undefined ? bottomInset : 0);
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
    const inputEditor = createTuiSingleLineTextarea(renderer, {
        id: `${id}-input`,
        placeholder: "Search",
    });
    const inputField = new BoxRenderable(renderer, {
        id: `${id}-input-field`,
        border: false,
        backgroundColor: TUI_INPUT,
        width: "100%",
        height: INPUT_BOX_ROWS,
        justifyContent: "center",
        paddingLeft: 2,
        paddingRight: 2,
    });
    inputField.add(inputEditor);
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
        focus(): void {
            if (inputActive) inputEditor.focus();
            else box.focus();
        },
        handleInputKey(key): boolean {
            return inputActive
                && inputEditor.handleKeyPress(tuiTextareaKey(key));
        },
        insertInputPaste(text): boolean {
            return inputActive && insertTuiSingleLinePaste(inputEditor, text);
        },
        inputText(): string {
            return inputEditor.plainText;
        },
        inputCursor(): number {
            return inputEditor.cursorOffset;
        },
        contentWidth(): number {
            if (rail !== undefined) return rail;
            return Math.max(
                20,
                Math.floor(renderer.width * CARD_WIDTH_FRACTION)
                    - DIALOG_CARD_PADDING * 2,
            );
        },
        railColumns(): number | undefined {
            return rail === undefined ? undefined : rail + railPadding * 2;
        },
        setBottomInset(rows): void {
            bottomInset = Math.max(0, rows);
            applyBottomInset();
        },
        visibleRows(): number {
            return listWindowRows(cardHeight(), chromeRows());
        },
        setRail(columns): void {
            if (rail === columns) return;
            rail = columns;
            // A dock is part of the screen behind a modal, while this same
            // surface becomes the modal card on a narrow terminal. Keep that
            // distinction in the shared transition so every dialog's scrim
            // covers every rail without dialog-specific visibility rules.
            surface.zIndex = columns === undefined
                ? DIALOG_CARD_Z_INDEX
                : DIALOG_BACKGROUND_Z_INDEX;
            applyBottomInset();
            if (columns === undefined) {
                box.border = false;
                surface.width = "100%";
                surface.alignItems = "center";
                surface.justifyContent = "center";
                box.width = `${CARD_WIDTH_FRACTION * 100}%`;
                box.height = options.fillHeight === true
                    ? Math.max(1, cardHeight())
                    : "auto";
                box.paddingLeft = DIALOG_CARD_PADDING;
                box.paddingRight = DIALOG_CARD_PADDING;
                box.paddingTop = 2;
                return;
            }
            // The surface stops at the rail's own right edge rather than
            // covering the screen: what stands beside a rail is still readable
            // and still takes the mouse, which is the difference between a rail
            // and a card.
            surface.width = columns + railPadding * 2;
            box.border = options.railDivider === true ? ["right"] : false;
            surface.alignItems = "stretch";
            surface.justifyContent = "flex-start";
            box.width = "100%";
            box.height = "100%";
            box.paddingLeft = railPadding;
            box.paddingRight = railPadding;
            box.paddingTop = 1;
            box.paddingBottom = 1;
        },
        update(state): void {
            footerRows = footerContentRows(state);
            inputRows = state.input === undefined ? 0 : INPUT_BLOCK_ROWS;
            inputActive = state.input !== undefined;
            inputField.parent?.remove(inputField.id);
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
            // The edge between a rail and the chat beside it thickens with
            // the rail's focus: the boundary is the one piece of chrome both
            // sides can see at once.
            if (options.railDivider === true) {
                box.borderStyle = state.focused === true ? "heavy" : "single";
            }
            const hint = state.hint ?? "esc";
            // A docked rail is a column, not a dialog: keep the title, drop
            // the esc chip (the footer already names it), and honour dimming.
            const railHeader = rail !== undefined || state.dimmed === true
                || options.panelBackground === false;
            add(railHeader
                ? groundHeaderNode(
                    renderer,
                    state.title,
                    hint,
                    state.dimmed === true,
                    state.headerActions,
                    view.pointer,
                    state.titleLeading,
                )
                : dialogHeaderNode(renderer, state.title, hint));
            // A dock uses the row below its title for a rule: the wordmark
            // above it is a heading, and a heading with nothing under it reads
            // as the first row of the list. Cards keep the dialog-style
            // breathing room under the header instead.
            if (rail === undefined) {
                muted("");
            } else {
                add(new TextRenderable(renderer, {
                    content: (state.focused === true ? "━" : "─")
                        .repeat(Math.max(1, view.contentWidth())),
                    fg: state.focused === true ? TUI_TEXT : TUI_ELEMENT,
                    width: "100%",
                    height: 1,
                }));
                muted("");
            }
            if (state.input !== undefined) {
                inputField.backgroundColor = TUI_INPUT;
                inputEditor.textColor = TUI_TEXT;
                inputEditor.focusedTextColor = TUI_TEXT;
                inputEditor.backgroundColor = TUI_INPUT;
                inputEditor.focusedBackgroundColor = TUI_INPUT;
                inputEditor.cursorColor = TUI_ACCENT;
                inputEditor.placeholderColor = TUI_MUTED;
                inputEditor.placeholder = state.input.placeholder ?? "Search";
                syncTuiSingleLineTextarea(
                    inputEditor,
                    state.input.text,
                    state.input.cursor,
                );
                box.add(inputField);
                muted("");
            }
            // The card is a fixed height, so a longer list is windowed around
            // the cursor rather than cut at the top: a row the arrows can
            // reach has to be a row the card can show.
            const height = cardHeight();
            const room = listWindowRows(height, chromeRows());
            // A card told to keep its height takes the one its list is
            // windowed to, so the frame is the same whether the list fills it.
            if (options.fillHeight === true && rail === undefined) {
                box.height = Math.max(1, height);
            }
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
            // A rail without the keyboard draws no selection bar. The bar is
            // the loudest thing on the pane, so leaving it lit beside a live
            // conversation puts the brightest mark on screen where the keys
            // are not. The row's state glyph remains visible without making
            // it double as a second selection marker.
            const selectable = rail === undefined || state.focused === true;
            for (const line of visible) {
                add(lineNode(
                    renderer,
                    view,
                    selectable ? line : { ...line, selected: false },
                    options.panelBackground === false,
                ));
            }
            const below = state.lines.length - above - visible.length;
            if (below > 0) muted(`… ${below} below`);
            // A dock is two regions: the list above, which scrolls, and a
            // fixed help block on the bottom edge, with an inset rule between
            // them. Centred cards keep their compact height.
            if (rail !== undefined || options.fillHeight === true) {
                add(new BoxRenderable(renderer, {
                    width: "100%",
                    flexGrow: 1,
                }));
            }
            if (rail !== undefined) {
                add(new TextRenderable(renderer, {
                    content: "─".repeat(Math.max(1, rail - 2)),
                    fg: TUI_ELEMENT,
                    marginLeft: 1,
                    width: "100%",
                    height: 1,
                }));
            }
            add(state.footerTable === undefined
                ? dialogFooterNode(renderer, state.footer)
                : footerTableNode(renderer, state.footerTable));
        },
    };
    return view;
}

/** A quiet two-column footer, matching the information tables used by TUIs. */
function footerTableNode(
    renderer: RenderContext,
    rows: readonly LinesViewFooterRow[],
): BoxRenderable {
    const table = new BoxRenderable(renderer, {
        width: "100%",
        height: rows.length,
        marginTop: 1,
        flexDirection: "column",
    });
    const labelWidth = Math.max(1, ...rows.map((row) => row.label.length + 2));
    for (const item of rows) {
        const row = new BoxRenderable(renderer, {
            width: "100%",
            height: 1,
            flexDirection: "row",
        });
        row.add(new TextRenderable(renderer, {
            content: item.label,
            fg: TUI_MUTED,
            width: labelWidth,
            height: 1,
        }));
        row.add(new TextRenderable(renderer, {
            content: item.value,
            fg: TUI_TEXT,
            flexGrow: 1,
            height: 1,
        }));
        table.add(row);
    }
    return table;
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
        if (line.tone === "heading") {
            return new TextRenderable(renderer, {
                content: line.text,
                fg: TUI_TEXT,
                attributes: TextAttributes.BOLD,
                width: "100%",
                height: 1,
            });
        }
        return line.tone === "accent" && line.text.length > 0
            ? dialogGroupHeaderNode(renderer, line.text, false)
            : plainLineNode(renderer, line);
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
    if ((transparent || line.tone === "muted") && line.selected !== true) {
        const row = new BoxRenderable(renderer, {
            width: "100%",
            height: 1,
        });
        attachRowPointer(row, pointer);
        row.add(plainLineNode(renderer, line));
        return row;
    }
    const leading = line.leading?.text ?? "";
    const label = leading.length > 0 && line.text.startsWith(leading)
        ? line.text.slice(leading.length)
        : line.text;
    return dialogOptionRow(renderer, {
        label,
        ...(leading.length === 0
            ? {}
            : { leading, leadingTone: line.leading?.tone }),
        active: line.selected === true,
        ...(line.emphasis === undefined ? {} : { emphasis: line.emphasis }),
        ...pointer,
    });
}

/** A line with no row of its own, emphasised run included. */
function plainLineNode(
    renderer: RenderContext,
    line: LinesViewLine,
): TextRenderable {
    return new TextRenderable(renderer, {
        content: lineContent(line, toneColor(line.tone)),
        width: "100%",
        height: 1,
    });
}

/** A line with its optional status prefix and emphasis both preserved. */
function lineContent(line: LinesViewLine, color: string): StyledText {
    const leading = line.leading?.text ?? "";
    if (leading.length > 0 && line.text.startsWith(leading)) {
        return new StyledText([
            fg(TUI_SUCCESS)(leading),
            fg(color)(line.text.slice(leading.length)),
        ]);
    }
    return emphasised(line.text, color, line.emphasis);
}

/** The line as one chunk, or as three when a run of it is emphasised. */
function emphasised(
    text: string,
    color: string,
    emphasis: { readonly start: number; readonly length: number } | undefined,
): StyledText {
    if (emphasis === undefined || emphasis.length <= 0) {
        return new StyledText([fg(color)(text)]);
    }
    const start = Math.max(0, Math.min(emphasis.start, text.length));
    const end = Math.min(text.length, start + emphasis.length);
    if (end <= start) return new StyledText([fg(color)(text)]);
    return new StyledText([
        ...(start > 0 ? [fg(color)(text.slice(0, start))] : []),
        underline(bold(fg(color)(text.slice(start, end)))),
        ...(end < text.length ? [fg(color)(text.slice(end))] : []),
    ]);
}

/** Header chrome on the app ground: structure without a filled panel band. */
function groundHeaderNode(
    renderer: RenderContext,
    title: string,
    hint: string,
    dimmed = false,
    actions: readonly LinesViewHeaderAction[] = [],
    pointer?: LinesViewPointer,
    leading?: LinesViewState["titleLeading"],
): BoxRenderable {
    const header = new BoxRenderable(renderer, {
        width: "100%",
        height: 1,
        flexDirection: "row",
        justifyContent: "space-between",
    });
    header.add(new TextRenderable(renderer, {
        content: headerTitleContent(title, dimmed, leading),
        fg: dimmed ? TUI_MUTED : TUI_TEXT,
        attributes: TextAttributes.BOLD,
    }));
    if (actions.length > 0) {
        const controls = new BoxRenderable(renderer, {
            height: 1,
            flexDirection: "row",
        });
        for (const [index, action] of actions.entries()) {
            const control = new BoxRenderable(renderer, {
                width: action.text.length,
                height: 1,
                ...(index === 0 ? {} : { marginLeft: 2 }),
            });
            attachRowPointer(control, {
                onSelect: () => pointer?.activate?.(action.id),
            });
            control.add(new TextRenderable(renderer, {
                content: action.text,
                fg: dimmed ? TUI_MUTED : TUI_TEXT,
                attributes: TextAttributes.BOLD,
                width: action.text.length,
                height: 1,
            }));
            controls.add(control);
        }
        header.add(controls);
    } else if (hint.length > 0) {
        header.add(new TextRenderable(renderer, {
            content: hint,
            fg: TUI_MUTED,
        }));
    }
    return header;
}

function headerTitleContent(
    title: string,
    dimmed: boolean,
    leading?: LinesViewState["titleLeading"],
): string | StyledText {
    if (
        dimmed
        || leading === undefined
        || !title.startsWith(leading.text)
    ) {
        return title;
    }
    return new StyledText([
        fg(TUI_ACCENT)(leading.text),
        fg(TUI_TEXT)(title.slice(leading.text.length)),
    ]);
}
