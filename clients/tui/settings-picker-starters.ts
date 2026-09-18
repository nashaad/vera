import type { ImportableSessionEntry } from "../../src/host/protocol.ts";
import type { ImportableSessionListing } from "../../src/host/session-import-service.ts";
import {
    importedSessionLabel,
    importToolLabel,
} from "../../src/store/session-import-provenance.ts";
import type { ProviderCatalogState } from "../../src/providers/catalog-state.ts";
import { journeyModels } from "./model-journeys.ts";
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
    OverrideSettings,
    OverrideSettingsPatch,
    ModelTurnSettings,
    ReviewerModelDefault,
    ReviewerModelSelection,
} from "../../src/engine/model-settings.ts";
import type {
    OverrideKey,
    OverrideRow,
} from "../../src/engine/override-rows.ts";
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
    SESSION_CREATE_LEAVE_OPTIONS,
    TUI_DECLARE_PROVIDER_VALUE,
    TUI_REFRESH_PROVIDERS_VALUE,
    TUI_PROVIDER_GROUP_RANK,
    type TuiAssignmentParentModel,
    type TuiConfigureFile,
    overrideMenuTarget,
    type OverrideMenuTarget,
    type TuiExtensionPickerAction,
    type TuiExtensionPickerRow,
    type TuiExtensionPickerState,
    type TuiImportScope,
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
    OVERRIDES_RESET_VALUE,
} from "./settings-picker-types.ts";

import {
    defaultCollapsedSections,
    firstSessionOptionIndex,
    modelOptions,
    modelPickerOptions,
    modelSyncedFocus,
    modelTabRows,
    providerModelKey,
    searched,
    sessionSectionedOptions,
} from "./settings-picker-model.ts";
import {
    IDLE_GROUP,
    NEEDS_YOU_GROUP,
    RECENT_GROUP,
    WORKING_GROUP,
} from "./workspace-panel.ts";

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
        readonly providerCatalogs?: readonly ProviderCatalogState[];
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
        allOptions: settings?.providerCatalogs === undefined ? rebuilt.allOptions : rebuilt.allOptions.filter((row) => row.description !== "current model" || row.pooledRank !== undefined),
        providerCatalogs: settings?.providerCatalogs ?? state.providerCatalogs,
        modelJourney: state.modelJourney,
        journeyView: state.journeyView,
        journeyProvider: state.journeyProvider,
        journeyAvailableOnly: state.journeyAvailableOnly,
        journeyPricedOnly: state.journeyPricedOnly,
        journeyImagesOnly: state.journeyImagesOnly,
        journeyNotice: state.journeyNotice,
        journeyFeedback: state.journeyFeedback,
        journeyRetainedModels: [...new Set([...(state.journeyRetainedModels ?? []),
            ...state.allOptions.filter((row) => row.pooledRank !== undefined).map((row) => row.value)])],
        title: state.title,
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
        ...(state.journeySort === undefined ? {} : { journeySort: state.journeySort }),
        // A journey folds its own groups, so it keeps its own set even when
        // empty: the sectioned picker starts some providers closed, and those
        // must not fold groups the journey shows as open.
        ...(collapsed.length === 0 && state.modelJourney === undefined
            ? {}
            : { collapsed }),
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
    const options = state.modelJourney !== undefined
        ? journeyModels({ ...onTab, query: state.query })
        : state.query.length === 0
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
            ? state.modelJourney === undefined
                ? Math.min(state.selectedIndex, Math.max(0, options.length - 1))
                : Math.max(0, options.findIndex((option) => option.model !== undefined))
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
        value: "overrides",
        label: "Overrides",
        description: "how much context Vera keeps, and when it summarises",
        searchText:
            "developer debug compaction window tool result levers"
            + " context limit tokens memory cap",
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
    { value: "8192", label: "8k", description: "compacts within a few turns" },
    { value: "16384", label: "16k", description: "compacts within a short session" },
    { value: "32768", label: "32k", description: "compacts after real work" },
    { value: "65536", label: "64k", description: "the smallest window a model is happy in" },
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

export interface OverrideValueRow {
    readonly key: OverrideKey;
    readonly target: OverrideMenuTarget;
    readonly label: string;
    /** The trailing column, for a terminal too narrow for the detail pane. */
    readonly means: string;
    /** What the lever does, for the pane beside the list. */
    readonly detail: string;
    readonly options: readonly TuiSettingsPickerOption[];
    readonly format: (value: number | string) => string;
}

const OFF: TuiSettingsPickerOption = {
    value: "default",
    label: "Default",
    description: "use the value Vera ships with",
};

function bytes(value: number | string): string {
    return typeof value === "number"
        ? `${Math.round(value / 1_024)}k`
        : String(value);
}

function plain(value: number | string): string {
    return String(value);
}

function ratio(value: number | string): string {
    return typeof value === "number" ? value.toFixed(2) : String(value);
}

export const OVERRIDE_VALUE_ROWS: readonly OverrideValueRow[] = [
    {
        key: "contextLimit",
        target: overrideMenuTarget("contextLimit"),
        label: "Context limit",
        means: "the window every fraction below is a share of",
        detail:
            "How much of the model's window Vera will use. Every fraction here is a share of this. Unset, Vera uses the window the model declares, and a model that declares none leaves the fractions with nothing to divide.",
        format: bytes,
        options: CONTEXT_LIMIT_OPTIONS,
    },
    {
        key: "compactionTriggerFraction",
        target: overrideMenuTarget("compactionTriggerFraction"),
        label: "Compaction trigger",
        means: "share of the window that fires a compaction",
        detail:
            "How full the window gets before Vera summarises. At 0.82, a 200k window compacts near 164k.",
        format: ratio,
        options: [
            OFF,
            { value: "0.3", label: "0.30", description: "fires early" },
            { value: "0.5", label: "0.50", description: "fires at half" },
            { value: "0.7", label: "0.70", description: "fires late" },
            { value: "0.82", label: "0.82", description: "what Vera ships with" },
        ],
    },
    {
        key: "compactionTriggerTokens",
        target: overrideMenuTarget("compactionTriggerTokens"),
        label: "Compaction trigger tokens",
        means: "a fixed token count that fires a compaction",
        detail:
            "A fixed token count that fires a compaction whatever the window is. This is what a model with no declared window falls back on.",
        format: plain,
        options: [
            OFF,
            { value: "8000", label: "8000", description: "fires inside a short session" },
            { value: "24000", label: "24000", description: "fires after real work" },
            { value: "100000", label: "100000", description: "what an unknown window uses" },
        ],
    },
    {
        key: "compactionTargetTokens",
        target: overrideMenuTarget("compactionTargetTokens"),
        label: "Compaction target tokens",
        means: "how small a summary lands, when the window is unknown",
        detail:
            "How small the summary has to land, counted in tokens. Only read when the window is unknown: with a window, the target is a share of it instead.",
        format: plain,
        options: [
            OFF,
            { value: "4000", label: "4000", description: "a short note" },
            { value: "12000", label: "12000", description: "a fuller note" },
        ],
    },
    {
        key: "postCompactionTargetFraction",
        target: overrideMenuTarget("postCompactionTargetFraction"),
        label: "Post-compaction target",
        means: "share of the window a summary lands under",
        detail:
            "How much of the window is still in use once a summary lands. At 0.45, a 200k window comes back near 90k.",
        format: ratio,
        options: [
            OFF,
            { value: "0.2", label: "0.20", description: "a much smaller note" },
            { value: "0.45", label: "0.45", description: "what Vera ships with" },
            { value: "0.6", label: "0.60", description: "a longer note" },
        ],
    },
    {
        key: "summaryWordCap",
        target: overrideMenuTarget("summaryWordCap"),
        label: "Summary word cap",
        means: "the most words a summary is asked for",
        detail:
            "The most words a summary is asked for. Lower is blunter, and cheaper to carry for the rest of the session.",
        format: plain,
        options: [
            OFF,
            { value: "250", label: "250", description: "short enough to read whole" },
            { value: "750", label: "750", description: "a page" },
            { value: "3000", label: "3000", description: "what Vera ships with" },
        ],
    },
    {
        key: "retainedUserTurns",
        target: overrideMenuTarget("retainedUserTurns"),
        label: "Retained user turns",
        means: "turns kept verbatim behind the summary",
        detail:
            "How many of your most recent turns survive a compaction word for word, sitting behind the summary.",
        format: plain,
        options: [
            OFF,
            { value: "1", label: "1", description: "the last turn only" },
            { value: "2", label: "2", description: "what Vera ships with" },
            { value: "4", label: "4", description: "more recent history kept" },
        ],
    },
    {
        key: "toolResultCeilingBytes",
        target: overrideMenuTarget("toolResultCeilingBytes"),
        label: "Tool result ceiling",
        means: "the most one tool result may carry",
        detail:
            "The most one tool result may carry into the conversation. A longer one is cut, and the whole result stays on disk for the agent to read back.",
        format: bytes,
        options: [
            OFF,
            { value: "8192", label: "8k", description: "small models see a page at a time" },
            { value: "16384", label: "16k", description: "a long file is still cut" },
            { value: "65536", label: "64k", description: "what Vera ships with" },
        ],
    },
    {
        key: "toolResultTotalBudgetBytes",
        target: overrideMenuTarget("toolResultTotalBudgetBytes"),
        label: "Tool result budget",
        means: "the most every carried result may add up to",
        detail:
            "The most every carried tool result may add up to. Past it, the oldest results are replaced by stubs to make room.",
        format: bytes,
        options: [
            OFF,
            { value: "16384", label: "16k", description: "results are stubbed early" },
            { value: "49152", label: "48k", description: "a middle budget" },
            { value: "131072", label: "128k", description: "what Vera ships with" },
        ],
    },
    {
        key: "toolResultStubAfterTurns",
        target: overrideMenuTarget("toolResultStubAfterTurns"),
        label: "Stub after turns",
        means: "turns a result stays whole before it may be stubbed",
        detail:
            "How many turns a tool result stays whole before it may become a stub. It follows the aging level unless you set it yourself.",
        format: plain,
        options: [
            OFF,
            { value: "1", label: "1", description: "stubs almost at once" },
            { value: "3", label: "3", description: "what a normal window uses" },
            { value: "5", label: "5", description: "what a large window uses" },
        ],
    },
    {
        key: "toolResultAgingLevel",
        target: overrideMenuTarget("toolResultAgingLevel"),
        label: "Aging level",
        means: "which row of the aging ladder a session uses",
        detail:
            "How hard Vera pushes old tool results out of the conversation. Auto picks the row from the window: relaxed above 400k, normal above 128k, tight below that.",
        format: plain,
        options: [
            { value: "auto", label: "Auto", description: "pick the row from the window" },
            { value: "relaxed", label: "Relaxed", description: "ages late, keeps reads whole" },
            { value: "normal", label: "Normal", description: "ages at three turns" },
            { value: "tight", label: "Tight", description: "ages at the lowest gate" },
        ],
    },
];

const OVERRIDE_LABEL_WIDTH = 26;
const OVERRIDE_VALUE_WIDTH = 10;
const OVERRIDE_SOURCE_WIDTH = 9;

function overrideColumns(row: OverrideValueRow, fact: OverrideRow | undefined): string {
    const value = fact?.value === undefined ? "none" : row.format(fact.value);
    const source = fact?.source === "configured" ? "set" : "default";
    const reads = fact?.inert === undefined ? "live" : "inert";
    return row.label.padEnd(OVERRIDE_LABEL_WIDTH)
        + value.padEnd(OVERRIDE_VALUE_WIDTH)
        + source.padEnd(OVERRIDE_SOURCE_WIDTH)
        + reads;
}

/**
 * Every lever on one screen. The columns are words rather than colours so the
 * pane still reads when nothing on the terminal is coloured.
 */
/**
 * The pane beside the list: what the lever is, where its value came from, and
 * whether this session reads it at all.
 */
function overrideDetail(
    row: OverrideValueRow,
    fact: OverrideRow | undefined,
): {
    readonly detailTitle: string;
    readonly detailFacts: readonly (readonly [string, string])[];
    readonly note: string;
} {
    return {
        detailTitle: row.label,
        detailFacts: [
            ["Now", fact?.value === undefined ? "not set" : row.format(fact.value)],
            ["Source", fact?.source === "configured" ? "you set this" : "shipped default"],
            ["Engine", fact?.inert === undefined ? "reads it" : "does not read it"],
        ],
        note: fact?.inert === undefined
            ? row.detail
            : `${row.detail} Not here: ${fact.inert}.`,
    };
}

export function startTuiOverridesMenu(
    overrides: OverrideSettings | undefined,
): TuiSettingsPickerState {
    const facts = new Map(
        (overrides?.rows ?? []).map((fact) => [fact.key, fact]),
    );
    const configured = (overrides?.rows ?? []).filter((fact) =>
        fact.source === "configured"
    ).length;
    const options: TuiSettingsPickerOption[] = OVERRIDE_VALUE_ROWS.map((row) => {
        const fact = facts.get(row.key);
        return {
            value: row.target,
            label: overrideColumns(row, fact),
            description: fact?.inert ?? row.means,
            searchText: `${row.label} ${row.key}`,
            ...overrideDetail(row, fact),
        };
    });
    options.push({
        value: OVERRIDES_RESET_VALUE,
        label: "Reset all to defaults",
        description: configured === 0
            ? "nothing is set: every lever already ships as it stands"
            : `clears the ${configured} you have set`,
        action: true,
        detailTitle: "Reset all to defaults",
        detailFacts: [["Set now", configured === 0 ? "none" : String(configured)]],
        note: configured === 0
            ? "Every lever is already at the value Vera ships with, so this"
                + " would change nothing."
            : "Drops every lever above out of your config. Nothing else in the"
                + " config is touched.",
    });
    return {
        kind: "overrides_settings",
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
        title: "Overrides",
        subtitle: configured === 0
            ? "every lever is at its shipped default"
            : `${configured} set, the rest shipped`,
        ...(overrides === undefined ? {} : { overrides }),
    };
}

export function startTuiOverrideValuePicker(
    target: TuiSettingsMenuTarget,
    overrides: OverrideSettings | undefined,
): TuiSettingsPickerState | undefined {
    const row = OVERRIDE_VALUE_ROWS.find(
        (candidate) => candidate.target === target,
    );
    if (row === undefined) {
        return undefined;
    }
    const fact = overrides?.rows.find((entry) => entry.key === row.key);
    const value = fact?.source === "configured" && fact.value !== undefined
        ? String(fact.value)
        : row.key === "toolResultAgingLevel"
        ? "auto"
        : "default";
    return {
        kind: "override_value",
        allOptions: row.options,
        options: row.options,
        selectedIndex: Math.max(
            0,
            row.options.findIndex((option) => option.value === value),
        ),
        query: "",
        title: row.label,
        overrideKey: row.key,
        ...(overrides === undefined ? {} : { overrides }),
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
    const allOptions = [
        ...rows,
        ...(rows.some((row) => row.refreshable === true) ? [{
            value: TUI_REFRESH_PROVIDERS_VALUE,
            label: "Refresh providers",
            description: "read model catalogs from all connected providers",
            action: true,
        }] : []),
        TUI_DECLARE_PROVIDER_OPTION,
    ];
    const named = options.selected === undefined
        ? -1
        : allOptions.findIndex((option) => option.value === options.selected);
    return {
        kind: "provider",
        title: "Configure providers",
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
    label: "Add provider…",
    description: "connect an endpoint and read its model catalog",
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
    // A reset is chosen on the Overrides pane itself, so the pane stays put
    // and the settings update that follows repaints its columns.
    if (selection.kind === "overrides" && previous.kind === "overrides_settings") {
        return previous;
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
            label: `Everything in your favorites (${total})`,
            description: "re-probes models that already answered",
        },
    ];
    return {
        kind: "pool_verify_scope",
        title: "Verify library models",
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
        if (!entry.available) continue;
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
        available.push(optionFor(value, "Connected models"));
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
        label: "Favorites",
        description: "manage saved favorites",
        group: "Favorites",
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
            ? "Models subagents may use, in fallback order. New assignments make a verification request, which may cost money."
            : "Choose any connected model. Assigning makes a verification request, which may cost money.",
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
    return isJobAssignmentId(assignment) ? "unset, inherits its intent" : "unset, no model bound";
}

export function settingsMenuOptions(
    overrides: OverrideSettings | undefined,
): readonly TuiSettingsPickerOption[] {
    const configured = (overrides?.rows ?? []).filter((row) =>
        row.source === "configured"
    ).length;
    if (configured === 0) {
        return SETTINGS_MENU_OPTIONS;
    }
    return SETTINGS_MENU_OPTIONS.map((option) =>
        option.value === "overrides"
            ? { ...option, description: `${configured} set` }
            : option
    );
}

export function startTuiSettingsMenu(
    kind: TuiSettingsMenuKind,
    overrides?: OverrideSettings,
): TuiSettingsPickerState {
    const options = kind === "settings"
        ? settingsMenuOptions(overrides)
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
    const listed = agents.filter((agent) =>
        sessionPickerLists(agent, includeUntitled)
    );
    const rows: TuiSettingsPickerOption[] = [];
    for (const group of [
        NEEDS_YOU_GROUP,
        WORKING_GROUP,
        IDLE_GROUP,
        RECENT_GROUP,
    ]) {
        const members = listed
            .filter((agent) => sessionPickerGroup(agent) === group)
            .toSorted((left, right) =>
                (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
            )
            .map((agent) => sessionPickerOption(agent, currentAgentId, now));
        rows.push(...markSharedSessionOptions(
            threadSessionOptions(members),
            sharedAgentGroups,
        ));
    }
    const options = sessionSectionedOptions(rows);
    return {
        kind: "session",
        allOptions: rows,
        options,
        selectedIndex: firstSessionOptionIndex(options, currentAgentId),
        query: "",
        loading,
        ...(enterDisposition === "keep_running"
            ? { enterDisposition }
            : {}),
        ...(nothingToLeave ? { nothingToLeave } : {}),
    };
}

export interface TuiImportPickerStart {
    readonly scope: TuiImportScope;
    readonly workspace: string;
    // Undefined while the host is still reading.
    readonly listing?: ImportableSessionListing;
    readonly now?: Date;
}

export function startTuiImportPicker(start: TuiImportPickerStart): TuiSettingsPickerState {
    const now = start.now ?? new Date();
    const options = (start.listing?.sessions ?? []).map((session) =>
        importPickerOption(session, now)
    );
    const where = start.scope === "folder" ? `This folder: ${start.workspace}` : "All folders";
    const truncated = start.listing?.truncated === true
        ? ` · newest ${options.length}`
        : "";
    return {
        kind: "session_import",
        title: "Import a conversation",
        subtitle: `${where}${truncated}`,
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
        importScope: start.scope,
        loading: start.listing === undefined,
    };
}

function importPickerOption(
    session: ImportableSessionEntry,
    now: Date,
): TuiSettingsPickerOption {
    const text = session.title ?? session.first_message ?? "(no preview)";
    const imported = session.imported_session_id === undefined ? "" : " · imported";
    const workspaceName = session.workspace.split("/").filter(Boolean).at(-1) ?? session.workspace;
    return {
        value: session.path,
        label: `${importToolLabel(session.tool)} · ${sessionTitle(text)}${imported}`,
        description: "",
        searchText: `${session.first_message ?? ""} ${session.workspace} ${session.path}`,
        activity: relativeTime(session.updated_at, now, "-"),
        workspace: clipToCells(workspaceName, SESSION_WORKSPACE_CELLS),
    };
}

function sessionPickerOption(
    agent: RegisteredAgentSummary,
    currentAgentId: string | undefined,
    now: Date,
): TuiSettingsPickerOption {
    return {
        value: agent.session_path,
        label: agent.imported_from === undefined
            ? sessionTitle(agent.title ?? agent.id)
            : `${sessionTitle(agent.title ?? agent.id)} ${importedSessionLabel(agent.imported_from.tool)}`,
        description: "",
        searchText: `${agent.id} ${agent.workspace}`,
        sessionId: agent.id,
        group: sessionPickerGroup(agent),
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
    };
}

export function sessionPickerGroup(agent: RegisteredAgentSummary): string {
    const live = agent.live
        || agent.status === "waiting"
        || agent.status === "working"
        || agent.worker_pid !== undefined;
    if (agent.status === "waiting") return NEEDS_YOU_GROUP;
    if (agent.status === "working") return WORKING_GROUP;
    return live ? IDLE_GROUP : RECENT_GROUP;
}

export function startTuiCreateLeavePicker(
    ignoreEnter = false,
): TuiSettingsPickerState {
    return {
        kind: "session_create_leave",
        title: "New conversation",
        allOptions: SESSION_CREATE_LEAVE_OPTIONS,
        options: SESSION_CREATE_LEAVE_OPTIONS,
        selectedIndex: 0,
        query: "",
        ...(ignoreEnter ? { ignoreEnter: true } : {}),
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
    searchable = false,
    presentation: { readonly layout?: "list-detail" | "menu"; readonly searchPlaceholder?: string } = {},
): TuiExtensionPickerState {
    const options = rows.map((row) => ({
        value: row.id,
        label: row.label,
        description: row.description ?? "",
        ...(row.current === true ? { current: true } : {}),
    }));
    return {
        kind: "extension",
        ...presentation,
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
        searchable, searchFocused: false,
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
