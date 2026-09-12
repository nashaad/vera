import { DIALOG_SEARCH_HEIGHT, dialogSearchHeight } from "./dialog-search.ts";
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
        // No borderColor here. OpenTUI's BoxRenderable constructor reads any border styling option as "this box wants a border" and overrides an explicit `border: false`, so passing a.
        border: false,
        backgroundColor: TUI_PANEL,
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
            search.editor.focus();
        },
        handleEditorKey(state, key): TuiCommandPaletteTransition {
            if (
                key.name === "escape" || key.name === "up"
                || key.name === "down" || key.name === "return"
                || key.name === "enter" || key.name === "kpenter"
            ) {
                return { state, handled: false };
            }
            const handled = search.editor.handleKeyPress(tuiTextareaKey(key));
            return handled
                ? searched(state, {
                    value: search.editor.plainText,
                    cursor: search.editor.cursorOffset,
                })
                : { state, handled: false };
        },
        handleEditorPaste(state, text): TuiCommandPaletteState {
            insertTuiSingleLinePaste(search.editor, text);
            return filteredState(
                state.allCommands,
                search.editor.plainText,
                search.editor.cursorOffset,
            );
        },
        update(state): void {
            search.box.parent?.remove(search.box.id);
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
            box.add(search.box);
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
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const commands = allCommands.filter((command) => {
        const searchable = `${command.label} ${command.description} ${command.group} ${
            command.slashName === undefined ? "" : `/${command.slashName}`
        } ${command.keyHint ?? ""}`
            .toLowerCase()
;
        return terms.every((term) => searchable.includes(term));
    }).toSorted((left, right) => {
        const labelMatch = (entry: TuiPaletteEntry) => Number(terms.every((term) => entry.label.toLowerCase().includes(term)));
        return labelMatch(right) - labelMatch(left);
    });
    return { allCommands, commands, selectedIndex: 0, query, queryCursor };
}

function rowMeta(command: TuiPaletteEntry): string | undefined {
    if (command.keyHint !== undefined) {
        return command.keyHint;
    }
    return command.slashName === undefined ? undefined : `/${command.slashName}`;
}

function counter(state: TuiCommandPaletteState): string {
    return state.commands.length === 0
        ? "0"
        : `${state.selectedIndex + 1}/${state.commands.length}`;
}

interface PaletteDisplayRow {
    readonly command: TuiPaletteEntry;
    readonly index: number;
    readonly gutter?: string;
    readonly spaced: boolean;
}

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

function paletteMaxRows(renderer: RenderContext): number {
    return listWindowRows(
        dialogBoxHeight(renderer, renderer.height / 4),
        DIALOG_CHROME_HEIGHT - DIALOG_SEARCH_HEIGHT + dialogSearchHeight(renderer),
    );
}

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
