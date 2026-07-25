import {
    BoxRenderable,
    TextRenderable,
    type Renderable,
    type RenderContext,
} from "@opentui/core";

import {
    DIALOG_CHROME_HEIGHT,
    DIALOG_GUTTER_WIDTH,
    dialogFooterNode,
    dialogGroupHeaderNode,
    dialogHeaderNode,
    dialogOptionRows,
    dialogSearchNode,
} from "./dialog-chrome.ts";
import { TUI_PALETTE_GROUPS, type TuiPaletteEntry } from "./commands.ts";
import { TUI_MUTED, TUI_PANEL } from "./state.ts";

export interface TuiCommandPaletteState {
    readonly allCommands: readonly TuiPaletteEntry[];
    readonly commands: readonly TuiPaletteEntry[];
    readonly selectedIndex: number;
    readonly query: string;
}

export interface TuiCommandPaletteKey {
    readonly name: string;
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
    return filteredState(grouped(commands), state.query);
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
    if (key.name === "backspace") {
        return searched(state, state.query.slice(0, -1));
    }
    if (key.name.length === 1) {
        return searched(state, state.query + key.name);
    }
    // Rows are verb phrases now, so "switch model" is the natural way to narrow
    // to one. Terminals name the spacebar rather than sending the character.
    if (key.name === "space") {
        return searched(state, `${state.query} `);
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
    const box = new BoxRenderable(renderer, {
        id: "command-palette",
        // No borderColor here. OpenTUI's BoxRenderable constructor reads any
        // border styling option as "this box wants a border" and overrides an
        // explicit `border: false`, so passing a color is what draws the box.
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: 4,
        left: "10%",
        width: "80%",
        height: 8,
        zIndex: 15,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        focusable: true,
        visible: false,
    });

    return {
        box,
        update(state): void {
            for (const node of nodes) {
                node.destroy();
            }
            nodes = [];
            const header = dialogHeaderNode(renderer, "Commands");
            const search = dialogSearchNode(renderer, state.query);
            box.add(header);
            box.add(search);
            nodes.push(header, search);

            const rows = windowedRows(displayRows(state), state.selectedIndex);
            let lines = 0;
            if (rows.length === 0) {
                const empty = new TextRenderable(renderer, {
                    content: "No commands found",
                    fg: TUI_MUTED,
                    width: "100%",
                    height: 1,
                    paddingLeft: DIALOG_GUTTER_WIDTH,
                });
                box.add(empty);
                nodes.push(empty);
                lines = 1;
            }
            const commandContents = rows.flatMap((row) =>
                row.kind === "command"
                    ? [{
                        label: row.command.label,
                        leading: "  ",
                        description: row.command.description.length === 0
                            ? undefined
                            : row.command.description,
                        meta: rowMeta(row.command),
                        active: row.index === state.selectedIndex,
                        current: false,
                    }]
                    : []
            );
            const commandNodes = dialogOptionRows(renderer, commandContents);
            let commandNodeIndex = 0;
            rows.forEach((row, position) => {
                const node = row.kind === "group"
                    ? dialogGroupHeaderNode(renderer, row.label, position > 0)
                    : commandNodes[commandNodeIndex++]!;
                lines += row.kind === "group" && position > 0 ? 2 : 1;
                box.add(node);
                nodes.push(node);
            });

            const footer = dialogFooterNode(
                renderer,
                "↑↓ move · ⏎ run · esc close",
            );
            box.add(footer);
            nodes.push(footer);
            box.height = lines + DIALOG_CHROME_HEIGHT;
        },
    };
}

const MAX_PALETTE_ROWS = 12;

function searched(
    state: TuiCommandPaletteState,
    query: string,
): TuiCommandPaletteTransition {
    return {
        state: filteredState(state.allCommands, query),
        handled: true,
    };
}

function filteredState(
    allCommands: readonly TuiPaletteEntry[],
    query: string,
): TuiCommandPaletteState {
    const normalized = query.toLowerCase();
    const commands = allCommands.filter((command) =>
        `${command.label} ${command.description} ${command.group} ${
            command.slashName === undefined ? "" : `/${command.slashName}`
        }`
            .toLowerCase()
            .includes(normalized)
    );
    return { allCommands, commands, selectedIndex: 0, query };
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

type PaletteDisplayRow =
    | { readonly kind: "group"; readonly label: string }
    | {
        readonly kind: "command";
        readonly command: TuiPaletteEntry;
        readonly index: number;
    };

function displayRows(
    state: TuiCommandPaletteState,
): readonly PaletteDisplayRow[] {
    const rows: PaletteDisplayRow[] = [];
    state.commands.forEach((command, index) => {
        if (state.commands[index - 1]?.group !== command.group) {
            rows.push({ kind: "group", label: command.group });
        }
        rows.push({ kind: "command", command, index });
    });
    return rows;
}

function windowedRows(
    rows: readonly PaletteDisplayRow[],
    selectedIndex: number,
): readonly PaletteDisplayRow[] {
    if (rows.length <= MAX_PALETTE_ROWS) {
        return rows;
    }
    const cursor = rows.findIndex((row) =>
        row.kind === "command" && row.index === selectedIndex
    );
    const centered = Math.max(0, cursor) - Math.floor(MAX_PALETTE_ROWS / 2);
    const start = Math.min(
        Math.max(0, centered),
        rows.length - MAX_PALETTE_ROWS,
    );
    return rows.slice(start, start + MAX_PALETTE_ROWS);
}
