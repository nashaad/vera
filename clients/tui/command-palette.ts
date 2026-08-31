import {
    BoxRenderable,
    TextRenderable,
    type Renderable,
    type RenderContext,
} from "@opentui/core";

import {
    dialogBoxHeight,
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import {
    DIALOG_CARD_PADDING,
    DIALOG_CHROME_HEIGHT,
    DIALOG_GUTTER,
    dialogFooterNode,
    dialogHeaderNode,
    dialogOptionRows,
    dialogRowPointer,
    type DialogRowPointer,
    createDialogSearchNode,
    updateDialogSearchNode,
    centeredDialogSurface,
} from "./dialog-chrome.ts";
import { TUI_PALETTE_GROUPS, type TuiPaletteEntry } from "./commands.ts";
import { TUI_MUTED, TUI_PANEL } from "./state.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

export interface TuiCommandPaletteState {
    readonly allCommands: readonly TuiPaletteEntry[];
    readonly commands: readonly TuiPaletteEntry[];
    readonly selectedIndex: number;
    readonly query: string;
    readonly queryCursor: number;
}

export interface TuiCommandPaletteKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
    readonly shift?: boolean;
}

export interface TuiCommandPaletteTransition {
    readonly state?: TuiCommandPaletteState;
    readonly selection?: TuiPaletteEntry;
    readonly handled: boolean;
}

export interface TuiCommandPaletteView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    pointer?: DialogRowPointer;
    focus(): void;
    handleEditorKey(
        state: TuiCommandPaletteState,
        key: TuiCommandPaletteKey,
    ): TuiCommandPaletteTransition;
    handleEditorPaste(
        state: TuiCommandPaletteState,
        text: string,
    ): TuiCommandPaletteState;
    update(state: TuiCommandPaletteState): void;
}

export function startTuiCommandPalette(
    commands: readonly TuiPaletteEntry[],
): TuiCommandPaletteState {
    return filteredState(grouped(commands), "");
}

export function updateTuiCommandPaletteCommands(
    state: TuiCommandPaletteState,
    commands: readonly TuiPaletteEntry[],
): TuiCommandPaletteState {
    return filteredState(grouped(commands), state.query, state.queryCursor);
}

/**
 * Registration order is an implementation detail; the palette shows a stable
 * heading order instead. Within a group, entries keep the order they registered
 * in, which is the order their commands are defined.
 */
function grouped(
    commands: readonly TuiPaletteEntry[],
): readonly TuiPaletteEntry[] {
    return TUI_PALETTE_GROUPS.flatMap((group) =>
        commands.filter((command) => command.group === group)
    );
}

export function handleTuiCommandPaletteKey(
    state: TuiCommandPaletteState,
    key: TuiCommandPaletteKey,
): TuiCommandPaletteTransition {
    if (key.ctrl || key.meta || key.super || key.hyper || key.shift) {
        return { state, handled: false };
    }
    if (key.name === "escape") {
        return { handled: true };
    }
    if (key.name === "up") {
        return {
            state: {
                ...state,
                selectedIndex: Math.max(0, state.selectedIndex - 1),
            },
            handled: true,
        };
    }
    if (key.name === "down") {
        return {
            state: {
                ...state,
                selectedIndex: Math.min(
                    state.commands.length - 1,
                    state.selectedIndex + 1,
                ),
            },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        return {
            selection: state.commands[state.selectedIndex],
            handled: true,
        };
    }
    return { state, handled: false };
}

export function createTuiCommandPaletteView(
    renderer: RenderContext,
): TuiCommandPaletteView {
    let nodes: Renderable[] = [];
    const search = createDialogSearchNode(renderer, "command-palette-search");
    const box = new BoxRenderable(renderer, {
        id: "command-palette",
        // No borderColor here. OpenTUI's BoxRenderable constructor reads any
        // border styling option as "this box wants a border" and overrides an
        // explicit `border: false`, so passing a color is what draws the box.
        border: false,
        backgroundColor: TUI_PANEL,
        // Wider than the other dialogs: the group column is bought out of the
        // card's own width rather than out of the descriptions.
        width: "90%",
        height: 8,
        paddingLeft: DIALOG_CARD_PADDING,
        paddingRight: DIALOG_CARD_PADDING,
        paddingTop: 2,
        paddingBottom: 1,
        focusable: true,
    });

    const surface = centeredDialogSurface(renderer, "command-palette-surface", box);
    const view: TuiCommandPaletteView = {
        box,
        surface,
        focus(): void {
            search.focus();
        },
        handleEditorKey(state, key): TuiCommandPaletteTransition {
            if (
                key.name === "escape" || key.name === "up"
                || key.name === "down" || key.name === "return"
                || key.name === "enter" || key.name === "kpenter"
            ) {
                return { state, handled: false };
            }
            const handled = search.handleKeyPress(tuiTextareaKey(key));
            return handled
                ? searched(state, {
                    value: search.plainText,
                    cursor: search.cursorOffset,
                })
                : { state, handled: false };
        },
        handleEditorPaste(state, text): TuiCommandPaletteState {
            insertTuiSingleLinePaste(search, text);
            return filteredState(
                state.allCommands,
                search.plainText,
                search.cursorOffset,
            );
        },
        update(state): void {
            search.parent?.remove(search.id);
            for (const node of nodes) {
                node.destroyRecursively();
            }
            nodes = [];
            const header = dialogHeaderNode(
                renderer,
                "Commands",
                `${counter(state)} · esc`,
            );
            updateDialogSearchNode(search, state.query, "Search", true, state.queryCursor);
            box.add(header);
            box.add(search);
            nodes.push(header);

            const rows = state.commands.length === 0 ? [] : windowedRows(renderer, state);
            if (rows.length === 0) {
                const empty = new TextRenderable(renderer, {
                    content: `${DIALOG_GUTTER}No commands found`,
                    fg: TUI_MUTED,
                    width: "100%",
                    height: 1,
                });
                box.add(empty);
                nodes.push(empty);
            }
            const commandNodes = dialogOptionRows(
                renderer,
                rows.map((row) => ({
                    ...(row.gutter === undefined
                        ? {}
                        : { leading: row.gutter, leadingTone: "muted" as const }),
                    spaced: row.spaced,
                    label: row.command.label,
                    description: row.command.description.length === 0
                        ? undefined
                        : row.command.description,
                    meta: rowMeta(row.command),
                    active: row.index === state.selectedIndex,
                    current: false,
                    ...dialogRowPointer(view.pointer, row.index),
                })),
            );
            commandNodes.forEach((node) => {
                box.add(node);
                nodes.push(node);
            });

            const footer = dialogFooterNode(
                renderer,
                "↑↓ move · ⏎ run · esc close",
            );
            box.add(footer);
            nodes.push(footer);
            box.height = "auto";
        },
    };
    return view;
}

function searched(
    state: TuiCommandPaletteState,
    editor: { readonly value: string; readonly cursor: number },
): TuiCommandPaletteTransition {
    return {
        state: filteredState(state.allCommands, editor.value, editor.cursor),
        handled: true,
    };
}

function filteredState(
    allCommands: readonly TuiPaletteEntry[],
    query: string,
    queryCursor = query.length,
): TuiCommandPaletteState {
    const normalized = query.toLowerCase();
    const commands = allCommands.filter((command) =>
        `${command.label} ${command.description} ${command.group} ${
            command.slashName === undefined ? "" : `/${command.slashName}`
        } ${command.keyHint ?? ""}`
            .toLowerCase()
            .includes(normalized)
    );
    return { allCommands, commands, selectedIndex: 0, query, queryCursor };
}

/**
 * The right-hand column answers "how else do I reach this": a keybinding when
 * the action has one, otherwise the slash command that runs it.
 */
function rowMeta(command: TuiPaletteEntry): string | undefined {
    if (command.keyHint !== undefined) {
        return command.keyHint;
    }
    return command.slashName === undefined ? undefined : `/${command.slashName}`;
}

/**
 * The cursor and the row count, so "is there more than I can see" is answered
 * without spending a row on a scrollbar.
 */
function counter(state: TuiCommandPaletteState): string {
    return state.commands.length === 0
        ? "0"
        : `${state.selectedIndex + 1}/${state.commands.length}`;
}

interface PaletteDisplayRow {
    readonly command: TuiPaletteEntry;
    readonly index: number;
    // The group name, on the first visible row of its group and nowhere else,
    // padded so every label starts on the same column. Undefined while
    // searching, where the list is one flat run and the column is dead width.
    readonly gutter?: string;
    readonly spaced: boolean;
}

/**
 * Groups are a column rather than a heading: the name is printed once at the
 * left of the group's first row and the gap below it does the separating.
 * Rows are the scarce axis in an overlay this tall and columns are not.
 */
function displayRows(
    commands: readonly TuiPaletteEntry[],
    offset: number,
    grouping: boolean,
): readonly PaletteDisplayRow[] {
    const width = Math.max(
        0,
        ...TUI_PALETTE_GROUPS.map((group) => group.length),
    ) + 2;
    return commands.map((command, position) => {
        const first = commands[position - 1]?.group !== command.group;
        return {
            command,
            index: offset + position,
            ...(grouping
                ? {
                    gutter: (first ? command.group.toLowerCase() : "")
                        .padEnd(width),
                }
                : {}),
            spaced: grouping && first && position > 0,
        };
    });
}

/**
 * The window is taken over the commands rather than over the rendered rows, so
 * a group whose heading has scrolled off still names itself on the first row
 * left visible.
 */
function windowedRows(
    renderer: RenderContext,
    state: TuiCommandPaletteState,
): readonly PaletteDisplayRow[] {
    const window = listWindowSlice(
        state.commands,
        state.selectedIndex,
        paletteMaxRows(renderer),
    );
    const offset = state.commands.indexOf(window[0]!);
    return displayRows(window, Math.max(0, offset), state.query.length === 0);
}

/**
 * The palette sits a quarter of the way down, near the composer it was typed
 * into, so its budget starts lower than a pane anchored at the top.
 */
function paletteMaxRows(renderer: RenderContext): number {
    return listWindowRows(
        dialogBoxHeight(renderer, renderer.height / 4),
        DIALOG_CHROME_HEIGHT,
    );
}

/**
 * The wheel over the palette. The list windows itself around the cursor, so
 * scrolling moves the cursor and lets the window follow.
 */
export function handleTuiCommandPaletteScroll(
    state: TuiCommandPaletteState,
    scroll: {
        readonly direction: "up" | "down" | "left" | "right";
        readonly delta: number;
    },
): TuiCommandPaletteTransition {
    const selectedIndex = wheelCursor(
        state.selectedIndex,
        state.commands.length,
        scroll,
    );
    return selectedIndex === undefined
        ? { state, handled: false }
        : { state: { ...state, selectedIndex }, handled: true };
}
