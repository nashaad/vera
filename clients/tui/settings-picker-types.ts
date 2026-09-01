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
import type { ProviderAccessKind } from "../../src/providers/registry.ts";
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

export const TUI_PROVIDER_GROUP_RANK: Readonly<Record<TuiProviderGroup, number>> = {
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

/**
 * The value of the row that opens the declaration form.
 *
 * Prefixed so it cannot collide with a provider id, which is what every other
 * row on this pane carries.
 */
export const TUI_DECLARE_PROVIDER_VALUE = "action:declare_provider";

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
export const MODEL_ASSIGNMENT_VALUE_PREFIX = "\u0000assignment:";

/** The session's own model, which is a row here but is not an assignment. */
export const SESSION_MODEL_VALUE = "\u0000session-model";

export const MODEL_ACTION_VALUE_PREFIX = "\u0000action:";

export const CONTEXT_LIMIT_VALUE = "\u0000context-limit";

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

export function tuiModelActionValue(action: string): string {
    return `${MODEL_ACTION_VALUE_PREFIX}${action}`;
}

/** The action a row stands for, or undefined when the row is not one. */
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

export function formatContextLimitOption(tokens: number): string {
    return tokens % 1_048_576 === 0
        ? `${tokens / 1_048_576}m`
        : `${Math.round(tokens / 1_024)}k`;
}

/** The session's model named the same way an assignment's model is. */
export function sessionRunsFact(
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

/** What runs the row, with the substitute named when it is not what was set. */
export function assignmentRunsFact(row: ModelAssignmentRow): string {
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

/** The one row that stands for every provider at once. */
export const CATALOG_REFRESH_ALL_VALUE = "\u0000all";

/**
 * Three significant figures at most, so the column stays the same width from
 * a fresh session to a long one and the unit carries the magnitude.
 */
export function formatSessionSize(bytes: number): string {
    if (bytes < 1_000) {
        return `${bytes}B`;
    }
    if (bytes < 1_000_000) {
        return `${Math.round(bytes / 1_000)}K`;
    }
    return `${(bytes / 1_000_000).toFixed(1)}M`;
}

/** The heading the recommended models are listed under. */
export const TUI_TOP_PICKS_SECTION = "Top picks";
