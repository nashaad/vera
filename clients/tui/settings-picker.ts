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
import type { PooledModel } from "../../src/model/catalog-view.ts";
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
    DIALOG_GUTTER,
    dialogFooterNode,
    dialogGroupHeaderNode,
    dialogHeaderNode,
    attachDialogRowPointer,
    dialogOptionRows,
    dialogRowPointer,
    type DialogRowPointer,
    dialogSearchNode,
    type DialogMeta,
    type DialogMetaPart,
} from "./dialog-chrome.ts";
import { tuiThemeSwatch, type TuiThemeName } from "./theme.ts";
import { tuiBindingId, tuiKeyHint } from "./keymap.ts";
import { relativeTime } from "../../src/relative-time.ts";

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
     * Session rows carry their own columns rather than folding activity and
     * workspace into the description: a session is recognised by its title, so
     * the title gets every column the other two do not need.
     */
    readonly activity?: string;
    readonly workspace?: string;
    /** Transcript bytes on disk, shown beside the workspace on session rows. */
    readonly sizeBytes?: number;
    /** True on the session the user is attached to right now. */
    readonly current?: boolean;
    /** The session this one was forked from, when the host reported one. */
    readonly forkedFrom?: string;
    /** Parent used to place a fork or async subagent under its source. */
    readonly threadParent?: string;
    /** How deep under its parent a forked row sits. Absent at the top level. */
    readonly depth?: number;
    /**
     * Position in the user's pool, absent on a row outside it. A rank rather
     * than a flag because the pool is ordered by when each model was added and
     * the provider list is ordered by provider: the Pool tab has to be able to
     * restore the order the store keeps, which sorting by provider destroys.
     */
    readonly pooledRank?: number;
    /**
     * The user's own name for this pool entry. The row reads by it, and the
     * model id stays on the row's meta line so the slug is never lost.
     */
    readonly poolName?: string;
    /** True on a pool row whose model cannot run right now. */
    readonly unavailable?: boolean;
    /** Set only when a source says the model takes images. */
    readonly images?: boolean;
    /** True on a pool row with no probe or rejection evidence behind it. */
    readonly unverified?: boolean;
    /** True on a model Vera's shipped curation recommends. */
    readonly recommended?: boolean;
    /**
     * The level the curation recommends this model at. Shown in the meta
     * column and nothing more: the row selects the same way on every tab, so
     * the level is still chosen on the level pane that follows.
     */
    readonly recommendedLevel?: string;
    /**
     * The heading this row belongs under. Model rows leave it unset and are
     * grouped by their provider instead, which is the same idea: a heading is
     * whatever one fact a run of rows shares.
     */
    readonly group?: string;
    /** Set only on provider rows: whether Vera already holds a credential. */
    readonly connected?: boolean;
    /**
     * Set only on a section header row: the section it opens and closes. A
     * header is an option like any other so the cursor reaches it by moving,
     * and ⏎ on it collapses the run of rows underneath.
     */
    readonly section?: string;
    /** Set on a header whose rows are hidden. */
    readonly sectionCollapsed?: boolean;
    /**
     * A copy of a model row listed in the Top picks section. The section mixes
     * providers, so its rows name theirs even though a row under a provider
     * heading does not.
     */
    readonly inTopPicks?: boolean;
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
 * Two questions, two views of one list. "All models" is what can run; "Pool" is
 * the short list the user keeps. Both filter the same rows, so a model has
 * exactly one row however many views it appears on.
 *
 * Vera's own recommendations are not a third view. They open All models as its
 * first section, above the providers, and the same models keep their rows in
 * the provider sections below.
 */
export type TuiModelPickerTab = "all" | "pool";

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
     * The sections the user has closed, by heading. It rides on the pane so a
     * tab switch and back finds the list the way it was left, and it lasts as
     * long as the pane does: which providers are worth hiding is a question
     * about this visit to the picker rather than a setting.
     */
    readonly collapsed?: readonly string[];
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
     * standalone `/effort` picker: Escape steps back to `modelPaneState`
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
    readonly subtitle?: string;
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
    | {
        readonly kind: "session";
        readonly sessionPath: string;
        readonly sessionId?: string;
    }
    | { readonly kind: "menu"; readonly target: TuiSettingsMenuTarget };

export interface TuiPoolToggle {
    readonly action: "add" | "remove";
    readonly provider: string;
    readonly model: string;
}

/** The selected pool row, on its way to the name prompt. */
export interface TuiPoolNameCandidate {
    readonly provider: string;
    readonly model: string;
    /** The row as it reads now, shown while the name is typed. */
    readonly label: string;
}

/** The selected pool row, sent off to be probed on the user's say-so. */
export interface TuiPoolVerify {
    readonly provider: string;
    readonly model: string;
}

export interface TuiSettingsPickerTransition {
    readonly state?: TuiSettingsPickerState;
    readonly selection?: TuiSettingsPickerSelection;
    readonly handled: boolean;
    /**
     * The pane does not edit the pool itself. It reports the intent and waits
     * for the settings snapshot to come back, so the list the user sees is
     * always the list the host actually stored.
     */
    readonly poolToggle?: TuiPoolToggle;
    /** Same contract as `poolToggle`: reported, not applied here. */
    readonly poolVerify?: TuiPoolVerify;
    /** Same contract again: the pane asks for the prompt, it does not name. */
    readonly poolName?: TuiPoolNameCandidate;
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
    readonly renameCandidate?: {
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
    pointer?: DialogRowPointer;
    /**
     * The tip line drawn above the key hints, or nothing. Set before `update`;
     * the pane redraws from scratch on every update and reads it then.
     */
    tip?: string;
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
    { value: "muted-blue", label: "Muted Blue", description: "blue transcript, muted details" },
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
    pooled: readonly PooledModel[] | undefined = undefined,
): TuiSettingsPickerState {
    const allOptions = kind === "theme"
        ? THEME_OPTIONS
        : kind === "model"
        ? modelOptions(availableModels, currentProvider, currentModel, pooled)
        : permissionOptions(availablePermissionModes);
    const currentValue = kind === "theme"
        ? currentTheme
        : kind === "model"
        ? currentModel === undefined || currentProvider === undefined
            ? undefined
            : providerModelKey(currentProvider, currentModel)
        : currentPermissions;
    // The pane opens on the tab holding the running model, cursor on its row:
    // the thing the user is most likely to act on is the model they are on,
    // and pooling it is then one key away. Pool otherwise, which is the short
    // list built for exactly this moment, and All when the pool is empty,
    // since an empty tab answers no question at all.
    const pooledOptions = modelTabRows(allOptions, "pool");
    const openingTab: TuiModelPickerTab =
        pooledOptions.some((option) => option.value === currentValue)
            ? "pool"
            : currentValue !== undefined
                && modelTabRows(allOptions, "all").some((option) =>
                    option.value === currentValue
                )
            ? "all"
            : pooledOptions.length > 0
            ? "pool"
            : "all";
    const collapsed = kind === "model"
        ? defaultCollapsedSections(allOptions, currentValue)
        : [];
    const options = kind === "model"
        ? modelPickerOptions(allOptions, openingTab, collapsed, "")
        : allOptions;
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
        ...(collapsed.length === 0 ? {} : { collapsed }),
        ...(kind === "model" && currentValue !== undefined
            ? { initialModel: currentValue }
            : {}),
        ...(kind === "theme" ? { initialTheme: currentTheme } : {}),
    };
}

/**
 * Rebuilds an open model pane from a fresh settings snapshot, keeping the
 * user where they were. The highlighted model is restored by identity rather
 * than by index: adding or removing a pool row shifts every index below it,
 * so an index would move the cursor to a different model than the one the
 * user just acted on.
 */
export function syncTuiModelPicker(
    state: TuiSettingsPickerState,
    settings: {
        readonly provider?: string;
        readonly model?: string;
        readonly availableModels?: readonly SuggestedModel[];
        readonly pooled?: readonly PooledModel[];
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
        settings?.pooled,
    );
    // The tab is the user's own place in the pane, so a snapshot arriving from
    // the host must not move them out of it. Adding a model from the Pool tab
    // would otherwise drop them back onto All mid-action.
    const tab = state.tab ?? "all";
    // Closed sections are the user's own place in the pane too, for the same
    // reason the tab is: a snapshot arriving from the host must not reopen
    // them under the user mid-action.
    const collapsed = state.collapsed ?? [];
    const onTab = {
        ...rebuilt,
        tab,
        ...(collapsed.length === 0 ? {} : { collapsed }),
        options: modelPickerOptions(rebuilt.allOptions, tab, collapsed, ""),
    };
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
        // adding a model must not turn escape into "close everything".
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
 * is pane two of a chain, not the standalone `/effort` picker.
 */
export function startTuiReasoningPicker(
    levels: readonly ReasoningLevel[],
    defaultLevel: ReasoningLevelId | undefined,
    currentReasoningEffort: ModelReasoningEffort | undefined,
    pendingModel: TuiPendingModelChoice | undefined = undefined,
): TuiSettingsPickerState {
    // One row per level a request can actually name. A repeated id is one
    // choice listed twice, and picking either row sends the same string.
    const seen = new Set<ReasoningLevelId>();
    const options = levels
        .filter((level) => {
            if (seen.has(level.id)) {
                return false;
            }
            seen.add(level.id);
            return true;
        })
        .map(levelOption);
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

/**
 * Which pane, if any, is left on screen once a selection has been applied.
 *
 * Most answered panes step back to the menu they were opened from, so changing
 * the theme and then the permissions is one trip through `/settings`.
 *
 * A model choice is the exception. Applying it reports into the transcript, and
 * work started by it keeps reporting after the keypress: admitting the model,
 * then whatever verifying it turns up. A card left over that transcript hides
 * exactly the feedback the keypress asked for, so the whole chain closes.
 */
export function tuiPickerAfterSelection(
    selection: TuiSettingsPickerSelection,
    previous: TuiSettingsPickerState | undefined,
): TuiSettingsPickerState | undefined {
    if (selection.kind === "model" || previous === undefined) {
        return undefined;
    }
    return tuiPickerMenuAncestor(previous);
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
    // The current session is listed rather than hidden. Switching is a
    // re-attach with the screen left up, so its row costs nothing and answers
    // "which one am I in" without the user having to remember.
    const options = agents
        .filter((agent) => agent.status !== "closed"
            && agent.status !== "failed"
            && agent.title !== undefined)
        .toSorted((left, right) =>
            (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
        )
        .map((agent) => ({
            value: agent.session_path,
            label: sessionTitle(agent.title!),
            description: "",
            searchText: `${agent.id} ${agent.workspace}`,
            sessionId: agent.id,
            activity: sessionActivity(agent, now),
            workspace: sessionWorkspace(agent),
            ...(agent.size_bytes === undefined
                ? {}
                : { sizeBytes: agent.size_bytes }),
            ...(agent.id === currentAgentId ? { current: true } : {}),
            ...(agent.forked_from === undefined
                ? {}
                : { forkedFrom: agent.forked_from }),
            ...(agent.parent_id === undefined && agent.forked_from === undefined
                ? {}
                : { threadParent: agent.parent_id ?? agent.forked_from }),
        }));
    const threaded = threadSessionOptions(options);
    return {
        kind: "session",
        allOptions: threaded,
        options: threaded,
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
    subtitle: string | undefined = undefined,
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
        ...(subtitle === undefined ? {} : { subtitle }),
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

// The workspace column does not shrink, so its budget is in terminal cells
// rather than characters: a name of wide glyphs would otherwise take twice the
// columns it was measured for and push the row past the terminal edge.
const SESSION_WORKSPACE_CELLS = 14;

/**
 * The longest title the picker will hold. Titles are shown whole at any width a
 * terminal has, so this is not a display measure: it is a bound on what one
 * malformed row can make the renderer pad and lay out on every visible row.
 */
const SESSION_TITLE_LIMIT = 200;

/**
 * Order forks under the session they came from, each one deeper than its parent.
 *
 * A fork is only threaded when its parent is on the list: a fork of a session
 * that has since been trashed is a session in its own right, and hanging it off
 * nothing would say otherwise. The rest of the list keeps the order it arrived
 * in, so threading rearranges a fork and nothing else.
 */
function threadSessionOptions(
    options: readonly TuiSettingsPickerOption[],
): TuiSettingsPickerOption[] {
    // Rows are tracked by position rather than by session id. A host that
    // reported the same id twice would otherwise lose a row here, and a list
    // that silently drops a session is worse than one that threads it oddly.
    const byParent = new Map<string, number[]>();
    const listed = new Set(options.map((option) => option.sessionId));
    options.forEach((option, index) => {
        const parent = option.threadParent ?? option.forkedFrom;
        if (parent === undefined || !listed.has(parent)) {
            return;
        }
        byParent.set(parent, [...byParent.get(parent) ?? [], index]);
    });
    if (byParent.size === 0) {
        return [...options];
    }
    const threaded: TuiSettingsPickerOption[] = [];
    const placed = new Set<number>();
    // An explicit stack rather than recursion: a long enough chain of forks is
    // a valid list, and walking it on the call stack would overflow.
    const place = (root: number): void => {
        const pending: (readonly [number, number])[] = [[root, 0]];
        while (pending.length > 0) {
            const [index, depth] = pending.pop()!;
            if (placed.has(index)) {
                continue;
            }
            placed.add(index);
            const option = options[index]!;
            threaded.push(depth === 0 ? option : { ...option, depth });
            const children = byParent.get(option.sessionId ?? "") ?? [];
            // Reversed, because the stack pops what went on last and children
            // keep the order they arrived in.
            for (let at = children.length - 1; at >= 0; at -= 1) {
                pending.push([children[at]!, depth + 1]);
            }
        }
    };
    options.forEach((option, index) => {
        const parent = option.threadParent ?? option.forkedFrom;
        if (parent === undefined || !listed.has(parent)) {
            place(index);
        }
    });
    // A cycle has no root, so nothing above reached it. Those rows are still
    // sessions and still belong on the list.
    options.forEach((_option, index) => place(index));
    return threaded;
}

function sessionTitle(title: string): string {
    const normalized = title.replaceAll(/\s+/g, " ").trim();
    const characters = [...normalized];
    return characters.length <= SESSION_TITLE_LIMIT
        ? normalized
        : `${characters.slice(0, SESSION_TITLE_LIMIT - 1).join("")}…`;
}

function sessionWorkspace(agent: RegisteredAgentSummary): string {
    const workspaceName = agent.workspace.split("/").filter(Boolean).at(-1)
        ?? agent.workspace;
    return clipToCells(workspaceName, SESSION_WORKSPACE_CELLS);
}

function clipToCells(value: string, cells: number): string {
    if (Bun.stringWidth(value) <= cells) {
        return value;
    }
    let clipped = "";
    let width = 0;
    for (const character of value) {
        const next = width + Bun.stringWidth(character);
        if (next > cells - 1) {
            break;
        }
        clipped += character;
        width = next;
    }
    return `${clipped}…`;
}

function sessionActivity(agent: RegisteredAgentSummary, now: Date): string {
    if (agent.status === "working" || agent.status === "waiting") {
        return agent.status;
    }
    if (agent.kind === "background" && agent.status === "completed") {
        return "completed";
    }
    // A live session with nothing running is one someone has open, which is
    // worth saying: the rest of the column is how long ago a row was last
    // touched, and "3h" under a conversation being read right now is wrong.
    return agent.live ? "open" : relativeTime(agent.updated_at, now, "saved");
}

/**
 * Three significant figures at most, so the column stays the same width from
 * a fresh session to a long one and the unit carries the magnitude.
 */
function formatSessionSize(bytes: number): string {
    if (bytes < 1_000) {
        return `${bytes}B`;
    }
    if (bytes < 1_000_000) {
        return `${Math.round(bytes / 1_000)}K`;
    }
    return `${(bytes / 1_000_000).toFixed(1)}M`;
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
        && tuiBindingId("session_picker", key) === "rename_session"
    ) {
        const selected = state.options[state.selectedIndex];
        return selected?.sessionId === undefined
            ? unchanged(state, true)
            : {
                state,
                renameCandidate: {
                    sessionId: selected.sessionId,
                    label: selected.label,
                },
                handled: true,
            };
    }
    if (
        state.kind === "session"
        && tuiBindingId("session_picker", key) === "trash_session"
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
        && tuiBindingId("model_picker", key) === "toggle_pooled"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected?.provider === undefined || selected.model === undefined) {
            return unchanged(state, true);
        }
        return {
            state,
            handled: true,
            poolToggle: {
                action: isPooled(state, selected) ? "remove" : "add",
                provider: selected.provider,
                model: selected.model,
            },
        };
    }
    // A name belongs to a pool entry, so the key does nothing on a row the
    // user has not pooled.
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "name_pooled"
    ) {
        const selected = state.options[state.selectedIndex];
        if (
            selected?.provider === undefined || selected.model === undefined
            || !isPooled(state, selected)
        ) {
            return unchanged(state, true);
        }
        return {
            state,
            handled: true,
            poolName: {
                provider: selected.provider,
                model: selected.model,
                label: selected.label,
            },
        };
    }
    // Verification is on demand and never on the way in: adding a model is
    // instant, and this is the key that spends probe calls deliberately.
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "verify_model"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected?.provider === undefined || selected.model === undefined) {
            return unchanged(state, true);
        }
        return {
            state,
            handled: true,
            poolVerify: {
                provider: selected.provider,
                model: selected.model,
            },
        };
    }
    // Also ahead of the modifier bail-out, and modified for the same reason as
    // ctrl+s above: every bare key on the model pane belongs to its search box.
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "open_providers"
    ) {
        return { state, handled: true, openProviders: true };
    }
    // Tab cycles the views of the same list. Shift is tolerated rather than
    // given its own direction: the cycle is short enough that forward always
    // gets there.
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "switch_tab"
    ) {
        const cycle: readonly TuiModelPickerTab[] = ["pool", "all"];
        const tab: TuiModelPickerTab = cycle[
            (cycle.indexOf(state.tab ?? "all") + 1) % cycle.length
        ]!;
        const selectedValue = state.options[state.selectedIndex]?.value;
        const options = modelPickerOptions(
            state.allOptions,
            tab,
            state.collapsed ?? [],
            "",
        );
        // The query is dropped on the way across. A search is a question about
        // one list, and carrying it over would land the user on an empty pane
        // with no sign of why.
        return {
            state: {
                ...state,
                tab,
                options,
                query: "",
                selectedIndex: restoredCursor(
                    options,
                    selectedValue,
                    state.initialModel,
                ),
            },
            handled: true,
        };
    }
    // Fold and unfold everything, ahead of the modifier bail-out below because
    // both chords carry shift. Either one replaces whatever mix of open and
    // closed sections the user had: it is one answer to "show me less" or
    // "show me all of it", not an edit to each section in turn.
    const foldAll = state.kind !== "model"
        ? undefined
        : tuiBindingId("model_picker", key);
    if (foldAll === "collapse_all" || foldAll === "expand_all") {
        const collapsed = foldAll === "collapse_all"
            ? sectionLabels(state as TuiSettingsPickerState)
            : [];
        const modelState = state as TuiSettingsPickerState;
        const options = modelPickerOptions(
            modelState.allOptions,
            modelState.tab ?? "all",
            collapsed,
            modelState.query,
        );
        const selectedValue = modelState.options[modelState.selectedIndex]
            ?.value;
        return {
            state: {
                ...modelState,
                collapsed,
                options,
                selectedIndex: restoredCursor(
                    options,
                    selectedValue,
                    modelState.initialModel,
                ),
            },
            handled: true,
        };
    }
    // Half-page movement, ahead of the modifier bail-out below. The cursor
    // travels with the jump rather than the window sliding out from under it,
    // so ctrl+d is ↓ held down and nothing new has to be learned about where
    // the highlight went.
    const halfPage = tuiBindingId("picker", key);
    if (halfPage === "half_page_down" || halfPage === "half_page_up") {
        const next = {
            ...state,
            selectedIndex: halfPageCursor(
                state.selectedIndex,
                state.options.length,
                viewportRows ?? FALLBACK_JUMP * 2,
                halfPage === "half_page_down" ? "down" : "up",
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
    // Digits pick the numbered row directly on the short panes. Only while
    // the search is empty: a query that contains a digit is still a search.
    if (
        digitQuickSelect(state)
        && state.query === ""
        && /^[1-9]$/.test(key.name)
    ) {
        const selected = state.options[Number(key.name) - 1];
        if (selected === undefined) {
            return unchanged(state, true);
        }
        return {
            selection: pickerSelection(state, selected),
            handled: true,
        };
    }
    if (
        key.name.length === 1
        && !key.ctrl
        && !key.meta
    ) {
        return searched(state, state.query + key.name);
    }
    // Left and right open and close a section, the shape a tree has everywhere
    // else. They do nothing on a model row: the list is one column, so there is
    // no sideways move for them to take.
    if (key.name === "left" || key.name === "right") {
        const selected = state.options[state.selectedIndex];
        if (state.kind !== "model" || selected?.section === undefined) {
            return unchanged(state, false);
        }
        const closed = selected.sectionCollapsed === true;
        if (closed === (key.name === "left")) {
            return unchanged(state, true);
        }
        return toggledSection(state, selected.section);
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
        if (state.kind === "model" && selected.section !== undefined) {
            return toggledSection(state, selected.section);
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

    const view: TuiSettingsPickerView = {
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
                renderThemePickerRows(renderer, box, state, nodes, view.pointer);
                return;
            }
            // A session is recognised by its title, and titles are the one row
            // value with no natural length, so this list gets the whole
            // terminal rather than the inset card the settings panes use.
            box.left = state.kind === "session" ? 0 : "10%";
            box.width = state.kind === "session" ? "100%" : "80%";
            renderListPickerRows(
                renderer,
                box,
                state,
                nodes,
                view.pointer,
                view.tip,
            );
        },
    };
    return view;
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
        (state.kind === "model" ? MODEL_TAB_STRIP_HEIGHT : 0)
            + (state.kind === "extension" && state.subtitle !== undefined ? 1 : 0),
    );
}

/**
 * The columns a row has for its label, description and meta together. Derived
 * from the same numbers the card is built from below: the card's share of the
 * terminal, less its own left and right padding, the row's, and the leading
 * gutter.
 */
function pickerContentWidth(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
): number {
    const cardWidth = state.kind === "session"
        ? renderer.width
        : Math.floor(renderer.width * 0.8);
    return Math.max(0, cardWidth - 8);
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
    pointer?: DialogRowPointer,
    tip?: string,
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
    let subtitleLines = 0;
    if (!searchable && state.subtitle !== undefined) {
        const subtitleNode = new TextRenderable(renderer, {
            content: state.subtitle,
            fg: TUI_MUTED,
            width: "100%",
            height: 2,
            paddingLeft: 1,
        });
        box.add(subtitleNode);
        nodes.push(subtitleNode);
        subtitleLines = 1;
    }
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
        pickerMaxRows(
            renderer,
            (tab === undefined ? 0 : MODEL_TAB_STRIP_HEIGHT) + subtitleLines,
        ),
    );
    let lines = 0;
    if (rows.length === 0) {
        const empty = new TextRenderable(renderer, {
            content: `${DIALOG_GUTTER}${emptyPickerMessage(state)}`,
            fg: TUI_MUTED,
            width: "100%",
            height: 1,
        });
        box.add(empty);
        nodes.push(empty);
        lines = 1;
    }
    // The activity column is padded to the widest value on screen, so the
    // titles beside it start on one column even though "just now" and "3d ago"
    // do not measure the same.
    const activityWidth = Math.max(0, ...rows.map((row) =>
        row.kind === "option" ? row.option.activity?.length ?? 0 : 0));
    // A fork is drawn under its parent only while the parent is on the list.
    // Search filters the threaded order without rebuilding it, so a fork whose
    // parent was filtered out would otherwise appear to hang off whichever
    // unrelated row the search left above it.
    const onScreen = new Set(state.options.map((option) => option.sessionId));
    let tinted = false;
    const optionNodes = dialogOptionRows(renderer, rows.flatMap((row) =>
        row.kind === "option"
            ? [{
                label: digitQuickSelect(state)
                        && state.query === ""
                        && row.index < 9
                    ? `${row.index + 1}. ${row.option.label}`
                    : row.option.label,
                leading: optionLeading(
                    state,
                    row.option,
                    activityWidth,
                    (row.option.threadParent ?? row.option.forkedFrom)
                            !== undefined
                        && onScreen.has(
                            (row.option.threadParent ?? row.option.forkedFrom)!,
                        ),
                ),
                ...(state.kind === "session"
                    ? { tint: (tinted = !tinted) }
                    : {}),
                // Model and session rows carry no description. A model's
                // marketing line is not what anyone picks on, and at these
                // widths it only ever arrived clipped to a few characters; a
                // session's facts are its own columns.
                ...(state.kind === "model" || state.kind === "session"
                    ? {}
                    : { description: row.option.description }),
                meta: optionMeta(state, row.option),
                active: row.index === state.selectedIndex,
                current: row.option.section !== undefined
                    || isCurrentOption(state, row.option),
                ...dialogRowPointer(pointer, row.index),
            }]
            : []
    ), pickerContentWidth(renderer, state));
    let optionNodeIndex = 0;
    rows.forEach((row, position) => {
        const node = row.kind === "group"
            ? dialogGroupHeaderNode(renderer, row.label, position > 0)
            : optionNodes[optionNodeIndex++]!;
        lines += row.kind === "group" && position > 0 ? 2 : 1;
        box.add(node);
        nodes.push(node);
    });

    // Above the hints, below the rows: the tip is about the pane, so it sits
    // with the pane's other standing text rather than floating over the list.
    if (tip !== undefined && tip.length > 0) {
        const tipNode = new TextRenderable(renderer, {
            content: new StyledText([
                { text: DIALOG_GUTTER } as TextChunk,
                fg(TUI_ACCENT)("Tip "),
                fg(TUI_MUTED)(tip),
            ]),
            width: "100%",
            height: 1,
            marginTop: 1,
        });
        box.add(tipNode);
        nodes.push(tipNode);
    }

    const footer = dialogFooterNode(
        renderer,
        pickerFooter(state, pickerContentWidth(renderer, state)),
    );
    box.add(footer);
    nodes.push(footer);
    box.height = lines + DIALOG_CHROME_HEIGHT - (searchable ? 0 : 3)
        + (tab === undefined ? 0 : MODEL_TAB_STRIP_HEIGHT)
        + subtitleLines
        + (tip !== undefined && tip.length > 0 ? 2 : 0);
}

// The strip, its explanation, and the blank line under both.
const MODEL_TAB_STRIP_HEIGHT = 3;

const MODEL_TAB_LABELS: readonly (readonly [TuiModelPickerTab, string])[] = [
    ["pool", "Pool"],
    ["all", "All models"],
];

const MODEL_TAB_DESCRIPTIONS: Readonly<Record<TuiModelPickerTab, string>> = {
    pool: "Your curated shortlist. ^s adds or removes models here.",
    all: "Everything your providers offer. Enter runs one without pooling it.",
};

/**
 * The tabs, drawn as one line of labels with the active one accented, followed
 * by one line that explains the active collection. No borders or brackets: the
 * pane already has a card edge, and a second frame inside it reads as two panes
 * rather than two views of one list.
 */
function modelTabStripNode(
    renderer: RenderContext,
    tab: TuiModelPickerTab,
): TextRenderable {
    const chunks: TextChunk[] = [fg(TUI_MUTED)(DIALOG_GUTTER)];
    MODEL_TAB_LABELS.forEach(([id, label], index) => {
        if (index > 0) {
            chunks.push(fg(TUI_MUTED)("   "));
        }
        chunks.push(
            id === tab ? fg(TUI_ACCENT)(label) : fg(TUI_MUTED)(label),
        );
    });
    chunks.push(fg(TUI_MUTED)(`\n${DIALOG_GUTTER}${MODEL_TAB_DESCRIPTIONS[tab]}`));
    return new TextRenderable(renderer, {
        content: new StyledText(chunks),
        width: "100%",
        height: MODEL_TAB_STRIP_HEIGHT,
    });
}

/**
 * One hint per entry, in reading order, each with the order it is dropped in
 * when the row will not fit: 0 is kept longest. A hint that wrapped would split
 * a chord from its label, so the row sheds whole hints instead.
 */
interface PickerHint {
    readonly text: string;
    readonly drop: number;
}

function fittedHints(hints: readonly PickerHint[], width: number): string {
    const kept = [...hints];
    for (;;) {
        const line = kept.map((hint) => hint.text).join(" · ");
        if (width <= 0 || Bun.stringWidth(line) <= width || kept.length <= 1) {
            return line;
        }
        let last = 0;
        kept.forEach((hint, index) => {
            if (hint.drop >= kept[last]!.drop) {
                last = index;
            }
        });
        if (kept[last]!.drop === 0) {
            return line;
        }
        kept.splice(last, 1);
    }
}

export function pickerFooter(
    state: TuiAnySettingsPickerState,
    width = 0,
): string {
    if (state.kind === "session") {
        return [
            "↑↓ ^d^u move",
            "⏎ select",
            tuiKeyHint("rename_session"),
            tuiKeyHint("trash_session"),
            "esc close",
        ].join(" · ");
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
        const pool = selected === undefined || selected.provider === undefined
            ? undefined
            : isPooled(state, selected)
                // Removal is the same key saying the opposite thing, which is
                // the one hint the table cannot hold for us.
                ? tuiKeyHint("toggle_pooled").replace("pool", "remove")
                : tuiKeyHint("toggle_pooled");
        return fittedHints([
            // The movement entry carries the half-page keys rather than taking
            // a separate slot: they are the same movement, and this footer is
            // already the longest one in the pane.
            { text: "↑↓ ^d^u move", drop: 0 },
            { text: "⏎ select", drop: 0 },
            ...(pool === undefined ? [] : [{ text: pool, drop: 1 }]),
            ...(selected?.provider === undefined
                ? []
                : [{ text: tuiKeyHint("verify_model"), drop: 4 }]),
            // Naming belongs to a pool entry, so the hint appears on the same
            // rows the key works on and nowhere else.
            ...(pool === undefined || selected === undefined
                    || !isPooled(state, selected)
                ? []
                : [{ text: tuiKeyHint("name_pooled"), drop: 5 }]),
            // Only while the cursor is on a heading: the keys do nothing on a
            // model row, and a hint for them there would be a lie.
            // The whole-list keys are worth a slot behind the row's own keys;
            // on a heading, where ← and → do something too, the entry moves up
            // because folding is then what the highlighted row is for.
            selected?.section === undefined
                ? { text: "⇧←→ fold all", drop: 5 }
                : { text: "←→ ⇧←→ fold", drop: 1 },
            { text: tuiKeyHint("open_providers"), drop: 6 },
            { text: "⇥ tabs", drop: 3 },
            { text: "esc close", drop: 0 },
        ], width);
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
    // The model pane carries its headings as rows of its own, so that the
    // cursor can reach one and fold the section under it. Everything else has
    // its headings derived here.
    const grouped = state.kind === "provider";
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
 * The pool mark rides on the model's own row, so the key and the list cannot
 * disagree about what is in the pool: both read the same snapshot the host
 * sent.
 */
function isPooled(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): boolean {
    return option.pooledRank !== undefined
        || state.allOptions.some((candidate) =>
            candidate.value === option.value && candidate.pooledRank !== undefined
        );
}

/**
 * Whether the list carries group headings.
 *
 * The connect pane always does: it is two runs of rows, the ones most people
 * want and the rest, and that split is the only ordering it has.
 *
 * Everything but the un-searched Pool tab does, search results included: a
 * filtered list is still in provider order, so a heading there labels a real run
 * of rows. That is what tells apart a subscription model from an OpenRouter one,
 * and stating it once per group beats repeating it on every row.
 *
 * Pool is the exception. It is ordered by the user's own use rather than by
 * provider, so headings would label nothing and the provider goes on the row
 * itself instead.
 */
function isProviderGrouped(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "provider"
        || (state.kind === "model"
            && (state.query.length > 0 || state.tab !== "pool"));
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

function isHeadingRow(row: PickerDisplayRow | undefined): boolean {
    return row !== undefined
        && (row.kind === "group" || row.option.section !== undefined);
}

function stickyGroupRow(
    rows: readonly PickerDisplayRow[],
    start: number,
): PickerDisplayRow | undefined {
    if (start === 0 || isHeadingRow(rows[start])) {
        return undefined;
    }
    for (let index = start - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (isHeadingRow(row)) {
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
    if (state.kind === "session") {
        return option.current === true;
    }
    return state.kind === "model" && option.value === state.initialModel;
}

/**
 * The marker column. A check on the connect pane rather than the dot the other
 * panes use: a dot means "the one in effect", and connected providers are not
 * exclusive, so several rows can carry it at once.
 */
/**
 * The panes short enough that a digit names a row faster than moving to it.
 * The model and session panes stay out: their names carry digits, so a digit
 * there is search input. On the panes below, digits select only while the
 * search is empty, and the numbers hide once a query starts filtering.
 */
function digitQuickSelect(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "reasoning"
        || state.kind === "permissions"
        || state.kind === "settings"
        || state.kind === "permission_settings";
}

function optionLeading(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
    activityWidth = 0,
    threaded = false,
): string {
    // A heading carries the fold arrow where a row carries its marker, so the
    // two read as one column.
    if (option.section !== undefined) {
        return option.sectionCollapsed === true ? "▸ " : "▾ ";
    }
    if (state.kind === "provider") {
        return option.connected === true ? "✓ " : "  ";
    }
    const marker = isCurrentOption(state, option) ? "● " : "  ";
    if (state.kind !== "session") {
        return marker;
    }
    // The session list turns the marker column into a marker, a fork gutter and
    // a time column, so the facts a row is worth reading for sit left of the
    // title rather than after it. A fork indents under its parent, which is
    // what makes the list read as a history rather than a pile.
    const depth = threaded ? option.depth ?? 0 : 0;
    const thread = depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
    return `${marker}${thread}${(option.activity ?? "").padEnd(activityWidth)}  `;
}

function optionMeta(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): DialogMeta | undefined {
    if (state.kind === "session") {
        if (option.sizeBytes === undefined) {
            return option.workspace;
        }
        return [
            { text: formatSessionSize(option.sizeBytes) },
            { text: "  " },
            { text: option.workspace ?? "" },
        ];
    }
    if (state.kind !== "model") {
        return undefined;
    }
    // The column is facts, not one fact: a row can carry its provider, its
    // availability, its recommended level, and its verification state at once.
    const parts: DialogMetaPart[] = [];
    const separated = (part: DialogMetaPart): void => {
        if (parts.length > 0) {
            parts.push({ text: " · " });
        }
        parts.push(part);
    };
    // The Top picks section mixes providers, so its rows name theirs even
    // though the same row under a provider heading does not.
    if (
        option.provider !== undefined
        && (option.inTopPicks === true || !isProviderGrouped(state))
    ) {
        separated({ text: option.provider });
    }
    // Vera's own curation, as a fact among the others rather than a view the
    // user has to know about: a row that is a top pick says so wherever it is
    // listed, the provider sections and search results included.
    if (option.recommended === true) {
        separated({ text: "top pick", tone: "positive" });
    }
    // A named row reads by its name, so the id it stands for goes here: the
    // name is the model's identity, and the slug still has to be findable.
    if (option.poolName !== undefined && option.model !== undefined) {
        separated({ text: option.model });
    }
    // A pool row whose model the provider no longer lists says so, on every
    // view. It is the one thing about a row that a provider heading cannot
    // tell you, and choosing it is a dead end.
    if (option.unavailable === true) {
        separated({ text: "unavailable" });
    }
    // The curation's level, on the model's own row rather than on a row of its
    // own. It is a suggestion for the level pane that follows, not part of
    // what selecting the row does.
    if (option.recommendedLevel !== undefined) {
        separated({ text: option.recommendedLevel });
    }
    // Only a yes is worth a word. The question this answers is whether an
    // attachment will go through, so the mark being there is the answer and
    // its absence means do not count on it.
    if (option.images === true) {
        separated({ text: "images", tone: "positive" });
    }
    // An unverified row runs like any other. The word says only that no probe
    // has established what the model can do yet; a probed pool row says so
    // too, so verifying visibly changes the row.
    if (option.pooledRank !== undefined) {
        separated(option.unverified === true
            ? { text: "unverified" }
            : { text: "verified", tone: "positive" });
    }
    return parts.length === 0 ? undefined : parts;
}

function emptyPickerMessage(state: TuiAnySettingsPickerState): string {
    if (state.kind === "extension") {
        return "No options available";
    }
    if (state.kind === "model" && state.tab === "pool") {
        return "No pooled models match. Tab switches to All models.";
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
    pointer?: DialogRowPointer,
): void {
    const header = dialogHeaderNode(renderer, "Theme");
    const search = dialogSearchNode(renderer, state.query);
    box.add(header);
    box.add(search);
    nodes.push(header, search);

    // Show the curated catalog even while filtering: unmatched rows dim rather
    // than vanish, so the list keeps its stable palette-card shape.
    const matches = new Set(state.options.map((option) => option.value));
    // The theme list is filtered but never shortened, so a row's position in
    // `allOptions` is not its cursor index: only matched rows are selectable,
    // and their index is the one the filtered list uses.
    const selectableIndex = new Map(
        state.options.map((option, index) => [option.value, index]),
    );
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
        const index = selectableIndex.get(option.value);
        if (index !== undefined) {
            attachDialogRowPointer(row, pointer, index);
        }
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

/**
 * Where the cursor lands on a list the user did not scroll: on the model they
 * were highlighting if it survived, else on the running model, else row one.
 * Shared by the tab keys and the filter key, which move the same cursor over
 * the same rows for the same reason.
 */
function restoredCursor(
    options: readonly TuiSettingsPickerOption[],
    selectedValue: string | undefined,
    initialModel: string | undefined,
): number {
    const selected = options.findIndex(
        (option) => option.value === selectedValue,
    );
    if (selected !== -1) {
        return selected;
    }
    return Math.max(
        0,
        options.findIndex((option) => option.value === initialModel),
    );
}

function matching(
    options: readonly TuiSettingsPickerOption[],
    query: string,
): readonly TuiSettingsPickerOption[] {
    const normalized = query.toLowerCase();
    return options.filter((option) =>
        `${option.label} ${option.value} ${option.description} ${
            option.searchText ?? ""
        }`
            .toLowerCase()
            .includes(normalized)
    );
}

function searched(
    state: TuiSettingsPickerState,
    query: string,
): TuiSettingsPickerTransition {
    // Search stays inside the active tab. The tab is a claim about what the
    // list is showing, and a search that reached past it would leave the
    // heading and the rows saying different things.
    const options = state.kind !== "model"
        ? matching(state.allOptions, query)
        // A query opens every section: a heading with its rows hidden is a
        // claim that the search found nothing there, which is not what a
        // closed section means.
        : modelPickerOptions(
            state.allOptions,
            state.tab ?? "all",
            state.collapsed ?? [],
            query,
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
 * Every model row exactly once, whichever tab it belongs to. Pool membership
 * is a mark on the model's own row rather than a second row for the same
 * model, so the two tabs are views of one list and no model can appear twice.
 *
 * A pool entry the runnable list has never heard of still gets a row: the user
 * put it there deliberately, so only the user takes it out. It carries
 * `unavailable`, which is what keeps it off the All tab, where it would be a
 * dead end. An entry with no evidence behind it carries `unverified`, which is
 * a note on the row rather than a gate: it can still be selected.
 */
function modelOptions(
    available: readonly SuggestedModel[] | undefined,
    currentProvider: string | undefined,
    currentModel: string | undefined,
    pooled: readonly PooledModel[] = [],
): readonly TuiSettingsPickerOption[] {
    const poolEntry = new Map(
        pooled.map((entry, rank) =>
            [providerModelKey(entry.provider, entry.model), { entry, rank }] as const
        ),
    );
    const poolMarks = (value: string): Partial<TuiSettingsPickerOption> => {
        const held = poolEntry.get(value);
        return {
            ...(held === undefined ? {} : { pooledRank: held.rank }),
            ...(held?.entry.poolName === undefined
                ? {}
                : { poolName: held.entry.poolName, label: held.entry.poolName }),
            ...(held !== undefined && !held.entry.verified
                ? { unverified: true }
                : {}),
            ...(held?.entry.imageSupport === true ? { images: true } : {}),
        };
    };
    const runnable = (available ?? []).map((model) => {
        const value = providerModelKey(model.provider, model.model);
        return {
            value,
            label: model.label,
            description: model.description,
            searchText: `${model.provider} ${model.model}${
                poolEntry.get(value)?.entry.poolName === undefined
                    ? ""
                    : ` ${poolEntry.get(value)?.entry.poolName}`
            }`,
            provider: model.provider,
            model: model.model,
            ...recommendationMarks(model),
            ...poolMarks(value),
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
        runnable.push({
            value: currentValue,
            label: currentModel,
            description: "current model",
            searchText: `${currentProvider} ${currentModel}`,
            provider: currentProvider,
            model: currentModel,
            ...poolMarks(currentValue),
        });
    }
    const orphanEntries = pooled.flatMap((entry, rank) => {
        const value = providerModelKey(entry.provider, entry.model);
        return runnable.some((option) => option.value === value) ? [] : [{
            value,
            label: entry.poolName ?? entry.label,
            description: "not available right now",
            searchText: `${entry.provider} ${entry.model}${
                entry.poolName === undefined ? "" : ` ${entry.poolName}`
            }`,
            ...(entry.poolName === undefined
                ? {}
                : { poolName: entry.poolName }),
            provider: entry.provider,
            model: entry.model,
            pooledRank: rank,
            unavailable: true,
            ...recommendationMarks(entry),
            ...(entry.verified ? {} : { unverified: true }),
            ...(entry.imageSupport === true ? { images: true } : {}),
        }];
    });
    return [...runnable, ...orphanEntries].toSorted((left, right) =>
        left.provider.localeCompare(right.provider)
            || left.label.localeCompare(right.label)
    );
}

/**
 * The curation's marks on a model row. A recommendation is two notes on the
 * one row rather than a row of its own, so the Top picks tab can filter the
 * same list every other tab shows.
 */
function recommendationMarks(model: {
    readonly recommended?: boolean;
    readonly recommendedLevel?: string;
}): Partial<TuiSettingsPickerOption> {
    if (model.recommended !== true) {
        return {};
    }
    return {
        recommended: true,
        ...(model.recommendedLevel === undefined
            ? {}
            : { recommendedLevel: model.recommendedLevel }),
    };
}

/**
 * The All tab is what can run, in catalog order. The Pool tab is the pool in
 * its own order, newest entry first: sorting it by provider would throw away
 * the only ordering the user's own actions produced.
 *
 * That order is stable. Using a model does not move it, so a pool row stays
 * where the user last left it and stays worth aiming at.
 */
function modelTabRows(
    allOptions: readonly TuiSettingsPickerOption[],
    tab: TuiModelPickerTab,
): readonly TuiSettingsPickerOption[] {
    if (tab === "all") {
        return allOptions.filter((option) => option.unavailable !== true);
    }
    return allOptions
        .filter((option) => option.pooledRank !== undefined)
        .toSorted((left, right) => left.pooledRank! - right.pooledRank!);
}

/** The heading the recommended models are listed under. */
export const TUI_TOP_PICKS_SECTION = "Top picks";

/**
 * The rows one view of the model list shows, headings included.
 *
 * The un-searched Pool tab is the one flat list: it is ordered by the user's
 * own use rather than by provider, so a heading there would label nothing.
 */
function modelPickerOptions(
    allOptions: readonly TuiSettingsPickerOption[],
    tab: TuiModelPickerTab,
    collapsed: readonly string[],
    query: string,
): readonly TuiSettingsPickerOption[] {
    const rows = modelTabRows(allOptions, tab);
    const matched = query === "" ? rows : matching(rows, query);
    if (tab === "pool" && query === "") {
        return matched;
    }
    return sectionedOptions(
        matched,
        query === "" ? collapsed : [],
        tab === "all",
    );
}

function sectionHeader(
    label: string,
    rows: readonly TuiSettingsPickerOption[],
    collapsed: readonly string[],
): TuiSettingsPickerOption {
    const closed = collapsed.includes(label);
    return {
        value: sectionValue(label),
        label: closed ? `${label} (${rows.length})` : label,
        description: "",
        section: label,
        ...(closed ? { sectionCollapsed: true } : {}),
    };
}

function sectionValue(label: string): string {
    return `section:${label}`;
}

function sectionedOptions(
    rows: readonly TuiSettingsPickerOption[],
    collapsed: readonly string[],
    topPicks: boolean,
): readonly TuiSettingsPickerOption[] {
    const options: TuiSettingsPickerOption[] = [];
    const picks = topPicks
        ? rows.filter((row) => row.recommended === true)
        : [];
    if (picks.length > 0) {
        options.push(sectionHeader(TUI_TOP_PICKS_SECTION, picks, collapsed));
        if (!collapsed.includes(TUI_TOP_PICKS_SECTION)) {
            options.push(...picks.map((row) => ({
                ...row,
                value: `${TUI_TOP_PICKS_SECTION}:${row.value}`,
                inTopPicks: true,
            })));
        }
    }
    const providers = new Map<string, TuiSettingsPickerOption[]>();
    rows.forEach((row) => {
        const label = row.group ?? row.provider ?? "Other";
        const existing = providers.get(label);
        if (existing === undefined) {
            providers.set(label, [row]);
            return;
        }
        existing.push(row);
    });
    providers.forEach((group, label) => {
        options.push(sectionHeader(label, group, collapsed));
        if (!collapsed.includes(label)) {
            options.push(...group);
        }
    });
    return options;
}

/**
 * How All models opens: Top picks showing, the providers closed.
 *
 * The recommendations are the answer to "which model should I switch to", and
 * a provider list of a few hundred rows underneath them is a haystack around
 * that answer. The section holding the running model stays open, because the
 * pane opens with the cursor on that row and a cursor inside a closed section
 * is a pane that opens somewhere the user cannot see.
 */
function defaultCollapsedSections(
    allOptions: readonly TuiSettingsPickerOption[],
    currentValue: string | undefined,
): readonly string[] {
    const rows = modelTabRows(allOptions, "all");
    const open = rows.find((option) => option.value === currentValue)?.provider;
    const sections = new Set<string>();
    rows.forEach((option) => {
        const label = option.group ?? option.provider ?? "Other";
        if (label !== open) {
            sections.add(label);
        }
    });
    return [...sections];
}

/** Every section the list is showing, closed or open. */
function sectionLabels(
    state: TuiSettingsPickerState,
): readonly string[] {
    return modelPickerOptions(
        state.allOptions,
        state.tab ?? "all",
        [],
        state.query,
    ).flatMap((option) => option.section === undefined ? [] : [option.section]);
}

/** The pane with one section opened or closed, cursor left on its heading. */
function toggledSection(
    state: TuiSettingsPickerState,
    label: string,
): TuiSettingsPickerTransition {
    const collapsed = (state.collapsed ?? []).includes(label)
        ? (state.collapsed ?? []).filter((entry) => entry !== label)
        : [...(state.collapsed ?? []), label];
    const options = modelPickerOptions(
        state.allOptions,
        state.tab ?? "all",
        collapsed,
        state.query,
    );
    return {
        state: {
            ...state,
            collapsed,
            options,
            selectedIndex: Math.max(
                0,
                options.findIndex((option) => option.value === sectionValue(label)),
            ),
        },
        handled: true,
    };
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
        // Model only. A recommended level is a note on the row, not part of
        // the choice: the row has to select the same way on every tab, or the
        // tabs stop being views of one list.
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
        // The id rides along with the path because the caller has to recognise
        // the row for the session already on screen, and it knows itself by id.
        return {
            kind,
            sessionPath: value,
            ...(option.sessionId === undefined
                ? {}
                : { sessionId: option.sessionId }),
        };
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
