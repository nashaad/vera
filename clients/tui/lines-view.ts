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

export type LinesViewTone = "text" | "muted" | "accent" | "heading";

export interface LinesViewLine {
    readonly text: string;
    readonly tone?: LinesViewTone;
    readonly leading?: {
        readonly text: string;
        readonly tone: "positive";
    };
    readonly rowId?: string;
    readonly selected?: boolean;
    readonly emphasis?: { readonly start: number; readonly length: number };
}

export interface LinesViewFooterRow {
    readonly label: string;
    readonly value: string;
}

export interface LinesViewHeaderAction {
    readonly id: string;
    readonly text: string;
}

export interface LinesViewState {
    readonly title: string;
    readonly titleLeading?: {
        readonly text: string;
        readonly tone: "accent";
    };
    readonly hint?: string;
    readonly headerActions?: readonly LinesViewHeaderAction[];
    readonly input?: {
        readonly text: string;
        readonly cursor?: number;
        readonly placeholder?: string;
    };
    readonly lines: readonly LinesViewLine[];
    readonly cursorLine?: number;
    readonly footer: string;
    readonly footerTable?: readonly LinesViewFooterRow[];
    readonly dimmed?: boolean;
    readonly focused?: boolean;
}

export interface LinesView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    focus(): void;
    handleInputKey(key: TuiTextEditorKey): boolean;
    insertInputPaste(text: string): boolean;
    inputText(): string;
    inputCursor(): number;
    pointer?: LinesViewPointer;
    contentWidth(): number;
    setRail(columns: number | undefined): void;
    railColumns(): number | undefined;
    setBottomInset(rows: number): void;
    visibleRows(): number;
    update(state: LinesViewState): void;
}

export interface LinesViewOptions {
    readonly panelBackground?: boolean;
    readonly railDivider?: boolean;
    readonly railPadding?: number;
    readonly fillHeight?: boolean;
}

export interface LinesViewPointer {
    readonly hover?: (rowId: string) => void;
    readonly activate?: (rowId: string) => void;
}

const CARD_WIDTH_FRACTION = 0.9;
const CARD_TOP_MARGIN = 3;
const COMPOSER_RESERVE = 9;
const CARD_CHROME_HEIGHT = 7;

const RAIL_PADDING = 1;
const RAIL_CHROME_HEIGHT = 8;
const RAIL_TOP_MARGIN = 1;

const INPUT_BOX_ROWS = 3;
const INPUT_BLOCK_ROWS = INPUT_BOX_ROWS + 1;

function footerContentRows(state: LinesViewState): number {
    return Math.max(
        1,
        state.footerTable?.length ?? state.footer.split("\n").length,
    );
}

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
    let inputRows = 0;
    const chromeRows = (): number =>
        (rail === undefined ? CARD_CHROME_HEIGHT : RAIL_CHROME_HEIGHT)
        + footerRows - 1 + inputRows;
    const railPadding = options.railPadding ?? RAIL_PADDING;
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
            if (options.railDivider === true) {
                box.borderStyle = state.focused === true ? "heavy" : "single";
            }
            const hint = state.hint ?? "esc";
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
            const height = cardHeight();
            const room = listWindowRows(height, chromeRows());
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
