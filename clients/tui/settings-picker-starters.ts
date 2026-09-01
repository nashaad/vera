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
    // The pane opens on Pool whenever there is one: it is the short list the
    // user built for exactly this moment. All only when the pool is empty,
    // since an empty tab answers no question at all.
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

/**
 * A short list of files that actually exist, plus the profile config the
 * editor is allowed to create. The caller owns discovery so this picker stays
 * a pure projection of the filesystem snapshot it was handed.
 */
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
    // The tab is the user's own place in the pane, so a snapshot arriving from
    // the host must not move them out of it. Adding a model from the Pool tab
    // would otherwise drop them back onto All mid-action.
    const tab = state.tab ?? "all";
    // Closed sections are the user's own place in the pane too, for the same
    // reason the tab is: a snapshot arriving from the host must not reopen
    // them under the user mid-action.
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
        // Slot rows are read from config and the pool rather than from the
        // host, so a rebuild has nothing to put back and has to carry them.
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
        // The pane it was opened from survives a snapshot. A rebuild is the host
        // answering an edit made inside this pane, not a fresh way in, so
        // adding a model must not turn escape into "close everything".
        ...(state.parent === undefined ? {} : { parent: state.parent }),
        ...(state.canUndoPoolChange === true
            ? { canUndoPoolChange: true }
            : {}),
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

/**
 * The developer pane. The toggle is the only row while the block is off: the
 * overrides are not shown as things to set and then ignored, because a row
 * that reads as a setting and changes nothing is worse than an absent one.
 */
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

/** The value pane for one developer override. */
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

/**
 * The connect pane: every provider Vera ships, grouped by how the user gets
 * access. Connected rows say so in words rather than relying on a mark.
 *
 * The list is short and hand-picked rather than fetched, so it opens with the
 * cursor on the first unconnected row: with this few rows, the one thing left
 * to do is the thing worth landing on.
 */
export function startTuiProviderPicker(
    providers: readonly TuiProviderRow[],
    options: {
        /** The row to open on, for a caller that just changed one. */
        readonly selected?: string;
        /** A line under the title, for something the pane has to say. */
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
    // A named row wins over the first unconnected one: a caller that just
    // declared or forgot something is pointing at the row the user will act on
    // next, and the default only applies when nobody said.
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

/**
 * The last row on the connect pane: the way in that does not need the chord.
 *
 * It sits below the groups because it is not one of them, and it survives
 * search because it is the answer to a query that matched nothing.
 */
export const TUI_DECLARE_PROVIDER_OPTION: TuiSettingsPickerOption = {
    value: TUI_DECLARE_PROVIDER_VALUE,
    label: "Declare a provider…",
    description: "one Vera does not ship, by base URL",
    searchText: "declare custom new add provider",
    action: true,
};

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
    // Turning the developer block on is answered by the rows it reveals, so
    // the pane that asked stays put rather than stepping back to `/settings`
    // and leaving the keypress looking like it did nothing.
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

/**
 * Two rows, because the reviewer route is ordered: the failsafe is simply the
 * next entry the router tries when the primary cannot answer.
 */
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

/**
 * Any model is offered. The reviewer is the user's call, so pooled entries are
 * a convenience list rather than a gate.
 */
export function startTuiReviewerPicker(
    slot: TuiReviewerSlot,
    pooled: readonly PooledModel[] = [],
    current?: ReviewerModelSelection,
    availableModels: readonly SuggestedModel[] = [],
): TuiSettingsPickerState {
    // Pooled entries first, then everything else the host knows about, so a
    // user who has pooled nothing still has a list to choose from.
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

/**
 * Asked before a sweep because the two answers cost differently. Re-probing a
 * model that already answered spends a call to learn what is already recorded,
 * so the cheaper one leads and the list says how many each covers.
 */
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

/**
 * Asked after the refresh row, because which providers to ask is a separate
 * question from whether to ask at all. Each row says how many models that
 * provider holds now, which is the number the refresh is about to change.
 */
export function startTuiCatalogRefreshScopePicker(
    providers: readonly { readonly name: string; readonly models: number }[],
): TuiSettingsPickerState {
    const total = providers.reduce((sum, entry) => sum + entry.models, 0);
    // The catalog is the whole list a provider offers, which is larger than the
    // model tab's count, since that one is folded. Saying which is which keeps
    // the two numbers from reading as a contradiction.
    const rows: TuiSettingsPickerOption[] = providers.map((entry) => ({
        value: entry.name,
        label: entry.name,
        description: `${entry.models} in its catalog`,
    }));
    // One provider needs no row for all of them: it would be the same call
    // twice under two names.
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
        // What this assignment is for belongs to the pane, not to one of its
        // rows: read on a row it looks like a description of that row.
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

/** What leaving an assignment unset does, which is the row's real meaning. */
export function unsetAssignmentMeans(assignment: ModelAssignmentId): string {
    if (assignment === "subagents") return "subagent spawns are refused";
    return isJobAssignmentId(assignment)
        ? `uses ${JOB_ASSIGNMENT_INTENTS[assignment] ?? "this session's model"}`
        : "uses this session's model";
}

/**
 * The menu, with the developer row saying so while the block is on. An
 * override that changes what the whole session does must be visible from the
 * menu, not only from inside the pane that set it.
 */
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
    // The current session is listed rather than hidden. Switching is a
    // re-attach with the screen left up, so its row costs nothing and answers
    // "which one am I in" without the user having to remember.
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

// The workspace column does not shrink, so its budget is in terminal cells
// rather than characters: a name of wide glyphs would otherwise take twice the
// columns it was measured for and push the row past the terminal edge.
export const SESSION_WORKSPACE_CELLS = 14;

/**
 * The longest title the picker will hold. Titles are shown whole at any width a
 * terminal has, so this is not a display measure: it is a bound on what one
 * malformed row can make the renderer pad and lay out on every visible row.
 */
export const SESSION_TITLE_LIMIT = 200;

/**
 * Order forks under the session they came from, each one deeper than its parent.
 *
 * A fork is only threaded when its parent is on the list: a fork of a session
 * that has since been trashed is a session in its own right, and hanging it off
 * nothing would say otherwise. The rest of the list keeps the order it arrived
 * in, so threading rearranges a fork and nothing else.
 */
export function threadSessionOptions(
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
    // A live session with nothing running is one someone has open, which is
    // worth saying: the rest of the column is how long ago a row was last
    // touched, and "3h" under a conversation being read right now is wrong.
    return agent.live ? "open" : relativeTime(agent.updated_at, now, "saved");
}

/**
 * Whether the session list shows this row.
 *
 * A conversation that was opened and never spoken to has no title and no turns
 * to title it by, so listing it would name something that never happened.
 * Anything asking whether there is a list worth opening asks this too, or it
 * offers a way into an empty list.
 */
export function sessionPickerLists(
    agent: RegisteredAgentSummary,
    includeUntitled = false,
): boolean {
    if (agent.status === "closed" || agent.status === "failed") return false;
    return includeUntitled || agent.title !== undefined
        || agent.has_user_content === true || agent.parent_id !== undefined
        || agent.forked_from !== undefined;
}
