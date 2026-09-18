import { DIALOG_SEARCH_HEIGHT, dialogSearchHeight } from "./dialog-search.ts";
import {
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import {
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
import { arrowMovesForward, sectionArrow, steppedSection } from "./section-keys.ts";

export type TuiHelpTab =
    | "general"
    | "keys"
    | "slash_commands"
    | "extensions";

/** The sections of a searchable page. The menu and General are one section each. */
export type TuiHelpSection = "search" | "list";

export interface TuiHelpState {
    /** The highlighted menu row, and the page shown while `open`. */
    readonly tab: TuiHelpTab;
    readonly open: boolean;
    readonly focus: TuiHelpSection;
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
    onSection?: (section: TuiHelpSection) => void;
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

const HELP_PAGE_DESCRIPTIONS: Readonly<Record<TuiHelpTab, string>> = {
    general: "How Vera works and the main keys",
    keys: "Every key, grouped by where it works",
    slash_commands: "Commands you type in the composer",
    extensions: "Commands that extensions add",
};

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
    { scope: "import_picker", title: "Import picker" },
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
        open: false,
        focus: "search",
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

/** Whether the open page has a Search section. */
export function helpPageSearchable(state: TuiHelpState): boolean {
    return state.open && state.tab !== "general";
}

/** A pointed row is a menu row on the menu and a list row on a page. */
export function pointedHelpRow(state: TuiHelpState, index: number): TuiHelpState {
    if (!state.open) {
        return { ...state, tab: HELP_TABS[index] ?? state.tab };
    }
    return { ...state, focus: "list", selectedIndex: index };
}

export function handleTuiHelpKey(
    state: TuiHelpState,
    key: TuiHelpKey,
): TuiHelpTransition {
    const enter = key.name === "return" || key.name === "enter" || key.name === "kpenter";
    if (key.name === "escape") {
        return state.open
            ? { state: { ...state, open: false, focus: "search", query: "", queryCursor: 0, selectedIndex: 0 }, handled: true }
            : { handled: true };
    }
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return { state, handled: false };
    }
    if (!state.open) {
        if (enter) {
            return { state: { ...state, open: true, focus: "search" }, handled: true };
        }
        if (key.name === "up" || key.name === "down") {
            const at = HELP_TABS.indexOf(state.tab) + (key.name === "up" ? -1 : 1);
            return {
                state: { ...state, tab: HELP_TABS[Math.max(0, Math.min(HELP_TABS.length - 1, at))]! },
                handled: true,
            };
        }
        // One section: Left, Right, Tab, and Space have nowhere to go.
        return sectionArrow(key.name) !== undefined || tuiBindingId("help", key) === "help_section" || key.name === "space"
            ? { state, handled: true }
            : { state, handled: false };
    }
    if (enter) {
        return { state, handled: true };
    }
    if (!helpPageSearchable(state)) {
        return sectionArrow(key.name) !== undefined || tuiBindingId("help", key) === "help_section" || key.name === "space"
            ? { state, handled: true }
            : { state, handled: false };
    }
    const sections: readonly TuiHelpSection[] = ["search", "list"];
    if (tuiBindingId("help", key) === "help_section") {
        const forward = !(key.shift || key.name === "backtab");
        return {
            state: { ...state, focus: steppedSection(sections, state.focus, forward) },
            handled: true,
        };
    }
    const arrow = sectionArrow(key.name);
    if (arrow === undefined) {
        return { state, handled: false };
    }
    const vertical = arrow === "up" || arrow === "down";
    // The editor moves the caret first; an arrow reaching here is at an edge.
    if (state.focus === "search" && !vertical) {
        return { state, handled: true };
    }
    if (state.focus === "list" && vertical) {
        return {
            state: {
                ...state,
                selectedIndex: Math.max(0, Math.min(
                    filteredRows(state).length - 1,
                    state.selectedIndex + (arrow === "up" ? -1 : 1),
                )),
            },
            handled: true,
        };
    }
    return {
        state: { ...state, focus: steppedSection(sections, state.focus, arrowMovesForward(arrow)) },
        handled: true,
    };
}

export function createTuiHelpView(renderer: RenderContext): TuiHelpView {
    let nodes: Renderable[] = [];
    let searching = false;
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
            if (searching) search.editor.focus();
            else box.focus();
        },
        handleEditorKey(state, key): TuiHelpTransition {
            const typing = !key.ctrl && !key.meta && !key.super && !key.hyper
                && key.name !== "space" && (key.sequence ?? key.name).length === 1;
            if (
                !helpPageSearchable(state)
                || (state.focus !== "search" && !typing)
                || key.name === "escape"
                || key.name === "up" || key.name === "down"
                || tuiBindingId("help", key) === "help_section"
                || key.name === "return" || key.name === "enter"
                || key.name === "kpenter"
            ) {
                return { state, handled: false };
            }
            if (!search.editor.handleKeyPress(tuiTextareaKey(key))) {
                return { state, handled: false };
            }
            return {
                state: {
                    ...state,
                    focus: "search",
                    query: search.editor.plainText,
                    queryCursor: search.editor.cursorOffset,
                    selectedIndex: 0,
                },
                handled: true,
            };
        },
        handleEditorPaste(state, text): TuiHelpState {
            if (!helpPageSearchable(state)) return state;
            insertTuiSingleLinePaste(search.editor, text);
            return {
                ...state,
                focus: "search",
                query: search.editor.plainText,
                queryCursor: search.editor.cursorOffset,
                selectedIndex: 0,
            };
        },
        update(state): void {
            searching = helpPageSearchable(state) && state.focus === "search";
            search.box.parent?.remove(search.box.id);
            search.box.onMouseDown = () => view.onSection?.("search");
            for (const node of nodes) {
                node.destroyRecursively();
            }
            nodes = [];
            const header = dialogHeaderNode(
                renderer,
                state.open ? `Help › ${tabLabel(state.tab)}` : "Help",
            );
            box.add(header);
            nodes.push(header);
            if (!state.open) {
                const rows = dialogOptionRows(renderer, HELP_TABS.map((tab, index) => ({
                    label: tabLabel(tab),
                    description: HELP_PAGE_DESCRIPTIONS[tab],
                    active: tab === state.tab,
                    current: false,
                    ...dialogRowPointer(view.pointer, index),
                })));
                rows.forEach((row) => {
                    box.add(row);
                    nodes.push(row);
                });
            } else if (state.tab === "general") {
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
                            dimmed: state.focus !== "list",
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
                !state.open
                    ? "↑↓ choose · ⏎ open · esc close"
                    : state.tab === "general"
                    ? "esc back"
                    : state.focus === "search"
                    ? "type search · Tab/↑↓ sections · esc back"
                    : "↑↓ browse · Tab/←→ sections · type search · esc back",
            );
            box.add(footer);
            nodes.push(footer);
        },
    };
    return view;
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
    if (!state.open) {
        const at = wheelCursor(HELP_TABS.indexOf(state.tab), HELP_TABS.length, scroll);
        return at === undefined
            ? { state, handled: false }
            : { state: { ...state, tab: HELP_TABS[at]! }, handled: true };
    }
    if (!helpPageSearchable(state)) {
        return { state, handled: false };
    }
    const selectedIndex = wheelCursor(
        state.selectedIndex,
        filteredRows(state).length,
        scroll,
    );
    return selectedIndex === undefined
        ? { state, handled: false }
        : { state: { ...state, focus: "list", selectedIndex }, handled: true };
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
            "The Keys page lists every chord, grouped by where it applies.\n\n",
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
            "Included and installed extensions can contribute commands without entering model history.",
        ),
    ]);
}
