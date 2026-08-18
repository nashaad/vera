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
    DIALOG_CARD_Z_INDEX,
    APP_PADDING_BOTTOM,
    APP_PADDING_TOP,
    dialogFooterNode,
    dialogOptionRows,
    dialogRowPointer,
    type DialogRowPointer,
    dialogSearchNode,
} from "./dialog-chrome.ts";
import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import { TUI_KEYMAP, tuiBindingId, type TuiKeyScope } from "./keymap.ts";

export type TuiHelpTab =
    | "general"
    | "keys"
    | "slash_commands"
    | "extensions";

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
    pointer?: DialogRowPointer;
    update(state: TuiHelpState): void;
}

const HELP_TABS: readonly TuiHelpTab[] = [
    "general",
    "keys",
    "slash_commands",
    "extensions",
];

/** The scopes worth naming to a user, in the order the tab lists them. */
const HELP_KEY_SCOPES: readonly { scope: TuiKeyScope; title: string }[] = [
    { scope: "global", title: "Anywhere" },
    { scope: "conversation", title: "Transcript" },
    { scope: "composer", title: "Composer" },
    { scope: "unfocused", title: "Composer unfocused" },
    { scope: "picker", title: "Settings panes" },
    { scope: "model_picker", title: "Model picker" },
    { scope: "session_picker", title: "Session picker" },
    { scope: "approval", title: "Approvals" },
    { scope: "question", title: "Questions" },
    { scope: "secret_prompt", title: "Key entry" },
    { scope: "provider_form", title: "Provider declaration" },
    { scope: "preferences_list", title: "Preferences" },
    { scope: "help", title: "This card" },
];

const CHORD_SYMBOLS: Readonly<Record<string, string>> = {
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
};

/**
 * A chord as the help card writes it.
 *
 * Arrow names become arrows because that is what the key is labelled, and
 * nothing else is rewritten: a chord a user cannot find in the table by
 * searching for what they read is worse than an unpretty one.
 */
function chordLabel(chord: string): string {
    return chord
        .split("+")
        .map((part) => CHORD_SYMBOLS[part] ?? part)
        .join("+");
}

/**
 * Whether a terminal can be relied on to deliver the chord at all.
 *
 * Shift on a ctrl+letter chord is only reported under the kitty keyboard
 * protocol; elsewhere ctrl+shift+u is indistinguishable from ctrl+u and the
 * binding never matches. Saying so beside the row is the difference between a
 * key that looks broken and one the user knows to swap for its alias.
 */
function needsKittyKeyboard(chord: string): boolean {
    const parts = chord.split("+");
    return parts.includes("ctrl") && parts.includes("shift")
        && parts.at(-1)!.length === 1;
}

function keyRows(): readonly {
    readonly label: string;
    readonly description: string;
    readonly meta: string;
}[] {
    return HELP_KEY_SCOPES.flatMap(({ scope, title }) =>
        TUI_KEYMAP.filter((binding) => binding.scope === scope).map((
            binding,
        ) => ({
            label: binding.keys.map(chordLabel).join(" / "),
            description: binding.description,
            meta: binding.keys.every(needsKittyKeyboard)
                ? `${title} · some terminals`
                : title,
        }))
    );
}

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
    if (tuiBindingId("help", key) === "next_help_tab") {
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
                    filteredRows(state).length - 1,
                    state.selectedIndex + 1,
                ),
            },
            handled: true,
        };
    }
    if (key.name.length === 1 || key.name === "space") {
        return {
            state: {
                ...state,
                query: state.query + (key.name === "space" ? " " : key.name),
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
        height: "86%",
        zIndex: DIALOG_CARD_Z_INDEX,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        focusable: true,
        visible: false,
    });

    const view: TuiHelpView = {
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
                        content: state.tab === "keys"
                            ? "No keys found"
                            : state.tab === "extensions"
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
                            label: command.label,
                            description: command.description,
                            meta: command.meta,
                            active: index === state.selectedIndex,
                            current: false,
                            ...dialogRowPointer(view.pointer, index),
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
    return view;
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

interface TuiHelpRow {
    readonly label: string;
    readonly description: string;
    readonly meta: string;
}

function filteredRows(state: TuiHelpState): readonly TuiHelpRow[] {
    const commands: readonly (
        | TuiCommandCatalogEntry
        | ExtensionCommandDescriptor
    )[] = state.tab === "extensions" ? state.extensionCommands : state.commands;
    const rows: readonly TuiHelpRow[] = state.tab === "keys"
        ? keyRows()
        : commands.map((command) => ({
            label: `/${command.name}`,
            description: command.description,
            meta: "source" in command ? command.source : command.usage,
        }));
    const query = state.query.toLowerCase();
    return rows.filter((row) =>
        `${row.label} ${row.description} ${row.meta}`
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
): readonly { readonly command: TuiHelpRow; readonly index: number }[] {
    const commands = filteredRows(state)
        .map((command, index) => ({ command, index }));
    return listWindowSlice(
        commands,
        state.selectedIndex,
        // The card is a fixed share of the terminal rather than growing to fit,
        // so its budget comes off that share and not off the whole screen.
        listWindowRows(
            (renderer.height - APP_PADDING_TOP - APP_PADDING_BOTTOM) * 0.9,
            HELP_CHROME,
        ),
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
        filteredRows(state).length,
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
        fg(TUI_TEXT)("Keys\n"),
        // The Keys tab is generated from the keymap, so naming chords here as
        // well is the drift the table exists to stop. What stays is the input
        // the table deliberately omits: enter, escape, and typing.
        fg(TUI_MUTED)(
            "The Keys tab lists every chord, grouped by where it applies.\n\n",
        ),
        fg(TUI_TEXT)("Composer\n"),
        fg(TUI_MUTED)(
            "Enter send   Shift+Enter newline   Up recall last submission\n"
            + "/ browse commands\n\n",
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
