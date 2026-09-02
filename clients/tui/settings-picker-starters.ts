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
import type { SuggestedModel } from "../../src/model/supported-models.ts";
import type { PooledModel } from "../../src/model/catalog-view.ts";
import { isJobAssignmentId, JOB_ASSIGNMENT_INTENTS, type ModelAssignmentId } from "../../src/config/model-assignments.ts";
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
import { type TuiThemeName } from "./theme.ts";
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

import {
    CATALOG_REFRESH_ALL_VALUE,
    MODEL_ASSIGNMENT_BROWSE_VALUE,
    MODEL_ASSIGNMENT_SELF_VALUE,
    POOL_VERIFY_ALL_VALUE,
    POOL_VERIFY_UNVERIFIED_VALUE,
    REVIEWER_CLEAR_VALUE,
    TUI_DECLARE_PROVIDER_VALUE,
    TUI_PROVIDER_GROUP_RANK,
    type TuiAssignmentParentModel,
    type TuiConfigureFile,
    type TuiDeveloperKey,
    type TuiExtensionPickerAction,
    type TuiExtensionPickerRow,
    type TuiExtensionPickerState,
    type TuiModelPickerTab,
    type TuiPendingModelChoice,
    type TuiProviderRow,
    type TuiReviewerSlot,
    type TuiSettingsMenuKind,
    type TuiSettingsMenuTarget,
    type TuiSettingsPickerKind,
    type TuiSettingsPickerOption,
    type TuiSettingsPickerSelection,
    type TuiSettingsPickerState,
    tuiPickerMenuAncestor,
} from "./settings-picker-types.ts";

import {
    defaultCollapsedSections,
    modelOptions,
    modelPickerOptions,
    modelSyncedFocus,
    modelTabLabel,
    modelTabRows,
    providerModelKey,
    searched,
} from "./settings-picker-model.ts";

export const PERMISSION_OPTIONS: readonly TuiSettingsPickerOption[] = [
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

export const THEME_OPTIONS: readonly TuiSettingsPickerOption[] = [
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
        // The pane it was opened from survives a snapshot. A rebuild is the host answering an edit made inside this pane, not a fresh way in, so adding a model must not turn escape into "…
        ...(state.parent === undefined ? {} : { parent: state.parent }),
        ...(state.canUndoPoolChange === true
            ? { canUndoPoolChange: true }
            : {}),
        selectedIndex: selectedIndex === -1
            ? Math.min(state.selectedIndex, Math.max(0, options.length - 1))
            : selectedIndex,
    };
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

export function levelOption(level: ReasoningLevel): TuiSettingsPickerOption {
    return {
        value: level.id,
        label: level.label,
        description: level.description ?? "",
    };
}

export function permissionOptions(
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

export const SETTINGS_MENU_OPTIONS: readonly TuiSettingsPickerOption[] = [
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

export const CONTEXT_LIMIT_OPTIONS: readonly TuiSettingsPickerOption[] = [
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

export interface DeveloperValueRow {
    readonly key: TuiDeveloperKey;
    readonly target: TuiSettingsMenuTarget;
    readonly label: string;
    readonly description: string;
    readonly options: readonly TuiSettingsPickerOption[];
    readonly format: (value: number) => string;
}

export const DEVELOPER_VALUE_ROWS: readonly DeveloperValueRow[] = [
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

export const PERMISSION_SETTINGS_OPTIONS: readonly TuiSettingsPickerOption[] = [
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
            hasCredential: provider.hasCredential,
            ...(provider.answerState === undefined
                ? {}
                : { answerState: provider.answerState }),
            ...(provider.refreshable === true ? { refreshable: true } : {}),
            ...(provider.declared === true ? { declared: true } : {}),
            ...(provider.endpointEditable === true
                ? { endpointEditable: true }
                : {}),
        }));
    const firstUnconnected = rows.findIndex(
        (option) => option.answerState !== "connected",
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

export const TUI_DECLARE_PROVIDER_OPTION: TuiSettingsPickerOption = {
    value: TUI_DECLARE_PROVIDER_VALUE,
    label: "Declare a provider…",
    description: "one Vera does not ship, by base URL",
    searchText: "declare custom new add provider",
    action: true,
};

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

export function reviewerSlotLabel(selection?: ReviewerModelSelection): string {
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

/** The last gate: the chosen provider's models, one of which is about to be asked a real question. */
export function startTuiOnboardingModelPicker(
    provider: string,
    models: readonly {
        readonly model: string;
        readonly label: string;
    }[],
    rail: string,
): TuiSettingsPickerState {
    const options: readonly TuiSettingsPickerOption[] = models.map((entry) => ({
        value: entry.model,
        label: entry.label,
        description: entry.model,
    }));
    return {
        kind: "onboarding_model",
        onboardingProvider: provider,
        title: "Choose a model",
        subtitle: rail,
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
    };
}

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

export function unsetAssignmentMeans(assignment: ModelAssignmentId): string {
    if (assignment === "subagents") return "subagent spawns are refused";
    return isJobAssignmentId(assignment)
        ? `uses ${JOB_ASSIGNMENT_INTENTS[assignment] ?? "this session's model"}`
        : "uses this session's model";
}

export function settingsMenuOptions(
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

export function markSharedSessionOptions(
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

// The workspace column does not shrink, so its budget is in terminal cells rather than characters: a name of wide glyphs would otherwise take twice the columns it was measured for…
export const SESSION_WORKSPACE_CELLS = 14;

export const SESSION_TITLE_LIMIT = 200;

export function threadSessionOptions(
    options: readonly TuiSettingsPickerOption[],
): TuiSettingsPickerOption[] {
    // Rows are tracked by position rather than by session id. A host that reported the same id twice would otherwise lose a row here, and a list that silently drops a session is worse…
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

export function sessionTitle(title: string): string {
    const normalized = title.replaceAll(/\s+/g, " ").trim();
    const characters = [...normalized];
    return characters.length <= SESSION_TITLE_LIMIT
        ? normalized
        : `${characters.slice(0, SESSION_TITLE_LIMIT - 1).join("")}…`;
}

export function sessionWorkspace(agent: RegisteredAgentSummary): string {
    const workspaceName = agent.workspace.split("/").filter(Boolean).at(-1)
        ?? agent.workspace;
    return clipToCells(workspaceName, SESSION_WORKSPACE_CELLS);
}

export function clipToCells(value: string, cells: number): string {
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

export function sessionActivity(agent: RegisteredAgentSummary, now: Date): string {
    if (agent.status === "working" || agent.status === "waiting") {
        return agent.status;
    }
    if (agent.kind === "background" && agent.status === "completed") {
        return "completed";
    }
    return agent.live ? "open" : relativeTime(agent.updated_at, now, "saved");
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
