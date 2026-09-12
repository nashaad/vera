import { DIALOG_SEARCH_HEIGHT, dialogSearchHeight } from "./dialog-search.ts";
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

import { dialogHeaderNode } from "./dialog-header.ts";

import type { ExtensionCommandDescriptor } from "../../src/extensions/commands.ts";
import { chordNeedsExtendedKeyboard } from "./keybindings.ts";
import type { TuiCommandCatalogEntry } from "./commands.ts";
import {
    DIALOG_CARD_Z_INDEX,
    APP_PADDING_TOP,
    dialogFooterNode,
    dialogOptionRows,
    dialogRowPointer,
    type DialogRowPointer,
    createDialogSearchNode,
    updateDialogSearchNode,
} from "./dialog-chrome.ts";
import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import {
    activeTuiKeymap,
    tuiBindingId,
    tuiChordLabel,
    type TuiKeyScope,
} from "./keymap.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

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
    readonly queryCursor: number;
    readonly selectedIndex: number;
}

export interface TuiHelpKey {
    readonly name: string;
    readonly sequence?: string;
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
    focus(): void;
    handleEditorKey(state: TuiHelpState, key: TuiHelpKey): TuiHelpTransition;
    handleEditorPaste(state: TuiHelpState, text: string): TuiHelpState;
    update(state: TuiHelpState): void;
}

const HELP_TABS: readonly TuiHelpTab[] = [
    "general",
    "keys",
    "slash_commands",
    "extensions",
];

const HELP_KEY_SCOPES: readonly { scope: TuiKeyScope; title: string }[] = [
    { scope: "global", title: "Anywhere" },
    { scope: "conversation", title: "Transcript" },
    { scope: "composer", title: "Composer" },
    { scope: "unfocused", title: "Composer unfocused" },
    { scope: "picker", title: "Settings panes" },
    { scope: "switch_model_picker", title: "Switch model" },
    { scope: "model_prefix", title: "After Ctrl+X" },
    { scope: "shortlist_picker", title: "Model Library" },
    { scope: "verification_picker", title: "Model verification" },
    { scope: "model_picker", title: "Model picker" },
    { scope: "session_picker", title: "Session picker" },
    { scope: "approval", title: "Approvals" },
    { scope: "question", title: "Questions" },
    { scope: "secret_prompt", title: "Key entry" },
    { scope: "provider_form", title: "Provider declaration" },
    { scope: "preferences_list", title: "Preferences" },
    { scope: "help", title: "This card" },
    { scope: "diagnostics", title: "Inspect" },
];

/** The leading chords, then a count of the rest. A binding carrying five aliases would otherwise widen this column until every description in the table is squeezed out of its row. */
function chordListLabel(keys: readonly string[]): string {
    const shown = keys.slice(0, 2).map(tuiChordLabel).join(" / ");
    const rest = keys.length - 2;
    return rest > 0 ? `${shown} (+${rest})` : shown;
}

/** Whether a terminal can be relied on to deliver the chord at all. Shift on a ctrl+letter chord is only reported under the kitty keyboard protocol, and ctrl already spends the byte on keys like `[` and `m`. */
const needsKittyKeyboard = chordNeedsExtendedKeyboard;

function keyRows(): readonly {
    readonly label: string;
    readonly description: string;
    readonly meta: string;
}[] {
    return HELP_KEY_SCOPES.flatMap(({ scope, title }) =>
        activeTuiKeymap().filter((binding) => binding.scope === scope).map((
            binding,
        ) => ({
            label: chordListLabel(binding.keys),
            description: binding.description,
            meta: binding.keys.every(needsKittyKeyboard)
                ? `${title} · kitty`
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
        queryCursor: 0,
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
    return { state, handled: false };
}

export function createTuiHelpView(renderer: RenderContext): TuiHelpView {
    let nodes: Renderable[] = [];
    let shownTab: TuiHelpTab = "general";
    const search = createDialogSearchNode(renderer, "help-search");
    const box = new BoxRenderable(renderer, {
        id: "help",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: 1,
        left: "4%",
        width: "92%",
        bottom: 3,
        zIndex: DIALOG_CARD_Z_INDEX,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 0,
        focusable: true,
        visible: false,
    });

    const view: TuiHelpView = {
        box,
        focus(): void {
            if (shownTab === "general") box.focus();
            else search.editor.focus();
        },
        handleEditorKey(state, key): TuiHelpTransition {
            if (
                state.tab === "general" || key.name === "escape"
                || key.name === "up" || key.name === "down"
                || key.name === "return" || key.name === "enter"
                || key.name === "kpenter"
                || (state.query.length === 0
                    && (key.name === "left" || key.name === "right"))
            ) {
                return { state, handled: false };
            }
            if (!search.editor.handleKeyPress(tuiTextareaKey(key))) {
                return { state, handled: false };
            }
            return {
                state: {
                    ...state,
                    query: search.editor.plainText,
                    queryCursor: search.editor.cursorOffset,
                    selectedIndex: 0,
                },
                handled: true,
            };
        },
        handleEditorPaste(state, text): TuiHelpState {
            if (state.tab === "general") return state;
            insertTuiSingleLinePaste(search.editor, text);
            return {
                ...state,
                query: search.editor.plainText,
                queryCursor: search.editor.cursorOffset,
                selectedIndex: 0,
            };
        },
        update(state): void {
            shownTab = state.tab;
            search.box.parent?.remove(search.box.id);
            for (const node of nodes) {
                node.destroyRecursively();
            }
            nodes = [];
            const tabs = new TextRenderable(renderer, {
                content: helpTabs(state.tab),
                width: "100%",
                height: 1,
            });
            const header = dialogHeaderNode(renderer, tabs);
            box.add(header);
            nodes.push(header);
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
                updateDialogSearchNode(
                    search,
                    state.query,
                    "Search",
                    true,
                    state.queryCursor,
                );
                box.add(search.box);
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
        state: {
            ...state,
            tab,
            query: "",
            queryCursor: 0,
            selectedIndex: 0,
        },
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

const HELP_CHROME = 9;

function windowedCommands(
    renderer: RenderContext,
    state: TuiHelpState,
): readonly { readonly command: TuiHelpRow; readonly index: number }[] {
    const commands = filteredRows(state)
        .map((command, index) => ({ command, index }));
    return listWindowSlice(
        commands,
        state.selectedIndex,
        listWindowRows((renderer.height - APP_PADDING_TOP) * 0.9, HELP_CHROME - DIALOG_SEARCH_HEIGHT + dialogSearchHeight(renderer)),
    );
}

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
        fg(TUI_MUTED)(
            "The Keys tab lists every chord, grouped by where it applies.\n\n",
        ),
        fg(TUI_TEXT)("Composer\n"),
        fg(TUI_MUTED)(
            "Enter send   Shift+Enter newline   Up recall last submission\n"
            + "/ browse commands   Esc Esc rewind when idle\n\n",
        ),
        fg(TUI_TEXT)("While Vera is working\n"),
        fg(TUI_MUTED)(
            "Typed Enter queues   Empty Enter sends all   Escape sends one   Ctrl+C stops\n\n",
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
