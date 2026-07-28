import {
    BoxRenderable,
    fg,
    StyledText,
    TextRenderable,
    type Renderable,
    type RenderContext,
    type TextChunk,
} from "@opentui/core";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import type { SuggestedModel } from "../../src/model/supported-models.ts";
import type { PinnedModel } from "../../src/model/catalog-view.ts";
import type {
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import { inferReasoningSelection } from "../../src/model/reasoning-effort.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import {
    dialogBoxHeight,
    halfPageCursor,
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import {
    DIALOG_CHROME_HEIGHT,
    DIALOG_GUTTER_WIDTH,
    dialogFooterNode,
    dialogGroupHeaderNode,
    dialogHeaderNode,
    dialogOptionRows,
    dialogSearchNode,
} from "./dialog-chrome.ts";
import { tuiThemeSwatch, type TuiThemeName } from "./theme.ts";

export type TuiSettingsPickerKind =
    | "model"
    | "provider"
    | "reasoning"
    | "permissions"
    | "theme"
    | "session"
    | "settings"
    | "permission_settings";

/**
 * Where a menu row leads. The menu kinds carry no value of their own: choosing
 * a row opens another surface, so the selection names a destination instead of
 * a setting.
 */
export type TuiSettingsMenuTarget =
    | "model"
    | "reasoning"
    | "permissions"
    | "theme"
    | "permission_mode"
    | "granted_permissions";

export type TuiSettingsMenuKind = Extract<
    TuiSettingsPickerKind,
    "settings" | "permission_settings"
>;

export interface TuiSettingsPickerOption {
    readonly value: string;
    readonly label: string;
    readonly description: string;
    readonly searchText?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly sessionId?: string;
    /**
     * Position in the user's pin list, absent on an unpinned row. A rank
     * rather than a flag because the pin list is ordered by when each model was
     * pinned and the provider list is ordered by provider: the Pinned tab has to
     * be able to restore the order the store keeps, which sorting by provider
     * destroys.
     */
    readonly pinnedRank?: number;
    /** True on a pinned row whose model cannot run right now. */
    readonly unavailable?: boolean;
    /**
     * The heading this row belongs under. Model rows leave it unset and are
     * grouped by their provider instead, which is the same idea: a heading is
     * whatever one fact a run of rows shares.
     */
    readonly group?: string;
    /** Set only on provider rows: whether Vera already holds a credential. */
    readonly connected?: boolean;
}

/**
 * A provider as the connect pane shows it, which is the registry plus the one
 * fact the registry cannot know on its own. Passed in rather than read here:
 * whether a provider is connected comes off disk, and this module stays a pure
 * function of what it is handed.
 */
export interface TuiProviderRow {
    readonly id: string;
    readonly label: string;
    readonly group: string;
    readonly hint?: string;
    readonly connected: boolean;
}

/**
 * Two questions, two tabs. "All models" is what can run; "Pinned" is the short
 * list the user keeps. They were one list with a pinned group on top, which
 * showed every kept model twice and so reduced nothing.
 */
export type TuiModelPickerTab = "all" | "pinned";

export interface TuiExtensionPickerRow {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export type TuiExtensionPickerActionKey =
    | "enter"
    | "s"
    | "delete"
    | "backspace";

export interface TuiExtensionPickerAction {
    readonly id: string;
    readonly key: TuiExtensionPickerActionKey;
    readonly label: string;
}

export interface TuiSettingsPickerState {
    readonly kind: TuiSettingsPickerKind;
    readonly allOptions: readonly TuiSettingsPickerOption[];
    readonly options: readonly TuiSettingsPickerOption[];
    readonly selectedIndex: number;
    readonly query: string;
    readonly initialTheme?: TuiThemeName;
    readonly initialModel?: string;
    readonly loading?: boolean;
    /** Set only on the model pane. */
    readonly tab?: TuiModelPickerTab;
    /**
     * The pane this one was opened from, absent when a slash command or a
     * palette row opened it directly. Escape steps back to it rather than
     * closing the stack, so a wrong turn into a submenu costs one key instead
     * of reopening `/settings`.
     */
    readonly parent?: TuiSettingsPickerState;
    /**
     * Set only on a level pane opened from the model pane. Its presence is
     * what tells this pane it is pane two of a chain rather than the
     * standalone `/reasoning` picker: Escape steps back to `modelPaneState`
     * instead of closing, and Enter folds the level into the model
     * selection instead of returning a bare reasoning selection.
     */
    readonly pendingModel?: TuiPendingModelChoice;
}

export interface TuiPendingModelChoice {
    readonly provider: string;
    readonly model: string;
    readonly modelPaneState: TuiSettingsPickerState;
}

export interface TuiExtensionPickerState {
    readonly kind: "extension";
    readonly allOptions: readonly TuiSettingsPickerOption[];
    readonly options: readonly TuiSettingsPickerOption[];
    readonly selectedIndex: number;
    readonly query: "";
    readonly title: string;
    readonly selectedId?: string;
    readonly extensionRows: readonly TuiExtensionPickerRow[];
    readonly extensionActions: readonly TuiExtensionPickerAction[];
}

export interface TuiSettingsPickerKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
    readonly shift?: boolean;
}

export type TuiSettingsPickerSelection =
    | {
        readonly kind: "model";
        readonly provider: string;
        readonly model: string;
        // Present only when this selection folded in a chained level pane.
        readonly reasoningEffort?: ModelReasoningEffort;
    }
    | {
        readonly kind: "reasoning";
        readonly reasoningEffort: ModelReasoningEffort;
    }
    | { readonly kind: "provider"; readonly providerId: string }
    | { readonly kind: "permissions"; readonly mode: ApprovalMode }
    | { readonly kind: "theme"; readonly theme: TuiThemeName }
    | { readonly kind: "session"; readonly sessionPath: string }
    | { readonly kind: "menu"; readonly target: TuiSettingsMenuTarget };

export interface TuiPinToggle {
    readonly action: "add" | "remove";
    readonly provider: string;
    readonly model: string;
}

export interface TuiSettingsPickerTransition {
    readonly state?: TuiSettingsPickerState;
    readonly selection?: TuiSettingsPickerSelection;
    readonly handled: boolean;
    /**
     * The pane does not edit the pin list itself. It reports the intent and waits
     * for the settings snapshot to come back, so the list the user sees is
     * always the list the host actually stored.
     */
    readonly pinToggle?: TuiPinToggle;
    /**
     * The model pane asking for the connect pane over it. A request rather than
     * a state: which providers are connected is a fact about the disk, and only
     * the caller can read it.
     */
    readonly openProviders?: boolean;
    readonly previewTheme?: TuiThemeName;
    readonly trashCandidate?: {
        readonly sessionId: string;
        readonly label: string;
    };
}

export interface TuiExtensionPickerSelection {
    readonly kind: "extension";
    readonly rowId: string;
    readonly actionId: string;
}

export interface TuiExtensionPickerTransition {
    readonly state?: TuiExtensionPickerState;
    readonly selection?: TuiExtensionPickerSelection;
    readonly handled: boolean;
}

export type TuiAnySettingsPickerState =
    | TuiSettingsPickerState
    | TuiExtensionPickerState;

export interface TuiSettingsPickerView {
    readonly box: BoxRenderable;
    update(state: TuiAnySettingsPickerState): void;
}

const PERMISSION_OPTIONS: readonly TuiSettingsPickerOption[] = [
    { value: "ask", label: "Ask", description: "ask before every bash command" },
    {
        value: "auto",
        label: "Auto",
        description: "a reviewer clears the safe ones, you decide the rest",
    },
    {
        value: "full_access",
        label: "Full access",
        description: "allow commands with your user permissions",
    },
];

/**
 * The one-line description of a mode, in the same words the picker offers it in.
 * Shared rather than reworded so the `/permissions` notice and the picker it
 * opens cannot describe the same mode two different ways. Undefined for a custom
 * mode, which nobody wrote a description for.
 */
export function tuiPermissionModeDescription(
    mode: string,
): string | undefined {
    return PERMISSION_OPTIONS.find((option) => option.value === mode)
        ?.description;
}

const THEME_OPTIONS: readonly TuiSettingsPickerOption[] = [
    { value: "default", label: "Default", description: "Vera's original palette" },
    { value: "system", label: "System", description: "inherit terminal colors" },
    { value: "orng", label: "Orng", description: "warm orange on black" },
    { value: "palenight", label: "Palenight", description: "soft blue and purple" },
    { value: "synthwave", label: "Synthwave", description: "bright cyan and neon" },
    { value: "nightowl", label: "Night Owl", description: "deep blue, low glare" },
    { value: "github", label: "GitHub", description: "GitHub dark palette" },
];

export function startTuiSettingsPicker(
    kind: Exclude<TuiSettingsPickerKind, "reasoning">,
    currentModel: string | undefined,
    currentReasoning: ModelReasoningEffort | undefined,
    currentPermissions: ApprovalMode | undefined,
    availableModels: readonly SuggestedModel[] | undefined = undefined,
    currentTheme: TuiThemeName = "default",
    currentProvider: string | undefined = undefined,
    availablePermissionModes: readonly string[] | undefined = undefined,
    pinned: readonly PinnedModel[] | undefined = undefined,
): TuiSettingsPickerState {
    const allOptions = kind === "theme"
        ? THEME_OPTIONS
        : kind === "model"
        ? modelOptions(availableModels, currentProvider, currentModel, pinned)
        : permissionOptions(availablePermissionModes);
    // The pane opens on Pinned, which is the short list the user built for
    // exactly this moment. It falls back to All when nothing is pinned yet,
    // since an empty tab answers no question at all.
    const openingTab: TuiModelPickerTab =
        modelTabOptions(allOptions, "pinned").length > 0 ? "pinned" : "all";
    const options = kind === "model"
        ? modelTabOptions(allOptions, openingTab)
        : allOptions;
    const currentValue = kind === "theme"
        ? currentTheme
        : kind === "model"
        ? currentModel === undefined || currentProvider === undefined
            ? undefined
            : providerModelKey(currentProvider, currentModel)
        : currentPermissions;
    const selectedIndex = Math.max(
        0,
        options.findIndex((option) => option.value === currentValue),
    );
    return {
        kind,
        allOptions,
        options,
        selectedIndex,
        query: "",
        ...(kind === "model" ? { tab: openingTab } : {}),
        ...(kind === "model" && currentValue !== undefined
            ? { initialModel: currentValue }
            : {}),
        ...(kind === "theme" ? { initialTheme: currentTheme } : {}),
    };
}

/**
 * Rebuilds an open model pane from a fresh settings snapshot, keeping the
 * user where they were. The highlighted model is restored by identity rather
 * than by index: adding or removing a pinned row shifts every index below it,
 * so an index would move the cursor to a different model than the one the
 * user just acted on.
 */
export function syncTuiModelPicker(
    state: TuiSettingsPickerState,
    settings: {
        readonly provider?: string;
        readonly model?: string;
        readonly availableModels?: readonly SuggestedModel[];
        readonly pinned?: readonly PinnedModel[];
    } | undefined,
): TuiSettingsPickerState {
    if (state.kind !== "model") {
        return state;
    }
    const selectedValue = state.options[state.selectedIndex]?.value;
    const rebuilt = startTuiSettingsPicker(
        "model",
        settings?.model,
        undefined,
        undefined,
        settings?.availableModels,
        undefined,
        settings?.provider,
        undefined,
        settings?.pinned,
    );
    // The tab is the user's own place in the pane, so a snapshot arriving from
    // the host must not move them out of it. Pinning a model from the Pinned tab
    // would otherwise drop them back onto All mid-action.
    const tab = state.tab ?? "all";
    const onTab = { ...rebuilt, tab, options: modelTabOptions(rebuilt.allOptions, tab) };
    const options = state.query.length === 0
        ? onTab.options
        : searched(onTab, state.query).state?.options ?? onTab.options;
    const selectedIndex = options.findIndex(
        (option) => option.value === selectedValue,
    );
    return {
        ...onTab,
        options,
        query: state.query,
        // The pane it was opened from survives a snapshot. A rebuild is the host
        // answering an edit made inside this pane, not a fresh way in, so
        // pinning a model must not turn escape into "close everything".
        ...(state.parent === undefined ? {} : { parent: state.parent }),
        selectedIndex: selectedIndex === -1
            ? Math.min(state.selectedIndex, Math.max(0, options.length - 1))
            : selectedIndex,
    };
}

/**
 * The level pane. Renders exactly what the model's own `levels` list
 * contains, no synthesized rows: an empty list means the model has no
 * reasoning control at all, and the caller checks for that before opening
 * this pane rather than opening an empty one.
 *
 * The pre-highlight reuses `inferReasoningSelection`, the same placement
 * rule the engine uses to resolve a requested level against a model's own
 * list, so what lights up here and what a turn actually resolves to are the
 * same sentence: the current effort if valid for this model, else the
 * model's own default, else its top level.
 *
 * `pendingModel` is set only when this pane was opened from the model pane:
 * its presence is what tells `pickerSelection` and Escape-handling that this
 * is pane two of a chain, not the standalone `/reasoning` picker.
 */
export function startTuiReasoningPicker(
    levels: readonly ReasoningLevel[],
    defaultLevel: ReasoningLevelId | undefined,
    currentReasoningEffort: ModelReasoningEffort | undefined,
    pendingModel: TuiPendingModelChoice | undefined = undefined,
): TuiSettingsPickerState {
    const options = levels.map(levelOption);
    const highlighted = inferReasoningSelection(
        currentReasoningEffort ?? "",
        levels.map((level) => level.id),
        defaultLevel,
    ).providerEffort;
    const selectedIndex = Math.max(
        0,
        options.findIndex((option) => option.value === highlighted),
    );
    return {
        kind: "reasoning",
        allOptions: options,
        options,
        selectedIndex,
        query: "",
        // A chained pane is a step inside the model choice, so the model pane
        // is both what Escape returns to and what `pendingModel` folds into.
        ...(pendingModel === undefined ? {} : {
            pendingModel,
            parent: pendingModel.modelPaneState,
        }),
    };
}

function levelOption(level: ReasoningLevel): TuiSettingsPickerOption {
    return {
        value: level.id,
        label: level.label,
        description: level.description ?? "",
    };
}

function permissionOptions(
    available: readonly string[] | undefined,
): readonly TuiSettingsPickerOption[] {
    if (available === undefined) {
        return PERMISSION_OPTIONS;
    }
    return available.map((name) =>
        PERMISSION_OPTIONS.find((option) => option.value === name) ?? {
            value: name,
            label: name,
            description: "custom permission mode",
        }
    );
}

const SETTINGS_MENU_OPTIONS: readonly TuiSettingsPickerOption[] = [
    { value: "model", label: "Model", description: "which model answers" },
    {
        value: "reasoning",
        label: "Reasoning",
        description: "how much it thinks first",
        searchText: "effort think",
    },
    {
        value: "permissions",
        label: "Permissions",
        description: "what Vera may run, and what you have approved",
        searchText: "grants approvals allowed",
    },
    { value: "theme", label: "Theme", description: "TUI colors" },
];

const PERMISSION_SETTINGS_OPTIONS: readonly TuiSettingsPickerOption[] = [
    {
        value: "permission_mode",
        label: "Mode",
        description: "how much Vera asks before running commands",
    },
    {
        value: "granted_permissions",
        label: "Granted",
        description: "review and revoke what you have approved",
        searchText: "allowed grants preferences",
    },
];

/**
 * The connect pane: every provider Vera ships, with what it wants written on
 * the row and a mark on the ones already connected.
 *
 * The list is short and hand-picked rather than fetched, so it opens with the
 * cursor on the first unconnected row: with this few rows, the one thing left
 * to do is the thing worth landing on.
 */
export function startTuiProviderPicker(
    providers: readonly TuiProviderRow[],
): TuiSettingsPickerState {
    const options = providers.map((provider) => ({
        value: provider.id,
        label: provider.label,
        description: provider.hint ?? "",
        searchText: provider.id,
        group: provider.group,
        connected: provider.connected,
    }));
    const firstUnconnected = options.findIndex(
        (option) => option.connected !== true,
    );
    return {
        kind: "provider",
        allOptions: options,
        options,
        selectedIndex: Math.max(0, firstUnconnected),
        query: "",
    };
}

/**
 * The pane, remembering where it was opened from.
 *
 * Kept out of the `start*` functions so the parent is one thing set at the one
 * place that knows it, rather than a trailing argument every opener has to
 * thread through whether or not it has one.
 */
export function withTuiPickerParent(
    state: TuiSettingsPickerState,
    parent: TuiSettingsPickerState | undefined,
): TuiSettingsPickerState {
    return parent === undefined ? state : { ...state, parent };
}

/**
 * The nearest menu above this pane, and where a finished choice lands.
 *
 * Escape steps back exactly one level, since a wrong turn should cost one key.
 * A completed choice skips further: dropping the user back onto the model pane
 * they just answered, or the level pane that folded into it, re-asks a question
 * they are done with. A menu is the only ancestor still worth returning to,
 * because it was a list of other things to change rather than a step in this
 * one.
 */
export function tuiPickerMenuAncestor(
    state: TuiSettingsPickerState,
): TuiSettingsPickerState | undefined {
    let current = state.parent;
    while (current !== undefined) {
        if (current.kind === "settings" || current.kind === "permission_settings") {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}

export function startTuiSettingsMenu(
    kind: TuiSettingsMenuKind,
): TuiSettingsPickerState {
    const options = kind === "settings"
        ? SETTINGS_MENU_OPTIONS
        : PERMISSION_SETTINGS_OPTIONS;
    return {
        kind,
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
    };
}

export function startTuiSessionPicker(
    agents: readonly RegisteredAgentSummary[],
    currentAgentId?: string,
    loading = false,
    now: Date = new Date(),
): TuiSettingsPickerState {
    const options = agents
        .filter((agent) => agent.kind === "interactive"
            && agent.id !== currentAgentId
            && agent.status !== "closed"
            && agent.status !== "failed"
            && agent.title !== undefined)
        .toSorted((left, right) =>
            (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
        )
        .map((agent) => ({
            value: agent.session_path,
            label: truncateSessionTitle(agent.title!),
            description: sessionDescription(agent, now),
            searchText: `${agent.id} ${agent.workspace}`,
            sessionId: agent.id,
        }));
    return {
        kind: "session",
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
        loading,
    };
}

/**
 * A client extension supplies semantic rows and actions, while this module
 * owns the cursor, focus, rendering, and terminal-key details. Search is
 * intentionally omitted so the action key `s` remains available to the
 * extension.
 */
export function startTuiExtensionPicker(
    title: string,
    rows: readonly TuiExtensionPickerRow[],
    selectedId: string | undefined = undefined,
    actions: readonly TuiExtensionPickerAction[] = [],
): TuiExtensionPickerState {
    const options = rows.map((row) => ({
        value: row.id,
        label: row.label,
        description: row.description ?? "",
    }));
    return {
        kind: "extension",
        allOptions: options,
        options,
        selectedIndex: Math.max(
            0,
            options.findIndex((option) => option.value === selectedId),
        ),
        query: "",
        title,
        ...(selectedId === undefined ? {} : { selectedId }),
        extensionRows: rows,
        extensionActions: actions,
    };
}

function handleTuiExtensionPickerKey(
    state: TuiExtensionPickerState,
    key: TuiSettingsPickerKey,
): TuiExtensionPickerTransition {
    if (key.ctrl || key.meta || key.super || key.hyper || key.shift) {
        return unchanged(state, false);
    }
    if (key.name === "escape") {
        return { handled: true };
    }
    if (key.name === "up" || key.name === "down") {
        const step = key.name === "up" ? -1 : 1;
        const nextIndex = Math.min(
            state.options.length - 1,
            Math.max(0, state.selectedIndex + step),
        );
        const next = state.options[nextIndex];
        return unchanged({
            ...state,
            selectedIndex: nextIndex,
            ...(next === undefined ? {} : { selectedId: next.value }),
        }, true);
    }

    const actionKey = extensionPickerActionKey(key);
    const action = actionKey === undefined
        ? undefined
        : state.extensionActions?.find((candidate) =>
            candidate.key === actionKey
        );
    const row = state.options[state.selectedIndex];
    if (action === undefined) {
        return unchanged(state, false);
    }
    if (row === undefined) {
        return unchanged(state, true);
    }
    return {
        selection: {
            kind: "extension",
            rowId: row.value,
            actionId: action.id,
        },
        handled: true,
    };
}

function extensionPickerActionKey(
    key: TuiSettingsPickerKey,
): TuiExtensionPickerActionKey | undefined {
    if (key.name === "return" || key.name === "enter") return "enter";
    if (key.name === "s") return "s";
    if (key.name === "delete") return "delete";
    if (key.name === "backspace") return "backspace";
    return undefined;
}

function truncateSessionTitle(title: string): string {
    const normalized = title.replaceAll(/\s+/g, " ").trim();
    const characters = [...normalized];
    return characters.length <= 30
        ? normalized
        : `${characters.slice(0, 29).join("")}…`;
}

function sessionDescription(
    agent: RegisteredAgentSummary,
    now: Date,
): string {
    const workspaceName = agent.workspace.split("/").filter(Boolean).at(-1)
        ?? agent.workspace;
    const workspace = workspaceName.length <= 14
        ? workspaceName
        : `${workspaceName.slice(0, 13)}…`;
    const activity = agent.status === "working" || agent.status === "waiting"
        ? agent.status
        : relativeSessionTime(agent.updated_at, now);
    return `${activity} · ${workspace}`;
}

function relativeSessionTime(value: string | undefined, now: Date): string {
    const timestamp = value === undefined ? Number.NaN : Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return "saved";
    }
    const elapsedMinutes = Math.max(
        0,
        Math.floor((now.getTime() - timestamp) / 60_000),
    );
    if (elapsedMinutes < 1) {
        return "just now";
    }
    if (elapsedMinutes < 60) {
        return `${elapsedMinutes}m ago`;
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `${elapsedHours}h ago`;
    }
    const elapsedDays = Math.floor(elapsedHours / 24);
    return elapsedDays < 7
        ? `${elapsedDays}d ago`
        : new Date(timestamp).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
        });
}

export function handleTuiSettingsPickerKey(
    state: TuiExtensionPickerState,
    key: TuiSettingsPickerKey,
    viewportRows?: number,
): TuiExtensionPickerTransition;
export function handleTuiSettingsPickerKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
    viewportRows?: number,
): TuiSettingsPickerTransition;
export function handleTuiSettingsPickerKey(
    state: TuiAnySettingsPickerState,
    key: TuiSettingsPickerKey,
    viewportRows?: number,
): TuiSettingsPickerTransition | TuiExtensionPickerTransition {
    if (state.kind === "extension") {
        return handleTuiExtensionPickerKey(state, key);
    }
    if (
        state.kind === "session"
        && key.name === "delete"
    ) {
        const selected = state.options[state.selectedIndex];
        return selected?.sessionId === undefined
            ? unchanged(state, true)
            : {
                state,
                trashCandidate: {
                    sessionId: selected.sessionId,
                    label: selected.label,
                },
                handled: true,
            };
    }
    // Ahead of the modifier bail-out below, and deliberately a modifier key:
    // the model pane sends every bare printable key to its search box, and "-"
    // is a character in most model ids, so no unmodified key is available.
    if (
        state.kind === "model"
        && key.ctrl
        && key.name === "s"
        && !key.meta
        && !key.super
        && !key.hyper
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected?.provider === undefined || selected.model === undefined) {
            return unchanged(state, true);
        }
        return {
            state,
            handled: true,
            pinToggle: {
                action: isPinned(state, selected) ? "remove" : "add",
                provider: selected.provider,
                model: selected.model,
            },
        };
    }
    // Also ahead of the modifier bail-out, and modified for the same reason as
    // ctrl+s above: every bare key on the model pane belongs to its search box.
    if (
        state.kind === "model"
        && key.ctrl
        && key.name === "e"
        && !key.meta
        && !key.super
        && !key.hyper
    ) {
        return { state, handled: true, openProviders: true };
    }
    // Tab flips between the two views of the same list. Shift is tolerated
    // rather than given its own direction: with two tabs, forward and backward
    // are the same move.
    if (
        state.kind === "model"
        && key.name === "tab"
        && !key.ctrl
        && !key.meta
        && !key.super
        && !key.hyper
    ) {
        const tab: TuiModelPickerTab = state.tab === "pinned" ? "all" : "pinned";
        const selectedValue = state.options[state.selectedIndex]?.value;
        const options = modelTabOptions(state.allOptions, tab);
        // The query is dropped on the way across. A search is a question about
        // one list, and carrying it over would land the user on an empty pane
        // with no sign of why.
        // The cursor follows the highlighted model across. When that model has
        // no row on the far tab it falls back to the running model rather than
        // to row one, which is where the user is in every other sense.
        const selectedIndex = options.findIndex(
            (option) => option.value === selectedValue,
        );
        const running = options.findIndex(
            (option) => option.value === state.initialModel,
        );
        return {
            state: {
                ...state,
                tab,
                options,
                query: "",
                selectedIndex: selectedIndex !== -1
                    ? selectedIndex
                    : Math.max(0, running),
            },
            handled: true,
        };
    }
    // Half-page movement, ahead of the modifier bail-out below. The cursor
    // travels with the jump rather than the window sliding out from under it,
    // so ctrl+d is ↓ held down and nothing new has to be learned about where
    // the highlight went.
    if (
        key.ctrl
        && (key.name === "d" || key.name === "u")
        && !key.meta && !key.super && !key.hyper
    ) {
        const next = {
            ...state,
            selectedIndex: halfPageCursor(
                state.selectedIndex,
                state.options.length,
                viewportRows ?? FALLBACK_JUMP * 2,
                key.name === "d" ? "down" : "up",
            ),
        };
        return { state: next, handled: true, ...themePreview(next) };
    }
    if (key.ctrl || key.meta || key.super || key.hyper || key.shift) {
        return unchanged(state, false);
    }
    if (key.name === "escape") {
        // Leaving a theme pane puts back the theme the user came in with,
        // whether that lands them in the parent menu or out of the pane.
        const preview = state.kind === "theme" && state.initialTheme !== undefined
            ? { previewTheme: state.initialTheme }
            : {};
        // Escape inside a pane opened from another one steps back rather than
        // closing outright, so a wrong turn costs one key instead of reopening
        // whatever led there.
        if (state.parent !== undefined) {
            return { state: state.parent, handled: true, ...preview };
        }
        return { handled: true, ...preview };
    }
    if (key.name === "backspace") {
        return searched(state, state.query.slice(0, -1));
    }
    if (
        key.name.length === 1
        && !key.ctrl
        && !key.meta
    ) {
        return searched(state, state.query + key.name);
    }
    if (key.name === "up") {
        const next = {
                ...state,
                selectedIndex: Math.max(0, state.selectedIndex - 1),
            };
        return {
            state: next,
            handled: true,
            ...themePreview(next),
        };
    }
    if (key.name === "down") {
        const next = {
                ...state,
                selectedIndex: Math.min(
                    state.options.length - 1,
                    state.selectedIndex + 1,
                ),
            };
        return {
            state: next,
            handled: true,
            ...themePreview(next),
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const selected = state.options[state.selectedIndex];
        if (selected === undefined) {
            return unchanged(state, true);
        }
        return {
            selection: pickerSelection(state, selected),
            handled: true,
        };
    }
    return unchanged(state, false);
}

/**
 * The wheel over an open pane.
 *
 * It moves the cursor rather than sliding the window under it, which is the
 * same rule ctrl+d and ctrl+u follow: the pane windows itself around
 * `selectedIndex`, so a window that moved on its own would leave ⏎ pointing at
 * a row that is no longer on screen.
 */
export function handleTuiSettingsPickerScroll(
    state: TuiAnySettingsPickerState,
    scroll: { readonly direction: "up" | "down" | "left" | "right"; readonly delta: number },
): TuiSettingsPickerTransition | TuiExtensionPickerTransition {
    const selectedIndex = wheelCursor(
        state.selectedIndex,
        state.options.length,
        scroll,
    );
    if (state.kind === "extension") {
        return selectedIndex === undefined
            ? unchanged(state, false)
            : { state: { ...state, selectedIndex }, handled: true };
    }
    if (selectedIndex === undefined) {
        return unchanged(state, false);
    }
    const next = { ...state, selectedIndex };
    return { state: next, handled: true, ...themePreview(next) };
}

export function createTuiSettingsPickerView(
    renderer: RenderContext,
): TuiSettingsPickerView {
    let nodes: Renderable[] = [];
    const box = new BoxRenderable(renderer, {
        id: "settings-picker",
        // No borderColor here. OpenTUI's BoxRenderable constructor reads any
        // border styling option as "this box wants a border" and overrides an
        // explicit `border: false`, so passing a color is what draws the box.
        border: false,
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
            box.title = undefined;
            if (state.kind === "theme") {
                box.left = "20%";
                box.width = "60%";
                box.height = state.allOptions.length + DIALOG_CHROME_HEIGHT;
                renderThemePickerRows(renderer, box, state, nodes);
                return;
            }
            box.left = "10%";
            box.width = "80%";
            renderListPickerRows(renderer, box, state, nodes);
        },
    };
}

/**
 * Half-page distance when nobody measured the window. Only callers that have no
 * renderer land here, which today is tests: the TUI always measures.
 */
const FALLBACK_JUMP = 5;

/**
 * How many rows the card can show without running off the bottom.
 *
 * Group headers cost more than one line, so this is a row budget rather than a
 * line budget and a heavily grouped list can still overrun by a line or two.
 * The alternative is a window whose size changes as you scroll past headers,
 * which is worse to use than an occasional tight fit.
 */
function pickerMaxRows(renderer: RenderContext, extraChrome: number): number {
    return listWindowRows(
        dialogBoxHeight(renderer, PICKER_TOP_OFFSET),
        DIALOG_CHROME_HEIGHT + extraChrome,
    );
}

// Where the card's top edge sits, matching `box.top` below.
const PICKER_TOP_OFFSET = 2;

/**
 * How far the half-page keys move, which is half of what is currently on
 * screen. The key handler is a pure function of state and cannot see the
 * terminal, so whoever owns the renderer measures this and passes it in: a
 * second constant here would be free to disagree with the window the user is
 * actually looking at.
 */
export function tuiPickerViewportRows(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
): number {
    return pickerMaxRows(
        renderer,
        state.kind === "model" ? MODEL_TAB_STRIP_HEIGHT : 0,
    );
}

/**
 * The columns a row has for its label, description and meta together. Derived
 * from the same numbers the card is built from below: 80% of the terminal, less
 * the card's own left and right padding, the row's, and the leading gutter.
 */
function pickerContentWidth(renderer: RenderContext): number {
    return Math.max(0, Math.floor(renderer.width * 0.8) - 8);
}

type PickerDisplayRow =
    | { readonly kind: "group"; readonly label: string }
    | {
        readonly kind: "option";
        readonly option: TuiSettingsPickerOption;
        readonly index: number;
    };

function renderListPickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiAnySettingsPickerState,
    nodes: Renderable[],
): void {
    const searchable = state.kind !== "extension";
    const header = dialogHeaderNode(
        renderer,
        pickerTitle(
            state.kind,
            state.kind === "extension" ? state.title : undefined,
        ),
    );
    box.add(header);
    nodes.push(header);
    if (searchable) {
        const search = dialogSearchNode(renderer, state.query);
        box.add(search);
        nodes.push(search);
    }
    const tab = state.kind === "model" ? state.tab ?? "all" : undefined;
    if (tab !== undefined) {
        const strip = modelTabStripNode(renderer, tab);
        box.add(strip);
        nodes.push(strip);
    }

    const rows = windowedDisplayRows(
        listDisplayRows(state),
        state.selectedIndex,
        pickerMaxRows(renderer, tab === undefined ? 0 : MODEL_TAB_STRIP_HEIGHT),
    );
    let lines = 0;
    if (rows.length === 0) {
        const empty = new TextRenderable(renderer, {
            content: emptyPickerMessage(state),
            fg: TUI_MUTED,
            width: "100%",
            height: 1,
            paddingLeft: DIALOG_GUTTER_WIDTH,
        });
        box.add(empty);
        nodes.push(empty);
        lines = 1;
    }
    const optionNodes = dialogOptionRows(renderer, rows.flatMap((row) =>
        row.kind === "option"
            ? [{
                label: row.option.label,
                leading: optionLeading(state, row.option),
                // Model rows carry no description. A model's marketing line is
                // not what anyone picks on, and at these widths it only ever
                // arrived clipped to a few characters, so the row reads as the
                // name and the provider heading above it.
                ...(state.kind === "model"
                    ? {}
                    : { description: row.option.description }),
                meta: optionMeta(state, row.option),
                active: row.index === state.selectedIndex,
                current: isCurrentOption(state, row.option),
            }]
            : []
    ), pickerContentWidth(renderer));
    let optionNodeIndex = 0;
    rows.forEach((row, position) => {
        const node = row.kind === "group"
            ? dialogGroupHeaderNode(renderer, row.label, position > 0)
            : optionNodes[optionNodeIndex++]!;
        lines += row.kind === "group" && position > 0 ? 2 : 1;
        box.add(node);
        nodes.push(node);
    });

    const footer = dialogFooterNode(renderer, pickerFooter(state));
    box.add(footer);
    nodes.push(footer);
    box.height = lines + DIALOG_CHROME_HEIGHT - (searchable ? 0 : 3)
        + (tab === undefined ? 0 : MODEL_TAB_STRIP_HEIGHT);
}

// The strip itself plus the blank line under it.
const MODEL_TAB_STRIP_HEIGHT = 2;

const MODEL_TAB_LABELS: readonly (readonly [TuiModelPickerTab, string])[] = [
    ["pinned", "Pinned"],
    ["all", "All models"],
];

/**
 * The two tabs, drawn as one line of labels with the active one accented. No
 * borders or brackets: the pane already has a card edge, and a second frame
 * inside it reads as two panes rather than two views of one list.
 */
function modelTabStripNode(
    renderer: RenderContext,
    tab: TuiModelPickerTab,
): TextRenderable {
    const chunks: TextChunk[] = [];
    MODEL_TAB_LABELS.forEach(([id, label], index) => {
        if (index > 0) {
            chunks.push(fg(TUI_MUTED)("   "));
        }
        chunks.push(
            id === tab ? fg(TUI_ACCENT)(label) : fg(TUI_MUTED)(label),
        );
    });
    return new TextRenderable(renderer, {
        content: new StyledText(chunks),
        width: "100%",
        height: MODEL_TAB_STRIP_HEIGHT,
        paddingLeft: DIALOG_GUTTER_WIDTH,
    });
}

function pickerFooter(state: TuiAnySettingsPickerState): string {
    if (state.kind === "session") {
        return "↑↓ ^d^u move · ⏎ select · del trash · esc close";
    }
    if (state.kind === "extension") {
        const actions = (state.extensionActions ?? []).map((action) =>
            `${extensionPickerKeyLabel(action.key)} ${action.label}`
        );
        return ["↑↓ move", ...actions, "esc close"].join(" · ");
    }
    if (state.kind === "settings") {
        return "↑↓ move · ⏎ open · esc close";
    }
    if (state.kind === "permission_settings") {
        return "↑↓ move · ⏎ open · esc back";
    }
    if (state.kind === "reasoning" && state.pendingModel !== undefined) {
        return "↑↓ move · ⏎ select · esc back";
    }
    if (state.kind === "provider") {
        const selected = state.options[state.selectedIndex];
        return [
            "↑↓ move",
            selected?.connected === true ? "⏎ reconnect" : "⏎ connect",
            state.parent === undefined ? "esc close" : "esc back",
        ].join(" · ");
    }
    if (state.kind === "model") {
        const selected = state.options[state.selectedIndex];
        const pinned = selected === undefined || selected.provider === undefined
            ? undefined
            : isPinned(state, selected)
                ? "^s unpin"
                : "^s pin";
        return [
            // The movement entry carries the half-page keys rather than taking a
            // separate slot: they are the same movement, and this footer is
            // already the longest one in the pane.
            "↑↓ ^d^u move",
            "⏎ select",
            ...(pinned === undefined ? [] : [pinned]),
            "^e providers",
            "⇥ tabs",
            "esc close",
        ].join(" · ");
    }
    return "↑↓ move · ⏎ select · esc close";
}

function extensionPickerKeyLabel(
    key: TuiExtensionPickerActionKey,
): string {
    if (key === "enter") return "⏎";
    if (key === "delete") return "del";
    if (key === "backspace") return "⌫";
    return key;
}

function listDisplayRows(
    state: TuiAnySettingsPickerState,
): readonly PickerDisplayRow[] {
    const grouped = isProviderGrouped(state);
    const rows: PickerDisplayRow[] = [];
    state.options.forEach((option, index) => {
        if (grouped && groupLabel(state.options[index - 1]) !== groupLabel(option)) {
            rows.push({ kind: "group", label: groupLabel(option) ?? "Other" });
        }
        rows.push({ kind: "option", option, index });
    });
    return rows;
}

/**
 * The pin mark rides on the model's own row, so the key and the list cannot
 * disagree about what is pinned: both read the same snapshot the host sent.
 */
function isPinned(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): boolean {
    return option.pinnedRank !== undefined
        || state.allOptions.some((candidate) =>
            candidate.value === option.value && candidate.pinnedRank !== undefined
        );
}

/**
 * Whether the list carries group headings.
 *
 * The connect pane always does: it is two runs of rows, the ones most people
 * want and the rest, and that split is the only ordering it has.
 *
 * Everything but the un-searched Pinned tab does, search results included: a
 * filtered list is still in provider order, so a heading there labels a real run
 * of rows. That is what tells apart a subscription model from an OpenRouter one,
 * and stating it once per group beats repeating it on every row.
 *
 * Pinned is the exception. It is ordered by the user's own use rather than by
 * provider, so headings would label nothing and the provider goes on the row
 * itself instead.
 */
function isProviderGrouped(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "provider"
        || (state.kind === "model"
            && (state.query.length > 0 || state.tab !== "pinned"));
}

function groupLabel(
    option: TuiSettingsPickerOption | undefined,
): string | undefined {
    return option?.group ?? option?.provider;
}

function windowedDisplayRows(
    rows: readonly PickerDisplayRow[],
    selectedIndex: number,
    maxRows: number,
): readonly PickerDisplayRow[] {
    const cursor = rows.findIndex((row) =>
        row.kind === "option" && row.index === selectedIndex
    );
    const window = listWindowSlice(rows, cursor, maxRows);
    if (window.length === rows.length) {
        return rows;
    }
    const start = rows.indexOf(window[0]!);
    // A window that opens partway down a group would show provider rows with no
    // provider above them, which is the one thing the grouping exists to say.
    // Reprinting the heading costs the window's first row and is what makes the
    // list readable from anywhere in it rather than only from the top.
    const stuck = stickyGroupRow(rows, start);
    if (stuck === undefined) {
        return window;
    }
    // The heading takes a row from the end unless that is where the cursor is,
    // in which case it takes the top row instead. Either way the highlighted row
    // stays on screen, which is the one row that cannot be spared.
    const cursorAtEnd = window.at(-1)?.kind === "option"
        && (window.at(-1) as { readonly index: number }).index === selectedIndex;
    return cursorAtEnd
        ? [stuck, ...window.slice(1)]
        : [stuck, ...window.slice(0, -1)];
}

function stickyGroupRow(
    rows: readonly PickerDisplayRow[],
    start: number,
): PickerDisplayRow | undefined {
    if (start === 0 || rows[start]?.kind !== "option") {
        return undefined;
    }
    for (let index = start - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (row.kind === "group") {
            return row;
        }
    }
    return undefined;
}

function isCurrentOption(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): boolean {
    if (state.kind === "extension") {
        return option.value === state.selectedId;
    }
    // A connected provider is the connect pane's version of "this is already
    // the case", which is what the marker column says everywhere else.
    if (state.kind === "provider") {
        return option.connected === true;
    }
    return state.kind === "model" && option.value === state.initialModel;
}

/**
 * The marker column. A check on the connect pane rather than the dot the other
 * panes use: a dot means "the one in effect", and connected providers are not
 * exclusive, so several rows can carry it at once.
 */
function optionLeading(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): string {
    if (state.kind === "provider") {
        return option.connected === true ? "✓ " : "  ";
    }
    return isCurrentOption(state, option) ? "● " : "  ";
}

function optionMeta(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): string | undefined {
    if (state.kind !== "model") {
        return undefined;
    }
    // A pin whose model the provider no longer lists says so, on every view. It
    // is the one thing about a row that a provider heading cannot tell you, and
    // choosing it is a dead end.
    if (option.unavailable === true) {
        return "unavailable";
    }
    return isProviderGrouped(state) ? undefined : option.provider;
}

function emptyPickerMessage(state: TuiAnySettingsPickerState): string {
    if (state.kind === "extension") {
        return "No options available";
    }
    if (state.kind !== "session") {
        return "No matches found";
    }
    return state.loading === true
        ? "Loading conversations…"
        : "No conversations found";
}

const THEME_LABEL_WIDTH = 11;

function renderThemePickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiSettingsPickerState,
    nodes: Renderable[],
): void {
    const header = dialogHeaderNode(renderer, "Theme");
    const search = dialogSearchNode(renderer, state.query);
    box.add(header);
    box.add(search);
    nodes.push(header, search);

    // Show the curated catalog even while filtering: unmatched rows dim rather
    // than vanish, so the list keeps its stable palette-card shape.
    const matches = new Set(state.options.map((option) => option.value));
    state.allOptions.forEach((option) => {
        const active = option.value === state.options[state.selectedIndex]?.value;
        const current = option.value === state.initialTheme;
        const matched = matches.has(option.value);
        const row = new TextRenderable(renderer, {
            content: themeRowContent(option, active, current, matched),
            bg: active ? TUI_ELEMENT : TUI_PANEL,
            width: "100%",
            height: 1,
            paddingRight: 1,
        });
        box.add(row);
        nodes.push(row);
    });

    const footer = dialogFooterNode(renderer, "↑↓ move · ⏎ apply · esc cancel");
    box.add(footer);
    nodes.push(footer);
}

function themeRowContent(
    option: TuiSettingsPickerOption,
    active: boolean,
    current: boolean,
    matched: boolean,
): StyledText {
    const labelColor = matched
        ? (active || current ? TUI_ACCENT : TUI_TEXT)
        : TUI_MUTED;
    const chunks: TextChunk[] = [
        active ? fg(TUI_ACCENT)("› ") : fg(TUI_PANEL)("  "),
        fg(TUI_ACCENT)(current ? "● " : "  "),
        fg(labelColor)(option.label.padEnd(THEME_LABEL_WIDTH)),
        ...themeSwatchChunks(option.value as TuiThemeName, matched),
        fg(matched ? TUI_MUTED : TUI_PANEL)(`  ${option.description}`),
    ];
    return new StyledText(chunks);
}

function themeSwatchChunks(name: TuiThemeName, matched: boolean): TextChunk[] {
    const swatch = tuiThemeSwatch(name);
    if (swatch === undefined) {
        // System inherits the terminal palette, unknown until applied.
        return [fg(TUI_MUTED)("░░ ░░ ░░ ░░")];
    }
    return swatch.flatMap((color, index) => [
        ...(index === 0 ? [] : [fg(TUI_PANEL)(" ")]),
        fg(matched ? color : TUI_MUTED)("██"),
    ]);
}

function searched(
    state: TuiSettingsPickerState,
    query: string,
): TuiSettingsPickerTransition {
    const normalized = query.toLowerCase();
    // Search spans both tabs. A user typing a model name is asking whether the
    // model exists, not whether it exists on the tab they happen to be on, and
    // a hit that stayed hidden behind the other tab would read as "not there".
    // Clearing the query drops back to the tab's own list.
    const searchable = state.kind === "model" && query.length === 0
        ? modelTabOptions(state.allOptions, state.tab ?? "all")
        : state.allOptions;
    const options = searchable.filter((option) =>
        `${option.label} ${option.value} ${option.description} ${
            option.searchText ?? ""
        }`
            .toLowerCase()
            .includes(normalized)
    );
    const next = { ...state, options, selectedIndex: 0, query };
    return {
        state: next,
        handled: true,
        ...themePreview(next),
    };
}

function themePreview(
    state: TuiSettingsPickerState,
): { readonly previewTheme?: TuiThemeName } {
    if (state.kind !== "theme") {
        return {};
    }
    const value = state.options[state.selectedIndex]?.value;
    return value === undefined ? {} : { previewTheme: value as TuiThemeName };
}

/**
 * Every model row exactly once, whichever tab it belongs to. A pin is a mark
 * on the model's own row rather than a second row for the same model, so the
 * two tabs are views of one list and no model can appear twice.
 *
 * A pin the runnable list has never heard of still gets a row: the user put it
 * there deliberately, so only the user takes it out. It carries `unavailable`,
 * which is what keeps it off the All tab, where it would be a dead end.
 */
function modelOptions(
    available: readonly SuggestedModel[] | undefined,
    currentProvider: string | undefined,
    currentModel: string | undefined,
    pinned: readonly PinnedModel[] = [],
): readonly TuiSettingsPickerOption[] {
    const rankOf = new Map(
        pinned.map((entry, rank) =>
            [providerModelKey(entry.provider, entry.model), rank] as const
        ),
    );
    const runnable = (available ?? []).map((model) => {
        const value = providerModelKey(model.provider, model.model);
        const rank = rankOf.get(value);
        return {
            value,
            label: model.label,
            description: model.description,
            searchText: `${model.provider} ${model.model}`,
            provider: model.provider,
            model: model.model,
            ...(rank === undefined ? {} : { pinnedRank: rank }),
        };
    });
    const currentValue = currentModel === undefined || currentProvider === undefined
        ? undefined
        : providerModelKey(currentProvider, currentModel);
    if (
        currentValue !== undefined && currentProvider !== undefined
        && currentModel !== undefined
        && !runnable.some((option) => option.value === currentValue)
    ) {
        const rank = rankOf.get(currentValue);
        runnable.push({
            value: currentValue,
            label: currentModel,
            description: "current model",
            searchText: `${currentProvider} ${currentModel}`,
            provider: currentProvider,
            model: currentModel,
            ...(rank === undefined ? {} : { pinnedRank: rank }),
        });
    }
    const orphanPins = pinned.flatMap((entry, rank) => {
        const value = providerModelKey(entry.provider, entry.model);
        return runnable.some((option) => option.value === value) ? [] : [{
            value,
            label: entry.label,
            description: "not available right now",
            searchText: `${entry.provider} ${entry.model}`,
            provider: entry.provider,
            model: entry.model,
            pinnedRank: rank,
            unavailable: true,
        }];
    });
    return [...runnable, ...orphanPins].toSorted((left, right) =>
        left.provider.localeCompare(right.provider)
            || left.label.localeCompare(right.label)
    );
}

/**
 * The All tab is what can run, in catalog order. The Pinned tab is the pin
 * list in its own order, newest pin first: sorting it by provider would throw
 * away the only ordering the user's own actions produced.
 *
 * That order is stable. Using a model does not move it, so a pinned row stays
 * where the user last left it and stays worth aiming at.
 */
function modelTabOptions(
    allOptions: readonly TuiSettingsPickerOption[],
    tab: TuiModelPickerTab,
): readonly TuiSettingsPickerOption[] {
    if (tab === "all") {
        return allOptions.filter((option) => option.unavailable !== true);
    }
    return allOptions
        .filter((option) => option.pinnedRank !== undefined)
        .toSorted((left, right) => left.pinnedRank! - right.pinnedRank!);
}

function providerModelKey(provider: string, model: string): string {
    return JSON.stringify([provider, model]);
}

function pickerSelection(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): TuiSettingsPickerSelection {
    const kind = state.kind;
    if (kind === "model") {
        if (option.provider === undefined || option.model === undefined) {
            throw new Error("model picker option is missing provider identity");
        }
        return { kind, provider: option.provider, model: option.model };
    }
    const value = option.value;
    if (kind === "provider") {
        return { kind, providerId: value };
    }
    if (kind === "reasoning") {
        // A chained level pane folds its result into the model choice that
        // opened it, so the two panes resolve to one patch rather than two.
        if (state.pendingModel !== undefined) {
            return {
                kind: "model",
                provider: state.pendingModel.provider,
                model: state.pendingModel.model,
                reasoningEffort: value as ModelReasoningEffort,
            };
        }
        return { kind, reasoningEffort: value as ModelReasoningEffort };
    }
    if (kind === "permissions") {
        return { kind, mode: value as ApprovalMode };
    }
    if (kind === "session") {
        return { kind, sessionPath: value };
    }
    if (kind === "settings" || kind === "permission_settings") {
        return { kind: "menu", target: value as TuiSettingsMenuTarget };
    }
    return { kind, theme: value as TuiThemeName };
}

function pickerTitle(
    kind: TuiSettingsPickerKind | "extension",
    title?: string,
): string {
    if (title !== undefined) return title;
    return kind === "model"
        ? "Select model"
        : kind === "provider"
        ? "Connect a provider"
        : kind === "reasoning"
            ? "Reasoning"
            : kind === "permissions"
                ? "Permission mode"
                : kind === "session"
                    ? "Resume"
                    : kind === "settings"
                        ? "Settings"
                        : kind === "permission_settings"
                            ? "Permissions"
                            : "Theme";
}

function unchanged(
    state: TuiExtensionPickerState,
    handled: boolean,
): TuiExtensionPickerTransition;
function unchanged(
    state: TuiSettingsPickerState,
    handled: boolean,
): TuiSettingsPickerTransition;
function unchanged(
    state: TuiAnySettingsPickerState,
    handled: boolean,
): TuiSettingsPickerTransition | TuiExtensionPickerTransition {
    if (state.kind === "extension") {
        return { state, handled };
    }
    return { state, handled };
}
