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

/** Which developer override a value pane is choosing. */
export type TuiDeveloperKey =
    | "contextLimit"
    | "compactionTriggerFraction"
    | "postCompactionTargetFraction"
    | "summaryWordCap";

/** Which reviewer a pane is choosing for. */
export type TuiReviewerSlot = "primary" | "fallback";

export interface TuiSettingsPickerOption {
    readonly value: string;
    readonly label: string;
    readonly description: string;
    /** A full sentence about the row, drawn in the column beside the list. */
    readonly note?: string;
    /** The row's name for that column, when the row's label is a table line. */
    readonly detailTitle?: string;
    /** The row's own facts, for a row the model facts do not describe. */
    readonly detailFacts?: readonly (readonly [string, string])[];
    readonly searchText?: string;
    readonly provider?: string;
    readonly model?: string;
    /** A two-line row whose second line gets the full card width. */
    readonly card?: boolean;
    readonly rowMeta?: DialogMeta;
    readonly sessionId?: string;
    /** Unclipped current session name, used to seed the rename field. */
    readonly sessionName?: string;
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
    /** One end of the non-hierarchical group currently open in both panes. */
    readonly sharedEdge?: "start" | "end";
    readonly sharedGroup?: string;
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
    /** WebDev Arena overall rating, integer. Absent is a blank cell. */
    readonly waScore?: number;
    readonly pricing?: ModelPricing;
    /** True when this model is on or near Vera's listed-output front. */
    readonly onPareto?: boolean;
    /** True on a pool row with no probe or rejection evidence behind it. */
    readonly unverified?: boolean;
    /**
     * Why this row is folded away until the user asks for everything. A batch
     * row names a submission mode rather than a model, an alias row duplicates
     * a concrete row already listed, and an old row is one the provider listed
     * long enough ago that the newer models have moved past it.
     */
    readonly hiddenByDefault?: ReductionReason;
    /** True on a model Vera's shipped curation recommends. */
    readonly recommended?: boolean;
    /**
     * The level the curation recommends this model at. Shown in the meta
     * column and nothing more: the row selects the same way on every tab, so
     * the level is still chosen on the level pane that follows.
     */
    readonly recommendedLevel?: string;
    /** Host-computed provider capability, carried on provider and model rows. */
    readonly refreshable?: boolean;
    /**
     * The heading this row belongs under. Model rows leave it unset and are
     * grouped by their provider instead, which is the same idea: a heading is
     * whatever one fact a run of rows shares.
     */
    readonly group?: string;
    /** Set only on provider rows: whether Vera already holds a credential. */
    readonly connected?: boolean;
    /**
     * A row that does something rather than naming a thing. It carries no
     * heading, no marker of its own, and nothing that counts providers or
     * models may include it.
     */
    readonly action?: boolean;
    /** A provider row whose endpoint the user wrote and can rewrite. */
    readonly declared?: boolean;
    /** A provider row whose endpoint the user may point elsewhere. */
    readonly endpointEditable?: boolean;
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

/** A concrete file `/configure` can hand to the user's editor. */
export interface TuiConfigureFile {
    readonly label: string;
    readonly path: string;
    readonly displayPath: string;
    readonly scope: "Profile" | "Project";
    /** Profile config may be created by the editor; optional files may not. */
    readonly createIfMissing: boolean;
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
    readonly group: TuiProviderGroup;
    readonly hint?: string;
    readonly connected: boolean;
    readonly refreshable?: boolean;
    /** Declared in config rather than shipped, so its endpoint is editable. */
    readonly declared?: boolean;
    /**
     * Whether the endpoint is the user's to move. False for a provider reached
     * over a flow bound to the account it signs in to.
     */
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

/** Maps a provider fact to this client's connect-list heading. */
export function tuiProviderGroup(
    access: ProviderAccessKind,
    declared = false,
): TuiProviderGroup {
    if (declared) return "Added in config";
    if (access === "subscription") return "Subscriptions";
    if (access === "api_key") return "API keys";
    return "Local";
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
    /** The row the extension says is already in effect. */
    readonly current?: boolean;
}

export type TuiExtensionPickerActionKey =
    | "enter"
    // `d` is the /agent surface's "save the session's pair as this agent's
    // default". It is a named action key like the others, not a binding: it
    // exists only while a picker that declares it is open.
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
    /** Absent on older/fixed states; an active search defaults to its end. */
    readonly queryCursor?: number;
    /** Overrides the name the pane draws for its kind. */
    readonly title?: string;
    /** A line under the title, for a pane whose rows need the context. */
    readonly subtitle?: string;
    readonly initialTheme?: TuiThemeName;
    readonly initialModel?: string;
    readonly loading?: boolean;
    /** Set only on the model pane. */
    readonly tab?: TuiModelPickerTab;
    /** Which part of a model collection owns the arrow keys. */
    readonly modelFocus?:
        | "list"
        | "list_action"
        | "detail"
        | "page_entry"
        | "page"
        | "intelligence";
    /** Which page action is highlighted while the page view holds focus. */
    readonly modelPageIndex?: number;
    /**
     * Set when the pane was opened with no conversation behind it. The catalog
     * arrives on a session snapshot, so there is nothing to list and no chord
     * that would fill it: the empty state has to say that rather than report
     * an empty catalog the user could act on.
     */
    readonly modelCatalogUnavailable?: boolean;
    /** The focused action in the selected model's inspector. */
    readonly modelActionIndex?: number;
    /** Provider-owned context for the generic request-options action. */
    readonly requestOptionsProviders?: Readonly<Record<
        string,
        TuiModelRequestOptionsSupport
    >>;
    /** Exact provider/model refs with a stored profile entry. */
    readonly configuredRequestOptions?: readonly string[];
    /**
     * The Defaults tab's rows, which are jobs rather than models and so cannot be
     * filtered out of `allOptions` the way the other tabs are. Set by the
     * client after the pane opens, since assignments come from config and the
     * pool rather than from the settings snapshot the pane is built from.
     */
    readonly assignmentOptions?: readonly TuiSettingsPickerOption[];
    /**
     * The Actions tab's rows: the things this pane can do that are not
     * choosing a model. They are rows so they can be read and searched for
     * by name, rather than only being reachable by a chord the user has to
     * already know about.
     */
    readonly actionOptions?: readonly TuiSettingsPickerOption[];
    /**
     * WebDev Arena snapshot date for Help (`YYYY-MM-DD`). Carried from the
     * settings snapshot so the TUI does not read the cache.
     */
    readonly webdevArenaSnapshot?: string;
    /** The caller has one confirmed pool change it can reverse. */
    readonly canUndoPoolChange?: boolean;
    /**
     * `/resume` Enter stops the conversation being left. `/subagents` Enter
     * keeps it running, the same leave as a rail click: opening a child is
     * not leaving the work.
     */
    readonly enterDisposition?: TuiSessionLeaveDisposition;
    /**
     * The picker was opened with no conversation on screen, so Enter is not a
     * switch away from anything: it opens the row and nothing else happens.
     */
    readonly nothingToLeave?: boolean;
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
    /** Set only on a reviewer pane: which slot the chosen row fills. */
    readonly reviewerSlot?: TuiReviewerSlot;
    /** Set only on a developer value pane: which override the row writes. */
    readonly developerKey?: TuiDeveloperKey;
    /** The snapshot a developer pane was built from, so it can rebuild. */
    readonly developerSettings?: DeveloperSettings;
    /** Set only on an assignment pane: which assignment the chosen row binds. */
    readonly modelAssignment?: ModelAssignmentId;
    /** Ordered refs already assigned, used by the subagents toggle list. */
    readonly assignedModels?: readonly string[];
    readonly assignmentAllowsSelf?: boolean;
    /**
     * Set on the model pane once the user has asked for the folded rows. Like
     * `collapsed`, it lasts as long as the pane: wanting the whole catalog is
     * a question about this visit rather than a setting to carry forward.
     */
    readonly revealAll?: boolean;
    /**
     * All models WA Score floor for this visit. Absent means `any`.
     */
    readonly intelligenceCutoff?: IntelligenceCutoff;
    /** The file identities behind a configure pane's display rows. */
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
    /**
     * Set when the chain started on an assignment pane rather than the model
     * pane, so the folded result binds the assignment instead of changing the
     * session's own model.
     */
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
        /** Absent clears the slot. */
        readonly provider?: string;
        readonly model?: string;
    }
    /** How much of the kept collection the probe sweep should cover. */
    | { readonly kind: "pool_verify_scope"; readonly onlyUnverified: boolean }
    /** Which providers to ask for their model lists. Empty names them all. */
    | {
        readonly kind: "catalog_refresh_scope";
        readonly providers: readonly string[];
    }
    /** The Defaults pane was left for the collection defaults are chosen from. */
    | { readonly kind: "model_assignment_browse" }
    /** A Defaults-tab row was chosen: open the model list for it. */
    | { readonly kind: "model_assignment_open"; readonly assignment: ModelAssignmentId }
    | {
        readonly kind: "model_assignment";
        readonly assignment: ModelAssignmentId;
        /** Absent unbinds the assignment. */
        readonly provider?: string;
        readonly model?: string;
        /** Present only when this selection folded in a chained level pane. */
        readonly reasoningEffort?: ModelReasoningEffort;
        /** The one-key toggle accepts the model/provider default without pinning it. */
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
    /**
     * The pane does not edit the pool itself. It reports the intent and waits
     * for the settings snapshot to come back, so the list the user sees is
     * always the list the host actually stored.
     */
    readonly poolToggle?: TuiPoolToggle;
    /** The caller owns the confirmed change and applies its inverse. */
    readonly undoPoolChange?: boolean;
    /** Same contract as `poolToggle`: reported, not applied here. */
    readonly poolVerify?: TuiPoolVerify;
    /** The sweep key was pressed: ask how much of the collection it covers. */
    readonly poolVerifySweep?: boolean;
    /** Same contract again: the pane asks for the prompt, it does not name. */
    readonly poolName?: TuiPoolNameCandidate;
    /** The selected model whose profile request body should be edited. */
    readonly requestOptions?: TuiModelRequestOptionsCandidate;
    /** A reorder of one pool entry, by places, for the client to send on. */
    readonly poolMove?: {
        readonly provider: string;
        readonly model: string;
        readonly delta: number;
    };
    /**
     * The model pane asking for the connect pane over it. A request rather than
     * a state: which providers are connected is a fact about the disk, and only
     * the caller can read it.
     */
    readonly openProviders?: boolean;
    /**
     * The connect pane asking for a provider's stored credential to be
     * forgotten. A request rather than a state, for the same reason
     * `openProviders` is: only the caller can read or write the store.
     */
    readonly forgetProvider?: string;
    /**
     * The connect pane asking for the declaration form over it. A request for
     * the same reason `forgetProvider` is one: the form ends in a write to
     * `config.json`, and only the caller touches the disk.
     */
    readonly declareProvider?: boolean;
    /**
     * The provider whose model list should be asked for again now. Named
     * rather than boolean because the answer is always "the one under the
     * cursor": on the connect pane that is the row itself, and on a model
     * list it is the provider the highlighted model belongs to.
     */
    readonly refreshCatalog?: string;
    /** Ask which providers to refresh before asking any of them. */
    readonly refreshCatalogScope?: boolean;
    /** A declared provider whose form should reopen filled in. */
    readonly editProvider?: string;
    /** A shipped provider whose endpoint the user wants to move. */
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

/** Move picker focus to a rendered row, including model-pane action rows. */
export function moveTuiSettingsPickerPointer(
    state: TuiAnySettingsPickerState,
    index: number,
): TuiAnySettingsPickerState {
    if (state.kind !== "model") {
        return { ...state, selectedIndex: index };
    }
    // The page area sits above the list, so it counts down from the rows
    // rather than on from them and can never collide with one.
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
    /**
     * The tip line drawn above the key hints, or nothing. Set before `update`;
     * the pane redraws from scratch on every update and reads it then.
     */
    tip?: string;
    /** A live model check drawn as an inset console above the footer. */
    verification?: {
        readonly subject: string;
        /** The checks the engine has reported so far, in arrival order. */
        readonly steps?: readonly {
            readonly label: string;
            readonly status: "running" | "passed" | "failed" | "skipped";
        }[];
    };
    /** What clicking a tab chip does, in the same terms as the ⇥ key. */
    onTab?: (tab: TuiModelPickerTab) => void;
    /** Opens provider connection without changing which model tab is active. */
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
    /**
     * `railInset` is the width, in columns, of a workspace rail the picker is
     * drawn beside rather than over. Omit or pass 0 when nothing occupies the
     * card's left edge.
     */
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
            + "To edit another profile, restart with: vera --profile <name>",
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
 * A shortlist refresh can arrive on the main connection while this picker
 * belongs to a side agent. Keep that agent's running pair and catalog while
 * accepting the newly stored global shortlist.
 */
export function mergeTuiModelPickerSettings(
    target: ModelTurnSettings | undefined,
    poolSource: ModelTurnSettings | undefined,
): ModelTurnSettings | undefined {
    if (target === undefined) return poolSource;
    if (poolSource?.pooled === undefined) return target;
    return { ...target, pooled: poolSource.pooled };
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
 * The value of the row that opens the declaration form.
 *
 * Prefixed so it cannot collide with a provider id, which is what every other
 * row on this pane carries.
 */
export const TUI_DECLARE_PROVIDER_VALUE = "action:declare_provider";

/**
 * The last row on the connect pane: the way in that does not need the chord.
 *
 * It sits below the groups because it is not one of them, and it survives
 * search because it is the answer to a query that matched nothing.
 */
const TUI_DECLARE_PROVIDER_OPTION: TuiSettingsPickerOption = {
    value: TUI_DECLARE_PROVIDER_VALUE,
    label: "Declare a provider…",
    description: "one Vera does not ship, by base URL",
    searchText: "declare custom new add provider",
    action: true,
};

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

/** The row that empties a reviewer slot rather than choosing a model. */
export const REVIEWER_CLEAR_VALUE = "\u0000clear";

/**
 * The row that leaves this pane for the collection a default is chosen from.
 *
 * A default can only name a model the user has already kept, so a user whose
 * model is not kept yet finds a list that does not contain it and no reason
 * given. The row says the reason and goes to the place that fixes it.
 */
export const MODEL_ASSIGNMENT_BROWSE_VALUE = "\u0000browse";
export const MODEL_ASSIGNMENT_SELF_VALUE = "\u0000allow-self";

/**
 * Slot rows share a list with model rows, so their values are namespaced to
 * keep an assignment named like a model from ever being mistaken for one.
 */
const MODEL_ASSIGNMENT_VALUE_PREFIX = "\u0000assignment:";

/** The session's own model, which is a row here but is not an assignment. */
const SESSION_MODEL_VALUE = "\u0000session-model";
const MODEL_ACTION_VALUE_PREFIX = "\u0000action:";
const CONTEXT_LIMIT_VALUE = "\u0000context-limit";

export function tuiModelAssignmentValue(assignment: ModelAssignmentId): string {
    return `${MODEL_ASSIGNMENT_VALUE_PREFIX}${assignment}`;
}

/**
 * The rows the Actions tab holds, and the same rows a search on any model tab
 * can turn up. Each is a sentence about what will happen, with the chord that
 * also does it on the right, so the pane teaches its own keys instead of
 * relying on a footer that truncates.
 *
 * Only actions that stand on their own are here. A key that acts on whichever
 * model the cursor is over has no meaning as a row, since selecting the row
 * moves the cursor off the model.
 */
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
    // One row, not one per provider: which providers to ask is the second
    // question, and asking it here would repeat the same chord down the list.
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

/** The action a row stands for, or undefined when the row is not one. */
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

/**
 * The Defaults tab's rows: the session's own model first, because it is the
 * model most of Vera's work runs on and a tab claiming to show everything that
 * would omit it is lying, then one row per assignment.
 *
 * A row is its name and one status word. Model names, route names and the
 * reason behind either are all longer than half a card, so they live in the
 * block beside the list, which is sized for them: a name cut to "m…" tells the
 * user less than nothing.
 */
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

/** The session's model named the same way an assignment's model is. */
function sessionRunsFact(
    model: string | undefined,
    reasoningEffort: ModelReasoningEffort | undefined,
): string {
    if (model === undefined) return "not known";
    return reasoningEffort === undefined
        ? model
        : `${model} (${reasoningEffort})`;
}

/**
 * The row's state in one everyday word, which is all the list carries. The
 * vocabulary is closed and short enough to fit the narrowest list: anything
 * that would need a sentence is a sentence, in the block beside the list.
 */
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

/** What runs the row, with the substitute named when it is not what was set. */
function assignmentRunsFact(row: ModelAssignmentRow): string {
    const running = row.models[0];
    // Nothing bound anywhere still runs: the session's model is the last rung
    // and there is no rung below it.
    if (running === undefined) {
        return row.assignment === "subagents"
            ? row.allowSelf === true ? "parent model" : "not configured"
            : "this session's model";
    }
    const named = running.reasoning_effort === undefined
        ? running.model
        : `${running.model} (${running.reasoning_effort})`;
    // What ran is not what this row names, so the row says whose model it is.
    return row.source === "assignment"
        ? named
        : `${named} (via ${row.inherits ?? "this session"})`;
}

/** The row as a fact block, for the column beside the list. */
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
        // Only where something is set: whether a model the user has not named
        // is in the pool is not a fact about this row.
        ...(row.bound
            ? [[
                "Shortlisted",
                row.source === "assignment" ? "yes" : "no",
            ] as const]
            : []),
    ];
}

/**
 * The row in full sentences: what this assignment is for, and, when that is
 * not the whole story, what is running it and what to do about it.
 */
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
 * The models offered for one assignment, which is the pool and nothing else. An
 * binds only what can run, and reachability is pool membership, so offering a
 * assignment set from outside it would read back as
 * unreachable the moment it is written. Widening the choice means adding to
 * the pool first.
 */
/** The two answers to "how much of it", which is the only question a sweep has. */
export const POOL_VERIFY_UNVERIFIED_VALUE = "unverified";
export const POOL_VERIFY_ALL_VALUE = "all";

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

/** The one row that stands for every provider at once. */
export const CATALOG_REFRESH_ALL_VALUE = "\u0000all";

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
function unsetAssignmentMeans(assignment: ModelAssignmentId): string {
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
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "undo_pool_change"
    ) {
        return state.canUndoPoolChange === true
            ? { state, handled: true, undoPoolChange: true }
            : unchanged(state, true);
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
    // Order belongs to the pool, so like a name this does nothing on a row the
    // user has not pooled. Order is not decoration: the failsafe rung walks
    // the pool in this order too.
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
    // A refresh spends no model call and cannot change a setting, so unlike
    // the probe keys below it asks nothing first: the only question it could
    // ask is which provider, and the cursor has already answered that.
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
    // The sweep asks how much of the collection it covers before it spends
    // anything, so the key is safe to press to find out what it would do.
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "verify_pool"
    ) {
        return { state, handled: true, poolVerifySweep: true };
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
    // The fold is a default, not a filter: this key is the whole reason the
    // list can open short without the short list claiming the other models do
    // not exist. It only ever adds rows, so it never needs an undo.
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
    // Also ahead of the modifier bail-out, and modified for the same reason as
    // ctrl+s above: every bare key on the model pane belongs to its search box.
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "open_providers"
    ) {
        return { state, handled: true, openProviders: true };
    }
    // Tab walks right across the strip and Shift+Tab walks left. The model
    // pane's scoped binding overrides the global quickslot chord while open.
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
        // Providers is the last stop, and it swaps what the card lists rather
        // than what the model list shows, so the list under it wraps to the
        // first tab. Both ways out of that pane then land on the start of the
        // strip; parking the list on Help would send the next ⇥ straight back
        // into the pane the user just left.
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
    // ⇥ off the connect pane and back onto the collections. It resumes the pane
    // that opened it rather than a fixed tab: arriving by ^e from All models
    // and leaving by ⇥ should not silently move the list somewhere else.
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
    // Ahead of the modifier bail-out below, because the chord carries shift.
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
    // Forgetting is a fact about the store, so the pane only names the row and
    // the caller decides whether there is anything there to forget.
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
        // Escape here has a level to give back, so it does that rather than
        // closing the dialog from under a view the user opened on purpose.
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
    // This short policy list reserves bare p for assignment. It has no search
    // field, so every other printable key is swallowed instead of building an
    // invisible query and moving the cursor away from the row just toggled.
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
    // Left and right open and close a section, the shape a tree has everywhere
    // else. On a row inside a section they act on the heading above it, so
    // closing a long provider does not first mean scrolling back up to it.
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
        // The same request ctrl+shift+n makes, from a row anyone can see.
        if (state.kind === "provider" && selected.action === true) {
            return { state, handled: true, declareProvider: true };
        }
        // A declared row carries an endpoint the user wrote, so opening it
        // means opening what they wrote. The form's key field covers the
        // credential, which is the only thing a shipped row has to offer.
        if (state.kind === "provider" && selected.declared === true) {
            return { state, handled: true, editProvider: selected.value };
        }
        // The session's model is shown on the Slots tab but is not changed
        // there: choosing it moves to the list that does change it, which is
        // the same list every other way in reaches.
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

/** Apply text already edited by the native search field to the active pane. */
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
        // No borderColor here. OpenTUI's BoxRenderable constructor reads any
        // border styling option as "this box wants a border" and overrides an
        // explicit `border: false`, so passing a color is what draws the box.
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
            // A session is recognised by its title, and titles are the one row
            // value with no natural length, so this list gets the whole
            // terminal rather than the inset card the settings panes use. It
            // starts at the top edge too: an inset card is read against the
            // scrimmed transcript around it, but a full-width panel with a
            // strip of transcript over it reads as a row that leaked through.
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

// Header, search block, footer with its blank line, and the card's vertical
// padding (or padding plus border on the retro chromes, which add up to the
// same three lines). The theme list never windows, so the card's height is a
// straight function of how many themes it offers.
const THEME_CARD_CHROME_LINES = 9;

/**
 * Where the theme card starts: the shared picker offset, pulled up only as far
 * as needed for the whole list to fit above the bottom padding row. One
 * formula for every chrome, so the card does not jump when the theme under the
 * cursor changes the chrome out from beneath it.
 */
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


/**
 * Whether the facts about the highlighted row are drawn beside the list.
 *
 * The pool, Defaults, and Actions. All models stays a name scan; Full price
 * and Blended price sit as labelled rows under that list.
 */
function hasModelDetail(state: TuiAnySettingsPickerState): boolean {
    const tab = state.kind === "model" ? state.tab ?? "all" : undefined;
    return tab === "pool" || tab === "defaults" || tab === "actions";
}

/** The narrowest the detail column is worth drawing at. */
const MODEL_DETAIL_MIN_WIDTH = 30;

/** The narrowest the list column may be squeezed to. */
const MODEL_LIST_MIN_WIDTH = 28;

/**
 * The rule between the two columns, carried on every line of the detail column
 * rather than drawn as a border: the card already has an edge, and a second
 * frame inside it reads as two cards rather than one pane with two columns.
 */
const MODEL_DETAIL_RULE = "│  ";

/** How far the rows hold off that rule. */
const MODEL_LIST_RULE_GAP = 2;

interface ModelPaneSplit {
    readonly listWidth: number;
    readonly detailWidth: number;
}

/**
 * How the card's width divides between the list and the facts beside it, or
 * nothing when the terminal cannot spare a second column and the list takes
 * the whole width.
 */
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

/**
 * The columns a row has for its label, description and meta together. Derived
 * from the same numbers the card is built from below: the card's share of the
 * terminal, less its own left and right padding, the row's, and the leading
 * gutter.
 */
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

/**
 * The columns the card has inside its own padding. The footer runs the whole
 * width, so it is measured against this rather than against the row width,
 * which is short by the leading gutter.
 *
 * `railInset` is how many leading columns the workspace rail already holds
 * when the picker is drawn beside it (see `fitSettingsPickerBesideWorkspace`
 * in main.ts) rather than over it. The card's outer box shrinks to match, so
 * its content has to be built for the same narrower width or the detail
 * column runs past the box's own right edge.
 */
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


/**
 * The facts about the highlighted model, beside the list rather than crammed
 * into its row. It follows the cursor and takes no keys of its own: what a row
 * does is still what ⏎ and the footer's keys do.
 *
 * The column is as tall as the list next to it and every line carries the rule,
 * so a model with more facts than its neighbour fills more of a column that was
 * already there instead of moving anything.
 */
/**
 * The detail block as list rows, for a card too narrow to hold a second
 * column. It carries no title: the highlighted row is directly above it and
 * has already named itself.
 */
/**
 * How many lines the block under a single-column list will take.
 *
 * With no second column the inspector, its actions and the More page are drawn
 * below the rows, out of the same vertical budget. Counting them before the
 * window is sized keeps the card inside the screen instead of letting it grow
 * past the bottom by however many actions the row happens to carry.
 */
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
    // A column that simply goes blank reads as a broken render. It says what
    // is not there instead, and names the key that brings it back.
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
    // A row whose label is a table line names itself here instead, and brings
    // its own facts: what runs a job is not what describes a model.
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
            // The heading says how to get here. Without it the column reads as
            // a list of chords rather than somewhere the cursor can go.
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

/** Word wrap for the one paragraph this pane draws. */
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

/**
 * The pane explaining itself, as a third view rather than a separate overlay.
 * A question about this pane ("what does the dot mean", "how do I keep this
 * model") is asked while looking at it, and answering it somewhere else costs
 * the user the list they were reading.
 *
 * It is the pane's own vocabulary only. The full key reference is /help, and
 * repeating it here would be a second copy to keep true.
 */
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

/**
 * A term and what it means, or a lone string for a heading or a blank line.
 */
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

/**
 * How many lines the facts column wants. The two columns run to whichever of
 * them is taller, so a short list still leaves the facts beside it room to be
 * read in full rather than clipping the last of them.
 */
function modelDetailHeight(
    state: TuiAnySettingsPickerState,
    width: number,
): number {
    // The two views that do not describe a model measure themselves, or the
    // column is sized for facts that are not being drawn and clips them.
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
        // The name, a blank, two lines per fact, a blank, and the note.
        return 3 + option.detailFacts.length * 2
            + wrappedTo(option.note ?? "", width).length;
    }
    // The name, the source, a blank, then facts as labelled rows in two
    // columns, then a padding blank before Actions.
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
    // The first three are the left column and are drawn for every model, in
    // this order. Anything after them fills the second column, which a model
    // may leave empty.
    const facts: ModelDetailFact[] = [];
    // On the pool tab every row is pooled, so the fact says nothing there.
    if (state.kind === "model" && state.tab !== "pool") {
        facts.push(option.pooledRank === undefined
            ? ["Shortlist", "not shortlisted"]
            : ["Shortlist", "on your shortlist", "positive"]);
    }
    // The word on its own says nothing about what was checked, so the value
    // says it: a probe is a real call to the provider for this model.
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

/** Trailing ellipsis rather than a cut, for the pane's own one-line values. */
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
    // The help page keeps the field so that tabbing onto it does not lift the
    // tabs and everything under them by three lines. It draws inert, without
    // the caret, since this page holds nothing to filter.
    // A pane whose whole list is two fixed answers has nothing to filter, and
    // an empty field above them reads as a row the cursor has landed on.
    const searchable = pickerIsSearchable(state);
    const header = dialogHeaderNode(
        renderer,
        pickerTitle(
            state.kind,
            state.kind === "extension"
                ? state.title
                // The connect pane keeps the model pane's name while it draws
                // inside it: one card that changes what it lists, not two.
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
        // A blank line above and below separates this standing explanation
        // from both the title and the rows. Count its margin as well as its
        // two wrapped text lines and trailing blank when sizing the list.
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

    // The list and the facts about the highlighted row sit side by side, so the
    // rows go into a column of their own rather than straight onto the card.
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
            // The rows hold off the rule, so a right-aligned mark on one of
            // them does not touch it.
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
                // Model and session rows carry no description. A model's
                // marketing line is not what anyone picks on, and at these
                // widths it only ever arrived clipped to a few characters; a
                // session's facts are its own columns.
                ...(state.kind === "model" || state.kind === "session"
                    ? {}
                    : { description: row.option.description }),
                // With the pane beside it, a row keeps only what tells it apart
                // from its neighbours. Everything else is one cursor move away.
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
    // With no second column the page has nowhere to sit beside the list, so it
    // takes the list's place the way it takes the inspector's when there is one.
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

    // The same block the column would have carried, under the list instead of
    // beside it. The pane keeps what it says at every width and gives up only
    // the second column, which is what the terminal actually ran out of.
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
        // The chords above are a legend, and a legend is easy to read past.
        // This line says the thing in words instead.
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

// Breathing room, the one-line collection explanation, and another blank
// before the rows. The tab rows themselves are added to this fixed chrome.
const MODEL_TAB_STRIP_CHROME_HEIGHT = 3;
/** Said in words under the chords, because the chords are a legend. */
const MODEL_ARROW_HINT =
    "Arrow keys move you: ↑↓ the list, → into the details, ← back";
const MODEL_ALL_MAX_ROWS = 28;
/** At most this many checks are kept on screen, newest last. */
const VERIFICATION_CONSOLE_STEPS = 3;

type VerificationConsole = NonNullable<TuiSettingsPickerView["verification"]>;

/** What the console occupies: the subject line and the checks under it. */
export function verificationConsoleLines(console_: VerificationConsole): number {
    const steps = console_.steps ?? [];
    // The margin above, a padded row on each side of the block, the subject
    // line, and one line per check it is showing.
    return 4 + Math.max(1, Math.min(VERIFICATION_CONSOLE_STEPS, steps.length));
}

/**
 * The live provider check, as a short list of what has happened.
 *
 * One line names what is being checked and stays put; under it each check
 * reports itself once it is done, and the one still running carries the
 * spinner. Nothing is repeated, so the block says only what has changed.
 */
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

/** Each ending a check can have, spelled out for a terminal without colour. */
const VERIFICATION_STEP_MARKS: Record<string, string> = {
    passed: "✓",
    failed: "✗",
    skipped: "skipped",
    running: "",
};

/**
 * Where the strip's highlight sits. The connect pane is a stop on it rather
 * than a modal over it: it draws in the same card, under the same tabs, so
 * ⇥ walks onto it and off it the way it walks between the collections.
 */
type ModelStripStop = TuiModelPickerTab | "providers";

/**
 * The model pane the strip belongs to, which is the pane itself on the three
 * collections and the parent on the connect pane. Undefined on a pane that
 * carries no strip, including a connect pane opened from anywhere else.
 */
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

/**
 * The name a tab is drawn with, read from the one list that names them, so
 * prose that points at a tab cannot drift from the tab's own label.
 */
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

/** What the line below the tabs says about the active collection. */
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
        // The active Providers stop carries padding on both sides.
        + Bun.stringWidth(
            `${" ".repeat(configurePad)}Providers ^e${" ".repeat(configurePad)}`,
        );
    const shortened = (names: readonly string[]) =>
        names.map((name) =>
            name.startsWith("All models")
                ? name.replace("All models", "All")
                : name
        );
    // How many models a collection holds is the first thing asked of a
    // shortlist, so the counts are the last thing given up: the strip tightens
    // its gaps and shortens its longest name before it drops them.
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
        // The narrowest rung abbreviates two labels rather than painting a
        // reachable stop outside the card.
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
        // The active tab is a filled chip, as the help card's tabs are: a tab
        // that differs from its neighbour only in colour reads as a heading
        // rather than as one of a set you can move between. The first chip
        // carries no space before its label, so the strip starts on the same
        // column as the line explaining it and the rows under it.
        // The count belongs to the tab, not to the line under it: how many
        // models a collection holds is the first thing asked of a shortlist.
        // Help is a page, not a collection, so it carries no count.
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
        // A chip looks like something to click, so it is one: clicking it does
        // what ⇥ onto that tab does, cursor and all.
        if (onTab !== undefined) {
            chip.onMouseDown = (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                onTab(id);
            };
        }
        chips.add(chip);
    });
    // The last stop on the strip. It swaps what the card lists rather than
    // what the model list shows, so it keeps a key of its own as well, but it
    // highlights and answers to ⇥ like the chips before it.
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

/**
 * One hint per entry, in reading order, each with the order it is dropped in
 * when the row will not fit: 0 is kept longest. A hint that wrapped would split
 * a chord from its label, so the row sheds whole hints instead.
 */
interface PickerHint {
    readonly text: string;
    readonly drop: number;
}

/**
 * The text cut to the room there is for it, with an ellipsis where it was cut.
 * A footer line that overflows its card wraps onto the padding line under it,
 * so the pane loses its bottom margin rather than the sentence losing a word.
 */
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

/**
 * The hint line, never wider than the card it sits in. A line that overflows
 * wraps onto the blank line under it and the pane loses its bottom padding, so
 * a branch that cannot shed a hint has its line cut instead.
 */
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
        // With nothing on screen to leave, opening a row in the background
        // and opening it are the same act, so only one of them is offered.
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
            // The chord and ⏎ are the same action, so the row that already
            // offers it on ⏎ does not advertise it twice.
            // The chord and ⏎ are the same action on a declared row, which
            // already says "⏎ edit", so only a shipped row advertises it.
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
    // The Defaults tab's rows are jobs, and a two-word state cell cannot say
    // what to do about one, so the cursor's row explains itself down here.
    // The Defaults tab's rows explain themselves in the column beside the
    // list, so the footer stays keys.
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
                // Removal is the same key saying the opposite thing, which is
                // the one hint the table cannot hold for us.
                ? tuiKeyHint("toggle_pooled").replace("pin", "unpin")
                : tuiKeyHint("toggle_pooled");
        return fittedHints([
            // The movement entry carries the half-page keys rather than taking
            // a separate assignment: they are the same movement, and this footer is
            // already the longest one in the pane.
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
            // Only while the cursor is on a heading: the keys do nothing on a
            // model row, and a hint for them there would be a lie.
            // The whole-list keys are worth a slot behind the row's own keys;
            // on a heading, where ← and → do something too, the entry moves up
            // because folding is then what the highlighted row is for.
            // The shortlist never groups, so folding keys would name something
            // that is not on screen.
            ...(state.tab === "pool" ? [] : [
                selected?.section === undefined
                    ? { text: "⇧←→ fold all", drop: 5 }
                    : { text: "←→ ⇧←→ fold", drop: 1 },
            ]),
            // Only where there is something folded to reveal, and it names the
            // direction the key would take you rather than the state you are
            // in, so the hint stays an instruction on both passes.
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
            // Sheds early, because the strip's own chip carries this chord and
            // is on screen whatever the footer had room for.
            { text: tuiKeyHint("open_providers"), drop: 6 },
            { text: "⇥ tabs", drop: 3 },
            { text: "esc close", drop: 0 },
        ], width);
    }
    return "↑↓ move · ⏎ select · esc close";
}

/**
 * Whether the pane is holding rows back, which is what makes the reveal key
 * worth a slot in the footer. A pooled row is shown whatever its mark says, so
 * it does not count as folded.
 */
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
    // The model pane carries its headings as rows of its own, so that the
    // cursor can reach one and fold the section under it. Everything else has
    // its headings derived here.
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
    // The extension says which row is in effect. `selectedId` is the cursor
    // and moves with the arrow keys, so reading the marker off it would draw a
    // dot that follows the highlight instead of marking anything.
    if (state.kind === "extension") {
        return option.current === true;
    }
    if (state.kind === "provider") return false;
    if (state.kind === "session") {
        return option.current === true;
    }
    return state.kind === "model" && option.value === state.initialModel;
}

/** A concrete model row can be probed without changing the active model. */
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

/** One clickable action row; the arrow remains visible without colour. */
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

/** Collection actions sit on their own quiet band below the model list. */
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
    // With no arrow in front of it the row has to carry its own focus, so it
    // inverts the way a selected model row does and stays legible with no
    // colour at all.
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

/**
 * The actions a page offers that no row on it stands for: they act on the
 * dialog, not on the list or on the model under the cursor.
 */
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

/**
 * The row that opens them, above the list rather than below.
 *
 * The cursor opens on the first model, so a row above it is one key away
 * whatever the list holds. The same row below would be a shortlist away.
 */
/**
 * Focus after a host snapshot. The page is built from the actions available
 * now, so focus that outlived its actions has to come back to the list rather
 * than address a row that is no longer there.
 */
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

/**
 * Which action row the cursor is on.
 *
 * The list can shrink under a held cursor (a model leaving the shortlist drops
 * two of its actions), so the index is read against what is there now. Keying
 * clamps the same way, and the row that lights is the row Enter runs.
 */
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

/**
 * Marks the row as a pane that opens, and says which way it will move.
 *
 * It follows the pane rather than the cursor: the row can hold the cursor with
 * the pane still shut, and the pane stays open while the cursor is inside it.
 */
function modelPageEntryGlyph(state: TuiAnySettingsPickerState): string {
    return state.kind === "model" && state.modelFocus === "page" ? "-" : "+";
}

/** What each page action is called when the entry row names it in passing. */
const MODEL_PAGE_ENTRY_SHORT: Record<string, string> = {
    shortlist_current: "add current",
    reveal_all: "show every model",
    verify_pool: "verify all",
    refresh: "refresh",
    providers: "providers",
};

/**
 * The entry row, naming what it holds.
 *
 * "More" alone says there is another level without saying it is worth opening,
 * so the row lists what it can as far as the width allows and counts whatever
 * did not fit.
 */
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

/** Item-scoped actions for the highlighted model. */
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

/** The one action that belongs to the active collection rather than one row. */
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

/** The mark that hangs left of a row's label, if the row has one. */
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
    // A filled dot, at the weight of the fold arrows it shares a column with.
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
    // The session list turns the marker column into a marker, a fork gutter and
    // a time column, so the facts a row is worth reading for sit left of the
    // title rather than after it. A fork indents under its parent, which is
    // what makes the list read as a history rather than a pile.
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
/** Filled input inset, kept; the live trial is a left quote rule. */
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
    // An assignment row's whole content is what runs it, so the column carries
    // rather than the facts a model row shows.
    // The status word is the row's whole right-hand column, at any width.
    // An action carries its chord wherever it is listed, including where a
    // search has lifted it above the models.
    if (
        state.tab === "defaults" || state.tab === "actions"
        || tuiModelActionOfValue(option.value) !== undefined
    ) {
        return option.description === ""
            ? undefined
            : [{ text: option.description }];
    }
    // The column is facts, not one fact: a row can carry its provider, its
    // availability, its recommended level, and its verification state at once.
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

/**
 * Why a model list is empty, in the words of the thing the user can do next.
 *
 * A search that matched nothing, a catalog that was never fetched and an
 * absent conversation look identical once the rows are gone, so each one
 * names its own way out instead of reporting the same absence three times.
 */
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
    // Naming More is only help if More is on screen. It is built from the
    // actions available now, and an empty shortlist with no current model
    // leaves it with none.
    return modelPageEntry(state) === undefined
        ? "Nothing shortlisted yet. Tab switches to All models."
        : "Nothing shortlisted yet. More above adds the current model.";
}

/** The sentences under the empty column's title, wrapped to its width. */
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
        // System inherits the terminal palette, unknown until applied.
        return [fg(TUI_MUTED)("░░ ░░ ░░ ░░")];
    }
    return swatch.flatMap((color, index) => [
        ...(index === 0 ? [] : [fg(TUI_PANEL)(" ")]),
        fg(matched ? color : TUI_MUTED)("██"),
    ]);
}

/**
 * The pane, moved to another view of the same list. One path for ⇥ and for a
 * click on a tab, so the two cannot end up on different rows.
 *
 * The query is dropped on the way across. A search is a question about one
 * list, and carrying it over would land the user on an empty pane with no sign
 * of why.
 */
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
        // An action row is not a search result. It stays through every query,
        // because a search that found nothing is exactly when the thing to do
        // next is declare the provider that is missing.
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
    // Search stays inside the active tab. The tab is a claim about what the
    // list is showing, and a search that reached past it would leave the
    // heading and the rows saying different things.
    const options = state.kind !== "model"
        ? matching(state.allOptions, query)
        // A query opens every section: a heading with its rows hidden is a
        // claim that the search found nothing there, which is not what a
        // closed section means.
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

/** Fixed action lists do not draw or accept an invisible search query. */
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

/**
 * Marketplace catalogs sometimes prefix a model name with its maker even
 * though the model id already carries that namespace. The picker has a
 * separate provider column, so lead with the name users are scanning for.
 */
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
            // A pooled row is the user's own choice and outranks the fold, the
            // same way the curation does on the host side.
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

/** Hides the current-model action as soon as a fresh snapshot includes it. */
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

/** The heading the recommended models are listed under. */
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
    revealAll = false,
    assignmentOptions: readonly TuiSettingsPickerOption[] = [],
    actionOptions: readonly TuiSettingsPickerOption[] = [],
    intelligenceCutoff: IntelligenceCutoff = "any",
    keepModel?: string,
): readonly TuiSettingsPickerOption[] {
    // Search reaches a folded row whether or not the pane is revealed. Typing
    // an id is naming a model outright, and a list that answers "no such
    // model" to a model it holds is worse than a long list. Search also
    // bypasses the intelligence cutoff so a name still finds a cheaper model.
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
    // The shortlist is what the user put there, in their order. Grouping it
    // by provider or lifting actions into it would answer a question about
    // models with rows that are not models.
    if (tab === "pool" || tab === "defaults" || tab === "actions") {
        return matched;
    }
    // A search on a model list is the user asking for something by name, and
    // what they name is as often a thing to do as a model to run. The matching
    // actions ride above the models under their own heading, so the word finds
    // them without the user having to know which tab they live on.
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

/**
 * How many rows each provider holds in total, folded ones included.
 *
 * A closed heading reads `openrouter (87 of 337)` rather than `(87)`, which is
 * the difference between a list that is short and a list that is pretending
 * the rest of the catalog is not there.
 */
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
    return modelListFor(state, { collapsed: [] }).flatMap((option) => option.section === undefined ? [] : [option.section]);
}

/**
 * The heading the cursor sits under, which is the heading itself when the
 * cursor is on it.
 */
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

/** The pane with one section opened or closed, cursor left on its heading. */
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

/**
 * An Actions row resolved to the same transition its chord produces, so the
 * two ways in cannot drift apart. Rows that only rearrange this pane are done
 * here; the rest hand the client the work it already knows how to do.
 */
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
        // Showing the folded rows is a change to the model list, so it lands
        // the user on that list rather than leaving them on the Actions tab
        // wondering whether anything happened.
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
        // The Defaults tab shares the model pane but its rows are jobs, so
        // they resolve to the assignment rather than to a model.
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
        // The id rides along with the path because the caller has to recognise
        // the row for the session already on screen, and it knows itself by id.
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
        // The all row is read off the pane the user answered, not recomputed
        // later: what it stands for is the list they were looking at when they
        // pressed the key.
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
        // The clear row carries no model, which is what unbinds the slot.
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
        // The clear row carries no model, which is what empties the slot.
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

/**
 * The declaration form for a provider Vera does not ship: an OpenAI- or
 * Anthropic-compatible endpoint the user runs or pays for themselves.
 *
 * The quirk flags a declaration can carry (`images`, `max_tokens`,
 * `thinking`) stay hand-edited in `config.json`, which remains the file this
 * form writes and never a second source of truth.
 *
 * The key field is on this screen rather than in a prompt that follows it, so
 * declaring an endpoint and giving it a key is one action in any order. It is
 * present only while the credential choice is `api_key`; the key itself goes
 * to the credential store, never to `config.json`.
 */
export type TuiProviderFormFieldId =
    | "id"
    | "base_url"
    | "protocol"
    | "credential"
    | "api_key";

/** Every field the form can show, in screen order. */
export const TUI_PROVIDER_FORM_FIELDS: readonly TuiProviderFormFieldId[] = [
    "id",
    "base_url",
    "protocol",
    "credential",
    "api_key",
];

/** The fields this form actually shows, which the credential choice decides. */
export function tuiProviderFormFields(
    state: TuiProviderFormState,
): readonly TuiProviderFormFieldId[] {
    // A provider Vera ships already owns its name and its wire protocol: the
    // adapter is written against them. What moves is where it answers, and the
    // key that reaches it.
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
    /** Held only while the form is open, and never rendered in the clear. */
    readonly apiKey: string;
    readonly field: TuiProviderFormFieldId;
    /** Set by a refused submit, cleared by the next edit. */
    readonly error?: string;
    /** The pane this was opened over, restored when it closes. */
    readonly parent?: TuiSettingsPickerState;
    /**
     * The name this form opened on, when it opened on an existing declaration.
     * Absent on a new one. A submit whose name moved away from this is a
     * rename, which the caller settles by moving the stored credential.
     */
    readonly editing?: string;
    /**
     * Set when the form opened on a provider Vera ships. Its endpoint is the
     * only thing it declares, so the rest of the fields are not shown and the
     * submit is an override rather than a declaration.
     */
    readonly shipped?: boolean;
}

/** A finished form, on its way to the caller that owns the config file. */
export interface TuiProviderFormDeclaration {
    readonly id: string;
    readonly declaration: VeraCustomProviderConfig;
    /**
     * The key to store alongside the declaration, when one was entered. Absent
     * on a declaration that carries no key, so the caller stores nothing.
     */
    readonly apiKey?: string;
    /** The name this declaration replaces, when the form opened on one. */
    readonly replaces?: string;
    /**
     * Set when this is a shipped provider's endpoint rather than a
     * declaration. The caller writes `provider_endpoints`, not `providers`.
     */
    readonly shipped?: boolean;
    /** Set when a shipped provider goes back to the host Vera ships with. */
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
    /** Present only on a submit that passed the form's own checks. */
    readonly submitted?: TuiProviderFormDeclaration;
}

export interface TuiProviderFormView {
    /** The visible card; focus lives here. */
    readonly box: BoxRenderable;
    /** Full-screen centering surface; visibility lives here. */
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
        /** A provider Vera ships, opened to move its endpoint. */
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

/**
 * A pasted base URL. Same reason the secret prompt takes one: the terminal
 * delivers a bracketed paste as its own event rather than as keystrokes, and a
 * URL is the field most likely to arrive that way.
 */
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
    // Swallowed rather than passed down, for the same reason the name prompt
    // swallows them: the pane behind this card is a list with its own
    // bindings, and a key falling through would move a row nobody can see.
    // Interrupt is decided ahead of every overlay and never reaches here.
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

/** One step through the shown fields, wrapping at either end. */
function movedProviderFormField(
    state: TuiProviderFormState,
    step: 1 | -1,
): TuiProviderFormState {
    const fields = tuiProviderFormFields(state);
    const at = fields.indexOf(state.field);
    const next = (at + step + fields.length) % fields.length;
    return { ...state, field: fields[next]! };
}

/**
 * What the form can decide on its own: a name that is usable as a key and a
 * URL that is there at all. Whether the URL is one Vera will accept is the
 * config writer's call, and its refusal comes back on the same error line.
 *
 * Checks run here rather than on every edit, so a half-typed field never
 * blocks moving to another one.
 */
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
    // A shipped provider always has a host to fall back to, so an emptied
    // field is the way back to it rather than a mistake.
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
            // An empty key field is a declaration without a key yet, not an
            // empty key, so it is left off rather than stored as "".
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
    // Turning the key off drops what was typed rather than keeping it out of
    // sight, so a declaration saved as keyless carries no key anywhere.
    return state.credential === "api_key"
        ? { ...rest, credential: "none", apiKey: "" }
        : { ...rest, credential: "api_key" };
}

/**
 * The shown rows as they read on screen, cursor and all.
 *
 * The key is drawn in the clear. A field being filled in shows its literal
 * value, so a paste that arrived truncated is visible while it can still be
 * fixed. Masking would belong to a stored key shown back to a passer-by, and
 * no surface does that.
 *
 * A field standing empty shows its placeholder softened, so nothing on this
 * card reads as a value already there.
 */
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
        // A key already stored is covered until the cursor is on it. Typing
        // one stays in the clear: a row of dots hides whether a paste landed
        // whole, which is the mistake this field exists to catch.
        const shown = field === "api_key" && !focused
            // A fixed count rather than one dot per character: the real length
            // wraps the card at any real key, and it is a fact about the
            // secret that the field has no reason to publish.
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
                // A field the credential choice hides leaves the card
                // entirely rather than sitting there greyed out.
                row.visible = line !== undefined;
                row.content = line ?? new StyledText([]);
            });
            error.content = state.error ?? "";
            // ←→ picks between the choices on a toggle row and moves the
            // cursor on a typed one, so the hint says whichever the field
            // under the cursor actually does.
            footer.content = `↑↓ ${tuiKeyHint("next_form_field")} · ${
                providerFormTextField(state.field) ? "←→ move" : "←→ change"
            } · ⏎ save · esc cancel`;
        },
    };
}
