import {
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import {
    bg,
    BoxRenderable,
    fg,
    StyledText,
    TextRenderable,
    type Renderable,
    type RenderContext,
} from "@opentui/core";

import type { ExtensionCommandDescriptor } from "../../src/extensions/commands.ts";
import type { TuiCommandCatalogEntry } from "./commands.ts";
import {
    dialogFooterNode,
    dialogOptionRows,
    dialogSearchNode,
} from "./dialog-chrome.ts";
import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";

export type TuiHelpTab = "general" | "slash_commands" | "extensions";

export interface TuiHelpState {
    readonly tab: TuiHelpTab;
    readonly commands: readonly TuiCommandCatalogEntry[];
    readonly extensionCommands: readonly ExtensionCommandDescriptor[];
    readonly query: string;
    readonly selectedIndex: number;
}

export interface TuiHelpKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
    readonly shift?: boolean;
}

export interface TuiHelpTransition {
    readonly state?: TuiHelpState;
    readonly handled: boolean;
}

export interface TuiHelpView {
    readonly box: BoxRenderable;
    update(state: TuiHelpState): void;
}

const HELP_TABS: readonly TuiHelpTab[] = [
    "general",
    "slash_commands",
    "extensions",
];

export function startTuiHelp(
    commands: readonly TuiCommandCatalogEntry[],
    extensionCommands: readonly ExtensionCommandDescriptor[],
): TuiHelpState {
    return {
        tab: "general",
        commands,
        extensionCommands,
        query: "",
        selectedIndex: 0,
    };
}

export function updateTuiHelpCommands(
    state: TuiHelpState,
    commands: readonly TuiCommandCatalogEntry[],
    extensionCommands: readonly ExtensionCommandDescriptor[],
): TuiHelpState {
    return { ...state, commands, extensionCommands, selectedIndex: 0 };
}

export function handleTuiHelpKey(
    state: TuiHelpState,
    key: TuiHelpKey,
): TuiHelpTransition {
    if (key.name === "escape") {
        return { handled: true };
    }
    if (
        key.name === "return"
        || key.name === "enter"
        || key.name === "kpenter"
    ) {
        return { state, handled: true };
    }
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return { state, handled: false };
    }
    if (key.name === "left") {
        return switchedTab(state, -1);
    }
    if (key.name === "right" || key.name === "tab") {
        return switchedTab(state, 1);
    }
    if (state.tab === "general") {
        return { state, handled: false };
    }
    if (key.name === "backspace") {
        return {
            state: { ...state, query: state.query.slice(0, -1), selectedIndex: 0 },
            handled: true,
        };
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
                    filteredCommands(state).length - 1,
                    state.selectedIndex + 1,
                ),
            },
            handled: true,
        };
    }
    if (key.name.length === 1) {
        return {
            state: {
                ...state,
                query: state.query + key.name,
                selectedIndex: 0,
            },
            handled: true,
        };
    }
    return { state, handled: false };
}

export function createTuiHelpView(renderer: RenderContext): TuiHelpView {
    let nodes: Renderable[] = [];
    const box = new BoxRenderable(renderer, {
        id: "help",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: 1,
        left: "4%",
        width: "92%",
        height: "90%",
        zIndex: 16,
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
            const tabs = new TextRenderable(renderer, {
                content: helpTabs(state.tab),
                width: "100%",
                height: 3,
            });
            box.add(tabs);
            nodes.push(tabs);
            if (state.tab === "general") {
                const general = new TextRenderable(renderer, {
                    content: generalHelp(),
                    width: "100%",
                    height: 17,
                    wrapMode: "word",
                });
                box.add(general);
                nodes.push(general);
            } else {
                const search = dialogSearchNode(renderer, state.query);
                box.add(search);
                nodes.push(search);
                const commands = windowedCommands(renderer, state);
                if (commands.length === 0) {
                    const empty = new TextRenderable(renderer, {
                        content: state.tab === "extensions"
                            ? "No extension commands found"
                            : "No slash commands found",
                        fg: TUI_MUTED,
                        width: "100%",
                        height: 1,
                        paddingLeft: 1,
                    });
                    box.add(empty);
                    nodes.push(empty);
                } else {
                    const rows = dialogOptionRows(renderer, commands.map(({ command, index }) => ({
                            label: `/${command.name}`,
                            description: command.description,
                            meta: "source" in command
                                ? command.source
                                : command.usage,
                            active: index === state.selectedIndex,
                            current: false,
                    })));
                    rows.forEach((row) => {
                        box.add(row);
                        nodes.push(row);
                    });
                }
            }
            const footer = dialogFooterNode(
                renderer,
                state.tab === "general"
                    ? "←→ tabs · esc close"
                    : "←→ tabs · ↑↓ browse · type search · esc close",
            );
            box.add(footer);
            nodes.push(footer);
        },
    };
}

function switchedTab(
    state: TuiHelpState,
    direction: -1 | 1,
): TuiHelpTransition {
    const current = HELP_TABS.indexOf(state.tab);
    const tab = HELP_TABS[
        (current + direction + HELP_TABS.length) % HELP_TABS.length
    ]!;
    return {
        state: { ...state, tab, query: "", selectedIndex: 0 },
        handled: true,
    };
}

function filteredCommands(
    state: TuiHelpState,
): readonly (TuiCommandCatalogEntry | ExtensionCommandDescriptor)[] {
    const commands = state.tab === "extensions"
        ? state.extensionCommands
        : state.commands;
    const query = state.query.toLowerCase();
    return commands.filter((command) =>
        `${command.name} ${command.description} ${command.usage}`
            .toLowerCase()
            .includes(query)
    );
}

/**
 * Everything in the card that is not a command row: the tab strip, the search
 * line, the footer, and the padding above.
 */
const HELP_CHROME = 8;

function windowedCommands(
    renderer: RenderContext,
    state: TuiHelpState,
): readonly {
    readonly command: TuiCommandCatalogEntry | ExtensionCommandDescriptor;
    readonly index: number;
}[] {
    const commands = filteredCommands(state)
        .map((command, index) => ({ command, index }));
    return listWindowSlice(
        commands,
        state.selectedIndex,
        // The card is a fixed share of the terminal rather than growing to fit,
        // so its budget comes off that share and not off the whole screen.
        listWindowRows(renderer.height * 0.9, HELP_CHROME),
    );
}

/**
 * The wheel over the help list. The cursor moves and the window follows, the
 * same as every other windowed list here.
 */
export function handleTuiHelpScroll(
    state: TuiHelpState,
    scroll: {
        readonly direction: "up" | "down" | "left" | "right";
        readonly delta: number;
    },
): TuiHelpTransition {
    if (state.tab === "general") {
        return { state, handled: false };
    }
    const selectedIndex = wheelCursor(
        state.selectedIndex,
        filteredCommands(state).length,
        scroll,
    );
    return selectedIndex === undefined
        ? { state, handled: false }
        : { state: { ...state, selectedIndex }, handled: true };
}

function helpTabs(active: TuiHelpTab): StyledText {
    return new StyledText([
        fg(TUI_TEXT)("Help  "),
        ...HELP_TABS.flatMap((tab) => [
            tab === active
                ? fg(TUI_BACKGROUND)(bg(TUI_ACCENT)(` ${tabLabel(tab)} `))
                : fg(TUI_ACCENT)(` ${tabLabel(tab)} `),
            fg(TUI_PANEL)("  "),
        ]),
    ]);
}

function tabLabel(tab: TuiHelpTab): string {
    if (tab === "slash_commands") {
        return "Slash commands";
    }
    return tab[0]!.toUpperCase() + tab.slice(1);
}

function generalHelp(): StyledText {
    return new StyledText([
        fg(TUI_ACCENT)("Vera keeps agent sessions resident so clients can attach, leave, and return.\n\n"),
        fg(TUI_TEXT)("Anywhere\n"),
        // Ctrl+P is otherwise advertised only by the idle status line, which is
        // replaced while a turn is running. A chord nobody can rediscover is a
        // chord nobody uses.
        fg(TUI_MUTED)(
            "Ctrl+P search every action by name or description\n\n",
        ),
        fg(TUI_TEXT)("Composer\n"),
        fg(TUI_MUTED)(
            "Enter send   Shift+Enter newline   Up recall last submission\n"
            + "/ browse commands   Tab complete a slash command\n\n",
        ),
        fg(TUI_TEXT)("While Vera is working\n"),
        fg(TUI_MUTED)(
            "Enter queues another prompt   Escape steers queued text   Ctrl+C stops\n\n",
        ),
        fg(TUI_TEXT)("Conversations\n"),
        fg(TUI_MUTED)(
            "Resume, name, fork, clone, rewind, or start fresh through slash commands.\n\n",
        ),
        fg(TUI_TEXT)("Extensions\n"),
        fg(TUI_MUTED)(
            "Bundled and installed extensions can contribute commands without entering model history.",
        ),
    ]);
}
