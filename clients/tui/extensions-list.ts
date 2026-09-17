import {
    BoxRenderable,
    fg,
    StyledText,
    TextRenderable,
    type MouseEvent,
    type Renderable,
    type RenderContext,
    type TextChunk,
} from "@opentui/core";

import type { ExtensionListEntry } from "../../src/extensions/manager.ts";
import {
    DIALOG_HEADER_HEIGHT,
    DIALOG_CARD_PADDING,
    DIALOG_CARD_Z_INDEX,
    dialogFooterNode,
    dialogGroupHeaderNode,
    dialogHeaderNode,
    updateDialogHeaderTitle,
    dialogInsetBottomOffset,
    dialogInsetTop,
    dialogOptionRow,
    dialogRowPointer,
    registerDialogCard,
    type DialogRowPointer,
} from "./dialog-chrome.ts";
import {
    dialogBoxHeight,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import { isTuiDialTabKey } from "./keymap.ts";
import {
    TUI_ACCENT,
    TUI_DANGER,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_SELECTION_TEXT,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";

const LIST_CHROME_ROWS = DIALOG_HEADER_HEIGHT + 6;
const EXTENSION_ROW_HEIGHT = 3;
const SCOPE_ORDER = ["project", "profile"] as const;

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
    "agents.register": "agents",
    "client.agents": "agents",
    "client.commands.register": "commands",
    "client.compose.suggester": "suggester",
    "client.compose.write": "compose",
    "client.context.read": "context",
    "client.experimental_tui": "tui",
    "client.keybindings.register": "keys",
    "client.messages.intercept": "intercept",
    "client.model_settings": "model settings",
    "client.preferences": "preferences",
    "client.sessions.read": "sessions",
    "client.ui.addressing": "addressing",
    "client.ui.mentions": "mentions",
    "client.ui.notice": "notice",
    "client.ui.picker": "picker",
    "client.ui.sidebar": "sidebar",
    "client.ui.transcript": "transcript",
    "commands.register": "commands",
    "hooks.command": "command hooks",
    "hooks.model_request": "model request",
    "hooks.post_tool_use": "post tool use",
    "sessions.identity": "session identity",
    "tools.register": "tools",
};

export type TuiExtensionStatus =
    | "enabled"
    | "disabled"
    | "failed"
    | "unmanaged"
    | "shadowed";

export type TuiExtensionsListScreen = "list" | "detail" | "remove_confirm" | "error";

export interface TuiExtensionSettingsCommand {
    readonly name: string;
    readonly label: string;
}

export interface TuiExtensionListRow {
    readonly settingsCommands?: readonly TuiExtensionSettingsCommand[];
    readonly scope: "profile" | "project";
    readonly id: string;
    readonly version: string;
    readonly status: TuiExtensionStatus;
    readonly managed: boolean;
    readonly path: string;
    readonly source?: string;
    readonly capabilities: readonly string[];
    readonly contributionLine: string;
    readonly error?: string;
    readonly loaded: boolean;
}

export interface TuiExtensionsListState {
    readonly screen: TuiExtensionsListScreen;
    readonly rows: readonly TuiExtensionListRow[];
    readonly selectedIndex: number;
    readonly actionIndex: number;
    readonly message?: string;
}

export interface TuiExtensionsListKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiExtensionsListMutation {
    readonly operation: "enable" | "disable" | "remove";
    readonly entry: TuiExtensionListRow;
}

export interface TuiExtensionsListTransition {
    readonly state?: TuiExtensionsListState;
    readonly handled: boolean;
    readonly mutate?: TuiExtensionsListMutation;
    readonly command?: string;
}

export interface TuiExtensionsListView {
    readonly box: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    pointer?: DialogRowPointer;
    focus(): void;
    update(state: TuiExtensionsListState): void;
    scroll(scroll: {
        readonly direction: "up" | "down" | "left" | "right";
        readonly delta: number;
    }): boolean;
}

export function extensionContributionLabel(capability: string): string {
    return CAPABILITY_LABELS[capability] ?? lastCapabilitySegment(capability);
}

export function extensionContributionLine(
    capabilities: readonly string[] | undefined,
): string {
    if (capabilities === undefined || capabilities.length === 0) return "none";
    return uniqueLabels(capabilities.map(extensionContributionLabel)).join(" · ");
}

export function openTuiExtensionsList(
    entries: readonly ExtensionListEntry[],
    loadedIds: ReadonlySet<string> = new Set(),
    selected?: { readonly scope: "profile" | "project"; readonly id: string },
): TuiExtensionsListState {
    const rows = extensionListRows(entries, loadedIds);
    return {
        screen: "list",
        rows,
        selectedIndex: selectedIndexOf(rows, selected),
        actionIndex: 0,
    };
}

export function openTuiExtensionsListError(message: string): TuiExtensionsListState {
    return {
        screen: "error",
        rows: [],
        selectedIndex: 0,
        actionIndex: 0,
        message,
    };
}

export function syncTuiExtensionsList(
    state: TuiExtensionsListState,
    entries: readonly ExtensionListEntry[],
    loadedIds: ReadonlySet<string> = new Set(),
): TuiExtensionsListState {
    if (state.screen === "error") {
        return openTuiExtensionsList(entries, loadedIds);
    }
    const selected = state.rows[state.selectedIndex];
    const rows = extensionListRows(entries, loadedIds);
    if (selected === undefined) {
        return {
            screen: "list",
            rows,
            selectedIndex: 0,
            actionIndex: 0,
        };
    }
    const selectedIndex = rows.findIndex((row) =>
        row.scope === selected.scope && row.id === selected.id
    );
    if (selectedIndex === -1) {
        return {
            screen: "list",
            rows,
            selectedIndex: 0,
            actionIndex: 0,
        };
    }
    return {
        screen: state.screen,
        rows,
        selectedIndex,
        actionIndex: Math.min(
            state.actionIndex,
            Math.max(0, detailActions(rows[selectedIndex]).length - 1),
        ),
    };
}

export function selectedExtensionRow(
    state: TuiExtensionsListState,
): TuiExtensionListRow | undefined {
    return state.rows[state.selectedIndex];
}

export function handleTuiExtensionsListKey(
    state: TuiExtensionsListState,
    key: TuiExtensionsListKey,
): TuiExtensionsListTransition {
    if (isTuiDialTabKey(key) && !key.ctrl && !key.meta) {
        return { state, handled: true };
    }
    if (key.ctrl || key.meta || key.super || key.hyper || key.shift) {
        return { state, handled: false };
    }
    if (state.screen === "error") {
        return key.name === "escape" ? { handled: true } : { state, handled: true };
    }
    if (state.screen === "remove_confirm") {
        return handleRemoveKey(state, key);
    }
    if (state.screen === "detail") {
        return handleDetailKey(state, key);
    }
    return handleListKey(state, key);
}

export function renderTuiExtensionsList(state: TuiExtensionsListState): string {
    const content = screenContent(state);
    return [content.title, "", content.body, "", content.footer].join("\n");
}

export function createTuiExtensionsListView(
    renderer: RenderContext,
): TuiExtensionsListView {
    const header = dialogHeaderNode(renderer, "Extensions");
    const body = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexDirection: "column",
        marginTop: 1,
        minHeight: 1,
    });
    const footer = dialogFooterNode(renderer, "");
    footer.flexShrink = 0;
    footer.wrapMode = "none";
    footer.overflow = "hidden";
    const box = new BoxRenderable(renderer, {
        id: "extensions-list",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: dialogInsetTop(renderer),
        left: "10%",
        width: "80%",
        height: "auto",
        zIndex: DIALOG_CARD_Z_INDEX,
        paddingLeft: DIALOG_CARD_PADDING,
        paddingRight: DIALOG_CARD_PADDING,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
        visible: false,
    });
    registerDialogCard(box);
    box.add(header);
    box.add(body);
    box.add(footer);
    let current: Renderable[] = [];
    let shown: TuiExtensionsListState | undefined;

    const view: TuiExtensionsListView = {
        box,
        themeBindings: [
            tuiThemeProperties(box, { backgroundColor: "panel" }),
            tuiThemeProperties(footer, { fg: "muted" }),
        ],
        focus(): void {
            box.focus();
        },
        update(state): void {
            shown = state;
            box.top = dialogInsetTop(renderer);
            box.maxHeight = dialogBoxHeight(
                renderer,
                dialogInsetTop(renderer),
                dialogInsetBottomOffset(renderer),
            );
            const indices = visibleRowIndices(renderer, state);
            const content = screenContent(state, indices);
            body.flexShrink = state.screen === "list" ? 0 : 1;
            updateDialogHeaderTitle(header, content.title);
            const range = state.screen === "list" && indices.length < state.rows.length
                ? `\nShowing ${indices[0]! + 1}-${indices.at(-1)! + 1} of ${state.rows.length}`
                : "";
            const hint = state.screen === "list" && state.rows.length > 0
                && Bun.stringWidth(content.footer) > listContentWidth(renderer)
                ? listFooter(state.rows[state.selectedIndex], true)
                : content.footer;
            footer.content = hint + range;
            for (const node of current) {
                node.destroyRecursively();
            }
            current = [];
            if (state.screen === "list") {
                paintList(renderer, body, state, view.pointer, current);
                return;
            }
            if (state.screen === "detail") {
                paintDetail(renderer, body, state, view.pointer, current);
                return;
            }
            const text = new TextRenderable(renderer, {
                content: content.body,
                fg: state.screen === "error" ? TUI_NOTICE : TUI_TEXT,
                width: "100%",
                height: "auto",
                wrapMode: "word",
            });
            body.add(text);
            current.push(text);
        },
        scroll(scroll): boolean {
            if (shown === undefined || shown.screen !== "list") return false;
            const next = wheelCursor(shown.selectedIndex, shown.rows.length, scroll);
            if (next === undefined || view.pointer?.hover === undefined) return false;
            view.pointer.hover(next);
            return true;
        },
    };
    return view;
}

function handleListKey(
    state: TuiExtensionsListState,
    key: TuiExtensionsListKey,
): TuiExtensionsListTransition {
    if (key.name === "escape") return { handled: true };
    if (state.rows.length === 0) return { state, handled: true };
    if (key.name === "left" || key.name === "right") return { state, handled: true };
    if (key.name === "up" || key.name === "down") {
        const step = key.name === "up" ? -1 : 1;
        return {
            state: {
                ...state,
                selectedIndex: clampIndex(
                    state.selectedIndex + step,
                    state.rows.length,
                ),
                actionIndex: 0,
            },
            handled: true,
        };
    }
    const selected = state.rows[state.selectedIndex];
    if (key.name === "return" || key.name === "enter" || key.name === "kpenter") {
        return selected === undefined
            ? { state, handled: true }
            : { state: { ...state, screen: "detail", actionIndex: 0 }, handled: true };
    }
    if ((key.name === "space" || key.sequence === " ") && selected !== undefined) {
        const mutate = toggleMutation(selected);
        return mutate === undefined
            ? { state, handled: true }
            : { state, handled: true, mutate };
    }
    return { state, handled: false };
}

function handleDetailKey(
    state: TuiExtensionsListState,
    key: TuiExtensionsListKey,
): TuiExtensionsListTransition {
    if (key.name === "escape") {
        return { state: { ...state, screen: "list", actionIndex: 0 }, handled: true };
    }
    const selected = state.rows[state.selectedIndex];
    const actions = detailActions(selected);
    if (key.name === "left" || key.name === "right") {
        return { state, handled: true };
    }
    if (key.name === "up" || key.name === "down") {
        if (actions.length === 0) return { state, handled: true };
        const step = key.name === "up" ? -1 : 1;
        return {
            state: {
                ...state,
                actionIndex: clampIndex(state.actionIndex + step, actions.length),
            },
            handled: true,
        };
    }
    if ((key.name === "space" || key.sequence === " ") && selected !== undefined) {
        const mutate = toggleMutation(selected);
        return mutate === undefined
            ? { state, handled: true }
            : { state, handled: true, mutate };
    }
    if (key.name === "return" || key.name === "enter" || key.name === "kpenter") {
        const action = actions[state.actionIndex];
        if (action === undefined || selected === undefined) {
            return { state, handled: true };
        }
        if (action.startsWith("command:")) {
            return { state, handled: true, command: action.slice("command:".length) };
        }
        if (action === "remove") {
            return {
                state: { ...state, screen: "remove_confirm" },
                handled: true,
            };
        }
        return { state, handled: true, mutate: toggleMutation(selected) };
    }
    return { state, handled: false };
}

function handleRemoveKey(
    state: TuiExtensionsListState,
    key: TuiExtensionsListKey,
): TuiExtensionsListTransition {
    if (key.name === "escape") {
        return { state: { ...state, screen: "detail" }, handled: true };
    }
    if (key.name === "return" || key.name === "enter" || key.name === "kpenter") {
        const selected = state.rows[state.selectedIndex];
        return selected === undefined
            ? { state, handled: true }
            : {
                state,
                handled: true,
                mutate: { operation: "remove", entry: selected },
            };
    }
    return { state, handled: true };
}

function extensionListRows(
    entries: readonly ExtensionListEntry[],
    loadedIds: ReadonlySet<string>,
): readonly TuiExtensionListRow[] {
    const projectIds = new Set(
        entries.filter((entry) => entry.scope === "project").map((entry) => entry.id),
    );
    return [...entries]
        .map((entry) => toRow(entry, projectIds, loadedIds))
        .toSorted((left, right) => compareRows(left, right));
}

function toRow(
    entry: ExtensionListEntry,
    projectIds: ReadonlySet<string>,
    loadedIds: ReadonlySet<string>,
): TuiExtensionListRow {
    const capabilities = entry.capabilities ?? [];
    const shadowed = entry.scope === "profile" && projectIds.has(entry.id);
    return {
        scope: entry.scope,
        id: entry.id,
        version: entry.version === undefined ? "?" : `v${entry.version}`,
        status: rowStatus(entry, shadowed),
        managed: entry.managed,
        path: entry.path,
        ...(entry.source === undefined ? {} : { source: entry.source }),
        capabilities,
        contributionLine: entry.error === undefined
            ? extensionContributionLine(capabilities)
            : entry.error,
        ...(entry.error === undefined ? {} : { error: entry.error }),
        loaded: loadedIds.has(entry.id),
    };
}

function rowStatus(
    entry: ExtensionListEntry,
    shadowed: boolean,
): TuiExtensionStatus {
    if (entry.error !== undefined) return "failed";
    if (entry.bundled) return entry.enabled ? "enabled" : "disabled";
    if (!entry.managed) return "unmanaged";
    if (shadowed) return "shadowed";
    return entry.enabled ? "enabled" : "disabled";
}

function compareRows(left: TuiExtensionListRow, right: TuiExtensionListRow): number {
    const scope = SCOPE_ORDER.indexOf(left.scope) - SCOPE_ORDER.indexOf(right.scope);
    if (scope !== 0) return scope;
    return left.id.localeCompare(right.id);
}

function selectedIndexOf(
    rows: readonly TuiExtensionListRow[],
    selected: { readonly scope: "profile" | "project"; readonly id: string } | undefined,
): number {
    if (selected === undefined) return 0;
    const index = rows.findIndex((row) =>
        row.scope === selected.scope && row.id === selected.id
    );
    return index === -1 ? 0 : index;
}

function toggleMutation(
    entry: TuiExtensionListRow,
): TuiExtensionsListMutation | undefined {
    if (!entry.managed) return undefined;
    return {
        operation: entry.status === "disabled" ? "enable" : "disable",
        entry,
    };
}

function detailActions(
    entry: TuiExtensionListRow | undefined,
): readonly string[] {
    if (!entry) return [];
    return [...(entry.settingsCommands ?? []).map((command) => `command:${command.name}`), ...(entry.managed ? ["toggle", "remove"] : [])];
}

function lastCapabilitySegment(capability: string): string {
    const segment = capability.split(".").at(-1) ?? capability;
    return segment.replaceAll("_", "-");
}

function uniqueLabels(labels: readonly string[]): readonly string[] {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const label of labels) {
        if (seen.has(label)) continue;
        seen.add(label);
        unique.push(label);
    }
    return unique;
}

function clampIndex(index: number, length: number): number {
    if (length <= 0) return 0;
    return Math.max(0, Math.min(length - 1, index));
}

function screenContent(
    state: TuiExtensionsListState,
    visibleIndices?: readonly number[],
): { readonly title: string; readonly body: string; readonly footer: string } {
    if (state.screen === "error") {
        return {
            title: "Extensions",
            body: state.message ?? "Could not read extension state.",
            footer: "esc close",
        };
    }
    if (state.screen === "remove_confirm") {
        const selected = state.rows[state.selectedIndex];
        return {
            title: selected === undefined
                ? "Remove extension?"
                : `Remove ${selected.id}?`,
            body: "This deletes the managed copy. The source is untouched.",
            footer: "⏎ remove · esc back",
        };
    }
    if (state.screen === "detail") {
        return detailContent(state);
    }
    if (state.rows.length === 0) {
        return {
            title: "Extensions",
            body: "No extensions installed\n/extension install <path>  adds a local copy",
            footer: "esc close",
        };
    }
    return {
        title: "Extensions",
        body: listBody(state, visibleIndices ?? state.rows.map((_, index) => index)),
        footer: listFooter(state.rows[state.selectedIndex]),
    };
}

function listBody(
    state: TuiExtensionsListState,
    indices: readonly number[],
): string {
    const idWidth = Math.max(...state.rows.map((row) => row.id.length));
    const lines: string[] = [];
    let scope: TuiExtensionListRow["scope"] | undefined;
    for (const index of indices) {
        const row = state.rows[index];
        if (row === undefined) continue;
        if (row.scope !== scope) {
            if (lines.length > 0) lines.push("");
            lines.push(scopeLabel(row.scope));
            scope = row.scope;
        }
        const marker = index === state.selectedIndex ? "›" : " ";
        lines.push(
            `${marker} ${row.id.padEnd(idWidth)}  ${row.version}  ${row.status}`,
        );
        lines.push(`  ${row.contributionLine}`);
    }
    return lines.join("\n");
}

function listFooter(row: TuiExtensionListRow | undefined, compact = false): string {
    if (row === undefined) return "esc close";
    if (!row.managed) return "↑↓ move · ⏎ details · esc close";
    const toggle = row.status === "disabled" ? "Space enable" : "Space disable";
    return compact
        ? `↑↓ · ⏎ details · ${toggle} · esc`
        : `↑↓ move · ⏎ details · ${toggle} · esc close`;
}

function detailContent(
    state: TuiExtensionsListState,
): { readonly title: string; readonly body: string; readonly footer: string } {
    const row = state.rows[state.selectedIndex];
    if (row === undefined) {
        return {
            title: "Extensions",
            body: "That extension is no longer installed.",
            footer: "esc back",
        };
    }
    const actions = detailActions(row);
    const actionLines = actions.map((action, index) => {
        const marker = index === state.actionIndex ? "›" : " ";
        const label = detailActionLabel(row, action);
        return `${marker} ${label}`;
    });
    const facts = [
        `${row.version} · ${row.status} · ${row.scope}`,
        row.loaded ? "loaded on this client" : "not loaded on this client",
        "",
        row.contributionLine,
        row.capabilities.join(", ") || "none",
        ...(actionLines.length === 0 ? [] : ["", ...actionLines]),
        "",
        `path    ${row.path}`,
        ...(row.source === undefined ? [] : [`source  ${row.source}`]),
    ];
    return {
        title: row.id,
        body: facts.join("\n"),
        footer: detailFooter(row, actions[state.actionIndex]),
    };
}

function detailFooter(
    row: TuiExtensionListRow,
    action: string | undefined,
): string {
    if (action?.startsWith("command:")) return "↑↓ move · ⏎ open · esc back";
    if (action === "remove") return "↑↓ move · ⏎ remove · esc back";
    if (action === "toggle") {
        const verb = row.status === "disabled" ? "enable" : "disable";
        return `↑↓ move · ⏎ ${verb} · esc back`;
    }
    return "esc back";
}

function detailActionLabel(row: TuiExtensionListRow, action: string): string {
    return action.startsWith("command:")
        ? row.settingsCommands?.find((command) => command.name === action.slice(8))?.label ?? "Configure"
        : action === "remove" ? "Remove" : toggleLabel(row);
}

function toggleLabel(row: TuiExtensionListRow): string {
    return row.status === "disabled" ? "Enable" : "Disable";
}

function scopeLabel(scope: TuiExtensionListRow["scope"]): string {
    return scope === "project" ? "In Project" : "In Profile";
}

function visibleRowIndices(
    renderer: RenderContext,
    state: TuiExtensionsListState,
): readonly number[] {
    if (state.screen !== "list") {
        return state.rows.map((_, index) => index);
    }
    const indices = state.rows.map((_, index) => index);
    const groups = new Set(state.rows.map((row) => row.scope)).size;
    const groupLines = groups === 0 ? 0 : groups * 2 - 1;
    const available = dialogBoxHeight(
        renderer,
        dialogInsetTop(renderer),
        dialogInsetBottomOffset(renderer),
    ) - LIST_CHROME_ROWS - groupLines;
    return listWindowSlice(
        indices,
        state.selectedIndex,
        Math.max(1, Math.floor(available / EXTENSION_ROW_HEIGHT)),
    );
}

function listContentWidth(renderer: RenderContext): number {
    return Math.max(1, Math.floor(renderer.width * 0.8) - DIALOG_CARD_PADDING * 2);
}

function paintList(
    renderer: RenderContext,
    body: BoxRenderable,
    state: TuiExtensionsListState,
    pointer: DialogRowPointer | undefined,
    current: Renderable[],
): void {
    if (state.rows.length === 0) {
        const empty = new TextRenderable(renderer, {
            content: "No extensions installed\n/extension install <path>  adds a local copy",
            fg: TUI_MUTED,
            width: "100%",
            height: "auto",
            wrapMode: "word",
        });
        body.add(empty);
        current.push(empty);
        return;
    }
    let scope: TuiExtensionListRow["scope"] | undefined;
    let firstGroup = true;
    const width = listContentWidth(renderer);
    const versionWidth = Math.min(12, Math.max(...state.rows.map((row) => Bun.stringWidth(row.version))));
    const statusWidth = Math.max(...state.rows.map((row) => row.status.length));
    const nameWidth = Math.max(1, width - versionWidth - statusWidth - 6);
    for (const index of visibleRowIndices(renderer, state)) {
        const row = state.rows[index];
        if (row === undefined) continue;
        if (row.scope !== scope) {
            const header = dialogGroupHeaderNode(
                renderer,
                scopeLabel(row.scope),
                !firstGroup,
            );
            body.add(header);
            current.push(header);
            scope = row.scope;
            firstGroup = false;
        }
        const item = extensionRowNode(
            renderer,
            row,
            index === state.selectedIndex,
            dialogRowPointer(pointer, index),
            { width, nameWidth, versionWidth, statusWidth },
        );
        body.add(item);
        current.push(item);
    }
}

function paintDetail(
    renderer: RenderContext,
    body: BoxRenderable,
    state: TuiExtensionsListState,
    pointer: DialogRowPointer | undefined,
    current: Renderable[],
): void {
    const row = state.rows[state.selectedIndex];
    if (row === undefined) {
        const missing = new TextRenderable(renderer, {
            content: "That extension is no longer installed.",
            fg: TUI_MUTED,
            width: "100%",
            height: "auto",
            wrapMode: "word",
        });
        body.add(missing);
        current.push(missing);
        return;
    }
    const summary = new TextRenderable(renderer, {
        content: new StyledText([
            fg(TUI_TEXT)(`${row.version} · `),
            ...statusChunks(row.status, false),
            fg(TUI_TEXT)(` · ${row.scope}\n`),
            fg(TUI_MUTED)(
                row.loaded ? "loaded on this client" : "not loaded on this client",
            ),
        ]),
        width: "100%",
        height: "auto",
        wrapMode: "word",
    });
    body.add(summary);
    current.push(summary);
    const contributions = new TextRenderable(renderer, {
        content: new StyledText([
            fg(TUI_TEXT)(`${row.contributionLine}\n`),
            fg(TUI_MUTED)(row.capabilities.join(", ") || "none"),
        ]),
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    body.add(contributions);
    current.push(contributions);
    const actions = detailActions(row);
    if (actions.length > 0) {
        const actionBox = new BoxRenderable(renderer, {
            width: "100%",
            height: "auto",
            flexDirection: "column",
            marginTop: 1,
        });
        for (const [index, action] of actions.entries()) {
            const option = dialogOptionRow(renderer, {
                label: detailActionLabel(row, action),
                marker: index === state.actionIndex ? "›" : undefined,
                active: index === state.actionIndex,
                ...dialogRowPointer(pointer, index),
            });
            actionBox.add(option);
        }
        body.add(actionBox);
        current.push(actionBox);
    }
    const facts = new TextRenderable(renderer, {
        content: new StyledText([
            fg(TUI_MUTED)("path    "),
            fg(TUI_TEXT)(`${row.path}`),
            ...(row.source === undefined
                ? []
                : [fg(TUI_MUTED)("\nsource  "), fg(TUI_TEXT)(row.source)]),
        ]),
        width: "100%",
        height: "auto",
        wrapMode: "char",
        marginTop: 1,
    });
    body.add(facts);
    current.push(facts);
}

interface ExtensionRowColumns {
    readonly width: number;
    readonly nameWidth: number;
    readonly versionWidth: number;
    readonly statusWidth: number;
}

function fittedColumn(text: string, width: number): string {
    let value = text;
    if (Bun.stringWidth(value) > width) {
        value = "";
        for (const character of text) {
            if (Bun.stringWidth(value + character) >= width) break;
            value += character;
        }
        value += "…";
    }
    return value + " ".repeat(Math.max(0, width - Bun.stringWidth(value)));
}

function extensionRowNode(
    renderer: RenderContext,
    row: TuiExtensionListRow,
    active: boolean,
    pointer: Pick<{ onSelect?: () => void; onHover?: () => void }, "onSelect" | "onHover">,
    columns: ExtensionRowColumns,
): BoxRenderable {
    const background = active ? TUI_ACCENT : TUI_PANEL;
    const label = active ? TUI_SELECTION_TEXT : TUI_TEXT;
    const detail = active ? TUI_SELECTION_TEXT : TUI_MUTED;
    const statusColor = active
        ? TUI_SELECTION_TEXT
        : row.status === "enabled"
        ? TUI_SUCCESS
        : row.status === "failed"
        ? TUI_DANGER
        : TUI_MUTED;
    const item = new BoxRenderable(renderer, {
        width: "100%",
        height: EXTENSION_ROW_HEIGHT,
        flexShrink: 0,
        flexDirection: "column",
        backgroundColor: TUI_PANEL,
    });
    if (pointer.onSelect !== undefined) {
        item.onMouseDown = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            pointer.onSelect?.();
        };
    }
    if (pointer.onHover !== undefined) {
        item.onMouseMove = (event: MouseEvent) => {
            event.stopPropagation();
            pointer.onHover?.();
        };
    }
    item.add(new TextRenderable(renderer, {
        content: new StyledText([
            fg(label)(`${active ? "›" : " "} ${fittedColumn(row.id, columns.nameWidth)}`),
            fg(detail)(`  ${fittedColumn(row.version, columns.versionWidth)}  `),
            fg(statusColor)(row.status.padEnd(columns.statusWidth)),
        ]),
        bg: background,
        attributes: active ? 1 : 0,
        width: "100%",
        height: 1,
        wrapMode: "none",
        overflow: "hidden",
    }));
    item.add(new TextRenderable(renderer, {
        content: `  ${fittedColumn(row.contributionLine, Math.max(1, columns.width - 2))}`,
        fg: row.status === "failed" ? TUI_DANGER : TUI_MUTED,
        bg: TUI_PANEL,
        width: "100%",
        height: 1,
        wrapMode: "none",
        overflow: "hidden",
    }));
    return item;
}

function statusChunks(
    status: TuiExtensionStatus,
    active: boolean,
): TextChunk[] {
    const color = active
        ? TUI_SELECTION_TEXT
        : status === "enabled"
        ? TUI_SUCCESS
        : status === "failed"
        ? TUI_DANGER
        : TUI_MUTED;
    return [fg(color)(status)];
}
