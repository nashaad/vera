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
    dialogHeaderNode,
    dialogOptionRow,
    dialogSearchNode,
} from "./dialog-chrome.ts";
import type { TuiPaletteEntry } from "./commands.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_PANEL } from "./state.ts";

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
    return {
        allCommands: commands,
        commands,
        selectedIndex: 0,
        query: "",
    };
}

export function updateTuiCommandPaletteCommands(
    state: TuiCommandPaletteState,
    commands: readonly TuiPaletteEntry[],
): TuiCommandPaletteState {
    return filteredState(commands, state.query);
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
        border: false,
        borderColor: TUI_ACCENT,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: 2,
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

            const rows = windowedCommands(state);
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
            } else {
                rows.forEach(({ command, index }) => {
                    const row = dialogOptionRow(renderer, {
                        label: command.slashName === undefined
                            ? command.name
                            : `/${command.slashName}`,
                        description: command.description,
                        meta: command.usage === undefined
                            || command.usage === `/${command.slashName ?? command.name}`
                            ? undefined
                            : command.usage,
                        active: index === state.selectedIndex,
                        current: false,
                    });
                    box.add(row);
                    nodes.push(row);
                });
            }

            const footer = dialogFooterNode(
                renderer,
                "↑↓ move · ⏎ run · esc close",
            );
            box.add(footer);
            nodes.push(footer);
            box.height = Math.min(MAX_PALETTE_ROWS, state.commands.length)
                + DIALOG_CHROME_HEIGHT;
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
        `${command.name} ${command.description} ${command.usage}`
            .toLowerCase()
            .includes(normalized)
    );
    return { allCommands, commands, selectedIndex: 0, query };
}

function windowedCommands(
    state: TuiCommandPaletteState,
): readonly {
    readonly command: TuiPaletteEntry;
    readonly index: number;
}[] {
    const start = Math.min(
        Math.max(
            0,
            state.selectedIndex - Math.floor(MAX_PALETTE_ROWS / 2),
        ),
        Math.max(0, state.commands.length - MAX_PALETTE_ROWS),
    );
    return state.commands
        .slice(start, start + MAX_PALETTE_ROWS)
        .map((command, offset) => ({ command, index: start + offset }));
}
