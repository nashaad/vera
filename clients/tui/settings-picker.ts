import {
    bg,
    BoxRenderable,
    fg,
    italic,
    StyledText,
    TextRenderable,
    type MouseEvent,
    type Renderable,
    type RenderContext,
    type TextChunk,
} from "@opentui/core";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import type { ReductionReason } from "../../src/model/catalog-reduction.ts";
import type { SuggestedModel } from "../../src/model/supported-models.ts";
import type { PooledModel } from "../../src/model/catalog-view.ts";
import {
    isJobAssignmentId,
    JOB_ASSIGNMENT_INTENTS,
    type ModelAssignmentId,
    type ModelAssignmentRow,
} from "../../src/config/model-assignments.ts";
import type {
    ModelPricing,
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import { formatBlendedRate, formatListedRates } from "../../src/model/listed-rates.ts";
import {
    INTELLIGENCE_CUTOFFS,
    stepIntelligenceCutoff,
    passesIntelligenceCutoff,
    type IntelligenceCutoff,
} from "../../src/model/intelligence-cutoff.ts";
import { inferReasoningSelection } from "../../src/model/reasoning-effort.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { ProviderAccessKind } from "../../src/providers/registry.ts";
import { isSafeProviderId } from "../../src/providers/provider-id.ts";
import {
    isVeraProviderId,
    type VeraCustomProviderConfig,
    type VeraProviderCredential,
    type VeraProviderProtocol,
} from "../../src/config.ts";
import type {
    DeveloperSettings,
    DeveloperSettingsPatch,
    ModelTurnSettings,
    ReviewerModelDefault,
    ReviewerModelSelection,
} from "../../src/engine/model-settings.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_CHROME,
    TUI_DANGER,
    TUI_ELEMENT,
    TUI_INPUT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_SELECTION_TEXT,
    TUI_TEXT,
} from "./state.ts";
import {
    dialogBoxHeight,
    halfPageCursor,
    LIST_MIN_ROWS,
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import {
    APP_PADDING_BOTTOM,
    APP_PADDING_TOP,
    centeredDialogSurface,
    DIALOG_CARD_Z_INDEX,
    DIALOG_CARD_PADDING,
    DIALOG_CHROME_HEIGHT,
    DIALOG_GUTTER,
    DIALOG_GUTTER_WIDTH,
    dialogFooterNode,
    dialogGroupHeaderNode,
    dialogHeaderNode,
    dialogInsetBottomOffset,
    dialogInsetTop,
    attachDialogRowPointer,
    dialogOptionRows,
    dialogRowPointer,
    type DialogRowPointer,
    createDialogSearchNode,
    updateDialogSearchNode,
    registerDialogCard,
    type DialogMeta,
    type DialogMetaPart,
} from "./dialog-chrome.ts";
import { tuiThemeSwatch, type TuiThemeName } from "./theme.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";
import { tuiBindingId, tuiKeyHint } from "./keymap.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";
import type { TuiSessionLeaveDisposition } from "./session-lifecycle.ts";
import { relativeTime } from "../../src/relative-time.ts";

export type TuiSettingsPickerKind =
    | "model"
    | "provider"
    | "reasoning"
    | "permissions"
    | "theme"
    | "context_limit"
    | "developer_settings"
    | "developer_value"
    | "session"
    | "configure"
    | "settings"
    | "permission_settings"
    | "reviewer_settings"
    | "reviewer"
    | "model_assignment"
    | "pool_verify_scope"
    | "catalog_refresh_scope";

export type TuiSettingsMenuTarget =
    | "model"
    | "reasoning"
    | "permissions"
    | "theme"
    | "context_limit"
    | "developer"
    | "developer_context_limit"
    | "developer_compaction_trigger"
    | "developer_target_fraction"
    | "developer_summary_words"
    | "permission_mode"
    | "granted_permissions"
    | "reviewer"
    | "reviewer_primary"
    | "reviewer_fallback";

export type TuiSettingsMenuKind = Extract<
    TuiSettingsPickerKind,
    "settings" | "permission_settings" | "reviewer_settings"
>;

export type TuiDeveloperKey =
    | "contextLimit"
    | "compactionTriggerFraction"
    | "postCompactionTargetFraction"
    | "summaryWordCap";

export type TuiReviewerSlot = "primary" | "fallback";

export interface TuiSettingsPickerOption {
    readonly value: string;
    readonly label: string;
    readonly description: string;
    readonly note?: string;
    readonly detailTitle?: string;
    readonly detailFacts?: readonly (readonly [string, string])[];
    readonly searchText?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly card?: boolean;
    readonly rowMeta?: DialogMeta;
    readonly sessionId?: string;
    readonly sessionName?: string;
    readonly activity?: string;
    readonly workspace?: string;
    readonly sizeBytes?: number;
    readonly current?: boolean;
    readonly forkedFrom?: string;
    readonly threadParent?: string;
    readonly depth?: number;
    readonly sharedEdge?: "start" | "end";
    readonly sharedGroup?: string;
    readonly pooledRank?: number;
    readonly poolName?: string;
    readonly unavailable?: boolean;
    readonly images?: boolean;
    readonly waScore?: number;
    readonly pricing?: ModelPricing;
    readonly onPareto?: boolean;
    readonly unverified?: boolean;
    readonly hiddenByDefault?: ReductionReason;
    readonly recommended?: boolean;
    readonly recommendedLevel?: string;
    readonly refreshable?: boolean;
    readonly group?: string;
    readonly connected?: boolean;
    readonly action?: boolean;
    readonly declared?: boolean;
    readonly endpointEditable?: boolean;
    readonly section?: string;
    readonly sectionCollapsed?: boolean;
    readonly inTopPicks?: boolean;
}

export interface TuiConfigureFile {
    readonly label: string;
    readonly path: string;
    readonly displayPath: string;
    readonly scope: "Profile" | "Project";
    readonly createIfMissing: boolean;
}

export interface TuiProviderRow {
    readonly id: string;
    readonly label: string;
    readonly group: TuiProviderGroup;
    readonly hint?: string;
    readonly connected: boolean;
    readonly refreshable?: boolean;
    readonly declared?: boolean;
    readonly endpointEditable?: boolean;
}

export type TuiProviderGroup =
    | "Subscriptions"
    | "API keys"
    | "Local"
    | "Added in config";

const TUI_PROVIDER_GROUP_RANK: Readonly<Record<TuiProviderGroup, number>> = {
    "Subscriptions": 0,
    "API keys": 1,
    "Local": 2,
    "Added in config": 3,
};

export function tuiProviderGroup(
    access: ProviderAccessKind,
    declared = false,
): TuiProviderGroup {
    if (declared) return "Added in config";
    if (access === "subscription") return "Subscriptions";
    if (access === "api_key") return "API keys";
    return "Local";
}

export type TuiModelPickerTab =
    | "all"
    | "pool"
    | "actions"
    | "defaults"
    | "help";

export interface TuiExtensionPickerRow {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly current?: boolean;
}

export type TuiExtensionPickerActionKey =
    | "enter"
    | "d"
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
    readonly queryCursor?: number;
    readonly title?: string;
    readonly subtitle?: string;
    readonly initialTheme?: TuiThemeName;
    readonly initialModel?: string;
    readonly loading?: boolean;
    readonly tab?: TuiModelPickerTab;
    readonly modelFocus?:
        | "list"
        | "list_action"
        | "detail"
        | "page_entry"
        | "page"
        | "intelligence";
    readonly modelPageIndex?: number;
    readonly modelCatalogUnavailable?: boolean;
    readonly modelActionIndex?: number;
    readonly requestOptionsProviders?: Readonly<Record<
        string,
        TuiModelRequestOptionsSupport
    >>;
    readonly configuredRequestOptions?: readonly string[];
    readonly assignmentOptions?: readonly TuiSettingsPickerOption[];
    readonly actionOptions?: readonly TuiSettingsPickerOption[];
    readonly webdevArenaSnapshot?: string;
    readonly canUndoPoolChange?: boolean;
    readonly enterDisposition?: TuiSessionLeaveDisposition;
    readonly nothingToLeave?: boolean;
    readonly collapsed?: readonly string[];
    readonly parent?: TuiSettingsPickerState;
    readonly pendingModel?: TuiPendingModelChoice;
    readonly reviewerSlot?: TuiReviewerSlot;
    readonly developerKey?: TuiDeveloperKey;
    readonly developerSettings?: DeveloperSettings;
    readonly modelAssignment?: ModelAssignmentId;
    readonly assignedModels?: readonly string[];
    readonly assignmentAllowsSelf?: boolean;
    readonly revealAll?: boolean;
    readonly intelligenceCutoff?: IntelligenceCutoff;
    readonly configureFiles?: readonly TuiConfigureFile[];
}

export interface TuiAssignmentParentModel {
    readonly provider?: string;
    readonly model: string;
}

export interface TuiPendingModelChoice {
    readonly provider: string;
    readonly model: string;
    readonly modelPaneState: TuiSettingsPickerState;
    readonly assignment?: ModelAssignmentId;
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
        readonly reasoningEffort?: ModelReasoningEffort;
    }
    | {
        readonly kind: "reasoning";
        readonly reasoningEffort: ModelReasoningEffort;
    }
    | { readonly kind: "provider"; readonly providerId: string }
    | { readonly kind: "permissions"; readonly mode: ApprovalMode }
    | { readonly kind: "theme"; readonly theme: TuiThemeName }
    | { readonly kind: "context_limit"; readonly limit: number | null }
    | {
        readonly kind: "developer";
        readonly patch: DeveloperSettingsPatch;
    }
    | {
        readonly kind: "session";
        readonly sessionPath: string;
        readonly sessionId?: string;
        readonly sourceDisposition: TuiSessionLeaveDisposition;
    }
    | { readonly kind: "configure"; readonly file: TuiConfigureFile }
    | { readonly kind: "menu"; readonly target: TuiSettingsMenuTarget }
    | {
        readonly kind: "reviewer";
        readonly slot: TuiReviewerSlot;
        readonly provider?: string;
        readonly model?: string;
    }
    | { readonly kind: "pool_verify_scope"; readonly onlyUnverified: boolean }
    | {
        readonly kind: "catalog_refresh_scope";
        readonly providers: readonly string[];
    }
    | { readonly kind: "model_assignment_browse" }
    | { readonly kind: "model_assignment_open"; readonly assignment: ModelAssignmentId }
    | {
        readonly kind: "model_assignment";
        readonly assignment: ModelAssignmentId;
        readonly provider?: string;
        readonly model?: string;
        readonly reasoningEffort?: ModelReasoningEffort;
        readonly acceptDefaultReasoning?: true;
        readonly remove?: boolean;
        readonly clear?: boolean;
        readonly allowSelf?: boolean;
    };

export interface TuiPoolToggle {
    readonly action: "add" | "remove";
    readonly provider: string;
    readonly model: string;
}

export interface TuiPoolNameCandidate {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
}

export interface TuiPoolVerify {
    readonly provider: string;
    readonly model: string;
}

export interface TuiModelRequestOptionsSupport {
    readonly providerLabel: string;
    readonly label: string;
    readonly explanation: string;
    readonly documentationUrl: string;
}

export interface TuiModelRequestOptionsCandidate {
    readonly provider: string;
    readonly model: string;
    readonly support: TuiModelRequestOptionsSupport;
}

export interface TuiSettingsPickerTransition {
    readonly state?: TuiSettingsPickerState;
    readonly selection?: TuiSettingsPickerSelection;
    readonly handled: boolean;
    readonly poolToggle?: TuiPoolToggle;
    readonly undoPoolChange?: boolean;
    readonly poolVerify?: TuiPoolVerify;
    readonly poolVerifySweep?: boolean;
    readonly poolName?: TuiPoolNameCandidate;
    readonly requestOptions?: TuiModelRequestOptionsCandidate;
    readonly poolMove?: {
        readonly provider: string;
        readonly model: string;
        readonly delta: number;
    };
    readonly openProviders?: boolean;
    readonly forgetProvider?: string;
    readonly declareProvider?: boolean;
    readonly refreshCatalog?: string;
    readonly refreshCatalogScope?: boolean;
    readonly editProvider?: string;
    readonly editEndpoint?: string;
    readonly previewTheme?: TuiThemeName;
    readonly trashCandidate?: {
        readonly sessionId: string;
        readonly label: string;
    };
    readonly renameCandidate?: {
        readonly sessionId: string;
        readonly label: string;
        readonly value?: string;
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

export function moveTuiSettingsPickerPointer(
    state: TuiAnySettingsPickerState,
    index: number,
): TuiAnySettingsPickerState {
    if (state.kind !== "model") {
        return { ...state, selectedIndex: index };
    }
    if (index < 0) {
        if (index === -1) {
            return modelPageEntry(state) === undefined
                ? state
                : { ...state, modelFocus: "page_entry" };
        }
        const pageIndex = -index - 2;
        return pageIndex < modelPageActions(state).length
            ? { ...state, modelFocus: "page", modelPageIndex: pageIndex }
            : state;
    }
    if (index < state.options.length) {
        return { ...state, selectedIndex: index, modelFocus: "list" };
    }
    if (index === state.options.length && modelListAction(state) !== undefined) {
        return { ...state, modelFocus: "list_action" };
    }
    const actionIndex = index - state.options.length - 1;
    const actions = modelDetailActions(
        state,
        state.options[state.selectedIndex],
    );
    if (actionIndex >= 0 && actionIndex < actions.length) {
        return {
            ...state,
            modelFocus: "detail",
            modelActionIndex: actionIndex,
        };
    }
    return state;
}

export interface TuiSettingsPickerView {
    readonly box: BoxRenderable;
    pointer?: DialogRowPointer;
    tip?: string;
    verification?: {
        readonly subject: string;
        readonly steps?: readonly {
            readonly label: string;
            readonly status: "running" | "passed" | "failed" | "skipped";
        }[];
    };
    onTab?: (tab: TuiModelPickerTab) => void;
    onConfigure?: () => void;
    focus(): void;
    handleEditorKey(
        state: TuiSettingsPickerState,
        key: TuiSettingsPickerKey,
    ): TuiSettingsPickerTransition;
    handleEditorPaste(
        state: TuiSettingsPickerState,
        text: string,
    ): TuiSettingsPickerTransition;
    update(state: TuiAnySettingsPickerState, railInset?: number): void;
}

const PERMISSION_OPTIONS: readonly TuiSettingsPickerOption[] = [
    {
        value: "readonly",
        label: "Readonly",
        description: "allow reads and deny changes",
    },
    { value: "ask", label: "Ask", description: "ask before every bash command" },
    {
        value: "auto",
        label: "Auto",
        description: "a classifier clears the safe ones, you decide the rest",
    },
    {
        value: "full_access",
        label: "Full access",
        description: "allow commands with your user permissions",
    },
];

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
    { value: "orng", label: "Orng", description: "warm orange on charcoal" },
    { value: "palenight", label: "Palenight", description: "soft blue and purple" },
    { value: "synthwave", label: "Synthwave", description: "bright cyan and neon" },
    { value: "nightowl", label: "Night Owl", description: "deep blue, low glare" },
    { value: "github", label: "GitHub", description: "GitHub dark palette" },
    { value: "midnight-blue", label: "Midnight Blue", description: "navy, gold, and cool white" },
    { value: "midnight-blue-ii", label: "Midnight Blue II", description: "gold accent, blue code" },
    { value: "norton-commander", label: "NC", description: "blue panels, cyan bars, yellow detail" },
    { value: "nc-navy", label: "NC Navy", description: "deep navy panels, cyan bars" },
    { value: "windows-31", label: "retro31", description: "navy windows on teal" },
];

export function startTuiSettingsPicker(
    kind: Exclude<TuiSettingsPickerKind, "reasoning" | "configure">,
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
    const pooledOptions = modelTabRows(allOptions, "pool");
    const openingTab: TuiModelPickerTab = pooledOptions.length > 0
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

export function startTuiConfigurePicker(
    files: readonly TuiConfigureFile[],
): TuiSettingsPickerState {
    const options = files.map((file) => ({
        value: file.path,
        label: file.label,
        description: file.displayPath,
        group: file.scope,
        searchText: `${file.label} ${file.path}`,
    }));
    return {
        kind: "configure",
        title: "Configure",
        subtitle:
            "Choose a configuration file to edit\n"
            + "These files are the daily Vera home.",
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
        configureFiles: files,
    };
}

export function syncTuiModelPicker(
    state: TuiSettingsPickerState,
    settings: {
        readonly provider?: string;
        readonly model?: string;
        readonly availableModels?: readonly SuggestedModel[];
        readonly pooled?: readonly PooledModel[];
        readonly actionOptions?: readonly TuiSettingsPickerOption[];
        readonly webdevArenaSnapshot?: string;
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
    // The tab is the user's own place in the pane, so a snapshot arriving from the host must not move them out of it.
    const tab = state.tab ?? "all";
    // Closed sections are the user's own place in the pane too, for the same reason the tab is: a snapshot arriving from the host must not reopen them under the user mid-action.
    const collapsed = state.collapsed ?? [];
    const actionOptions = settings?.actionOptions ?? state.actionOptions ?? [];
    const onTab = {
        ...rebuilt,
        tab,
        ...modelSyncedFocus(state, { ...rebuilt, tab, actionOptions }),
        modelActionIndex: state.modelActionIndex ?? 0,
        ...(state.requestOptionsProviders === undefined
            ? {}
            : { requestOptionsProviders: state.requestOptionsProviders }),
        ...(state.configuredRequestOptions === undefined
            ? {}
            : { configuredRequestOptions: state.configuredRequestOptions }),
        ...(state.revealAll === true ? { revealAll: true } : {}),
        ...(state.intelligenceCutoff === undefined
                || state.intelligenceCutoff === "any"
            ? {}
            : { intelligenceCutoff: state.intelligenceCutoff }),
        ...(collapsed.length === 0 ? {} : { collapsed }),
        ...(settings?.webdevArenaSnapshot === undefined
            ? {}
            : { webdevArenaSnapshot: settings.webdevArenaSnapshot }),
        ...(state.assignmentOptions === undefined
            ? {}
            : { assignmentOptions: state.assignmentOptions }),
        ...(actionOptions.length === 0 ? {} : { actionOptions }),
        options: modelPickerOptions(
            rebuilt.allOptions,
            tab,
            collapsed,
            "",
            state.revealAll === true,
            state.assignmentOptions ?? [],
            actionOptions,
            state.intelligenceCutoff ?? "any",
            state.initialModel,
        ),
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
        // The pane it was opened from survives a snapshot. A rebuild is the host answering an edit made inside this pane, not a fresh way in, so adding a model must not turn escape into "
        ...(state.parent === undefined ? {} : { parent: state.parent }),
        ...(state.canUndoPoolChange === true
            ? { canUndoPoolChange: true }
            : {}),
        selectedIndex: selectedIndex === -1
            ? Math.min(state.selectedIndex, Math.max(0, options.length - 1))
            : selectedIndex,
    };
}

export function mergeTuiModelPickerSettings(
    target: ModelTurnSettings | undefined,
    poolSource: ModelTurnSettings | undefined,
): ModelTurnSettings | undefined {
    if (target === undefined) return poolSource;
    if (poolSource?.pooled === undefined) return target;
    return { ...target, pooled: poolSource.pooled };
}

export function startTuiReasoningPicker(
    levels: readonly ReasoningLevel[],
    defaultLevel: ReasoningLevelId | undefined,
    currentReasoningEffort: ModelReasoningEffort | undefined,
    pendingModel: TuiPendingModelChoice | undefined = undefined,
): TuiSettingsPickerState {
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
        value: "context_limit",
        label: "Context limit",
        description: "maximum conversation context across models",
        searchText: "tokens window memory cap",
    },
    {
        value: "developer",
        label: "Developer",
        description: "overrides for testing Vera itself",
        searchText: "debug override compaction window",
    },
    {
        value: "permissions",
        label: "Permissions",
        description: "what Vera may run, and what you have approved",
        searchText: "grants approvals allowed",
    },
    {
        value: "reviewer",
        label: "Classifier",
        description: "which model classifies actions in auto mode",
        searchText: "approval auto review failsafe",
    },
    { value: "theme", label: "Theme", description: "TUI colors" },
];

const CONTEXT_LIMIT_OPTIONS: readonly TuiSettingsPickerOption[] = [
    { value: "auto", label: "Auto", description: "use each model's maximum" },
    { value: "131072", label: "128k", description: "smaller, more frequent summaries" },
    { value: "204800", label: "200k", description: "balanced context ceiling" },
    { value: "262144", label: "256k", description: "extended context" },
    { value: "524288", label: "512k", description: "large context" },
];

export function startTuiContextLimitPicker(
    current: number | undefined,
): TuiSettingsPickerState {
    return {
        kind: "context_limit",
        allOptions: CONTEXT_LIMIT_OPTIONS,
        options: CONTEXT_LIMIT_OPTIONS,
        selectedIndex: Math.max(
            0,
            CONTEXT_LIMIT_OPTIONS.findIndex((option) =>
                option.value === (current === undefined ? "auto" : String(current))
            ),
        ),
        query: "",
    };
}

interface DeveloperValueRow {
    readonly key: TuiDeveloperKey;
    readonly target: TuiSettingsMenuTarget;
    readonly label: string;
    readonly description: string;
    readonly options: readonly TuiSettingsPickerOption[];
    readonly format: (value: number) => string;
}

const DEVELOPER_VALUE_ROWS: readonly DeveloperValueRow[] = [
    {
        key: "contextLimit",
        target: "developer_context_limit",
        label: "Context limit",
        description: "windows below what the normal setting offers",
        format: (value) => `${Math.round(value / 1_024)}k`,
        options: [
            { value: "default", label: "Off", description: "use the normal context limit" },
            { value: "8192", label: "8k", description: "compacts within a few turns" },
            { value: "16384", label: "16k", description: "compacts within a short session" },
            { value: "32768", label: "32k", description: "compacts after real work" },
            { value: "65536", label: "64k", description: "smallest window a model is happy in" },
        ],
    },
    {
        key: "compactionTriggerFraction",
        target: "developer_compaction_trigger",
        label: "Compaction trigger",
        description: "share of the window that fires a compaction",
        format: (value) => value.toFixed(2),
        options: [
            { value: "default", label: "Off", description: "use the configured trigger" },
            { value: "0.3", label: "0.30", description: "fires early" },
            { value: "0.5", label: "0.50", description: "fires at half" },
            { value: "0.7", label: "0.70", description: "fires late" },
        ],
    },
    {
        key: "postCompactionTargetFraction",
        target: "developer_target_fraction",
        label: "Post-compaction target",
        description: "share of the window a summary lands under",
        format: (value) => value.toFixed(2),
        options: [
            { value: "default", label: "Off", description: "use the built-in 0.45" },
            { value: "0.2", label: "0.20", description: "a much smaller note" },
            { value: "0.45", label: "0.45", description: "what Vera ships with" },
            { value: "0.6", label: "0.60", description: "a longer note" },
        ],
    },
    {
        key: "summaryWordCap",
        target: "developer_summary_words",
        label: "Summary word cap",
        description: "the most words a note is asked for",
        format: (value) => String(value),
        options: [
            { value: "default", label: "Off", description: "use the built-in 3000" },
            { value: "250", label: "250", description: "short enough to read whole" },
            { value: "750", label: "750" , description: "a page" },
            { value: "3000", label: "3000", description: "what Vera ships with" },
        ],
    },
];

export function startTuiDeveloperMenu(
    developer: DeveloperSettings | undefined,
): TuiSettingsPickerState {
    const enabled = developer?.enabled === true;
    const options: TuiSettingsPickerOption[] = [{
        value: enabled ? "developer_enabled_off" : "developer_enabled_on",
        label: enabled ? "Turn off" : "Turn on",
        description: enabled
            ? "restore every normal setting at once"
            : "let the overrides below take effect",
    }];
    if (enabled) {
        for (const row of DEVELOPER_VALUE_ROWS) {
            const current = developer?.[row.key];
            options.push({
                value: row.target,
                label: row.label,
                description: current === undefined
                    ? row.description
                    : `${row.format(current)} · ${row.description}`,
            });
        }
    }
    return {
        kind: "developer_settings",
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
        title: "Developer",
        subtitle: enabled
            ? "overrides are in force"
            : "off: nothing here is read",
        ...(developer === undefined ? {} : { developerSettings: developer }),
    };
}

export function startTuiDeveloperValuePicker(
    target: TuiSettingsMenuTarget,
    developer: DeveloperSettings | undefined,
): TuiSettingsPickerState | undefined {
    const row = DEVELOPER_VALUE_ROWS.find(
        (candidate) => candidate.target === target,
    );
    if (row === undefined) {
        return undefined;
    }
    const current = developer?.[row.key];
    const value = current === undefined ? "default" : String(current);
    return {
        kind: "developer_value",
        allOptions: row.options,
        options: row.options,
        selectedIndex: Math.max(
            0,
            row.options.findIndex((option) => option.value === value),
        ),
        query: "",
        title: row.label,
        developerKey: row.key,
    };
}

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

export function startTuiProviderPicker(
    providers: readonly TuiProviderRow[],
    options: {
        readonly selected?: string;
        readonly subtitle?: string;
    } = {},
): TuiSettingsPickerState {
    const rows: TuiSettingsPickerOption[] = [...providers]
        .sort((left, right) =>
            TUI_PROVIDER_GROUP_RANK[left.group]
            - TUI_PROVIDER_GROUP_RANK[right.group]
        )
        .map((provider) => ({
            value: provider.id,
            label: provider.label,
            description: provider.hint ?? "",
            searchText: provider.id,
            group: provider.group,
            connected: provider.connected,
            ...(provider.refreshable === true ? { refreshable: true } : {}),
            ...(provider.declared === true ? { declared: true } : {}),
            ...(provider.endpointEditable === true
                ? { endpointEditable: true }
                : {}),
        }));
    const firstUnconnected = rows.findIndex(
        (option) => option.connected !== true,
    );
    const allOptions = [...rows, TUI_DECLARE_PROVIDER_OPTION];
    const named = options.selected === undefined
        ? -1
        : allOptions.findIndex((option) => option.value === options.selected);
    return {
        kind: "provider",
        allOptions,
        options: allOptions,
        selectedIndex: named >= 0 ? named : Math.max(0, firstUnconnected),
        query: "",
        ...(options.subtitle === undefined
            ? {}
            : { subtitle: options.subtitle }),
    };
}

export const TUI_DECLARE_PROVIDER_VALUE = "action:declare_provider";

const TUI_DECLARE_PROVIDER_OPTION: TuiSettingsPickerOption = {
    value: TUI_DECLARE_PROVIDER_VALUE,
    label: "Declare a provider…",
    description: "one Vera does not ship, by base URL",
    searchText: "declare custom new add provider",
    action: true,
};

export function withTuiPickerParent(
    state: TuiSettingsPickerState,
    parent: TuiSettingsPickerState | undefined,
): TuiSettingsPickerState {
    return parent === undefined ? state : { ...state, parent };
}

export function tuiPickerMenuAncestor(
    state: TuiSettingsPickerState,
): TuiSettingsPickerState | undefined {
    let current = state.parent;
    while (current !== undefined) {
        if (
            current.kind === "settings"
            || current.kind === "permission_settings"
            || current.kind === "reviewer_settings"
            || current.kind === "developer_settings"
        ) {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}

export function tuiPickerAfterSelection(
    selection: TuiSettingsPickerSelection,
    previous: TuiSettingsPickerState | undefined,
): TuiSettingsPickerState | undefined {
    if (selection.kind === "model" || previous === undefined) {
        return undefined;
    }
    if (
        selection.kind === "developer"
        && previous.kind === "developer_settings"
        && selection.patch.enabled !== undefined
    ) {
        return startTuiDeveloperMenu({
            ...previous.developerSettings,
            enabled: selection.patch.enabled,
        });
    }
    return tuiPickerMenuAncestor(previous);
}

export const REVIEWER_CLEAR_VALUE = "\u0000clear";

export const MODEL_ASSIGNMENT_BROWSE_VALUE = "\u0000browse";
export const MODEL_ASSIGNMENT_SELF_VALUE = "\u0000allow-self";

const MODEL_ASSIGNMENT_VALUE_PREFIX = "\u0000assignment:";

const SESSION_MODEL_VALUE = "\u0000session-model";
const MODEL_ACTION_VALUE_PREFIX = "\u0000action:";
const CONTEXT_LIMIT_VALUE = "\u0000context-limit";

export function tuiModelAssignmentValue(assignment: ModelAssignmentId): string {
    return `${MODEL_ASSIGNMENT_VALUE_PREFIX}${assignment}`;
}

export function tuiModelActionOptions(
    providers: readonly string[],
    options: {
        readonly hasPool?: boolean;
        readonly currentModel?: {
            readonly provider: string;
            readonly model: string;
            readonly shortlisted: boolean;
        };
    } = {},
): readonly TuiSettingsPickerOption[] {
    const rows: TuiSettingsPickerOption[] = [];
    if (options.currentModel?.shortlisted === false) {
        const current = options.currentModel;
        rows.push({
            value: tuiModelActionValue("shortlist_current"),
            label: "Add current model to shortlist",
            description: "enter",
            note:
                `Adds ${current.provider}/${current.model}, the model this conversation is using, to your shortlist.`,
            detailTitle: "add current model",
            detailFacts: [["Current model", `${current.provider}/${current.model}`]],
            searchText: `add pin keep current model shortlist ${current.provider} ${current.model}`,
            provider: current.provider,
            model: current.model,
            action: true,
        });
    }
    if (providers.length > 0) rows.push({
        value: tuiModelActionValue("refresh"),
        label: "Refresh model catalog from providers",
        description: tuiKeyHint("refresh_catalog").split(" ")[0] ?? "",
        note:
            "Asks the providers for their models again, so anything released since the last check shows up here. Which ones to ask comes next.",
        detailTitle: "refresh model catalog from providers",
        detailFacts: [],
        searchText: `refresh reload update fetch new models catalog ${
            providers.join(" ")
        }`,
    });
    if (options.hasPool === true) {
        rows.push({
            value: tuiModelActionValue("verify_pool"),
            label: "Verify shortlisted models",
            description: tuiKeyHint("verify_pool").split(" ")[0] ?? "",
            note:
                "Choose unverified models or the whole shortlist, then send one small request to each and mark the ones that answer.",
            detailTitle: "verify shortlist",
            detailFacts: [],
            searchText: "verify check test probe working broken shortlist pool",
        });
    }
    rows.push({
        value: tuiModelActionValue("reveal_all"),
        label: "Show or hide the rarely used models",
        description: tuiKeyHint("reveal_all_models").split(" ")[0] ?? "",
        note:
            "All models opens short by default. This is the switch between the short list and the whole catalog.",
        detailTitle: "show every model",
        detailFacts: [],
        searchText: "show hide all hidden folded every catalog reveal more",
    });
    rows.push({
        value: tuiModelActionValue("providers"),
        label: "Connect, edit or forget a provider",
        description: tuiKeyHint("open_providers").split(" ")[0] ?? "",
        note:
            "Opens the provider list, where keys and endpoints are set and a provider can be removed.",
        detailTitle: "providers",
        detailFacts: [],
        searchText:
            "provider providers connect add key api endpoint forget remove declare openrouter cerebras",
    });
    return rows;
}

function tuiModelActionValue(action: string): string {
    return `${MODEL_ACTION_VALUE_PREFIX}${action}`;
}

export function tuiModelActionOfValue(value: string): string | undefined {
    return value.startsWith(MODEL_ACTION_VALUE_PREFIX)
        ? value.slice(MODEL_ACTION_VALUE_PREFIX.length)
        : undefined;
}

function modelAssignmentOfValue(value: string): ModelAssignmentId | undefined {
    return value.startsWith(MODEL_ASSIGNMENT_VALUE_PREFIX)
        ? value.slice(MODEL_ASSIGNMENT_VALUE_PREFIX.length) as ModelAssignmentId
        : undefined;
}

export function tuiModelAssignmentOptions(
    rows: readonly ModelAssignmentRow[],
    sessionModel?: string,
    sessionReasoningEffort?: ModelReasoningEffort,
    contextLimit?: number,
): readonly TuiSettingsPickerOption[] {
    return [
        {
            value: SESSION_MODEL_VALUE,
            label: "model",
            group: "This session",
            description: "",
            note: "The model this session runs on. Press \u23ce to change it.",
            detailTitle: "session model",
            detailFacts: [[
                "Runs",
                sessionRunsFact(sessionModel, sessionReasoningEffort),
            ] as const],
            searchText: "session current model main",
        },
        {
            value: CONTEXT_LIMIT_VALUE,
            label: "context limit",
            description: "",
            group: "Global",
            note: "The global ceiling Vera applies across models. Press ⏎ to change it.",
            detailTitle: "context limit",
            detailFacts: [[
                "Limit",
                contextLimit === undefined
                    ? "Auto (model maximum)"
                    : formatContextLimitOption(contextLimit),
            ] as const],
            searchText: "context limit tokens window memory cap",
        },
        ...rows.map((row) => ({
            value: tuiModelAssignmentValue(row.assignment),
            label: row.label,
            description: assignmentStatusWord(row),
            group: isJobAssignmentId(row.assignment)
                ? "Dedicated jobs"
                : "Work styles",
            note: assignmentNote(row),
            detailTitle: row.label,
            detailFacts: assignmentFacts(row),
            searchText: `${row.assignment} ${row.label} ${row.intent}`,
        })),
    ];
}

function formatContextLimitOption(tokens: number): string {
    return tokens % 1_048_576 === 0
        ? `${tokens / 1_048_576}m`
        : `${Math.round(tokens / 1_024)}k`;
}

function sessionRunsFact(
    model: string | undefined,
    reasoningEffort: ModelReasoningEffort | undefined,
): string {
    if (model === undefined) return "not known";
    return reasoningEffort === undefined
        ? model
        : `${model} (${reasoningEffort})`;
}

function assignmentStatusWord(row: ModelAssignmentRow): string {
    if (row.assignment === "subagents") {
        if (row.declared.length === 0) {
            return row.allowSelf ? "parent fallback" : "not set";
        }
        if (row.declared.length === 1) {
            return `1 · ${row.declared[0]!.model}`;
        }
        return `${row.declared.length} models`;
    }
    if (row.bound) {
        return row.source === "assignment" ? "set" : "not shortlisted";
    }
    return row.inherits === undefined
        ? "uses session"
        : `uses ${row.inherits}`;
}

function assignmentRunsFact(row: ModelAssignmentRow): string {
    const running = row.models[0];
    if (running === undefined) {
        return row.assignment === "subagents"
            ? row.allowSelf === true ? "parent model" : "not configured"
            : "this session's model";
    }
    const named = running.reasoning_effort === undefined
        ? running.model
        : `${running.model} (${running.reasoning_effort})`;
    return row.source === "assignment"
        ? named
        : `${named} (via ${row.inherits ?? "this session"})`;
}

function assignmentFacts(
    row: ModelAssignmentRow,
): readonly (readonly [string, string])[] {
    const setTo = !row.bound
        ? "nothing"
        : row.route === undefined
        ? "a model picked here"
        : `route "${row.route}"`;
    const ifUnset = row.assignment === "subagents"
        ? "spawn is refused"
        : row.inherits === undefined
        ? "this session's model"
        : `whatever ${row.inherits} uses`;
    return [
        ["Runs", assignmentRunsFact(row)],
        ["Set to", setTo],
        ["If unset", ifUnset],
        ...(row.bound
            ? [[
                "Shortlisted",
                row.source === "assignment" ? "yes" : "no",
            ] as const]
            : []),
    ];
}

function assignmentNote(row: ModelAssignmentRow): string {
    const purpose = `${row.label}: ${row.intent}.`;
    if (!row.bound) {
        if (row.assignment === "subagents") {
            return `${purpose} Nothing is set here, so subagent spawns are refused.`;
        }
        if (row.inherits !== undefined) {
            return `${purpose} Nothing is set here, so it uses whatever ${row.inherits} uses.`;
        }
        return `${purpose} Nothing is set here, so it runs on this session's model.`;
    }
    if (row.source === "assignment") {
        return purpose;
    }
    const runs = `${row.inherits ?? "this session's model"} runs it instead`;
    return `${purpose} The model it is set to is not on your shortlist, so ${runs}.`
        + ` Add that model to your shortlist, or point ${row.label} at one that is.`;
}

function reviewerSlotLabel(selection?: ReviewerModelSelection): string {
    if (selection === undefined) return "not set";
    return selection.provider === undefined
        ? selection.model
        : `${selection.model} · ${selection.provider}`;
}

export function startTuiReviewerMenu(
    reviewerDefault?: ReviewerModelDefault,
): TuiSettingsPickerState {
    const agentModel = reviewerDefault?.mode !== "fixed";
    const options: readonly TuiSettingsPickerOption[] = [
        {
            value: "reviewer_primary",
            label: "Primary",
            description: agentModel
                ? "the agent's own model"
                : reviewerSlotLabel(reviewerDefault?.primary),
            searchText: "classifier reviewer approval auto",
        },
        {
            value: "reviewer_fallback",
            label: "Failsafe",
            description: reviewerSlotLabel(reviewerDefault?.fallback),
            searchText: "classifier reviewer fallback backup",
        },
    ];
    return {
        kind: "reviewer_settings",
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
    };
}

export function startTuiReviewerPicker(
    slot: TuiReviewerSlot,
    pooled: readonly PooledModel[] = [],
    current?: ReviewerModelSelection,
    availableModels: readonly SuggestedModel[] = [],
): TuiSettingsPickerState {
    const seen = new Set<string>();
    const rows: TuiSettingsPickerOption[] = [];
    for (const entry of [...pooled, ...availableModels]) {
        const value = `${entry.provider}/${entry.model}`;
        if (seen.has(value)) continue;
        seen.add(value);
        rows.push({
            value,
            label: ("poolName" in entry ? entry.poolName : undefined)
                ?? entry.label,
            description: entry.provider,
            provider: entry.provider,
            model: entry.model,
            searchText: `${entry.provider} ${entry.model}`,
        });
    }
    const clearRow: TuiSettingsPickerOption = {
        value: REVIEWER_CLEAR_VALUE,
        label: slot === "primary" ? "Use configured default" : "None",
        description: slot === "primary"
            ? "clear this override; use Defaults or the session model"
            : "no failsafe classifier",
    };
    const options = [clearRow, ...rows];
    const currentValue = current === undefined
        ? undefined
        : `${current.provider ?? ""}/${current.model}`;
    const selectedIndex = Math.max(
        0,
        options.findIndex((option) => option.value === currentValue),
    );
    return {
        kind: "reviewer",
        allOptions: options,
        options,
        selectedIndex,
        query: "",
        reviewerSlot: slot,
    };
}

export const POOL_VERIFY_UNVERIFIED_VALUE = "unverified";
export const POOL_VERIFY_ALL_VALUE = "all";

export function startTuiPoolVerifyScopePicker(
    unverified: number,
    total: number,
): TuiSettingsPickerState {
    const options: readonly TuiSettingsPickerOption[] = [
        {
            value: POOL_VERIFY_UNVERIFIED_VALUE,
            label: `Only the ones never probed (${unverified})`,
            description: "leaves what already answered alone",
        },
        {
            value: POOL_VERIFY_ALL_VALUE,
            label: `Everything on your shortlist (${total})`,
            description: "re-probes models that already answered",
        },
    ];
    return {
        kind: "pool_verify_scope",
        title: "Verify shortlisted models",
        subtitle: "each model is one live call to its provider",
        allOptions: options,
        options,
        selectedIndex: unverified === 0 ? 1 : 0,
        query: "",
    };
}

export const CATALOG_REFRESH_ALL_VALUE = "\u0000all";

export function startTuiCatalogRefreshScopePicker(
    providers: readonly { readonly name: string; readonly models: number }[],
): TuiSettingsPickerState {
    const total = providers.reduce((sum, entry) => sum + entry.models, 0);
    const rows: TuiSettingsPickerOption[] = providers.map((entry) => ({
        value: entry.name,
        label: entry.name,
        description: `${entry.models} in its catalog`,
    }));
    const options: readonly TuiSettingsPickerOption[] = providers.length < 2
        ? rows
        : [
            {
                value: CATALOG_REFRESH_ALL_VALUE,
                label: `Every provider (${providers.length})`,
                description: `${total} in their catalogs`,
            },
            ...rows,
        ];
    return {
        kind: "catalog_refresh_scope",
        title: "Refresh model catalog from providers",
        subtitle: "each provider is one call over the network",
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
    };
}

export function startTuiModelAssignmentPicker(
    assignment: ModelAssignmentId,
    label: string,
    intent: string,
    pooled: readonly PooledModel[] = [],
    currentModels: readonly string[] = [],
    allowSelf = false,
    parentModel?: TuiAssignmentParentModel,
    selectedValue?: string,
): TuiSettingsPickerState {
    const pooledByRef = new Map(
        pooled.map((entry) => [`${entry.provider}/${entry.model}`, entry]),
    );
    const optionFor = (
        value: string,
        group: string,
        position?: number,
    ): TuiSettingsPickerOption => {
        const entry = pooledByRef.get(value);
        const slash = value.indexOf("/");
        const provider = entry?.provider ?? value.slice(0, slash);
        const model = entry?.model ?? value.slice(slash + 1);
        const modelLabel = entry?.poolName ?? entry?.label ?? model;
        return {
            value,
            label: position === undefined
                ? modelLabel
                : `${position}. ${modelLabel}`,
            description: provider,
            provider,
            model,
            group,
            searchText: `${provider} ${model}`,
        };
    };
    const assignedGroup = "Assigned · fallback order";
    const assigned = currentModels.map((value, index) =>
        optionFor(value, assignedGroup, index + 1));
    const assignedRefs = new Set(currentModels);
    const seen = new Set<string>();
    const available: TuiSettingsPickerOption[] = [];
    const standardRows: TuiSettingsPickerOption[] = [];
    for (const entry of pooled) {
        const value = `${entry.provider}/${entry.model}`;
        if (seen.has(value)) continue;
        seen.add(value);
        standardRows.push({
            value,
            label: entry.poolName ?? entry.label,
            description: entry.provider,
            ...(currentModels.includes(value)
                ? {
                    rowMeta: [{
                        text: `assigned ${currentModels.indexOf(value) + 1}`,
                        tone: "positive" as const,
                    }],
                }
                : {}),
            provider: entry.provider,
            model: entry.model,
            searchText: `${entry.provider} ${entry.model}`,
        });
        if (assignedRefs.has(value)) continue;
        available.push(optionFor(value, "Available from Shortlist"));
    }
    const clearRow: TuiSettingsPickerOption = {
        value: REVIEWER_CLEAR_VALUE,
        label: "Not set",
        description: allowSelf
            ? "no assigned models · parent fallback only"
            : unsetAssignmentMeans(assignment),
        group: assignedGroup,
    };
    const browseRow: TuiSettingsPickerOption = {
        value: MODEL_ASSIGNMENT_BROWSE_VALUE,
        label: "Add another model…",
        description: `manage ${modelTabLabel("pool")}`,
        group: "Shortlist",
    };
    const selfRow: TuiSettingsPickerOption = {
        value: MODEL_ASSIGNMENT_SELF_VALUE,
        label: "Spawning session model",
        description: allowSelf ? "on" : "off",
        card: true,
        rowMeta: parentModel === undefined
            ? "resolved from each spawning session"
            : `currently ${parentModel.provider === undefined
                ? parentModel.model
                : `${parentModel.provider}/${parentModel.model}`}`,
        group: "Parent model fallback",
        note: "When on, each spawning session's own model is tried after every assigned model.",
    };
    const options = assignment === "subagents"
        ? [
            ...(assigned.length === 0 ? [clearRow] : assigned),
            ...available,
            selfRow,
            browseRow,
        ]
        : [clearRow, ...standardRows, browseRow];
    const selectedIndex = selectedValue === undefined
        ? 0
        : Math.max(0, options.findIndex((option) => option.value === selectedValue));
    return {
        kind: "model_assignment",
        title: assignment === "subagents"
            ? "Subagent models"
            : `Assign a model to ${label}`,
        subtitle: assignment === "subagents"
            ? "Models subagents may use, in fallback order."
            : intent,
        allOptions: options,
        options,
        selectedIndex,
        query: "",
        modelAssignment: assignment,
        ...(assignment === "subagents" ? {
            assignedModels: currentModels,
            assignmentAllowsSelf: allowSelf,
        } : {}),
    };
}

function unsetAssignmentMeans(assignment: ModelAssignmentId): string {
    if (assignment === "subagents") return "subagent spawns are refused";
    return isJobAssignmentId(assignment)
        ? `uses ${JOB_ASSIGNMENT_INTENTS[assignment] ?? "this session's model"}`
        : "uses this session's model";
}

function settingsMenuOptions(
    developer: DeveloperSettings | undefined,
): readonly TuiSettingsPickerOption[] {
    if (developer?.enabled !== true) {
        return SETTINGS_MENU_OPTIONS;
    }
    return SETTINGS_MENU_OPTIONS.map((option) =>
        option.value === "developer"
            ? { ...option, description: "on: overrides are in force" }
            : option
    );
}

export function startTuiSettingsMenu(
    kind: TuiSettingsMenuKind,
    developer?: DeveloperSettings,
): TuiSettingsPickerState {
    const options = kind === "settings"
        ? settingsMenuOptions(developer)
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
    includeUntitled = false,
    sharedAgentGroups: readonly (readonly [string, string])[] = [],
    enterDisposition: TuiSessionLeaveDisposition = "stop",
    nothingToLeave = false,
): TuiSettingsPickerState {
    const options = agents
        .filter((agent) => sessionPickerLists(agent, includeUntitled))
        .toSorted((left, right) =>
            (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
        )
        .map((agent) => ({
            value: agent.session_path,
            label: sessionTitle(agent.title ?? agent.id),
            description: "",
            searchText: `${agent.id} ${agent.workspace}`,
            sessionId: agent.id,
            ...(agent.title === undefined ? {} : { sessionName: agent.title }),
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
    const threaded = markSharedSessionOptions(
        threadSessionOptions(options),
        sharedAgentGroups,
    );
    return {
        kind: "session",
        allOptions: threaded,
        options: threaded,
        selectedIndex: 0,
        query: "",
        loading,
        ...(enterDisposition === "keep_running"
            ? { enterDisposition }
            : {}),
        ...(nothingToLeave ? { nothingToLeave } : {}),
    };
}

function markSharedSessionOptions(
    options: readonly TuiSettingsPickerOption[],
    sharedAgentGroups: readonly (readonly [string, string])[],
): readonly TuiSettingsPickerOption[] {
    let result = [...options];
    sharedAgentGroups.forEach(([firstId, secondId], groupIndex) => {
        const first = result.findIndex((option) => option.sessionId === firstId);
        const second = result.findIndex((option) => option.sessionId === secondId);
        if (first === -1 || second === -1) return;
        const start = Math.min(first, second);
        const end = Math.max(first, second);
        const group = `shared-${groupIndex}`;
        const pair = [
            { ...result[start]!, sharedEdge: "start" as const, sharedGroup: group },
            { ...result[end]!, sharedEdge: "end" as const, sharedGroup: group },
        ];
        result = [
            ...result.slice(0, start),
            ...pair,
            ...result.slice(start + 1, end),
            ...result.slice(end + 1),
        ];
    });
    return result;
}

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
        ...(row.current === true ? { current: true } : {}),
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
    if (key.name === "d") return "d";
    if (key.name === "s") return "s";
    if (key.name === "delete") return "delete";
    if (key.name === "backspace") return "backspace";
    return undefined;
}

const SESSION_WORKSPACE_CELLS = 14;

const SESSION_TITLE_LIMIT = 200;

function threadSessionOptions(
    options: readonly TuiSettingsPickerOption[],
): TuiSettingsPickerOption[] {
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
    return agent.live ? "open" : relativeTime(agent.updated_at, now, "saved");
}

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
                    ...(selected.sessionName === undefined
                        ? {}
                        : { value: selected.sessionName }),
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
    if (
        state.kind === "session"
        && tuiBindingId("session_picker", key) === "background_switch"
    ) {
        const selected = state.options[state.selectedIndex];
        return selected === undefined
            ? unchanged(state, true)
            : {
                selection: {
                    kind: "session",
                    sessionPath: selected.value,
                    sourceDisposition: "keep_running",
                    ...(selected.sessionId === undefined
                        ? {}
                        : { sessionId: selected.sessionId }),
                },
                handled: true,
            };
    }
    if (
        state.kind === "model_assignment"
        && state.modelAssignment === "subagents"
        && tuiBindingId("model_assignment_picker", key)
            === "toggle_subagent_assignment"
    ) {
        const selected = state.options[state.selectedIndex];
        if (
            selected === undefined
            || selected.value === REVIEWER_CLEAR_VALUE
            || selected.value === MODEL_ASSIGNMENT_BROWSE_VALUE
        ) {
            return unchanged(state, true);
        }
        return {
            state,
            selection: {
                ...pickerSelection(state, selected),
                ...(state.assignedModels?.includes(selected.value) === true
                    || selected.value === MODEL_ASSIGNMENT_SELF_VALUE
                    ? {}
                    : { acceptDefaultReasoning: true as const }),
            },
            handled: true,
        };
    }
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
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "undo_pool_change"
    ) {
        return state.canUndoPoolChange === true
            ? { state, handled: true, undoPoolChange: true }
            : unchanged(state, true);
    }
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
    if (
        state.kind === "model"
        && (tuiBindingId("model_picker", key) === "move_pooled_up"
            || tuiBindingId("model_picker", key) === "move_pooled_down")
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
            poolMove: {
                provider: selected.provider,
                model: selected.model,
                delta: tuiBindingId("model_picker", key) === "move_pooled_up"
                    ? -1
                    : 1,
            },
        };
    }
    if (
        (state.kind === "model" || state.kind === "provider")
        && tuiBindingId("model_picker", key) === "refresh_catalog"
    ) {
        const selected = state.options[state.selectedIndex];
        const provider = state.kind === "provider"
            ? (selected?.action === true ? undefined : selected?.value)
            : selected?.provider;
        if (provider === undefined || selected?.refreshable !== true) {
            return unchanged(state, true);
        }
        return { state, handled: true, refreshCatalog: provider };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "verify_pool"
    ) {
        return { state, handled: true, poolVerifySweep: true };
    }
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
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "reveal_all_models"
    ) {
        const modelState = state as TuiSettingsPickerState;
        const revealAll = modelState.revealAll !== true;
        const options = modelListFor(modelState, { revealAll });
        const selectedValue = modelState.options[modelState.selectedIndex]
            ?.value;
        return {
            state: {
                ...modelState,
                revealAll,
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
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "open_providers"
    ) {
        return { state, handled: true, openProviders: true };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "switch_tab"
    ) {
        const cycle: readonly TuiModelPickerTab[] = [
            "pool",
            "all",
            "actions",
            "defaults",
            "help",
        ];
        const at = cycle.indexOf(state.tab ?? "all");
        if (key.shift === true) {
            if (at === 0) {
                return {
                    state: switchedModelTab(state, cycle.at(-1)!),
                    handled: true,
                    openProviders: true,
                };
            }
            return {
                state: switchedModelTab(state, cycle[at - 1] ?? cycle.at(-1)!),
                handled: true,
            };
        }
        if (at === cycle.length - 1) {
            return {
                state: switchedModelTab(state, cycle[0]!),
                handled: true,
                openProviders: true,
            };
        }
        return {
            state: switchedModelTab(state, cycle[at + 1] ?? cycle[0]!),
            handled: true,
        };
    }
    if (
        state.kind === "provider"
        && state.parent?.kind === "model"
        && tuiBindingId("model_picker", key) === "switch_tab"
    ) {
        return {
            state: key.shift === true
                ? switchedModelTab(state.parent, "help")
                : state.parent,
            handled: true,
        };
    }
    if (
        state.kind === "provider"
        && tuiBindingId("model_picker", key) === "declare_provider"
    ) {
        return { state, handled: true, declareProvider: true };
    }
    if (
        state.kind === "provider"
        && tuiBindingId("model_picker", key) === "edit_endpoint"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected?.endpointEditable !== true) {
            return unchanged(state, true);
        }
        return selected.declared === true
            ? { state, handled: true, editProvider: selected.value }
            : { state, handled: true, editEndpoint: selected.value };
    }
    if (
        state.kind === "provider"
        && tuiBindingId("model_picker", key) === "forget_provider"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected === undefined || selected.action === true) {
            return unchanged(state, true);
        }
        return { state, handled: true, forgetProvider: selected.value };
    }
    if (state.kind === "model" && state.modelFocus === "page") {
        const actions = modelPageActions(state);
        const selected = Math.min(
            state.modelPageIndex ?? 0,
            Math.max(0, actions.length - 1),
        );
        if (key.name === "left" || key.name === "escape") {
            return {
                state: { ...state, modelFocus: "page_entry" },
                handled: true,
            };
        }
        if (key.name === "up" || key.name === "down") {
            const delta = key.name === "up" ? -1 : 1;
            return {
                state: {
                    ...state,
                    modelPageIndex: Math.max(
                        0,
                        Math.min(actions.length - 1, selected + delta),
                    ),
                },
                handled: true,
            };
        }
        if (key.name === "return" || key.name === "enter") {
            const transition = modelActionTransition(state, actions[selected]!);
            return transition ?? unchanged(state, true);
        }
        if (key.name === "right") {
            return unchanged(state, true);
        }
        if ((key.name.length === 1 || key.name === "space") && !key.ctrl) {
            return unchanged(state, true);
        }
    }
    if (state.kind === "model" && state.modelFocus === "page_entry") {
        if (
            key.name === "right" || key.name === "return"
            || key.name === "enter"
        ) {
            return modelPageActions(state).length === 0
                ? unchanged(state, true)
                : {
                    state: { ...state, modelFocus: "page", modelPageIndex: 0 },
                    handled: true,
                };
        }
        if (key.name === "escape") {
            return {
                state: { ...state, modelFocus: "list", selectedIndex: 0 },
                handled: true,
            };
        }
        if (key.name === "down") {
            return {
                state: {
                    ...state,
                    modelFocus: showsIntelligenceCutoff(state)
                        ? "intelligence"
                        : "list",
                    selectedIndex: 0,
                },
                handled: true,
            };
        }
        if (key.name === "up" || key.name === "left") {
            return unchanged(state, true);
        }
    }
    if (state.kind === "model" && state.modelFocus === "intelligence") {
        if (key.name === "left" || key.name === "right") {
            const intelligenceCutoff = stepIntelligenceCutoff(
                state.intelligenceCutoff ?? "any",
                key.name === "right" ? 1 : -1,
            );
            const options = modelListFor(state, { intelligenceCutoff });
            return {
                state: {
                    ...state,
                    intelligenceCutoff,
                    options,
                    selectedIndex: restoredCursor(
                        options,
                        state.options[state.selectedIndex]?.value,
                        state.initialModel,
                    ),
                },
                handled: true,
            };
        }
        if (key.name === "down") {
            return {
                state: { ...state, modelFocus: "list" },
                handled: true,
            };
        }
        if (key.name === "up") {
            return modelPageEntry(state) === undefined
                ? unchanged(state, true)
                : {
                    state: { ...state, modelFocus: "page_entry" },
                    handled: true,
                };
        }
    }
    if (state.kind === "model" && state.modelFocus === "detail") {
        const actions = modelDetailActions(
            state,
            state.options[state.selectedIndex],
        );
        const selectedAction = modelActionCursor(state, actions);
        if (key.name === "left") {
            return {
                state: { ...state, modelFocus: "list" },
                handled: true,
            };
        }
        if (key.name === "right") {
            return unchanged(state, true);
        }
        if (key.name === "up" || key.name === "down") {
            const delta = key.name === "up" ? -1 : 1;
            return {
                state: {
                    ...state,
                    modelActionIndex: Math.max(
                        0,
                        Math.min(actions.length - 1, selectedAction + delta),
                    ),
                },
                handled: true,
            };
        }
        if (key.name === "return" || key.name === "enter") {
            return modelDetailActionTransition(state, actions[selectedAction]);
        }
        if ((key.name.length === 1 || key.name === "space") && !key.ctrl) {
            return unchanged(state, true);
        }
    }
    if (state.kind === "model" && state.modelFocus === "list_action") {
        if (key.name === "up") {
            return {
                state: { ...state, modelFocus: "list" },
                handled: true,
            };
        }
        if (key.name === "down" || key.name === "left") {
            return unchanged(state, true);
        }
        if (key.name === "right") {
            const actions = modelDetailActions(
                state,
                state.options[state.selectedIndex],
            );
            return actions.length === 0
                ? unchanged(state, true)
                : {
                    state: {
                        ...state,
                        modelFocus: "detail",
                        modelActionIndex: 0,
                    },
                    handled: true,
                };
        }
        if (key.name === "return" || key.name === "enter") {
            return modelListActionTransition(state, modelListAction(state));
        }
        if ((key.name.length === 1 || key.name === "space") && !key.ctrl) {
            return unchanged(state, true);
        }
    }
    const foldAll = state.kind !== "model"
        ? undefined
        : tuiBindingId("model_picker", key);
    if (foldAll === "collapse_all" || foldAll === "expand_all") {
        const collapsed = foldAll === "collapse_all"
            ? sectionLabels(state as TuiSettingsPickerState)
            : [];
        const modelState = state as TuiSettingsPickerState;
        const options = modelListFor(modelState, { collapsed });
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
        const preview = state.kind === "theme" && state.initialTheme !== undefined
            ? { previewTheme: state.initialTheme }
            : {};
        if (state.parent !== undefined) {
            return { state: state.parent, handled: true, ...preview };
        }
        return { handled: true, ...preview };
    }
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
        state.kind === "model_assignment"
        && state.modelAssignment === "subagents"
        && (key.name.length === 1 || key.name === "space")
    ) {
        return unchanged(state, true);
    }
    if (key.name.length === 1 || key.name === "space") {
        return unchanged(state, true);
    }
    if (key.name === "left" || key.name === "right") {
        if (
            state.kind === "model"
            && key.name === "right"
            && state.options[state.selectedIndex]?.section === undefined
        ) {
            const actions = modelDetailActions(
                state,
                state.options[state.selectedIndex],
            );
            if (actions.length > 0) {
                return {
                    state: {
                        ...state,
                        modelFocus: "detail",
                        modelActionIndex: 0,
                    },
                    handled: true,
                };
            }
        }
        const heading = enclosingSection(state);
        if (heading === undefined) {
            return unchanged(state, false);
        }
        const closed = heading.sectionCollapsed === true;
        if (closed === (key.name === "left")) {
            return unchanged(state, true);
        }
        return toggledSection(state, heading.section);
    }
    if (key.name === "up") {
        if (
            state.kind === "model"
            && state.selectedIndex === 0
            && (state.modelFocus ?? "list") === "list"
            && showsIntelligenceCutoff(state)
        ) {
            return {
                state: { ...state, modelFocus: "intelligence" },
                handled: true,
            };
        }
        if (
            state.kind === "model"
            && state.selectedIndex === 0
            && (state.modelFocus ?? "list") === "list"
            && modelPageEntry(state) !== undefined
        ) {
            return {
                state: { ...state, modelFocus: "page_entry" },
                handled: true,
            };
        }
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
        if (
            state.kind === "model"
            && state.selectedIndex === state.options.length - 1
            && modelListAction(state) !== undefined
        ) {
            return {
                state: { ...state, modelFocus: "list_action" },
                handled: true,
            };
        }
        const next = {
                ...state,
                selectedIndex: Math.max(
                    0,
                    Math.min(
                        state.options.length - 1,
                        state.selectedIndex + 1,
                    ),
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
        if (state.kind === "provider" && selected.action === true) {
            return { state, handled: true, declareProvider: true };
        }
        if (state.kind === "provider" && selected.declared === true) {
            return { state, handled: true, editProvider: selected.value };
        }
        const action = state.kind === "model"
            ? modelActionTransition(state as TuiSettingsPickerState, selected)
            : undefined;
        if (action !== undefined) {
            return action;
        }
        if (state.kind === "model" && selected.value === SESSION_MODEL_VALUE) {
            return {
                state: switchedModelTab(state as TuiSettingsPickerState, "all"),
                handled: true,
            };
        }
        return {
            selection: pickerSelection(state, selected),
            handled: true,
        };
    }
    return unchanged(state, false);
}

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

export function updateTuiSettingsPickerSearch(
    state: TuiSettingsPickerState,
    query: string,
    cursor = query.length,
): TuiSettingsPickerTransition {
    return pickerIsSearchable(state)
        ? searched(state, query, cursor)
        : unchanged(state, false);
}

export function createTuiSettingsPickerView(
    renderer: RenderContext,
): TuiSettingsPickerView {
    let nodes: Renderable[] = [];
    let searchLive = false;
    const search = createDialogSearchNode(renderer, "settings-picker-search");
    const box = new BoxRenderable(renderer, {
        id: "settings-picker",
        // No borderColor here. OpenTUI's BoxRenderable constructor reads any border styling option as "this box wants a border" and overrides an explicit `border: false`, so passing a.
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: dialogInsetTop(renderer),
        left: "10%",
        width: "80%",
        height: 8,
        zIndex: DIALOG_CARD_Z_INDEX,
        paddingLeft: DIALOG_CARD_PADDING,
        paddingRight: DIALOG_CARD_PADDING,
        paddingTop: 2,
        paddingBottom: 1,
        focusable: true,
        visible: false,
    });
    registerDialogCard(box);

    const view: TuiSettingsPickerView = {
        box,
        focus(): void {
            if (searchLive) search.focus();
            else box.focus();
        },
        handleEditorKey(state, key): TuiSettingsPickerTransition {
            if (
                !pickerIsSearchable(state)
                || (state.kind === "model" && state.tab === "help")
                || key.name === "escape" || key.name === "up"
                || key.name === "down" || key.name === "return"
                || key.name === "enter" || key.name === "kpenter"
                || tuiBindingId("picker", key) !== undefined
                || (state.kind === "model"
                    && tuiBindingId("model_picker", key) !== undefined)
                || (state.kind === "session"
                    && tuiBindingId("session_picker", key) !== undefined)
                || (state.query.length === 0
                    && (key.name === "left" || key.name === "right"))
                || (digitQuickSelect(state) && state.query === ""
                    && /^[1-9]$/.test(key.name))
            ) {
                return unchanged(state, false);
            }
            if (!search.handleKeyPress(tuiTextareaKey(key))) {
                return unchanged(state, false);
            }
            return updateTuiSettingsPickerSearch(
                state,
                search.plainText,
                search.cursorOffset,
            );
        },
        handleEditorPaste(state, text): TuiSettingsPickerTransition {
            if (
                !pickerIsSearchable(state)
                || (state.kind === "model" && state.tab === "help")
            ) {
                return unchanged(state, false);
            }
            insertTuiSingleLinePaste(search, text);
            return updateTuiSettingsPickerSearch(
                state,
                search.plainText,
                search.cursorOffset,
            );
        },
        update(state, railInset = 0): void {
            search.parent?.remove(search.id);
            for (const node of nodes) {
                node.destroyRecursively();
            }
            nodes = [];
            searchLive = state.kind !== "extension"
                && pickerIsSearchable(state)
                && !(state.kind === "model" && state.tab === "help");
            box.title = undefined;
            if (state.kind === "theme") {
                box.paddingTop = 2;
                box.paddingBottom = 1;
                box.top = themePickerTop(renderer, state.allOptions.length);
                box.left = "20%";
                box.width = "60%";
                box.height = "auto";
                renderThemePickerRows(
                    renderer,
                    box,
                    state,
                    nodes,
                    search,
                    view.pointer,
                );
                return;
            }
            box.top = state.kind === "session" ? 0 : dialogInsetTop(renderer);
            box.left = state.kind === "session" ? 0 : "10%";
            box.width = state.kind === "session" ? "100%" : "80%";
            renderListPickerRows(
                renderer,
                box,
                state,
                nodes,
                view.pointer,
                view.tip,
                view.verification,
                view.onTab,
                view.onConfigure,
                search,
                railInset,
            );
        },
    };
    return view;
}

const FALLBACK_JUMP = 5;

function pickerMaxRows(
    renderer: RenderContext,
    extraChrome: number,
    rowLines = 1,
): number {
    const lines = listWindowRows(
        dialogBoxHeight(
            renderer,
            dialogInsetTop(renderer),
            dialogInsetBottomOffset(renderer),
        ),
        DIALOG_CHROME_HEIGHT + extraChrome,
    );
    return Math.max(LIST_MIN_ROWS, Math.floor(lines / rowLines));
}

const THEME_CARD_CHROME_LINES = 9;

function themePickerTop(renderer: RenderContext, themeRows: number): number {
    const height = themeRows + THEME_CARD_CHROME_LINES;
    return Math.max(
        APP_PADDING_TOP,
        Math.min(
            dialogInsetTop(renderer),
            renderer.height - APP_PADDING_BOTTOM - height,
        ),
    );
}

export function tuiPickerViewportRows(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    extraChrome = 0,
): number {
    const stripHeight = modelStripStop(state) === undefined
        ? 0
        : modelTabStripHeight(pickerContentWidth(renderer, state));
    const listedHeaderLines = showsListedFactsHeader(state)
            && state.options.length > 0
        ? 1
        : 0;
    const intelligenceLines = showsIntelligenceCutoff(state)
        ? INTELLIGENCE_SCALE_LINES
        : 0;
    const allModelsInfoLines = showsAllModelsPrices(state)
        ? allModelsPriceChromeLines()
        : 0;
    const rows = pickerMaxRows(
        renderer,
        stripHeight
            + (state.kind === "extension" && state.subtitle !== undefined ? 1 : 0)
            + listedHeaderLines
            + intelligenceLines
            + allModelsInfoLines
            + extraChrome,
    );
    return state.kind === "model" && state.tab === "all"
        ? Math.min(rows, MODEL_ALL_MAX_ROWS)
        : rows;
}

function hasModelDetail(state: TuiAnySettingsPickerState): boolean {
    const tab = state.kind === "model" ? state.tab ?? "all" : undefined;
    return tab === "pool" || tab === "defaults" || tab === "actions";
}

const MODEL_DETAIL_MIN_WIDTH = 30;

const MODEL_LIST_MIN_WIDTH = 28;

const MODEL_DETAIL_RULE = "│  ";

const MODEL_LIST_RULE_GAP = 2;

interface ModelPaneSplit {
    readonly listWidth: number;
    readonly detailWidth: number;
}

function modelPaneSplit(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    railInset = 0,
): ModelPaneSplit | undefined {
    if (!hasModelDetail(state)) {
        return undefined;
    }
    const cardWidth = pickerCardWidth(renderer, state, railInset);
    const detailWidth = Math.max(
        MODEL_DETAIL_MIN_WIDTH,
        Math.floor(cardWidth * 0.32),
    );
    const listWidth = cardWidth - detailWidth - MODEL_DETAIL_RULE.length;
    return listWidth < MODEL_LIST_MIN_WIDTH
        ? undefined
        : { listWidth, detailWidth };
}

function pickerContentWidth(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    railInset = 0,
): number {
    return Math.max(
        0,
        pickerCardWidth(renderer, state, railInset) - DIALOG_GUTTER_WIDTH,
    );
}

function pickerCardWidth(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    railInset = 0,
): number {
    const usableWidth = Math.max(0, renderer.width - railInset);
    const cardWidth = state.kind === "session"
        ? usableWidth
        : Math.floor(usableWidth * 0.8);
    return Math.max(0, cardWidth - DIALOG_CARD_PADDING * 2);
}

type PickerDisplayRow =
    | { readonly kind: "group"; readonly label: string }
    | {
        readonly kind: "option";
        readonly option: TuiSettingsPickerOption;
        readonly index: number;
    };

function stackedBelowListLines(
    state: TuiAnySettingsPickerState,
    width: number,
): number {
    if (state.kind === "model" && state.modelFocus === "page") {
        return 2 + modelPageActions(state).length;
    }
    const option = state.options[state.selectedIndex];
    if (state.kind === "model" && state.tab === "all") {
        return 0;
    }
    const actions = modelDetailActions(state, option);
    return stackedDetailLines(state, option, width).length
        + (actions.length === 0 ? 0 : 2 + actions.length);
}

function stackedDetailLines(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption | undefined,
    width: number,
): readonly (readonly TextChunk[])[] {
    if (
        state.kind === "model"
        && state.tab === "all"
    ) {
        return [];
    }
    if (
        state.kind !== "model" || state.tab !== "defaults"
        || option?.detailFacts === undefined
    ) {
        return [];
    }
    const lines: (readonly TextChunk[])[] = [[]];
    for (const [label, value] of option.detailFacts) {
        lines.push([fg(TUI_MUTED)(label)]);
        lines.push([fg(TUI_TEXT)(clippedTo(value, width))]);
    }
    lines.push([]);
    for (const text of wrappedTo(option.note ?? "", width)) {
        lines.push([fg(TUI_MUTED)(text)]);
    }
    return lines;
}

function stackedListedPriceLines(
    option: TuiSettingsPickerOption | undefined,
    width: number,
): readonly (readonly TextChunk[])[] {
    const full = formatListedRates(option?.pricing);
    const blended = formatBlendedRate(option?.pricing);
    const images = option?.images === true ? "i" : "";
    const row = (label: string, value: string): readonly TextChunk[] => {
        const pad = Math.max(1, 16 - label.length);
        return [
            fg(TUI_MUTED)(label),
            fg(TUI_TEXT)(`${" ".repeat(pad)}${clippedTo(value, width - 16)}`),
        ];
    };
    return [
        [fg(TUI_TEXT)(clippedTo(option?.label ?? "", width))],
        row("Full price", full ?? ""),
        row("Blended price", blended === undefined ? "" : `${blended}  7:2:1`),
        row("Images", images),
    ];
}

function allModelsPriceNode(
    renderer: RenderContext,
    option: TuiSettingsPickerOption | undefined,
    width: number,
): BoxRenderable {
    return ALL_MODELS_PRICE_CHROME === "fill"
        ? allModelsPriceFillNode(renderer, option, width)
        : allModelsPriceBorderNode(renderer, option, width);
}

function allModelsPriceFillNode(
    renderer: RenderContext,
    option: TuiSettingsPickerOption | undefined,
    width: number,
): BoxRenderable {
    const box = new BoxRenderable(renderer, {
        width,
        height: ALL_MODELS_PRICE_FACTS + 2 * ALL_MODELS_PRICE_PAD,
        marginTop: ALL_MODELS_PRICE_MARGIN,
        marginBottom: ALL_MODELS_PRICE_MARGIN,
        flexShrink: 0,
        flexDirection: "column",
        border: false,
        backgroundColor: TUI_INPUT,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: ALL_MODELS_PRICE_PAD,
        paddingBottom: ALL_MODELS_PRICE_PAD,
    });
    const innerWidth = Math.max(1, width - 2);
    for (const chunks of stackedListedPriceLines(option, innerWidth)) {
        box.add(new TextRenderable(renderer, {
            content: new StyledText([...chunks]),
            bg: TUI_INPUT,
            width: "100%",
            height: 1,
        }));
    }
    return box;
}

function allModelsPriceBorderNode(
    renderer: RenderContext,
    option: TuiSettingsPickerOption | undefined,
    width: number,
): BoxRenderable {
    const box = new BoxRenderable(renderer, {
        width,
        height: ALL_MODELS_PRICE_FACTS,
        marginTop: ALL_MODELS_PRICE_MARGIN,
        marginBottom: ALL_MODELS_PRICE_MARGIN,
        flexShrink: 0,
        flexDirection: "column",
        border: false,
        backgroundColor: TUI_PANEL,
    });
    const innerWidth = Math.max(1, width - 2);
    for (const chunks of stackedListedPriceLines(option, innerWidth)) {
        box.add(new TextRenderable(renderer, {
            content: new StyledText([
                fg(TUI_ELEMENT)("│ "),
                ...chunks,
            ]),
            width,
            height: 1,
        }));
    }
    return box;
}

function modelDetailNode(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    width: number,
    height: number,
    pointer?: DialogRowPointer,
): BoxRenderable {
    const pane = new BoxRenderable(renderer, {
        width: width + MODEL_DETAIL_RULE.length,
        height,
        flexShrink: 0,
        flexDirection: "column",
    });
    let drawn = 0;
    const line = (
        chunks: readonly TextChunk[] = [],
        pointerIndex?: number,
        limit = height,
    ): void => {
        if (drawn >= height || drawn >= limit) return;
        drawn += 1;
        const node = new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_ELEMENT)(MODEL_DETAIL_RULE), ...chunks]),
            width: width + MODEL_DETAIL_RULE.length,
            height: 1,
        });
        if (pointerIndex !== undefined) {
            attachDialogRowPointer(node, pointer, pointerIndex);
        }
        pane.add(node);
    };
    if (state.kind === "model" && state.modelFocus === "page") {
        const actions = modelPageActions(state);
        const selected = Math.min(
            state.modelPageIndex ?? 0,
            Math.max(0, actions.length - 1),
        );
        line([fg(TUI_TEXT)(clippedTo("More", width))]);
        line();
        actions.forEach((action, index) => {
            line(
                modelActionLineChunks(
                    {
                        label: action.label,
                        chord: action.description ?? "",
                    },
                    width,
                    index === selected,
                ),
                -2 - index,
            );
        });
        return pane;
    }
    const option = state.options[state.selectedIndex];
    if (
        state.kind === "model"
        && (state.tab === "pool" || state.tab === "all")
        && state.options.length === 0
    ) {
        const [title] = modelEmptyMessage(state).split(". ");
        line([fg(TUI_TEXT)(clippedTo(`${title}.`, width))]);
        line();
        for (const text of modelEmptyDetailBody(state, width)) {
            line([fg(TUI_MUTED)(text)]);
        }
        return pane;
    }
    const described = option !== undefined && option.section === undefined;
    if (described && option.detailFacts !== undefined) {
        line([fg(TUI_TEXT)(clippedTo(option.detailTitle ?? "", width))]);
        line();
        for (const [label, value] of option.detailFacts) {
            line([fg(TUI_MUTED)(label)]);
            line([fg(TUI_TEXT)(clippedTo(value, width))]);
        }
        line();
        for (const text of wrappedTo(option.note ?? "", width)) {
            line([fg(TUI_MUTED)(text)]);
        }
        while (drawn < height) {
            line();
        }
        return pane;
    }
    if (described) {
        const actions = modelDetailActions(state, option);
        const factLimit = Math.max(
            0,
            height - (actions.length === 0 ? 0 : actions.length + 1),
        );
        line(
            [fg(TUI_TEXT)(clippedTo(option.label, width))],
            undefined,
            factLimit,
        );
        line([
            fg(TUI_MUTED)(clippedTo(
                option.model === undefined || option.poolName === undefined
                    ? option.provider ?? ""
                    : `${option.provider ?? ""} · ${option.model}`,
                width,
            )),
        ], undefined, factLimit);
        line([], undefined, factLimit);
        const facts = modelDetailFacts(state, option);
        const leftFacts = facts.slice(0, MODEL_DETAIL_LEFT_FACTS);
        const rightFacts = facts.slice(MODEL_DETAIL_LEFT_FACTS);
        const factRows = modelDetailFactRowCount(facts);
        const col = rightFacts.length === 0
            ? width
            : Math.max(0, Math.floor((width - 2) / 2));
        for (let index = 0; index < factRows; index += 1) {
            const left = leftFacts[index];
            const right = rightFacts[index];
            line(
                factColumnChunks(left?.[0], right?.[0], col, width, true),
                undefined,
                factLimit,
            );
            line(
                factColumnChunks(
                    left?.[1],
                    right?.[1],
                    col,
                    width,
                    false,
                    left?.[2],
                    right?.[2],
                ),
                undefined,
                factLimit,
            );
        }
        line([], undefined, factLimit);
        if (actions.length > 0) {
            while (drawn < factLimit) {
                line();
            }
            const inside = state.kind === "model"
                && state.modelFocus === "detail";
            const hint = inside ? "← list" : "→ enter";
            line([
                fg(TUI_MUTED)(
                    "Actions".padEnd(
                        Math.max(0, width - Bun.stringWidth(hint)),
                    ),
                ),
                fg(TUI_ACCENT)(hint),
            ]);
        }
        actions.forEach((action, index) => {
            const active = state.kind === "model"
                && state.modelFocus === "detail"
                && modelActionCursor(state, actions) === index;
            line(
                modelActionLineChunks(action, width, active),
                state.options.length + 1 + index,
            );
        });
    }
    while (drawn < height) {
        line();
    }
    return pane;
}

function wrappedTo(text: string, width: number): readonly string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
        if (line.length === 0) {
            line = word;
        } else if (line.length + 1 + word.length <= width) {
            line = `${line} ${word}`;
        } else {
            lines.push(line);
            line = word;
        }
    }
    if (line.length > 0) {
        lines.push(line);
    }
    return lines;
}

function modelHelpNode(
    renderer: RenderContext,
    width: number,
    state: TuiAnySettingsPickerState,
): BoxRenderable {
    const page = new BoxRenderable(renderer, {
        width,
        height: modelHelpLines(state).length,
        flexShrink: 0,
        flexDirection: "column",
    });
    for (const [term, meaning] of modelHelpLines(state)) {
        page.add(new TextRenderable(renderer, {
            content: meaning === undefined
                ? new StyledText([fg(TUI_TEXT)(term)])
                : new StyledText([
                    fg(TUI_ACCENT)(term.padEnd(MODEL_HELP_TERM_WIDTH)),
                    fg(TUI_MUTED)(
                        clippedTo(meaning, width - MODEL_HELP_TERM_WIDTH),
                    ),
                ]),
            width,
            height: 1,
        }));
    }
    return page;
}

function modelHelpLines(
    state: TuiAnySettingsPickerState,
): readonly (readonly [string, string?])[] {
    const snapshot = state.kind === "model"
        ? state.webdevArenaSnapshot
        : undefined;
    return [
        ...MODEL_HELP_LINES,
        [""],
        ["Sources"],
        ["* WA Score", "WebDev Arena (LMArena), CC-BY 4.0"],
        ["", "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset"],
        [
            "",
            snapshot === undefined
                ? "snapshot unavailable"
                : `snapshot ${snapshot}`,
        ],
        [
            "7:2:1",
            "OpenRouter listed blend / 1M. Full price in details",
        ],
        ["P", "Vera front, WA Score vs listed output / 1M"],
    ];
}

const MODEL_HELP_TERM_WIDTH = 14;

const MODEL_HELP_LINES: readonly (readonly [string, string?])[] = [
    ["The two lists"],
    ["Shortlist", "the models you keep. Ordered by you, not by provider."],
    ["All models", "every model your connected providers offer. Cutoff: any, then 1400–1600."],
    ["Top picks", "models Vera is built and tested against."],
    [""],
    ["Marks"],
    ["●", "the model this conversation is running."],
    ["✓", "on Shortlist: answered a live probe, so its abilities are known."],
    ["★", "on All models: already on your shortlist."],
    ["P", "on or near Vera's WA Score × listed-output front"],
    ["i", "the model takes image input."],
    ["*", "on WA Score: source footnote, not the shortlist."],
    ["top pick", "a model Vera is built and tested against."],
    ["▼ ▶", "an open or closed section. ←→ opens and closes it."],
    [""],
    ["Keys"],
    ["⏎", "run this model. On All models it does not add it."],
    ["→ / mouse", "focus or click model actions. ← returns to the list."],
    ["Verify", "^v this model · ^⇧v all shortlisted models."],
    ["Refresh", "^f refresh model catalog from providers."],
    ["⇥", "walk the strip, ending in Providers. Search clears on the way."],
];

function modelDetailHeight(
    state: TuiAnySettingsPickerState,
    width: number,
): number {
    if (state.kind === "model" && state.modelFocus === "page") {
        return 2 + modelPageActions(state).length;
    }
    if (
        state.kind === "model"
        && (state.tab === "pool" || state.tab === "all")
        && state.options.length === 0
    ) {
        return 2 + modelEmptyDetailBody(state, width).length;
    }
    const option = state.options[state.selectedIndex];
    const described = option !== undefined && option.section === undefined;
    if (described && option.detailFacts !== undefined) {
        return 3 + option.detailFacts.length * 2
            + wrappedTo(option.note ?? "", width).length;
    }
    const facts = described ? modelDetailFacts(state, option) : [];
    const factLines = described
        ? modelDetailFactRowCount(facts) * 2 + 1
        : 0;
    const actions = modelDetailActions(state, option).length;
    return (described ? 3 + factLines : 0)
        + (actions === 0 ? 0 : actions + 1);
}

const MODEL_DETAIL_LEFT_FACTS = 3;

function modelDetailFactRowCount(facts: readonly ModelDetailFact[]): number {
    return Math.max(
        Math.min(MODEL_DETAIL_LEFT_FACTS, facts.length),
        Math.max(0, facts.length - MODEL_DETAIL_LEFT_FACTS),
    );
}

type ModelDetailFact = readonly [string, string, ("positive" | undefined)?];

function factColumnChunks(
    left: string | undefined,
    right: string | undefined,
    col: number,
    width: number,
    labels: boolean,
    leftTone?: "positive",
    rightTone?: "positive",
): readonly TextChunk[] {
    const leftText = clippedTo(left ?? "", col).padEnd(col);
    const rightText = clippedTo(right ?? "", Math.max(0, width - col - 2));
    const paint = (
        text: string,
        tone: "positive" | undefined,
    ): TextChunk =>
        fg(
            tone === "positive"
                ? TUI_SUCCESS
                : labels
                ? TUI_MUTED
                : TUI_TEXT,
        )(text);
    return [
        paint(leftText, leftTone),
        fg(TUI_TEXT)("  "),
        paint(rightText, rightTone),
    ];
}

function modelDetailFacts(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): readonly ModelDetailFact[] {
    const facts: ModelDetailFact[] = [];
    if (state.kind === "model" && state.tab !== "pool") {
        facts.push(option.pooledRank === undefined
            ? ["Shortlist", "not shortlisted"]
            : ["Shortlist", "on your shortlist", "positive"]);
    }
    facts.push(option.unverified === true || option.pooledRank === undefined
        ? ["Verified", "not probed yet"]
        : ["Verified", "answered a live probe", "positive"]);
    facts.push(["Images", option.images === true ? "i" : "not known"]);
    if (option.waScore !== undefined) {
        facts.push(["WA Score", String(option.waScore)]);
    }
    const full = formatListedRates(option.pricing);
    if (full !== undefined) {
        facts.push(["Full price", full]);
    }
    const blended = formatBlendedRate(option.pricing);
    if (blended !== undefined) {
        facts.push(["Blended price", `${blended}  7:2:1`]);
    }
    facts.push(["Model ID", option.model ?? "—"]);
    if (option.unavailable === true) {
        facts.push(["Available", "not from its provider"]);
    }
    return facts;
}

function clippedTo(text: string, width: number): string {
    return text.length <= width
        ? text
        : `${text.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
}

function renderListPickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiAnySettingsPickerState,
    nodes: Renderable[],
    pointer?: DialogRowPointer,
    tip?: string,
    verification?: { readonly subject: string },
    onTab?: (tab: TuiModelPickerTab) => void,
    onConfigure?: () => void,
    search?: ReturnType<typeof createDialogSearchNode>,
    railInset = 0,
): void {
    const tab = state.kind === "model" ? state.tab ?? "all" : undefined;
    const stripPane = modelStripPane(state);
    const stop = modelStripStop(state);
    const searchable = pickerIsSearchable(state);
    const header = dialogHeaderNode(
        renderer,
        pickerTitle(
            state.kind,
            state.kind === "extension"
                ? state.title
                : stop === "providers"
                ? pickerTitle("model")
                : state.title,
        ),
    );
    box.add(header);
    nodes.push(header);
    let subtitleLines = 0;
    if (state.subtitle !== undefined) {
        const subtitleNode = new TextRenderable(renderer, {
            content: state.subtitle,
            fg: TUI_MUTED,
            width: "100%",
            height: 3,
            marginTop: 1,
            paddingLeft: 1,
        });
        box.add(subtitleNode);
        nodes.push(subtitleNode);
        subtitleLines = 4;
    }
    if (searchable && search !== undefined) {
        updateDialogSearchNode(
            search,
            state.query,
            "Search",
            tab !== "help",
            "queryCursor" in state ? state.queryCursor : undefined,
        );
        box.add(search);
    }
    let tabStripHeight = 0;
    if (stop !== undefined && stripPane !== undefined) {
        const strip = modelTabStripNode(
            renderer,
            stop,
            {
                pool: modelTabRows(
                    stripPane.allOptions,
                    "pool",
                    false,
                    [],
                    stripPane.actionOptions ?? [],
                ).filter((option) => option.action !== true).length,
                all: modelTabRows(stripPane.allOptions, "all").length,
            },
            pickerContentWidth(renderer, state, railInset),
            tab === undefined || tab === "help" ? undefined : modelPaneNote(state),
            onTab,
            onConfigure,
        );
        tabStripHeight = strip.height;
        box.add(strip.node);
        nodes.push(strip.node);
    }

    if (tab === "help") {
        const page = modelHelpNode(
            renderer,
            pickerCardWidth(renderer, state, railInset),
            state,
        );
        box.add(page);
        nodes.push(page);
        const footer = dialogFooterNode(
            renderer,
            pickerFooter(state, pickerCardWidth(renderer, state, railInset)),
        );
        box.add(footer);
        nodes.push(footer);
        box.height = "auto";
        return;
    }

    const split = modelPaneSplit(renderer, state, railInset);
    const detailed = split !== undefined;
    let body: BoxRenderable | undefined;
    let listColumn = box;
    if (split !== undefined) {
        body = new BoxRenderable(renderer, {
            width: "100%",
            flexShrink: 0,
            flexDirection: "row",
        });
        listColumn = new BoxRenderable(renderer, {
            width: split.listWidth,
            flexShrink: 0,
            flexDirection: "column",
            paddingRight: MODEL_LIST_RULE_GAP,
        });
        body.add(listColumn);
        box.add(body);
        nodes.push(body);
    }
    const rowWidth = split === undefined
        ? pickerContentWidth(renderer, state, railInset)
        : split.listWidth - MODEL_LIST_RULE_GAP;
    const listAction = modelListAction(state);
    const listActionLines = listAction === undefined ? 0 : 2;
    const pageEntryLines = modelPageEntry(state) === undefined ? 0 : 2;
    const listedHeaderLines = showsListedFactsHeader(state)
            && state.options.length > 0
        ? 1
        : 0;
    const intelligenceLines = showsIntelligenceCutoff(state)
        ? INTELLIGENCE_SCALE_LINES
        : 0;
    const allModelsInfoLines = showsAllModelsPrices(state)
        ? allModelsPriceChromeLines()
        : 0;
    const stackedLines = split === undefined
        ? stackedBelowListLines(state, rowWidth)
        : 0;

    const availableRows = pickerMaxRows(
        renderer,
        tabStripHeight + subtitleLines
            + (verification === undefined
                ? 0
                : verificationConsoleLines(verification))
            + listActionLines
            + 1
            + pageEntryLines
            + listedHeaderLines
            + intelligenceLines
            + allModelsInfoLines
            + stackedLines,
    );
    const detailMaxLines = availableRows + listActionLines + pageEntryLines;
    const rows = windowedDisplayRows(
        listDisplayRows(state),
        state.selectedIndex,
        tab === "all"
            ? Math.min(availableRows, MODEL_ALL_MAX_ROWS)
            : availableRows,
    );
    let lines = 0;
    const activityWidth = Math.max(0, ...rows.map((row) =>
        row.kind === "option" ? row.option.activity?.length ?? 0 : 0));
    const onScreen = new Set(state.options.map((option) => option.sessionId));
    const sharedOnScreen = new Map<string, number>();
    for (const option of state.options) {
        if (option.sharedGroup === undefined) continue;
        sharedOnScreen.set(
            option.sharedGroup,
            (sharedOnScreen.get(option.sharedGroup) ?? 0) + 1,
        );
    }
    let tinted = false;
    const listedHeader = listedHeaderLines > 0 && rows.length > 0;
    const listedPrefixWidth = listedHeader
        ? Math.max(
            0,
            ...rows.flatMap((row) =>
                row.kind === "option"
                    ? [metaPartsLength(
                        optionMetaPrefixParts(state, row.option, detailed),
                    )]
                    : []
            ),
        )
        : 0;
    const optionNodes = dialogOptionRows(renderer, [
        ...(listedHeader
            ? [{
                label: "",
                active: false,
                meta: [{
                    text: `${" ".repeat(listedPrefixWidth)}${listedFactsHeaderText()}`,
                    tone: "detail" as const,
                }],
            }]
            : []),
        ...rows.flatMap((row) =>
        row.kind === "option"
            ? [{
                label: digitQuickSelect(state)
                        && state.kind !== "settings"
                        && state.query === ""
                        && row.index < 9
                    ? `${row.index + 1}. ${row.option.label}`
                    : row.option.label,
                marker: state.kind === "provider"
                        && row.index === state.selectedIndex
                    ? "›"
                    : optionMarker(state, row.option),
                leading: optionLeading(
                    state,
                    row.option,
                    activityWidth,
                    (row.option.threadParent ?? row.option.forkedFrom)
                            !== undefined
                        && onScreen.has(
                            (row.option.threadParent ?? row.option.forkedFrom)!,
                        ),
                    row.option.sharedGroup !== undefined
                        && sharedOnScreen.get(row.option.sharedGroup) === 2,
                ),
                ...(state.kind === "session"
                    ? { tint: (tinted = !tinted) }
                    : {}),
                ...(state.kind === "model" || state.kind === "session"
                    ? {}
                    : { description: row.option.description }),
                meta: row.option.rowMeta
                    ?? optionMeta(state, row.option, detailed, listedPrefixWidth),
                card: row.option.card,
                active: row.index === state.selectedIndex
                    && (state.kind !== "model"
                        || (state.modelFocus ?? "list") === "list"),
                current: row.option.section !== undefined
                    || isCurrentOption(state, row.option),
                ...dialogRowPointer(pointer, row.index),
            }]
            : []
        ),
    ], rowWidth);
    const stackedPage = split === undefined && state.kind === "model"
        && state.modelFocus === "page";
    const pageEntry = modelPageEntry(state);
    if (pageEntry !== undefined) {
        const entry = new TextRenderable(renderer, {
            content: new StyledText(modelListActionLineChunks(
                {
                    ...pageEntry,
                    label: modelPageEntryLabel(state, rowWidth),
                },
                rowWidth,
                state.kind === "model"
                    && (state.modelFocus === "page_entry"
                        || state.modelFocus === "page"),
            )),
            width: rowWidth,
            height: 1,
        });
        attachDialogRowPointer(entry, pointer, -1);
        listColumn.add(entry);
        nodes.push(entry);
        const rule = new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_ELEMENT)("\u2500".repeat(rowWidth))]),
            width: rowWidth,
            height: 1,
        });
        listColumn.add(rule);
        nodes.push(rule);
        lines += 2;
    }
    if (intelligenceLines > 0) {
        const focused = state.kind === "model"
            && state.modelFocus === "intelligence";
        for (const chunks of intelligenceScaleLines(
            rowWidth,
            state.kind === "model" ? state.intelligenceCutoff ?? "any" : "any",
            focused,
        )) {
            const node = new TextRenderable(renderer, {
                content: new StyledText([...chunks]),
                width: rowWidth,
                height: 1,
            });
            listColumn.add(node);
            nodes.push(node);
            lines += 1;
        }
        const prices = allModelsPriceNode(
            renderer,
            allModelsInfoOption(state),
            rowWidth,
        );
        listColumn.add(prices);
        nodes.push(prices);
        lines += allModelsPriceChromeLines();
    }
    if (rows.length === 0) {
        const empty = new TextRenderable(renderer, {
            content: `${DIALOG_GUTTER}${emptyPickerMessage(state)}`,
            fg: TUI_MUTED,
            width: "100%",
            height: 1,
        });
        listColumn.add(empty);
        nodes.push(empty);
        lines += 1;
    }
    let optionNodeIndex = listedHeader ? 1 : 0;
    if (listedHeader) {
        const header = optionNodes[0]!;
        listColumn.add(header);
        nodes.push(header);
        lines += 1;
    }
    (stackedPage ? [] : rows).forEach((row, position) => {
        const node = row.kind === "group"
            ? dialogGroupHeaderNode(renderer, row.label, position > 0)
            : optionNodes[optionNodeIndex++]!;
        lines += row.kind === "group" ? (position > 0 ? 2 : 1) : 1;
        listColumn.add(node);
        nodes.push(node);
    });
    if (listAction !== undefined && !stackedPage) {
        const divider = new TextRenderable(renderer, {
            content: new StyledText([
                fg(TUI_ELEMENT)("─".repeat(rowWidth)),
            ]),
            width: rowWidth,
            height: 1,
        });
        listColumn.add(divider);
        nodes.push(divider);
        const action = new TextRenderable(renderer, {
            content: new StyledText(modelListActionLineChunks(
                listAction,
                rowWidth,
                state.kind === "model" && state.modelFocus === "list_action",
            )),
            width: rowWidth,
            height: 1,
        });
        attachDialogRowPointer(action, pointer, state.options.length);
        listColumn.add(action);
        nodes.push(action);
        lines += listActionLines;
    }
    if (split !== undefined && body !== undefined) {
        const detailLines = Math.min(
            modelDetailHeight(state, split.detailWidth),
            detailMaxLines,
        );
        lines = Math.max(lines, detailLines);
        listColumn.height = lines;
        const detail = modelDetailNode(
            renderer,
            state,
            split.detailWidth,
            lines,
            pointer,
        );
        body.add(detail);
        nodes.push(detail);
        body.height = lines;
    }

    if (stackedPage) {
        const title = new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_MUTED)("More")]),
            width: "100%",
            height: 1,
            marginTop: 1,
        });
        listColumn.add(title);
        nodes.push(title);
        lines += 2;
        const actions = modelPageActions(state);
        const selected = Math.min(
            state.modelPageIndex ?? 0,
            Math.max(0, actions.length - 1),
        );
        actions.forEach((action, index) => {
            const node = new TextRenderable(renderer, {
                content: new StyledText(modelActionLineChunks(
                    { label: action.label, chord: action.description ?? "" },
                    rowWidth,
                    index === selected,
                )),
                width: "100%",
                height: 1,
            });
            attachDialogRowPointer(node, pointer, -2 - index);
            listColumn.add(node);
            nodes.push(node);
            lines += 1;
        });
    } else if (split === undefined) {
        const option = state.options[state.selectedIndex];
        for (const chunks of stackedDetailLines(state, option, rowWidth)) {
            const node = new TextRenderable(renderer, {
                content: new StyledText([...chunks]),
                width: "100%",
                height: 1,
            });
            lines += 1;
            listColumn.add(node);
            nodes.push(node);
        }
        const actions = state.kind === "model" && state.tab === "all"
            ? []
            : modelDetailActions(state, option);
        if (actions.length > 0) {
            const title = new TextRenderable(renderer, {
                content: new StyledText([
                    fg(TUI_MUTED)(
                        "Actions".padEnd(Math.max(0, rowWidth - 7)),
                    ),
                    fg(TUI_ACCENT)(
                        state.kind === "model" && state.modelFocus === "detail"
                            ? "← list"
                            : "→ enter",
                    ),
                ]),
                width: "100%",
                height: 1,
                marginTop: 1,
            });
            listColumn.add(title);
            nodes.push(title);
            lines += 2;
            actions.forEach((action, index) => {
                const node = new TextRenderable(renderer, {
                    content: new StyledText(modelActionLineChunks(
                        action,
                        rowWidth,
                        state.kind === "model"
                            && state.modelFocus === "detail"
                            && modelActionCursor(state, actions) === index,
                    )),
                    width: "100%",
                    height: 1,
                });
                attachDialogRowPointer(
                    node,
                    pointer,
                    state.options.length + 1 + index,
                );
                listColumn.add(node);
                nodes.push(node);
                lines += 1;
            });
        }
    }

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

    if (verification !== undefined) {
        const consoleBox = verificationConsoleNode(renderer, verification);
        box.add(consoleBox);
        nodes.push(consoleBox);
    }

    const footer = dialogFooterNode(
        renderer,
        pickerFooter(state, pickerCardWidth(renderer, state, railInset)),
    );
    box.add(footer);
    nodes.push(footer);
    if (state.kind === "model") {
        const arrows = new TextRenderable(renderer, {
            content: `${DIALOG_GUTTER}${MODEL_ARROW_HINT}`,
            fg: TUI_MUTED,
            width: "100%",
            height: 1,
        });
        box.add(arrows);
        nodes.push(arrows);
    }
    box.height = "auto";
}

const MODEL_TAB_STRIP_CHROME_HEIGHT = 3;
const MODEL_ARROW_HINT =
    "Arrow keys move you: ↑↓ the list, → into the details, ← back";
const MODEL_ALL_MAX_ROWS = 28;
const VERIFICATION_CONSOLE_STEPS = 3;

type VerificationConsole = NonNullable<TuiSettingsPickerView["verification"]>;

export function verificationConsoleLines(console_: VerificationConsole): number {
    const steps = console_.steps ?? [];
    return 4 + Math.max(1, Math.min(VERIFICATION_CONSOLE_STEPS, steps.length));
}

function verificationConsoleNode(
    renderer: RenderContext,
    console_: VerificationConsole,
): BoxRenderable {
    const steps = console_.steps ?? [];
    const shown = steps.slice(-VERIFICATION_CONSOLE_STEPS);
    const consoleBox = new BoxRenderable(renderer, {
        width: "100%",
        height: verificationConsoleLines(console_) - 1,
        marginTop: 1,
        flexShrink: 0,
        flexDirection: "column",
        border: false,
        backgroundColor: TUI_INPUT,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        paddingBottom: 1,
    });
    const line = (chunks: TextChunk[]): void => {
        consoleBox.add(new TextRenderable(renderer, {
            content: new StyledText(chunks),
            bg: TUI_INPUT,
            width: "100%",
            height: 1,
        }));
    };
    line([
        fg(TUI_TEXT)("Verifying "),
        fg(TUI_MUTED)(console_.subject),
    ]);
    if (shown.length === 0) {
        line([
            fg(TUI_ACCENT)("⠋ "),
            fg(TUI_MUTED)("Waiting for provider response"),
        ]);
        return consoleBox;
    }
    for (const step of shown) {
        line(
            step.status === "running"
                ? [fg(TUI_ACCENT)("⠋ "), fg(TUI_MUTED)(step.label)]
                : [
                    fg(TUI_MUTED)("  "),
                    fg(TUI_MUTED)(`${step.label} `),
                    fg(
                        step.status === "failed" ? TUI_DANGER : TUI_SUCCESS,
                    )(VERIFICATION_STEP_MARKS[step.status] ?? "✓"),
                ],
        );
    }
    return consoleBox;
}

const VERIFICATION_STEP_MARKS: Record<string, string> = {
    passed: "✓",
    failed: "✗",
    skipped: "skipped",
    running: "",
};

type ModelStripStop = TuiModelPickerTab | "providers";

function modelStripPane(
    state: TuiAnySettingsPickerState,
): TuiSettingsPickerState | undefined {
    if (state.kind === "model") {
        return state;
    }
    return state.kind === "provider" && state.parent?.kind === "model"
        ? state.parent
        : undefined;
}

function modelStripStop(
    state: TuiAnySettingsPickerState,
): ModelStripStop | undefined {
    if (state.kind === "model") {
        return state.tab ?? "all";
    }
    return modelStripPane(state) === undefined ? undefined : "providers";
}

const MODEL_TAB_LABELS: readonly (readonly [TuiModelPickerTab, string])[] = [
    ["pool", "Shortlist"],
    ["all", "All models"],
    ["actions", "Actions"],
    ["defaults", "Defaults"],
    ["help", "Help"],
];

const MODEL_TAB_COMPACT_LABELS = MODEL_TAB_LABELS.map(([, label]) =>
    label === "Shortlist"
        ? "Short"
        : label === "All models"
        ? "All"
        : label === "Defaults"
        ? "Defs"
        : label
);

function modelTabStripItemWidths(
    names: readonly string[],
    gap: number,
    pad: number,
    configurePad: number,
): readonly number[] {
    const tabs = names.map((name, index) =>
        Bun.stringWidth(name) + pad * (index === 0 ? 1 : 2) + gap
    );
    return [
        ...tabs,
        Bun.stringWidth("Providers ^e") + configurePad * 2,
    ];
}

function modelTabStripRowCount(
    width: number,
    names: readonly string[],
    gap: number,
    pad: number,
    configurePad: number,
): number {
    const limit = Math.max(1, width);
    let rows = 1;
    let used = 0;
    for (const rawWidth of modelTabStripItemWidths(
        names,
        gap,
        pad,
        configurePad,
    )) {
        const itemWidth = Math.min(rawWidth, limit);
        if (used > 0 && used + itemWidth > limit) {
            rows += 1;
            used = itemWidth;
        } else {
            used += itemWidth;
        }
    }
    return rows;
}

function modelTabStripHeight(width: number): number {
    return MODEL_TAB_STRIP_CHROME_HEIGHT + modelTabStripRowCount(
        width,
        MODEL_TAB_COMPACT_LABELS,
        1,
        0,
        0,
    );
}

function modelTabLabel(tab: TuiModelPickerTab): string {
    return MODEL_TAB_LABELS.find(([id]) => id === tab)?.[1] ?? tab;
}

const MODEL_TAB_DESCRIPTIONS: Readonly<Record<TuiModelPickerTab, string>> = {
    defaults: "Every job Vera runs a model for, and the model it runs.",
    pool: "Models you keep close. More holds what this list can do, or browse All models.",
    all: "Everything your providers offer. Enter runs one without adding it.",
    actions: "Everything this pane can do besides choose a model.",
    help: "What the marks and the keys in this pane mean.",
};

function modelPaneNote(state: TuiAnySettingsPickerState): string {
    const tab = state.kind === "model" ? state.tab ?? "all" : "all";
    return MODEL_TAB_DESCRIPTIONS[tab];
}

function modelTabStripNode(
    renderer: RenderContext,
    tab: ModelStripStop,
    counts: Readonly<Partial<Record<TuiModelPickerTab, number>>>,
    width: number,
    note?: string,
    onTab?: (tab: TuiModelPickerTab) => void,
    onConfigure?: () => void,
): { readonly node: BoxRenderable; readonly height: number } {
    const fullNames = MODEL_TAB_LABELS.map(([id, label]) => {
        const count = counts[id];
        return count === undefined ? label : `${label} (${count})`;
    });
    const namesWithoutCounts = MODEL_TAB_LABELS.map(([, label]) => label);
    const stripWidth = (
        names: readonly string[],
        gap: number,
        pad = 1,
        configurePad = 1,
    ) =>
        names.reduce(
            (total, name) => total + Bun.stringWidth(name) + pad * 2,
            0,
        )
        + gap * MODEL_TAB_LABELS.length
        + Bun.stringWidth(
            `${" ".repeat(configurePad)}Providers ^e${" ".repeat(configurePad)}`,
        );
    const shortened = (names: readonly string[]) =>
        names.map((name) =>
            name.startsWith("All models")
                ? name.replace("All models", "All")
                : name
        );
    const rungs: readonly (
        readonly [readonly string[], number, number, number]
    )[] = [
        [fullNames, 2, 1, 1],
        [fullNames, 1, 1, 1],
        [shortened(fullNames), 1, 1, 1],
        [namesWithoutCounts, 2, 1, 1],
        [namesWithoutCounts, 1, 1, 1],
        [shortened(namesWithoutCounts), 1, 1, 1],
        [shortened(namesWithoutCounts), 1, 0, 1],
        [shortened(namesWithoutCounts), 1, 0, 0],
        [MODEL_TAB_COMPACT_LABELS, 1, 0, 0],
    ];
    const [names, gap, pad, configurePad] = rungs.find(([
        candidate,
        spacing,
        padding,
        providerPadding,
    ]) => stripWidth(candidate, spacing, padding, providerPadding) <= width)
        ?? rungs.at(-1)!;
    const tabRows = modelTabStripRowCount(
        width,
        names,
        gap,
        pad,
        configurePad,
    );
    const height = MODEL_TAB_STRIP_CHROME_HEIGHT + tabRows;
    const strip = new BoxRenderable(renderer, {
        width: "100%",
        height,
        flexDirection: "column",
    });
    const chips = new BoxRenderable(renderer, {
        width: "100%",
        height: tabRows,
        flexDirection: "row",
        flexWrap: "wrap",
    });
    const itemLimit = Math.max(1, width);
    MODEL_TAB_LABELS.forEach(([id], index) => {
        const named = names[index]!;
        const margin = " ".repeat(pad);
        const text = index === 0
            ? `${named}${margin}`
            : `${margin}${named}${margin}`;
        const gapText = " ".repeat(gap);
        const chip = new TextRenderable(renderer, {
            content: new StyledText([
                id === tab
                    ? fg(TUI_BACKGROUND)(bg(TUI_ACCENT)(text))
                    : fg(TUI_ACCENT)(text),
                fg(TUI_PANEL)(gapText),
            ]),
            width: Math.min(Bun.stringWidth(text + gapText), itemLimit),
            flexShrink: 0,
            height: 1,
        });
        if (onTab !== undefined) {
            chip.onMouseDown = (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                onTab(id);
            };
        }
        chips.add(chip);
    });
    const chord = tuiKeyHint("open_providers").split(" ")[0] ?? "";
    const configureMargin = " ".repeat(configurePad);
    const configureText = `${configureMargin}Providers ${chord}${configureMargin}`;
    const configure = new TextRenderable(renderer, {
        content: new StyledText(
            tab === "providers"
                ? [fg(TUI_BACKGROUND)(bg(TUI_ACCENT)(
                    `${configureMargin}Providers ${chord}${configureMargin}`,
                ))]
                : [fg(TUI_ACCENT)("Providers "), fg(TUI_MUTED)(chord)],
        ),
        width: Math.min(Bun.stringWidth(configureText), itemLimit),
        flexShrink: 0,
        height: 1,
    });
    if (onConfigure !== undefined) {
        configure.onMouseDown = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            onConfigure();
        };
    }
    chips.add(configure);
    strip.add(chips);
    strip.add(new TextRenderable(renderer, {
        content: "",
        width: "100%",
        height: 1,
    }));
    strip.add(new TextRenderable(renderer, {
        content: note ?? "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
    }));
    strip.add(new TextRenderable(renderer, {
        content: "",
        width: "100%",
        height: 1,
    }));
    return { node: strip, height };
}

interface PickerHint {
    readonly text: string;
    readonly drop: number;
}

export function clippedToWidth(text: string, width: number): string {
    if (width <= 0 || Bun.stringWidth(text) <= width) return text;
    if (width === 1) return "\u2026";
    const chars = [...text];
    let kept = "";
    for (const char of chars) {
        if (Bun.stringWidth(kept + char) > width - 1) break;
        kept += char;
    }
    return `${kept.trimEnd()}\u2026`;
}

function fittedHints(hints: readonly PickerHint[], width: number): string {
    const kept = [...hints];
    for (;;) {
        const line = kept.map((hint) => hint.text).join(" · ");
        if (width <= 0 || Bun.stringWidth(line) <= width || kept.length <= 1) {
            return clippedToWidth(line, width);
        }
        let last = 0;
        kept.forEach((hint, index) => {
            if (hint.drop >= kept[last]!.drop) {
                last = index;
            }
        });
        if (kept[last]!.drop === 0) {
            return clippedToWidth(line, width);
        }
        kept.splice(last, 1);
    }
}

export function pickerFooter(
    state: TuiAnySettingsPickerState,
    width = 0,
): string {
    return clippedToWidth(pickerFooterText(state, width), width);
}

function pickerFooterText(
    state: TuiAnySettingsPickerState,
    width = 0,
): string {
    if (state.kind === "session") {
        const leavingSomething = state.nothingToLeave !== true;
        return [
            "↑↓ ^d^u move",
            !leavingSomething
                ? "⏎ open"
                : state.enterDisposition === "keep_running"
                ? "⏎ switch"
                : "⏎ stop & switch",
            ...(leavingSomething && state.enterDisposition !== "keep_running"
                ? [tuiKeyHint("background_switch")]
                : []),
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
    if (state.kind === "configure") {
        return "↑↓ move · ⏎ edit · esc close";
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
            selected?.action === true
                ? "⏎ declare"
                : selected?.declared === true
                ? "⏎ edit"
                : selected?.connected === true
                ? "⏎ reconnect"
                : "⏎ connect",
            ...(selected?.connected === true
                ? [tuiKeyHint("forget_provider")]
                : []),
            ...(selected?.endpointEditable === true
                && selected.declared !== true
                ? [tuiKeyHint("edit_endpoint")]
                : []),
            ...(selected?.action === true
                ? []
                : [tuiKeyHint("declare_provider")]),
            ...(selected?.refreshable === true
                ? [tuiKeyHint("refresh_catalog")]
                : []),
            ...(state.parent?.kind === "model" ? ["⇥ tabs"] : []),
            state.parent === undefined ? "esc close" : "esc back",
        ].join(" · ");
    }
    if (
        state.kind === "model_assignment"
        && state.modelAssignment === "subagents"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected?.value === MODEL_ASSIGNMENT_BROWSE_VALUE) {
            return "↑↓ move · ⏎ open · esc done";
        }
        if (selected?.value === REVIEWER_CLEAR_VALUE) {
            return "↑↓ move · esc done";
        }
        const action = selected?.value === MODEL_ASSIGNMENT_SELF_VALUE
            ? "p toggle"
            : state.assignedModels?.includes(selected?.value ?? "") === true
            ? "p remove"
            : "p assign";
        return `↑↓ move · ${action} · esc done`;
    }
    if (
        state.kind === "model"
        && (state.tab === "defaults" || state.tab === "actions")
    ) {
        return fittedHints([
            { text: "\u2191\u2193 move", drop: 0 },
            {
                text: state.tab === "actions" ? "\u23ce run" : "\u23ce change",
                drop: 0,
            },
            { text: "\u21e5 tabs", drop: 1 },
            { text: "esc close", drop: 0 },
        ], width);
    }
    if (state.kind === "model" && state.tab === "help") {
        return "⇥ tabs · esc close";
    }
    if (state.kind === "model") {
        const selected = state.options[state.selectedIndex];
        if (state.modelFocus === "detail") {
            return fittedHints([
                { text: "↑↓ move", drop: 0 },
                { text: "⏎ run", drop: 0 },
                { text: "← list", drop: 0 },
                { text: "⇥ tabs", drop: 2 },
                { text: "esc close", drop: 0 },
            ], width);
        }
        if (state.modelFocus === "intelligence") {
            return fittedHints([
                { text: "←→ cutoff", drop: 0 },
                { text: "↓ list", drop: 0 },
                { text: "⇥ tabs", drop: 1 },
                { text: "esc close", drop: 0 },
            ], width);
        }
        if (state.modelFocus === "page") {
            return fittedHints([
                { text: "\u2191\u2193 move", drop: 0 },
                { text: "\u23ce run", drop: 0 },
                { text: "\u2190 back", drop: 0 },
                { text: "esc back", drop: 1 },
            ], width);
        }
        if (state.modelFocus === "page_entry") {
            return fittedHints([
                { text: "\u2193 list", drop: 0 },
                { text: "\u2192 open", drop: 0 },
                { text: "\u21e5 tabs", drop: 2 },
                { text: "esc close", drop: 0 },
            ], width);
        }
        if (state.modelFocus === "list_action") {
            return fittedHints([
                { text: "↑ list", drop: 0 },
                { text: "⏎ run", drop: 0 },
                ...(modelDetailActions(state, selected).length === 0
                    ? []
                    : [{ text: "→ actions", drop: 1 }]),
                { text: "⇥ tabs", drop: 2 },
                { text: "esc close", drop: 0 },
            ], width);
        }
        const action = tuiModelActionOfValue(selected?.value ?? "");
        if (action === "shortlist_current") {
            return fittedHints([
                { text: "↑↓ move", drop: 0 },
                { text: "⏎ add", drop: 0 },
                { text: "⇥ tabs", drop: 1 },
                { text: "esc close", drop: 0 },
            ], width);
        }
        const pool = selected === undefined || selected.provider === undefined
            ? undefined
            : isPooled(state, selected)
                ? tuiKeyHint("toggle_pooled").replace("pin", "unpin")
                : tuiKeyHint("toggle_pooled");
        return fittedHints([
            { text: "↑↓ ^d^u move", drop: 0 },
            { text: "⏎ select", drop: 0 },
            ...(pool === undefined ? [] : [{ text: pool, drop: 1 }]),
            ...(state.canUndoPoolChange === true
                ? [{ text: tuiKeyHint("undo_pool_change"), drop: 1 }]
                : []),
            ...(modelOptionCanVerify(state, selected)
                ? [{ text: tuiKeyHint("verify_model"), drop: 2 }]
                : []),
            ...(modelDetailActions(state, selected).length === 0
                ? []
                : [{ text: "→ actions", drop: 2 }]),
            ...(state.tab === "pool" ? [] : [
                selected?.section === undefined
                    ? { text: "⇧←→ fold all", drop: 5 }
                    : { text: "←→ ⇧←→ fold", drop: 1 },
            ]),
            ...(state.tab !== "pool" && hasFoldedRows(state)
                ? [{
                    text: state.revealAll === true
                        ? tuiKeyHint("reveal_all_models").replace(
                            "show all",
                            "show fewer",
                        )
                        : tuiKeyHint("reveal_all_models"),
                    drop: 4,
                }]
                : []),
            { text: tuiKeyHint("open_providers"), drop: 6 },
            { text: "⇥ tabs", drop: 3 },
            { text: "esc close", drop: 0 },
        ], width);
    }
    return "↑↓ move · ⏎ select · esc close";
}

function hasFoldedRows(state: TuiSettingsPickerState): boolean {
    return state.allOptions.some((option) =>
        option.hiddenByDefault !== undefined
        && option.pooledRank === undefined
        && option.unavailable !== true
    );
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
    const grouped = state.kind === "provider"
        || state.kind === "configure"
        || (state.kind === "model" && state.tab === "defaults")
        || (state.kind === "model_assignment"
            && state.modelAssignment === "subagents");
    const rows: PickerDisplayRow[] = [];
    state.options.forEach((option, index) => {
        if (
            grouped
            && option.action !== true
            && groupLabel(state.options[index - 1]) !== groupLabel(option)
        ) {
            rows.push({ kind: "group", label: groupLabel(option) ?? "Other" });
        }
        rows.push({ kind: "option", option, index });
    });
    return rows;
}

function isPooled(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): boolean {
    return option.pooledRank !== undefined
        || state.allOptions.some((candidate) =>
            candidate.value === option.value && candidate.pooledRank !== undefined
        );
}

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
    const stuck = stickyGroupRow(rows, start);
    if (stuck === undefined) {
        return window;
    }
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
        return option.current === true;
    }
    if (state.kind === "provider") return false;
    if (state.kind === "session") {
        return option.current === true;
    }
    return state.kind === "model" && option.value === state.initialModel;
}

function modelOptionCanVerify(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption | undefined,
): boolean {
    return state.kind === "model"
        && option !== undefined
        && option.section === undefined
        && option.action !== true
        && option.provider !== undefined
        && option.model !== undefined
        && option.value !== SESSION_MODEL_VALUE;
}

type ModelDetailActionId =
    | "verify"
    | "toggle_pool"
    | "name"
    | "request_options";

interface ModelDetailAction {
    readonly id: ModelDetailActionId;
    readonly chord: string;
    readonly label: string;
}

type ModelListActionId = "verify_pool" | "reveal_all" | "page_entry";

interface ModelListAction {
    readonly id: ModelListActionId;
    readonly chord: string;
    readonly label: string;
}

function modelActionLineChunks(
    action: Pick<ModelDetailAction, "chord" | "label">,
    width: number,
    active: boolean,
): TextChunk[] {
    const chordWidth = Bun.stringWidth(action.chord);
    const labelWidth = Math.max(0, width - 1 - chordWidth);
    const label = labelWidth === 0
        ? ""
        : clippedTo(action.label, labelWidth).padEnd(labelWidth);
    if (active) {
        return [
            fg(TUI_BACKGROUND)(
                bg(TUI_ACCENT)(`${label} ${action.chord}`.padEnd(width)),
            ),
        ];
    }
    return [
        fg(TUI_TEXT)(label),
        fg(TUI_PANEL)(" "),
        fg(TUI_ACCENT)(action.chord),
    ];
}

function modelListActionLineChunks(
    action: ModelListAction,
    width: number,
    active: boolean,
): TextChunk[] {
    const chordWidth = Bun.stringWidth(action.chord);
    const labelWidth = Math.max(0, width - 1 - chordWidth);
    const label = labelWidth === 0
        ? ""
        : clippedTo(action.label, labelWidth).padEnd(labelWidth);
    if (active) {
        return [
            fg(TUI_BACKGROUND)(
                bg(TUI_ACCENT)(`${label} ${action.chord}`.padEnd(width)),
            ),
        ];
    }
    return [
        fg(TUI_TEXT)(label),
        fg(TUI_TEXT)(" "),
        fg(TUI_ACCENT)(action.chord),
    ];
}

function modelPageActions(
    state: TuiAnySettingsPickerState,
): readonly TuiSettingsPickerOption[] {
    if (
        state.kind !== "model"
        || (state.tab !== "pool" && state.tab !== "all")
    ) {
        return [];
    }
    const listOwn = state.tab === "pool"
        ? ["shortlist_current", "verify_pool"]
        : ["reveal_all"];
    return availableModelActionOptions(
        state.allOptions,
        state.actionOptions ?? [],
    ).filter((option) => {
        const id = tuiModelActionOfValue(option.value) ?? "";
        return listOwn.includes(id) || id === "refresh" || id === "providers";
    });
}

function modelSyncedFocus(
    state: TuiSettingsPickerState,
    rebuilt: TuiAnySettingsPickerState,
): {
    readonly modelFocus: NonNullable<TuiSettingsPickerState["modelFocus"]>;
    readonly modelPageIndex?: number;
} {
    const focus = state.modelFocus ?? "list";
    if (focus !== "page" && focus !== "page_entry") {
        return { modelFocus: focus };
    }
    const actions = modelPageActions(rebuilt);
    if (actions.length === 0) {
        return { modelFocus: "list" };
    }
    return focus === "page_entry"
        ? { modelFocus: "page_entry" }
        : {
            modelFocus: "page",
            modelPageIndex: Math.min(
                state.modelPageIndex ?? 0,
                actions.length - 1,
            ),
        };
}

function modelActionCursor(
    state: TuiAnySettingsPickerState,
    actions: readonly ModelDetailAction[],
): number {
    return Math.min(
        (state.kind === "model" ? state.modelActionIndex : undefined) ?? 0,
        Math.max(0, actions.length - 1),
    );
}

function modelPageEntry(
    state: TuiAnySettingsPickerState,
): ModelListAction | undefined {
    return modelPageActions(state).length === 0
        ? undefined
        : { id: "page_entry", chord: "\u203a", label: "More" };
}

function modelPageEntryGlyph(state: TuiAnySettingsPickerState): string {
    return state.kind === "model" && state.modelFocus === "page" ? "-" : "+";
}

const MODEL_PAGE_ENTRY_SHORT: Record<string, string> = {
    shortlist_current: "add current",
    reveal_all: "show every model",
    verify_pool: "verify all",
    refresh: "refresh",
    providers: "providers",
};

function modelPageEntryLabel(
    state: TuiAnySettingsPickerState,
    width: number,
): string {
    const glyph = modelPageEntryGlyph(state);
    const names = modelPageActions(state).map((option) =>
        MODEL_PAGE_ENTRY_SHORT[tuiModelActionOfValue(option.value) ?? ""]
            ?? option.label
    );
    const room = width - Bun.stringWidth(`${glyph} More · `) - 2;
    const shown: string[] = [];
    for (const name of names) {
        const next = [...shown, name].join(", ");
        const rest = names.length - shown.length - 1;
        const suffix = rest === 0 ? "" : ` (+${rest})`;
        if (Bun.stringWidth(next + suffix) > room) break;
        shown.push(name);
    }
    const opener = `${glyph} More`;
    if (shown.length === 0) return opener;
    const rest = names.length - shown.length;
    return `${opener} · ${shown.join(", ")}${
        rest === 0 ? "" : ` (+${rest})`
    }`;
}

function modelDetailActions(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption | undefined,
): readonly ModelDetailAction[] {
    if (
        state.kind !== "model"
        || option === undefined
        || option.section !== undefined
        || option.action === true
        || option.provider === undefined
        || option.model === undefined
        || option.value === SESSION_MODEL_VALUE
    ) {
        return [];
    }
    const pooled = isPooled(state, option);
    const requestOptions = state.requestOptionsProviders?.[option.provider];
    const modelReference = `${option.provider}/${option.model}`;
    return [
        ...(modelOptionCanVerify(state, option)
            ? [{
                id: "verify" as const,
                chord: tuiKeyHint("verify_model").split(" ")[0] ?? "",
                label: "Verify this model",
            }]
            : []),
        {
            id: "toggle_pool",
            chord: tuiKeyHint("toggle_pooled").split(" ")[0] ?? "",
            label: pooled ? "Unpin" : "Add to shortlist",
        },
        ...(pooled
            ? [{
                id: "name" as const,
                chord: tuiKeyHint("name_pooled").split(" ")[0] ?? "",
                label: "Name this model",
            }]
            : []),
        ...(requestOptions === undefined
            ? []
            : [{
                id: "request_options" as const,
                chord: state.configuredRequestOptions?.includes(modelReference)
                    ? "configured"
                    : "none",
                label: "Request options",
            }]),
    ];
}

function modelListAction(
    state: TuiAnySettingsPickerState,
): ModelListAction | undefined {
    if (state.kind !== "model") return undefined;
    return undefined;
}

function modelDetailActionTransition(
    state: TuiSettingsPickerState,
    action: ModelDetailAction | undefined,
): TuiSettingsPickerTransition {
    const option = state.options[state.selectedIndex];
    if (
        action === undefined
        || option?.provider === undefined
        || option.model === undefined
    ) {
        return unchanged(state, true);
    }
    if (action.id === "verify") {
        return {
            state,
            handled: true,
            poolVerify: { provider: option.provider, model: option.model },
        };
    }
    if (action.id === "toggle_pool") {
        return {
            state,
            handled: true,
            poolToggle: {
                action: isPooled(state, option) ? "remove" : "add",
                provider: option.provider,
                model: option.model,
            },
        };
    }
    if (action.id === "request_options") {
        const support = state.requestOptionsProviders?.[option.provider];
        if (support === undefined) return unchanged(state, true);
        return {
            state,
            handled: true,
            requestOptions: {
                provider: option.provider,
                model: option.model,
                support,
            },
        };
    }
    return {
        state,
        handled: true,
        poolName: {
            provider: option.provider,
            model: option.model,
            label: option.label,
        },
    };
}

function modelListActionTransition(
    state: TuiSettingsPickerState,
    action: ModelListAction | undefined,
): TuiSettingsPickerTransition {
    if (action === undefined) return unchanged(state, true);
    if (action.id === "verify_pool") {
        return { state, handled: true, poolVerifySweep: true };
    }
    const revealAll = state.revealAll !== true;
    const options = modelListFor(state, { revealAll });
    return {
        state: {
            ...state,
            revealAll,
            options,
            modelFocus: "list_action",
            selectedIndex: restoredCursor(
                options,
                state.options[state.selectedIndex]?.value,
                state.initialModel,
            ),
        },
        handled: true,
    };
}

function digitQuickSelect(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "reasoning"
        || state.kind === "permissions"
        || state.kind === "settings"
        || state.kind === "permission_settings";
}

function optionMarker(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): string | undefined {
    if (option.section !== undefined) {
        return option.sectionCollapsed === true ? "▶" : "▼";
    }
    if (option.action === true) {
        return "+";
    }
    if (state.kind === "provider") {
        return undefined;
    }
    return isCurrentOption(state, option) ? "●" : undefined;
}

function optionLeading(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
    activityWidth = 0,
    threaded = false,
    shared = false,
): string {
    if (option.section !== undefined || state.kind === "provider") {
        return "";
    }
    if (state.kind !== "session") {
        return "";
    }
    const depth = threaded ? option.depth ?? 0 : 0;
    const thread = shared && option.sharedEdge !== undefined
        ? `${option.sharedEdge === "start" ? "┌" : "└"} `
        : depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
    return `${thread}${(option.activity ?? "").padEnd(activityWidth)}  `;
}

const INTELLIGENCE_SCALE_LINES = 3;
const ALL_MODELS_PRICE_FACTS = 4;
const ALL_MODELS_PRICE_PAD = 1;
const ALL_MODELS_PRICE_MARGIN = 1;
type AllModelsPriceChrome = "fill" | "border";
const ALL_MODELS_PRICE_CHROME: AllModelsPriceChrome = "border";

function allModelsPriceChromeLines(): number {
    const boxHeight = ALL_MODELS_PRICE_CHROME === "fill"
        ? ALL_MODELS_PRICE_FACTS + 2 * ALL_MODELS_PRICE_PAD
        : ALL_MODELS_PRICE_FACTS;
    return 2 * ALL_MODELS_PRICE_MARGIN + boxHeight;
}

function showsIntelligenceCutoff(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "model" && (state.tab ?? "all") === "all";
}

function showsAllModelsPrices(state: TuiAnySettingsPickerState): boolean {
    return showsIntelligenceCutoff(state);
}

function isAllModelsInfoRow(
    option: TuiSettingsPickerOption | undefined,
): option is TuiSettingsPickerOption {
    return option !== undefined
        && option.section === undefined
        && tuiModelActionOfValue(option.value) === undefined;
}

function allModelsInfoOption(
    state: TuiAnySettingsPickerState,
): TuiSettingsPickerOption | undefined {
    const selected = state.options[state.selectedIndex];
    if (isAllModelsInfoRow(selected)) {
        return selected;
    }
    return state.options
        .slice(state.selectedIndex + 1)
        .find(isAllModelsInfoRow);
}

function intelligenceScaleLines(
    width: number,
    cutoff: IntelligenceCutoff,
    focused: boolean,
): readonly (readonly TextChunk[])[] {
    const stops = INTELLIGENCE_CUTOFFS;
    const trackWidth = Math.min(52, Math.max(36, width - 2));
    const labelGap = Math.max(
        1,
        trackWidth - "Any".length - "Smarter".length,
    );
    const axis = `Any${" ".repeat(labelGap)}Smarter`;
    const trackLength = Math.max(1, trackWidth - 1);
    const selectedIndex = Math.max(0, stops.indexOf(cutoff));
    const marker = Math.round(
        selectedIndex * (trackLength - 1) / Math.max(1, stops.length - 1),
    );
    const track: TextChunk[] = Array.from(
        { length: trackLength },
        (_, index) =>
            fg(index === marker ? TUI_ACCENT : TUI_ELEMENT)(
                index === marker ? "▲" : "─",
            ),
    );
    const optionLine = Array.from({ length: trackLength }, () => " ");
    let nextStart = 0;
    stops.forEach((choice, index) => {
        const position = Math.round(
            index * (trackLength - 1) / Math.max(1, stops.length - 1),
        );
        const start = Math.max(
            nextStart,
            0,
            Math.min(
                trackLength - choice.length,
                position - Math.floor(choice.length / 2),
            ),
        );
        for (let offset = 0; offset < choice.length; offset += 1) {
            optionLine[start + offset] = choice[offset] ?? " ";
        }
        nextStart = start + choice.length + 1;
    });
    const axisTone = focused ? TUI_ACCENT : TUI_MUTED;
    return [
        [fg(axisTone)(clippedTo(axis, width))],
        track,
        [fg(focused ? TUI_TEXT : TUI_MUTED)(optionLine.join(""))],
    ];
}

const LISTED_SCORE_WIDTH = 9;
const LISTED_RATES_WIDTH = 6;
const IMAGE_GLYPH = "i";
const LISTED_TRAILING_WIDTH = 2 + 1 + 1 + IMAGE_GLYPH.length + 1 + 1;

function showsListedFactsHeader(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "model" && state.tab === "all";
}

function listedFactCell(text: string, width: number): string {
    return text.length >= width ? text.slice(0, width) : text.padStart(width);
}

function listedFactsHeaderText(): string {
    return `${"WA Score*".padStart(LISTED_SCORE_WIDTH)}  ${
        "7:2:1".padStart(LISTED_RATES_WIDTH)
    }${" ".repeat(LISTED_TRAILING_WIDTH)}`;
}

function listedFactsParts(
    option: TuiSettingsPickerOption,
): readonly DialogMetaPart[] {
    const score = listedFactCell(
        option.waScore === undefined ? "" : String(option.waScore),
        LISTED_SCORE_WIDTH,
    );
    const rates = listedFactCell(
        formatBlendedRate(option.pricing) ?? "",
        LISTED_RATES_WIDTH,
    );
    const image = option.images === true
        ? IMAGE_GLYPH
        : " ".repeat(IMAGE_GLYPH.length);
    const mark = option.pooledRank !== undefined ? "★" : " ";
    return [
        { text: `${score}  ${rates}  ` },
        option.onPareto === true
            ? { text: "P", tone: "positive" }
            : { text: " " },
        { text: ` ${image} ${mark}` },
    ];
}

function optionMetaPrefixParts(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
    detailed: boolean,
): readonly DialogMetaPart[] {
    const parts: DialogMetaPart[] = [];
    const separated = (part: DialogMetaPart): void => {
        if (parts.length > 0) {
            parts.push({ text: " · " });
        }
        parts.push(part);
    };
    if (
        option.provider !== undefined
        && !detailed
        && (option.inTopPicks === true || !isProviderGrouped(state))
    ) {
        separated({ text: option.provider });
    }
    if (option.recommended === true && option.inTopPicks !== true) {
        separated({ text: "top pick", tone: "positive" });
    }
    if (option.poolName !== undefined && option.model !== undefined) {
        separated({ text: option.model });
    }
    if (option.unavailable === true) {
        separated({ text: "unavail" });
    }
    return parts;
}

function metaPartsLength(parts: readonly DialogMetaPart[]): number {
    return parts.reduce((total, part) => total + part.text.length, 0);
}

function optionMeta(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
    detailed = false,
    listedPrefixWidth = 0,
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
    if (state.kind === "provider") {
        return option.connected === true
            ? [{ text: "connected", tone: "positive" }]
            : undefined;
    }
    if (state.kind !== "model") {
        return undefined;
    }
    if (
        state.tab === "defaults" || state.tab === "actions"
        || tuiModelActionOfValue(option.value) !== undefined
    ) {
        return option.description === ""
            ? undefined
            : [{ text: option.description }];
    }
    const prefix = optionMetaPrefixParts(state, option, detailed);
    const parts: DialogMetaPart[] = [...prefix];
    if (
        state.tab === "all"
        && option.section === undefined
        && tuiModelActionOfValue(option.value) === undefined
    ) {
        const pad = Math.max(0, listedPrefixWidth - metaPartsLength(prefix));
        if (pad > 0) {
            parts.push({ text: " ".repeat(pad) });
        }
        parts.push(...listedFactsParts(option));
    }
    if (
        state.tab === "pool"
        && option.section === undefined
        && tuiModelActionOfValue(option.value) === undefined
        && option.pooledRank !== undefined
        && option.unverified !== true
    ) {
        if (parts.length > 0) {
            parts.push({ text: " · " });
        }
        parts.push({ text: "✓", tone: "positive" });
    }
    return parts.length === 0 ? undefined : parts;
}

export function sessionPickerLists(
    agent: RegisteredAgentSummary,
    includeUntitled = false,
): boolean {
    if (agent.status === "closed" || agent.status === "failed") return false;
    return includeUntitled || agent.title !== undefined
        || agent.has_user_content === true || agent.parent_id !== undefined
        || agent.forked_from !== undefined;
}

function modelEmptyMessage(state: TuiAnySettingsPickerState): string {
    if (state.kind !== "model") return "No matches found";
    if (state.query !== "") {
        return state.tab === "pool"
            ? "No shortlisted models match. Tab switches to All models."
            : "No models match that search.";
    }
    if (state.modelCatalogUnavailable === true) {
        return "Models arrive with a conversation. Start one, then reopen this.";
    }
    if (state.tab !== "pool") {
        return "No models yet. Ctrl+F asks your providers for their catalogs.";
    }
    return modelPageEntry(state) === undefined
        ? "Nothing shortlisted yet. Tab switches to All models."
        : "Nothing shortlisted yet. More above adds the current model.";
}

function modelEmptyDetailBody(
    state: TuiAnySettingsPickerState,
    width: number,
): readonly string[] {
    const [, ...rest] = modelEmptyMessage(state).split(". ");
    return wrappedTo(rest.join(". "), width);
}

function emptyPickerMessage(state: TuiAnySettingsPickerState): string {
    if (state.kind === "extension") {
        return "No options available";
    }
    if (
        state.kind === "model"
        && (state.tab === "pool" || state.tab === "all")
    ) {
        return modelEmptyMessage(state);
    }
    if (state.kind === "model_assignment") {
        return "No shortlisted models. Add one to the shortlist to assign it here.";
    }
    if (state.kind !== "session") {
        return "No matches found";
    }
    return state.loading === true
        ? "Loading conversations…"
        : "No conversations found";
}

const THEME_LABEL_WIDTH = 17;

function renderThemePickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiSettingsPickerState,
    nodes: Renderable[],
    search: ReturnType<typeof createDialogSearchNode>,
    pointer?: DialogRowPointer,
): void {
    const header = dialogHeaderNode(renderer, "Theme");
    updateDialogSearchNode(
        search,
        state.query,
        "Search",
        true,
        state.queryCursor,
    );
    box.add(header);
    box.add(search);
    nodes.push(header);

    const matches = new Set(state.options.map((option) => option.value));
    const selectableIndex = new Map(
        state.options.map((option, index) => [option.value, index]),
    );
    state.allOptions.forEach((option) => {
        const active = option.value === state.options[state.selectedIndex]?.value;
        const current = option.value === state.initialTheme;
        const matched = matches.has(option.value);
        const row = new TextRenderable(renderer, {
            content: themeRowContent(option, active, current, matched),
            bg: active && TUI_CHROME !== "plain" ? TUI_ACCENT
                : active ? TUI_ELEMENT : TUI_PANEL,
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
    const selectedColor = active && TUI_CHROME !== "plain"
        ? TUI_SELECTION_TEXT
        : TUI_ACCENT;
    const labelColor = matched
        ? (active || current ? selectedColor : TUI_TEXT)
        : TUI_MUTED;
    const chunks: TextChunk[] = [
        active ? fg(selectedColor)("› ") : fg(TUI_PANEL)("  "),
        fg(active ? selectedColor : TUI_ACCENT)(current ? "● " : "  "),
        fg(labelColor)(option.label.padEnd(THEME_LABEL_WIDTH)),
        ...themeSwatchChunks(option.value as TuiThemeName, matched),
        fg(active && TUI_CHROME !== "plain"
            ? TUI_SELECTION_TEXT
            : matched ? TUI_MUTED : TUI_PANEL)(`  ${option.description}`),
    ];
    return new StyledText(chunks);
}

function themeSwatchChunks(name: TuiThemeName, matched: boolean): TextChunk[] {
    const swatch = tuiThemeSwatch(name);
    if (swatch === undefined) {
        return [fg(TUI_MUTED)("░░ ░░ ░░ ░░")];
    }
    return swatch.flatMap((color, index) => [
        ...(index === 0 ? [] : [fg(TUI_PANEL)(" ")]),
        fg(matched ? color : TUI_MUTED)("██"),
    ]);
}

export function switchedModelTab(
    state: TuiSettingsPickerState,
    tab: TuiModelPickerTab,
): TuiSettingsPickerState {
    if (state.kind !== "model") {
        return state;
    }
    const selectedValue = state.options[state.selectedIndex]?.value;
    const options = modelListFor(state, { tab, query: "" });
    return {
        ...state,
        tab,
        options,
        query: "",
        modelFocus: "list",
        modelActionIndex: 0,
        selectedIndex: restoredCursor(options, selectedValue, state.initialModel),
    };
}

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
        option.action === true
        || `${option.label} ${option.value} ${option.description} ${
                option.searchText ?? ""
            }`
            .toLowerCase()
            .includes(normalized)
    );
}

function searched(
    state: TuiSettingsPickerState,
    query: string,
    queryCursor = query.length,
): TuiSettingsPickerTransition {
    const options = state.kind !== "model"
        ? matching(state.allOptions, query)
        : modelListFor(state, { query });
    const next = {
        ...state,
        options,
        selectedIndex: 0,
        query,
        queryCursor,
        ...(state.kind === "model" ? { modelFocus: "list" as const } : {}),
    };
    return {
        state: next,
        handled: true,
        ...themePreview(next),
    };
}

function pickerIsSearchable(state: TuiAnySettingsPickerState): boolean {
    return state.kind !== "extension"
        && state.kind !== "configure"
        && state.kind !== "pool_verify_scope"
        && state.kind !== "catalog_refresh_scope"
        && !(state.kind === "model_assignment"
            && state.modelAssignment === "subagents");
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
            ...(held?.entry.waScore === undefined
                ? {}
                : { waScore: held.entry.waScore }),
            ...(held?.entry.pricing === undefined
                ? {}
                : { pricing: held.entry.pricing }),
            ...(held?.entry.onPareto === true ? { onPareto: true } : {}),
        };
    };
    const runnable = (available ?? []).map((model) => {
        const value = providerModelKey(model.provider, model.model);
        return {
            value,
            label: modelRowLabel(model),
            description: model.description,
            searchText: `${model.provider} ${model.model}${
                poolEntry.get(value)?.entry.poolName === undefined
                    ? ""
                    : ` ${poolEntry.get(value)?.entry.poolName}`
            }`,
            provider: model.provider,
            model: model.model,
            ...(model.refreshable === true ? { refreshable: true } : {}),
            ...(model.hiddenByDefault === undefined
                ? {}
                : { hiddenByDefault: model.hiddenByDefault }),
            ...recommendationMarks(model),
            ...poolMarks(value),
            ...(model.imageSupport === true || poolEntry.get(value)?.entry.imageSupport === true
                ? { images: true }
                : {}),
            ...(model.waScore === undefined ? {} : { waScore: model.waScore }),
            ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
            ...(model.onPareto === true ? { onPareto: true } : {}),
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
            label: entry.poolName ?? modelRowLabel(entry),
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
            ...(entry.waScore === undefined ? {} : { waScore: entry.waScore }),
            ...(entry.pricing === undefined ? {} : { pricing: entry.pricing }),
            ...(entry.onPareto === true ? { onPareto: true } : {}),
        }];
    });
    return [...runnable, ...orphanEntries].toSorted((left, right) =>
        left.provider.localeCompare(right.provider)
            || left.label.localeCompare(right.label)
    );
}

function modelRowLabel(
    model: Pick<SuggestedModel, "model" | "label">,
): string {
    const maker = model.model.split("/", 1)[0];
    if (maker === undefined || !model.model.includes("/")) {
        return model.label;
    }
    const colon = model.label.indexOf(":");
    if (colon === -1) return model.label;
    const prefix = model.label.slice(0, colon);
    return prefix.localeCompare(maker, undefined, { sensitivity: "base" }) === 0
        ? model.label.slice(prefix.length + 1).trimStart()
        : model.label;
}

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

function modelTabRows(
    allOptions: readonly TuiSettingsPickerOption[],
    tab: TuiModelPickerTab,
    revealAll = false,
    assignmentOptions: readonly TuiSettingsPickerOption[] = [],
    actionOptions: readonly TuiSettingsPickerOption[] = [],
    intelligenceCutoff: IntelligenceCutoff = "any",
    keepModel?: string,
): readonly TuiSettingsPickerOption[] {
    const actions = availableModelActionOptions(allOptions, actionOptions);
    if (tab === "help") {
        return [];
    }
    if (tab === "actions") {
        return actions;
    }
    if (tab === "defaults") {
        return assignmentOptions;
    }
    if (tab === "all") {
        return allOptions.filter((option) =>
            option.unavailable !== true
            && (revealAll || option.hiddenByDefault === undefined
                || option.pooledRank !== undefined)
            && (passesIntelligenceCutoff(option.waScore, intelligenceCutoff)
                || option.model === keepModel
                || option.value === keepModel)
        );
    }
    return allOptions
        .filter((option) => option.pooledRank !== undefined)
        .toSorted((left, right) => left.pooledRank! - right.pooledRank!);
}

function availableModelActionOptions(
    allOptions: readonly TuiSettingsPickerOption[],
    actionOptions: readonly TuiSettingsPickerOption[],
): readonly TuiSettingsPickerOption[] {
    return actionOptions.filter((action) => {
        if (tuiModelActionOfValue(action.value) !== "shortlist_current") {
            return true;
        }
        return !allOptions.some((option) =>
            option.provider === action.provider
            && option.model === action.model
            && option.pooledRank !== undefined
        );
    });
}

export const TUI_TOP_PICKS_SECTION = "Top picks";

function modelListFor(
    state: TuiSettingsPickerState,
    patch: {
        collapsed?: readonly string[];
        query?: string;
        revealAll?: boolean;
        tab?: TuiModelPickerTab;
        intelligenceCutoff?: IntelligenceCutoff;
    } = {},
): readonly TuiSettingsPickerOption[] {
    return modelPickerOptions(
        state.allOptions,
        patch.tab ?? state.tab ?? "all",
        patch.collapsed ?? state.collapsed ?? [],
        patch.query ?? state.query,
        patch.revealAll ?? state.revealAll === true,
        state.assignmentOptions ?? [],
        state.actionOptions ?? [],
        patch.intelligenceCutoff ?? state.intelligenceCutoff ?? "any",
        state.initialModel,
    );
}

function modelPickerOptions(
    allOptions: readonly TuiSettingsPickerOption[],
    tab: TuiModelPickerTab,
    collapsed: readonly string[],
    query: string,
    revealAll = false,
    assignmentOptions: readonly TuiSettingsPickerOption[] = [],
    actionOptions: readonly TuiSettingsPickerOption[] = [],
    intelligenceCutoff: IntelligenceCutoff = "any",
    keepModel?: string,
): readonly TuiSettingsPickerOption[] {
    const rows = modelTabRows(
        allOptions,
        tab,
        revealAll || query !== "",
        assignmentOptions,
        actionOptions,
        query === "" ? intelligenceCutoff : "any",
        keepModel,
    );
    const matched = query === "" ? rows : matching(rows, query);
    if (tab === "pool" || tab === "defaults" || tab === "actions") {
        return matched;
    }
    const actions = query === "" ? [] : matching(actionOptions, query);
    return [
        ...(actions.length === 0
            ? []
            : [sectionHeader("Actions", actions, []), ...actions]),
        ...sectionedOptions(
            matched,
            query === "" ? collapsed : [],
            tab === "all",
            groupTotals(allOptions, tab),
        ),
    ];
}

function groupTotals(
    allOptions: readonly TuiSettingsPickerOption[],
    tab: TuiModelPickerTab,
): ReadonlyMap<string, number> {
    const totals = new Map<string, number>();
    for (const row of modelTabRows(allOptions, tab, true)) {
        const label = row.group ?? row.provider ?? "Other";
        totals.set(label, (totals.get(label) ?? 0) + 1);
    }
    return totals;
}

function sectionHeader(
    label: string,
    rows: readonly TuiSettingsPickerOption[],
    collapsed: readonly string[],
    total = rows.length,
): TuiSettingsPickerOption {
    const closed = collapsed.includes(label);
    const count = total > rows.length
        ? `${rows.length} of ${total}`
        : `${rows.length}`;
    return {
        value: sectionValue(label),
        label: closed ? `${label} (${count})` : label,
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
    totals: ReadonlyMap<string, number> = new Map(),
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
        options.push(
            sectionHeader(label, group, collapsed, totals.get(label) ?? group.length),
        );
        if (!collapsed.includes(label)) {
            options.push(...group);
        }
    });
    return options;
}

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

function sectionLabels(
    state: TuiSettingsPickerState,
): readonly string[] {
    return modelListFor(state, { collapsed: [] }).flatMap((option) => option.section === undefined ? [] : [option.section]);
}

function enclosingSection(
    state: TuiAnySettingsPickerState,
): (TuiSettingsPickerOption & { readonly section: string }) | undefined {
    if (state.kind !== "model") {
        return undefined;
    }
    for (let index = state.selectedIndex; index >= 0; index--) {
        const option = state.options[index];
        if (option?.section !== undefined) {
            return { ...option, section: option.section };
        }
    }
    return undefined;
}

function toggledSection(
    state: TuiSettingsPickerState,
    label: string,
): TuiSettingsPickerTransition {
    const collapsed = (state.collapsed ?? []).includes(label)
        ? (state.collapsed ?? []).filter((entry) => entry !== label)
        : [...(state.collapsed ?? []), label];
    const options = modelListFor(state, { collapsed });
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

function modelActionTransition(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): TuiSettingsPickerTransition | undefined {
    const action = tuiModelActionOfValue(option.value);
    if (action === undefined) {
        return undefined;
    }
    if (action === "refresh") {
        return { state, handled: true, refreshCatalogScope: true };
    }
    if (action === "verify_pool") {
        return { state, handled: true, poolVerifySweep: true };
    }
    if (
        action === "shortlist_current"
        && option.provider !== undefined
        && option.model !== undefined
    ) {
        return {
            state,
            handled: true,
            poolToggle: {
                action: "add",
                provider: option.provider,
                model: option.model,
            },
        };
    }
    if (action === "providers") {
        return { state, handled: true, openProviders: true };
    }
    if (action === "reveal_all") {
        const revealAll = state.revealAll !== true;
        const revealed = switchedModelTab({ ...state, revealAll }, "all");
        return { state: revealed, handled: true };
    }
    return unchanged(state, true);
}

function pickerSelection(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): TuiSettingsPickerSelection {
    const kind = state.kind;
    if (kind === "model") {
        const assignment = modelAssignmentOfValue(option.value);
        if (assignment !== undefined) {
            return { kind: "model_assignment_open", assignment };
        }
        if (option.value === CONTEXT_LIMIT_VALUE) {
            return { kind: "menu", target: "context_limit" };
        }
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
        if (state.pendingModel !== undefined) {
            const pending = state.pendingModel;
            if (pending.assignment !== undefined) {
                return {
                    kind: "model_assignment",
                    assignment: pending.assignment,
                    provider: pending.provider,
                    model: pending.model,
                    reasoningEffort: value as ModelReasoningEffort,
                };
            }
            return {
                kind: "model",
                provider: pending.provider,
                model: pending.model,
                reasoningEffort: value as ModelReasoningEffort,
            };
        }
        return { kind, reasoningEffort: value as ModelReasoningEffort };
    }
    if (kind === "permissions") {
        return { kind, mode: value as ApprovalMode };
    }
    if (kind === "context_limit") {
        return {
            kind,
            limit: value === "auto" ? null : Number(value),
        };
    }
    if (kind === "developer_value") {
        const key = state.developerKey;
        if (key === undefined) {
            throw new Error("developer value pane has no key");
        }
        return {
            kind: "developer",
            patch: { [key]: value === "default" ? null : Number(value) },
        };
    }
    if (kind === "developer_settings") {
        if (value === "developer_enabled_on" || value === "developer_enabled_off") {
            return {
                kind: "developer",
                patch: { enabled: value === "developer_enabled_on" },
            };
        }
        return { kind: "menu", target: value as TuiSettingsMenuTarget };
    }
    if (kind === "session") {
        return {
            kind,
            sessionPath: value,
            sourceDisposition: state.enterDisposition ?? "stop",
            ...(option.sessionId === undefined
                ? {}
                : { sessionId: option.sessionId }),
        };
    }
    if (kind === "configure") {
        const file = state.configureFiles?.find((candidate) =>
            candidate.path === value
        );
        if (file === undefined) {
            throw new Error("configure picker option is missing file identity");
        }
        return { kind, file };
    }
    if (
        kind === "settings"
        || kind === "permission_settings"
        || kind === "reviewer_settings"
    ) {
        return { kind: "menu", target: value as TuiSettingsMenuTarget };
    }
    if (kind === "pool_verify_scope") {
        return {
            kind,
            onlyUnverified: value === POOL_VERIFY_UNVERIFIED_VALUE,
        };
    }
    if (kind === "catalog_refresh_scope") {
        return {
            kind,
            providers: value === CATALOG_REFRESH_ALL_VALUE
                ? state.allOptions
                    .map((option) => option.value)
                    .filter((name) => name !== CATALOG_REFRESH_ALL_VALUE)
                : [value],
        };
    }
    if (kind === "model_assignment") {
        if (value === MODEL_ASSIGNMENT_BROWSE_VALUE) {
            return { kind: "model_assignment_browse" };
        }
        if (value === MODEL_ASSIGNMENT_SELF_VALUE) {
            return {
                kind,
                assignment: state.modelAssignment ?? "subagents",
                allowSelf: state.assignmentAllowsSelf !== true,
            };
        }
        return {
            kind,
            assignment: state.modelAssignment ?? "extra",
            ...(value === REVIEWER_CLEAR_VALUE ? { clear: true } : {
                ...(option.provider === undefined
                    ? {}
                    : { provider: option.provider }),
                ...(option.model === undefined ? {} : { model: option.model }),
                ...(state.assignedModels?.includes(value) === true
                    ? { remove: true }
                    : {}),
            }),
        };
    }
    if (kind === "reviewer") {
        return {
            kind,
            slot: state.reviewerSlot ?? "primary",
            ...(value === REVIEWER_CLEAR_VALUE ? {} : {
                ...(option.provider === undefined
                    ? {}
                    : { provider: option.provider }),
                ...(option.model === undefined ? {} : { model: option.model }),
            }),
        };
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
                        : kind === "configure"
                            ? "Configure"
                        : kind === "permission_settings"
                            ? "Permissions"
                            : kind === "reviewer_settings"
                                ? "Classifier"
                                : kind === "reviewer"
                                    ? "Select classifier"
                                    : kind === "model_assignment"
                                        ? "Assign a model"
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

export type TuiProviderFormFieldId =
    | "id"
    | "base_url"
    | "protocol"
    | "credential"
    | "api_key";

export const TUI_PROVIDER_FORM_FIELDS: readonly TuiProviderFormFieldId[] = [
    "id",
    "base_url",
    "protocol",
    "credential",
    "api_key",
];

export function tuiProviderFormFields(
    state: TuiProviderFormState,
): readonly TuiProviderFormFieldId[] {
    const shown = state.shipped === true
        ? TUI_PROVIDER_FORM_FIELDS.filter(
            (field) => field === "base_url" || field === "api_key",
        )
        : TUI_PROVIDER_FORM_FIELDS;
    return state.credential === "api_key"
        ? shown
        : shown.filter((field) => field !== "api_key");
}

export interface TuiProviderFormState {
    readonly id: string;
    readonly baseUrl: string;
    readonly protocol: VeraProviderProtocol;
    readonly credential: VeraProviderCredential;
    readonly apiKey: string;
    readonly field: TuiProviderFormFieldId;
    readonly error?: string;
    readonly parent?: TuiSettingsPickerState;
    readonly editing?: string;
    readonly shipped?: boolean;
}

export interface TuiProviderFormDeclaration {
    readonly id: string;
    readonly declaration: VeraCustomProviderConfig;
    readonly apiKey?: string;
    readonly replaces?: string;
    readonly shipped?: boolean;
    readonly restore?: boolean;
}

export interface TuiProviderFormKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiProviderFormTransition {
    readonly state?: TuiProviderFormState;
    readonly handled: boolean;
    readonly submitted?: TuiProviderFormDeclaration;
}

export interface TuiProviderFormView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    update(state: TuiProviderFormState): void;
}

export function startTuiProviderForm(
    parent?: TuiSettingsPickerState,
    existing?: {
        readonly id: string;
        readonly baseUrl: string;
        readonly protocol: VeraProviderProtocol;
        readonly credential: VeraProviderCredential;
        readonly apiKey?: string;
        readonly shipped?: boolean;
    },
): TuiProviderFormState {
    return {
        id: existing?.id ?? "",
        baseUrl: existing?.baseUrl ?? "",
        protocol: existing?.protocol ?? "openai-chat",
        credential: existing?.credential ?? "api_key",
        apiKey: existing?.apiKey ?? "",
        field: existing === undefined ? "id" : "base_url",
        ...(parent === undefined ? {} : { parent }),
        ...(existing === undefined ? {} : { editing: existing.id }),
        ...(existing?.shipped === true ? { shipped: true } : {}),
    };
}

export function handleTuiProviderFormPaste(
    state: TuiProviderFormState,
    text: string,
): TuiProviderFormState {
    const pasted = text.replaceAll(PROVIDER_FORM_CONTROL_RUN, "").trim();
    if (pasted.length === 0 || !providerFormTextField(state.field)) {
        return state;
    }
    return editedProviderFormField(
        state,
        providerFormFieldValue(state, state.field) + pasted,
    );
}

export function handleTuiProviderFormKey(
    state: TuiProviderFormState,
    key: TuiProviderFormKey,
): TuiProviderFormTransition {
    if (key.name === "escape") {
        return { handled: true };
    }
    const binding = tuiBindingId("provider_form", key);
    if (binding === "next_form_field") {
        return { state: movedProviderFormField(state, 1), handled: true };
    }
    if (binding === "previous_form_field") {
        return { state: movedProviderFormField(state, -1), handled: true };
    }
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return { state, handled: true };
    }
    if (key.name === "up" || key.name === "down") {
        return {
            state: movedProviderFormField(state, key.name === "up" ? -1 : 1),
            handled: true,
        };
    }
    if (
        !providerFormTextField(state.field)
        && (key.name === "left" || key.name === "right" || key.name === "space")
    ) {
        return { state: toggledProviderFormChoice(state), handled: true };
    }
    if (key.name === "return" || key.name === "enter") {
        return submittedProviderForm(state);
    }
    if (!providerFormTextField(state.field)) {
        return { state, handled: true };
    }
    if (key.name === "backspace") {
        return {
            state: editedProviderFormField(
                state,
                providerFormFieldValue(state, state.field).slice(0, -1),
            ),
            handled: true,
        };
    }
    const typed = key.sequence !== undefined && key.sequence.length > 0
        ? key.sequence
        : key.name.length === 1
        ? key.name
        : undefined;
    if (typed === undefined || PROVIDER_FORM_CONTROL_CHARACTERS.test(typed)) {
        return { state, handled: true };
    }
    return {
        state: editedProviderFormField(
            state,
            providerFormFieldValue(state, state.field) + typed,
        ),
        handled: true,
    };
}

function movedProviderFormField(
    state: TuiProviderFormState,
    step: 1 | -1,
): TuiProviderFormState {
    const fields = tuiProviderFormFields(state);
    const at = fields.indexOf(state.field);
    const next = (at + step + fields.length) % fields.length;
    return { ...state, field: fields[next]! };
}

function submittedProviderForm(
    state: TuiProviderFormState,
): TuiProviderFormTransition {
    const id = state.id.trim();
    const baseUrl = state.baseUrl.trim();
    if (id.length === 0) {
        return providerFormError(state, "id", "a name is required");
    }
    if (/\s/.test(id)) {
        return providerFormError(state, "id", "a name cannot contain spaces");
    }
    if (!isSafeProviderId(id)) {
        return providerFormError(
            state,
            "id",
            "use lowercase letters, numbers, dots, dashes, or underscores",
        );
    }
    if (state.shipped !== true && isVeraProviderId(id)) {
        return providerFormError(state, "id", `${id} is a provider Vera ships`);
    }
    if (baseUrl.length === 0 && state.shipped !== true) {
        return providerFormError(state, "base_url", "a base URL is required");
    }
    const apiKey = state.credential === "api_key" ? state.apiKey.trim() : "";
    return {
        handled: true,
        submitted: {
            id,
            declaration: {
                protocol: state.protocol,
                base_url: baseUrl,
                credential: state.credential,
            },
            ...(apiKey.length === 0 ? {} : { apiKey }),
            ...(state.editing === undefined || state.editing === id
                ? {}
                : { replaces: state.editing }),
            ...(state.shipped === true ? { shipped: true } : {}),
            ...(state.shipped === true && baseUrl.length === 0
                ? { restore: true }
                : {}),
        },
    };
}

function providerFormError(
    state: TuiProviderFormState,
    field: TuiProviderFormFieldId,
    error: string,
): TuiProviderFormTransition {
    return { state: { ...state, field, error }, handled: true };
}

function providerFormTextField(field: TuiProviderFormFieldId): boolean {
    return field === "id" || field === "base_url" || field === "api_key";
}

function providerFormFieldValue(
    state: TuiProviderFormState,
    field: TuiProviderFormFieldId,
): string {
    return field === "id"
        ? state.id
        : field === "api_key"
        ? state.apiKey
        : state.baseUrl;
}

function editedProviderFormField(
    state: TuiProviderFormState,
    value: string,
): TuiProviderFormState {
    const { error: _error, ...rest } = state;
    return state.field === "id"
        ? { ...rest, id: value }
        : state.field === "api_key"
        ? { ...rest, apiKey: value }
        : { ...rest, baseUrl: value };
}

function toggledProviderFormChoice(
    state: TuiProviderFormState,
): TuiProviderFormState {
    const { error: _error, ...rest } = state;
    if (state.field === "protocol") {
        return {
            ...rest,
            protocol: state.protocol === "openai-chat"
                ? "anthropic-messages"
                : "openai-chat",
        };
    }
    return state.credential === "api_key"
        ? { ...rest, credential: "none", apiKey: "" }
        : { ...rest, credential: "api_key" };
}

export function tuiProviderFormRows(
    state: TuiProviderFormState,
): readonly StyledText[] {
    return tuiProviderFormFields(state).map((field) => {
        const focused = state.field === field;
        const value = providerFormTextField(field)
            ? providerFormFieldValue(state, field)
            : field === "protocol"
            ? state.protocol
            : state.credential === "api_key"
            ? "API key"
            : "none";
        const empty = value.length === 0;
        const shown = field === "api_key" && !focused
            ? "•".repeat(Math.min(value.length, 12))
            : value;
        return new StyledText([
            fg(focused ? TUI_ACCENT : TUI_MUTED)(focused ? "› " : "  "),
            fg(TUI_MUTED)(`${PROVIDER_FORM_LABELS[field].padEnd(10)} `),
            empty
                ? italic(fg(TUI_MUTED)(PROVIDER_FORM_PLACEHOLDERS[field]))
                : fg(TUI_TEXT)(shown),
            ...(focused && providerFormTextField(field)
                ? [fg(TUI_ACCENT)("▏")]
                : []),
        ]);
    });
}

const PROVIDER_FORM_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const PROVIDER_FORM_CONTROL_RUN = /[\u0000-\u001f\u007f]/g;

const PROVIDER_FORM_LABELS: Readonly<Record<TuiProviderFormFieldId, string>> = {
    id: "Name",
    base_url: "Base URL",
    protocol: "Protocol",
    credential: "Credential",
    api_key: "Key",
};

const PROVIDER_FORM_PLACEHOLDERS: Readonly<
    Record<TuiProviderFormFieldId, string>
> = {
    id: "my-endpoint",
    base_url: "https://…/v1",
    protocol: "openai-chat",
    credential: "API key",
    api_key: "paste or type it, or leave it for later",
};

export function createTuiProviderFormView(
    renderer: RenderContext,
): TuiProviderFormView {
    const title = new TextRenderable(renderer, {
        content: "Declare a provider",
        fg: TUI_TEXT,
        attributes: 1,
        width: "100%",
        height: 1,
    });
    const hint = new TextRenderable(renderer, {
        content: "An OpenAI- or Anthropic-compatible endpoint of your own.",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
    });
    const rows = TUI_PROVIDER_FORM_FIELDS.map((field, index) =>
        new TextRenderable(renderer, {
            id: `provider-form-${field}`,
            content: "",
            width: "100%",
            height: "auto",
            wrapMode: "char",
            ...(index === 0 ? { marginTop: 1 } : {}),
        })
    );
    const error = new TextRenderable(renderer, {
        content: "",
        fg: TUI_ACCENT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "provider-form",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "70%",
        height: "auto",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
    });
    box.add(title);
    box.add(hint);
    for (const row of rows) {
        box.add(row);
    }
    box.add(error);
    box.add(footer);
    const surface = centeredDialogSurface(renderer, "provider-form-surface", box);
    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(title, { fg: "text" }),
            tuiThemeProperties(hint, { fg: "muted" }),
            tuiThemeProperties(error, { fg: "accent" }),
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        update(state): void {
            title.content = state.shipped === true
                ? `Edit ${state.id}`
                : state.editing === undefined
                ? "Declare a provider"
                : "Edit provider";
            hint.content = state.shipped === true
                ? "Where it answers, and the key that reaches it. Empty the"
                    + " URL to go back to the one Vera ships."
                : state.editing === undefined
                ? "An OpenAI- or Anthropic-compatible endpoint of your own."
                : "Change the endpoint, the protocol, or the key you stored.";
            const lines = tuiProviderFormRows(state);
            rows.forEach((row, index) => {
                const line = lines[index];
                row.visible = line !== undefined;
                row.content = line ?? new StyledText([]);
            });
            error.content = state.error ?? "";
            footer.content = `↑↓ ${tuiKeyHint("next_form_field")} · ${
                providerFormTextField(state.field) ? "←→ move" : "←→ change"
            } · ⏎ save · esc cancel`;
        },
    };
}
