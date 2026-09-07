import type { ProviderCatalogState } from "../../src/providers/catalog-state.ts";
import { BoxRenderable } from "@opentui/core";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import type { ReductionReason } from "../../src/model/catalog-reduction.ts";
import { isJobAssignmentId, type ModelAssignmentId, type ModelAssignmentRow } from "../../src/config/model-assignments.ts";
import type {
    ModelPricing,
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import { formatBlendedRate, formatListedRates } from "../../src/model/listed-rates.ts";
import { type IntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { ProviderAnswerState } from "../../src/providers/onboarding.ts";
import type { ProviderAccessKind } from "../../src/providers/registry.ts";
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
import type { OverrideKey } from "../../src/engine/override-rows.ts";
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
import { type DialogRowPointer, type DialogMeta } from "./dialog-chrome.ts";
import { type TuiThemeName } from "./theme.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";
import { tuiKeyHint } from "./keymap.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";
import type { TuiSessionLeaveDisposition } from "./session-lifecycle.ts";

export type TuiSettingsPickerKind =
    | "model"
    | "provider"
    | "provider_actions"
    | "reasoning"
    | "permissions"
    | "theme"
    | "context_limit"
    | "overrides_settings"
    | "override_value"
    | "session"
    | "configure"
    | "settings"
    | "permission_settings"
    | "reviewer_settings"
    | "reviewer"
    | "model_assignment"
    | "model_defaults"
    | "model_verification"
    | "pool_verify_scope"
    | "catalog_refresh_scope";

export const OVERRIDES_RESET_VALUE = "overrides_reset";

export type TuiSettingsMenuTarget =
    | "model"
    | "reasoning"
    | "permissions"
    | "theme"
    | "context_limit"
    | "overrides"
    | OverrideMenuTarget
    | "permission_mode"
    | "granted_permissions"
    | "reviewer"
    | "reviewer_primary"
    | "reviewer_fallback";

export type TuiSettingsMenuKind = Extract<
    TuiSettingsPickerKind,
    "settings" | "permission_settings" | "reviewer_settings"
>;

/** One menu target per lever, so a palette jump can name a single row. */
export type OverrideMenuTarget = `override_${OverrideKey}`;

export function overrideMenuTarget(key: OverrideKey): OverrideMenuTarget {
    return `override_${key}`;
}

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
    readonly verificationError?: string;
    readonly hiddenByDefault?: ReductionReason;
    readonly recommended?: boolean;
    readonly recommendedLevel?: string;
    readonly refreshable?: boolean;
    readonly group?: string;
    readonly hasCredential?: boolean;
    readonly answerState?: ProviderAnswerState;
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
    readonly hasCredential: boolean;
    readonly answerState?: ProviderAnswerState;
    readonly refreshable?: boolean;
    readonly declared?: boolean;
    readonly endpointEditable?: boolean;
}

export type TuiProviderGroup =
    | "Subscriptions"
    | "API keys"
    | "Local"
    | "Added in config";

export const TUI_PROVIDER_GROUP_RANK: Readonly<Record<TuiProviderGroup, number>> = {
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

/** Whether the page under the tab strip holds the keyboard. Nothing in the page is lit while the reader is up on the strip, even though each section still remembers where its cursor was. */
export function pickerPageHasKeys(
    state: { readonly pickerLevel?: "strip" | "page" },
): boolean {
    return (state.pickerLevel ?? "page") === "page";
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
    readonly providerCatalogs?: readonly ProviderCatalogState[];
    readonly modelJourney?: "switch" | "shortlist";
    readonly journeyNotice?: string;
    readonly verificationTargets?: readonly import("./model-verification.ts").VerificationTarget[];
    readonly onlyUnverified?: boolean;
    readonly loading?: boolean;
    readonly tab?: TuiModelPickerTab;
    /** Which level holds the keyboard: the row of tabs, or the page under it. A page always has a focused section; the strip is where the page as a whole is being chosen. */
    readonly pickerLevel?: "strip" | "page";
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
    readonly overrideKey?: OverrideKey;
    readonly overrides?: OverrideSettings;
    readonly modelAssignment?: ModelAssignmentId;
    readonly assignedModels?: readonly string[];
    readonly assignmentAllowsSelf?: boolean;
    readonly revealAll?: boolean;
    readonly intelligenceCutoff?: IntelligenceCutoff;
    readonly configureFiles?: readonly TuiConfigureFile[];
    /** The provider the onboarding model step is choosing within. */
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
    readonly sequence?: string;
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
        readonly kind: "overrides";
        readonly patch: OverrideSettingsPatch | null;
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
    | { readonly kind: "pool_verify_scope"; readonly onlyUnverified: boolean; readonly provider?: string }
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
    readonly refreshAllCatalogs?: boolean;
    readonly poolBulk?: { readonly action: "add" | "remove"; readonly models: readonly TuiSettingsPickerOption[] };
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

/** The line under a picker's list. A refusal is labelled and coloured apart from a tip, so a pick that did not land never reads as advice. */
export interface TuiPickerTipLine {
    readonly tone: "tip" | "refusal";
    readonly text: string;
}

export interface TuiSettingsPickerView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    pointer?: DialogRowPointer;
    tip?: string | TuiPickerTipLine;
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

export const TUI_DECLARE_PROVIDER_VALUE = "action:declare_provider";

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
            || current.kind === "overrides_settings"
        ) {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}

export const REVIEWER_CLEAR_VALUE = "\u0000clear";

export const MODEL_ASSIGNMENT_BROWSE_VALUE = "\u0000browse";

export const MODEL_ASSIGNMENT_SELF_VALUE = "\u0000allow-self";

export const MODEL_ASSIGNMENT_VALUE_PREFIX = "\u0000assignment:";

export const SESSION_MODEL_VALUE = "\u0000session-model";

export const MODEL_ACTION_VALUE_PREFIX = "\u0000action:";

export const CONTEXT_LIMIT_VALUE = "\u0000context-limit";

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

export function tuiModelActionValue(action: string): string {
    return `${MODEL_ACTION_VALUE_PREFIX}${action}`;
}

export function tuiModelActionOfValue(value: string): string | undefined {
    return value.startsWith(MODEL_ACTION_VALUE_PREFIX)
        ? value.slice(MODEL_ACTION_VALUE_PREFIX.length)
        : undefined;
}

export function modelAssignmentOfValue(value: string): ModelAssignmentId | undefined {
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

export function formatContextLimitOption(tokens: number): string {
    return tokens % 1_048_576 === 0
        ? `${tokens / 1_048_576}m`
        : `${Math.round(tokens / 1_024)}k`;
}

export function sessionRunsFact(
    model: string | undefined,
    reasoningEffort: ModelReasoningEffort | undefined,
): string {
    if (model === undefined) return "not known";
    return reasoningEffort === undefined
        ? model
        : `${model} (${reasoningEffort})`;
}

export function assignmentStatusWord(row: ModelAssignmentRow): string {
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

export function assignmentRunsFact(row: ModelAssignmentRow): string {
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

export function assignmentFacts(
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

export function assignmentNote(row: ModelAssignmentRow): string {
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

export const POOL_VERIFY_UNVERIFIED_VALUE = "unverified";

export const POOL_VERIFY_ALL_VALUE = "all";

export const CATALOG_REFRESH_ALL_VALUE = "\u0000all";

export function formatSessionSize(bytes: number): string {
    if (bytes < 1_000) {
        return `${bytes}B`;
    }
    if (bytes < 1_000_000) {
        return `${Math.round(bytes / 1_000)}K`;
    }
    return `${(bytes / 1_000_000).toFixed(1)}M`;
}

export const TUI_TOP_PICKS_SECTION = "Top picks";
