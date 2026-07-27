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
    DIALOG_CHROME_HEIGHT,
    DIALOG_GUTTER_WIDTH,
    dialogBottomOffset,
    dialogFooterNode,
    dialogGroupHeaderNode,
    dialogHeaderNode,
    dialogOptionRows,
    dialogSearchNode,
} from "./dialog-chrome.ts";
import { tuiThemeSwatch, type TuiThemeName } from "./theme.ts";

export type TuiSettingsPickerKind =
    | "model"
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
     * rather than a flag because the pin list is ordered by recency of use and
     * the provider list is ordered by provider: the Pinned tab has to be able
     * to restore the order the store keeps, which sorting by provider destroys.
     */
    readonly pinnedRank?: number;
    /** True on a pinned row whose model cannot run right now. */
    readonly unavailable?: boolean;
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
    // The pane opens on All rather than Pinned even when pins exist: the user
    // asked to change model, and the tab that can answer that in every case is
    // the one that lists every model.
    const options = kind === "model"
        ? modelTabOptions(allOptions, "all")
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
        ...(kind === "model" ? { tab: "all" as const } : {}),
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
        ...(pendingModel === undefined ? {} : { pendingModel }),
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
): TuiExtensionPickerTransition;
export function handleTuiSettingsPickerKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): TuiSettingsPickerTransition;
export function handleTuiSettingsPickerKey(
    state: TuiAnySettingsPickerState,
    key: TuiSettingsPickerKey,
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
        const selectedIndex = options.findIndex(
            (option) => option.value === selectedValue,
        );
        return {
            state: {
                ...state,
                tab,
                options,
                query: "",
                selectedIndex: selectedIndex === -1 ? 0 : selectedIndex,
            },
            handled: true,
        };
    }
    if (key.ctrl || key.meta || key.super || key.hyper || key.shift) {
        return unchanged(state, false);
    }
    if (key.name === "escape") {
        // Escape inside a submenu steps back to its parent rather than closing
        // outright, so a wrong turn costs one key instead of reopening /settings.
        if (state.kind === "permission_settings") {
            return { state: startTuiSettingsMenu("settings"), handled: true };
        }
        if (state.kind === "reasoning" && state.pendingModel !== undefined) {
            return { state: state.pendingModel.modelPaneState, handled: true };
        }
        return {
            handled: true,
            ...(state.kind === "theme" && state.initialTheme !== undefined
                ? { previewTheme: state.initialTheme }
                : {}),
        };
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
 * Even a cramped terminal shows this many rows, at the cost of the card running
 * past where it would rather stop. A list windowed down to one or two rows is
 * not a list, it is a spinner you have to operate.
 */
const PICKER_MIN_ROWS = 4;

/**
 * How many rows the card can show without running off the bottom. Derived from
 * the terminal rather than fixed: the old constant 12 left most of a tall
 * terminal empty and pushed the top of a long provider group off the window,
 * where it was easy to miss entirely.
 *
 * Group headers cost more than one line, so this is a row budget rather than a
 * line budget and a heavily grouped list can still overrun by a line or two.
 * The alternative is a window whose size changes as you scroll past headers,
 * which is worse to use than an occasional tight fit.
 */
function pickerMaxRows(renderer: RenderContext, extraChrome: number): number {
    const available = renderer.height
        - PICKER_TOP_OFFSET
        - dialogBottomOffset(renderer)
        - DIALOG_CHROME_HEIGHT
        - extraChrome;
    return Math.max(PICKER_MIN_ROWS, available);
}

// Where the card's top edge sits, matching `box.top` below.
const PICKER_TOP_OFFSET = 2;

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
                leading: isCurrentOption(state, row.option) ? "● " : "  ",
                description: row.option.description,
                meta: optionMeta(state, row.option),
                active: row.index === state.selectedIndex,
                current: isCurrentOption(state, row.option),
            }]
            : []
    ));
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
    ["all", "All models"],
    ["pinned", "Pinned"],
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
        return "↑↓ move · ⏎ select · del trash · esc close";
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
    if (state.kind === "model") {
        const selected = state.options[state.selectedIndex];
        const pinned = selected === undefined || selected.provider === undefined
            ? undefined
            : isPinned(state, selected)
                ? "^s unpin"
                : "^s pin";
        return [
            "↑↓ move",
            "⏎ select",
            ...(pinned === undefined ? [] : [pinned]),
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
    // Only the unfiltered All tab is grouped. A search result is a single ranked
    // list, and the Pinned tab is ordered by the user's own use rather than by
    // provider, so provider headers there would label nothing.
    const grouped = state.kind === "model" && state.query.length === 0
        && state.tab !== "pinned";
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

function groupLabel(
    option: TuiSettingsPickerOption | undefined,
): string | undefined {
    return option?.provider;
}

function windowedDisplayRows(
    rows: readonly PickerDisplayRow[],
    selectedIndex: number,
    maxRows: number,
): readonly PickerDisplayRow[] {
    if (rows.length <= maxRows) {
        return rows;
    }
    const cursor = rows.findIndex((row) =>
        row.kind === "option" && row.index === selectedIndex
    );
    const centered = Math.max(0, cursor) - Math.floor(maxRows / 2);
    const start = Math.min(
        Math.max(0, centered),
        rows.length - maxRows,
    );
    const window = rows.slice(start, start + maxRows);
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
    return state.kind === "model" && option.value === state.initialModel;
}

function optionMeta(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): string | undefined {
    return state.kind === "model" && state.query.length > 0
        ? option.provider
        : undefined;
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
 * list in its own order, which is recency of use: sorting it by provider would
 * throw away the only ordering the user's own actions produced.
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
