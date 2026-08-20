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
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import { inferReasoningSelection } from "../../src/model/reasoning-effort.ts";
import { isRefreshableProvider } from "../../src/model/refreshable-providers.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import {
    isVeraProviderId,
    type VeraCustomProviderConfig,
    type VeraProviderCredential,
    type VeraProviderProtocol,
} from "../../src/config.ts";
import type {
    ReviewerModelDefault,
    ReviewerModelSelection,
} from "../../src/engine/model-settings.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_CHROME,
    TUI_ELEMENT,
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
    attachDialogRowPointer,
    dialogOptionRows,
    dialogRowPointer,
    type DialogRowPointer,
    dialogSearchNode,
    registerDialogCard,
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
    | "context_limit"
    | "session"
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
    | "permission_mode"
    | "granted_permissions"
    | "reviewer"
    | "reviewer_primary"
    | "reviewer_fallback";

export type TuiSettingsMenuKind = Extract<
    TuiSettingsPickerKind,
    "settings" | "permission_settings" | "reviewer_settings"
>;

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
    /** Declared in config rather than shipped, so its endpoint is editable. */
    readonly declared?: boolean;
    /**
     * Whether the endpoint is the user's to move. False for a provider reached
     * over a flow bound to the account it signs in to.
     */
    readonly endpointEditable?: boolean;
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
    /** Overrides the name the pane draws for its kind. */
    readonly title?: string;
    /** A line under the title, for a pane whose rows need the context. */
    readonly subtitle?: string;
    readonly initialTheme?: TuiThemeName;
    readonly initialModel?: string;
    readonly loading?: boolean;
    /** Set only on the model pane. */
    readonly tab?: TuiModelPickerTab;
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
    /** The caller has one confirmed pool change it can reverse. */
    readonly canUndoPoolChange?: boolean;
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
    /** Set only on an assignment pane: which assignment the chosen row binds. */
    readonly modelAssignment?: ModelAssignmentId;
    /**
     * Set on the model pane once the user has asked for the folded rows. Like
     * `collapsed`, it lasts as long as the pane: wanting the whole catalog is
     * a question about this visit rather than a setting to carry forward.
     */
    readonly revealAll?: boolean;
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
        readonly kind: "session";
        readonly sessionPath: string;
        readonly sessionId?: string;
    }
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
    /** What clicking a tab chip does, in the same terms as the ⇥ key. */
    onTab?: (tab: TuiModelPickerTab) => void;
    /** Opens provider connection without changing which model tab is active. */
    onConfigure?: () => void;
    update(state: TuiAnySettingsPickerState): void;
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
        ...(state.revealAll === true ? { revealAll: true } : {}),
        ...(collapsed.length === 0 ? {} : { collapsed }),
        // Slot rows are read from config and the pool rather than from the
        // host, so a rebuild has nothing to put back and has to carry them.
        ...(state.assignmentOptions === undefined
            ? {}
            : { assignmentOptions: state.assignmentOptions }),
        ...(state.actionOptions === undefined
            ? {}
            : { actionOptions: state.actionOptions }),
        options: modelPickerOptions(
            rebuilt.allOptions,
            tab,
            collapsed,
            "",
            state.revealAll === true,
            state.assignmentOptions ?? [],
            state.actionOptions ?? [],
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
        value: "permissions",
        label: "Permissions",
        description: "what Vera may run, and what you have approved",
        searchText: "grants approvals allowed",
    },
    {
        value: "reviewer",
        label: "Reviewer",
        description: "which model approves actions in auto mode",
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
    options: {
        /** The row to open on, for a caller that just changed one. */
        readonly selected?: string;
        /** A line under the title, for something the pane has to say. */
        readonly subtitle?: string;
    } = {},
): TuiSettingsPickerState {
    const rows: TuiSettingsPickerOption[] = providers.map((provider) => ({
        value: provider.id,
        label: provider.label,
        description: provider.hint ?? "",
        searchText: provider.id,
        group: provider.group,
        connected: provider.connected,
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
    options: { readonly hasPool?: boolean } = {},
): readonly TuiSettingsPickerOption[] {
    // One row, not one per provider: which providers to ask is the second
    // question, and asking it here would repeat the same chord down the list.
    const rows: TuiSettingsPickerOption[] = providers.length === 0 ? [] : [{
        value: tuiModelActionValue("refresh"),
        label: "Refresh model lists",
        description: tuiKeyHint("refresh_catalog").split(" ")[0] ?? "",
        note:
            "Asks the providers for their models again, so anything released since the last check shows up here. Which ones to ask comes next.",
        detailTitle: "refresh model lists",
        detailFacts: [],
        searchText: `refresh reload update fetch new models catalog ${
            providers.join(" ")
        }`,
    }];
    if (options.hasPool === true) {
        rows.push({
            value: tuiModelActionValue("verify_pool"),
            label: "Check that shortlisted models work",
            description: tuiKeyHint("verify_pool").split(" ")[0] ?? "",
            note:
                "Sends one small request to each model on the shortlist and marks the ones that answer.",
            detailTitle: "check the shortlist",
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
        return "this session's model";
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
    const ifUnset = row.inherits === undefined
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
            searchText: "reviewer approval auto",
        },
        {
            value: "reviewer_fallback",
            label: "Failsafe",
            description: reviewerSlotLabel(reviewerDefault?.fallback),
            searchText: "reviewer fallback backup",
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
        label: slot === "primary" ? "Use the agent's model" : "None",
        description: slot === "primary"
            ? "review with whatever model the session runs"
            : "no failsafe reviewer",
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
            label: `Everything you keep (${total})`,
            description: "re-probes models that already answered",
        },
    ];
    return {
        kind: "pool_verify_scope",
        title: "Probe the models you keep",
        subtitle: "each one is a live call to its provider",
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
        title: "Refresh model lists",
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
    current?: string,
): TuiSettingsPickerState {
    const seen = new Set<string>();
    const rows: TuiSettingsPickerOption[] = [];
    for (const entry of pooled) {
        const value = `${entry.provider}/${entry.model}`;
        if (seen.has(value)) continue;
        seen.add(value);
        rows.push({
            value,
            label: entry.poolName ?? entry.label,
            description: entry.provider,
            provider: entry.provider,
            model: entry.model,
            searchText: `${entry.provider} ${entry.model}`,
        });
    }
    const clearRow: TuiSettingsPickerOption = {
        value: REVIEWER_CLEAR_VALUE,
        label: "Not set",
        description: unsetAssignmentMeans(assignment),
    };
    const browseRow: TuiSettingsPickerOption = {
        value: MODEL_ASSIGNMENT_BROWSE_VALUE,
        label: `Keep another model on ${modelTabLabel("pool")}\u2026`,
        description: `a default can only name a model on ${modelTabLabel("pool")}`,
    };
    const options = [clearRow, ...rows, browseRow];
    return {
        kind: "model_assignment",
        // What this assignment is for belongs to the pane, not to one of its
        // rows: read on a row it looks like a description of that row.
        title: `Assign a model to ${label}`,
        subtitle: intent,
        allOptions: options,
        options,
        selectedIndex: Math.max(
            0,
            options.findIndex((option) => option.value === current),
        ),
        query: "",
        modelAssignment: assignment,
    };
}

/** What leaving an assignment unset does, which is the row's real meaning. */
function unsetAssignmentMeans(assignment: ModelAssignmentId): string {
    return isJobAssignmentId(assignment)
        ? `uses ${JOB_ASSIGNMENT_INTENTS[assignment]}`
        : "uses this session's model";
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
    includeUntitled = false,
    sharedAgentGroups: readonly (readonly [string, string])[] = [],
): TuiSettingsPickerState {
    // The current session is listed rather than hidden. Switching is a
    // re-attach with the screen left up, so its row costs nothing and answers
    // "which one am I in" without the user having to remember.
    const options = agents
        .filter((agent) => agent.status !== "closed"
            && agent.status !== "failed"
            && (includeUntitled
                || agent.title !== undefined
                || agent.has_user_content === true
                || agent.parent_id !== undefined
                || agent.forked_from !== undefined))
        .toSorted((left, right) =>
            (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
        )
        .map((agent) => ({
            value: agent.session_path,
            label: sessionTitle(agent.title ?? agent.id),
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
        if (provider === undefined || !isRefreshableProvider(provider)) {
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
        const options = modelPickerOptions(
            modelState.allOptions,
            modelState.tab ?? "all",
            modelState.collapsed ?? [],
            modelState.query,
            revealAll,
            modelState.assignmentOptions ?? [],
            modelState.actionOptions ?? [],
        );
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
            modelState.revealAll === true,
            modelState.assignmentOptions ?? [],
            modelState.actionOptions ?? [],
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
        (key.name.length === 1 || key.name === "space")
        && !key.ctrl
        && !key.meta
    ) {
        return searched(state, state.query + (key.name === "space" ? " " : key.name));
    }
    // Left and right open and close a section, the shape a tree has everywhere
    // else. On a row inside a section they act on the heading above it, so
    // closing a long provider does not first mean scrolling back up to it.
    if (key.name === "left" || key.name === "right") {
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
        top: pickerTopOffset(renderer),
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
        update(state): void {
            for (const node of nodes) {
                node.destroyRecursively();
            }
            nodes = [];
            box.title = undefined;
            if (state.kind === "theme") {
                box.paddingTop = 2;
                box.paddingBottom = 1;
                box.top = themePickerTop(renderer, state.allOptions.length);
                box.left = "20%";
                box.width = "60%";
                box.height = "auto";
                renderThemePickerRows(renderer, box, state, nodes, view.pointer);
                return;
            }
            // A session is recognised by its title, and titles are the one row
            // value with no natural length, so this list gets the whole
            // terminal rather than the inset card the settings panes use. It
            // starts at the top edge too: an inset card is read against the
            // scrimmed transcript around it, but a full-width panel with a
            // strip of transcript over it reads as a row that leaked through.
            box.top = state.kind === "session" ? 0 : pickerTopOffset(renderer);
            box.left = state.kind === "session" ? 0 : "10%";
            box.width = state.kind === "session" ? "100%" : "80%";
            renderListPickerRows(
                renderer,
                box,
                state,
                nodes,
                view.pointer,
                view.tip,
                view.onTab,
                view.onConfigure,
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
        dialogBoxHeight(renderer, pickerTopOffset(renderer)),
        DIALOG_CHROME_HEIGHT + extraChrome,
    );
    return Math.max(LIST_MIN_ROWS, Math.floor(lines / rowLines));
}

// OpenCode's dialog wrapper starts cards a quarter of the way down the
// terminal. Using the same measured offset keeps Vera's inset pickers near the
// visual centre while leaving the full-width session list anchored at row 0.
function pickerTopOffset(renderer: RenderContext): number {
    return renderer.height / 4;
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
            pickerTopOffset(renderer),
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
): number {
    const rows = pickerMaxRows(
        renderer,
        (modelStripStop(state) === undefined ? 0 : MODEL_TAB_STRIP_HEIGHT)
            + (state.kind === "extension" && state.subtitle !== undefined ? 1 : 0),
    );
    return state.kind === "model" && state.tab === "all"
        ? Math.min(rows, MODEL_ALL_MAX_ROWS)
        : rows;
}


/**
 * Whether the facts about the highlighted row are drawn beside the list.
 *
 * The pool only. It is a short list the user built, so there is room beside it
 * and a reason to look: what a pooled model can do is why it is in the pool.
 * All models is hundreds of rows long and is read by scanning names, which a
 * half-width column turns into a list of clipped prefixes.
 */
function hasModelDetail(state: TuiAnySettingsPickerState): boolean {
    const tab = state.kind === "model" ? state.tab ?? "all" : undefined;
    return tab === "pool" || tab === "defaults" || tab === "actions";
}

/** The narrowest the detail column is worth drawing at. */
const MODEL_DETAIL_MIN_WIDTH = 26;

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
): ModelPaneSplit | undefined {
    if (!hasModelDetail(state)) {
        return undefined;
    }
    const cardWidth = pickerCardWidth(renderer, state);
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
): number {
    return Math.max(0, pickerCardWidth(renderer, state) - DIALOG_GUTTER_WIDTH);
}

/**
 * The columns the card has inside its own padding. The footer runs the whole
 * width, so it is measured against this rather than against the row width,
 * which is short by the leading gutter.
 */
function pickerCardWidth(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
): number {
    const cardWidth = state.kind === "session"
        ? renderer.width
        : Math.floor(renderer.width * 0.8);
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
function stackedDetailLines(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption | undefined,
    width: number,
): readonly (readonly TextChunk[])[] {
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

function modelDetailNode(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    width: number,
    height: number,
): BoxRenderable {
    const pane = new BoxRenderable(renderer, {
        width: width + MODEL_DETAIL_RULE.length,
        height,
        flexShrink: 0,
        flexDirection: "column",
    });
    let drawn = 0;
    const line = (chunks: readonly TextChunk[] = []): void => {
        if (drawn >= height) return;
        drawn += 1;
        pane.add(new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_ELEMENT)(MODEL_DETAIL_RULE), ...chunks]),
            width: width + MODEL_DETAIL_RULE.length,
            height: 1,
        }));
    };
    const option = state.options[state.selectedIndex];
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
        line([fg(TUI_TEXT)(clippedTo(option.label, width))]);
        line([
            fg(TUI_MUTED)(clippedTo(
                option.model === undefined || option.poolName === undefined
                    ? option.provider ?? ""
                    : `${option.provider ?? ""} · ${option.model}`,
                width,
            )),
        ]);
        line();
        for (const fact of modelDetailFacts(state, option)) {
            const [label, value, tone] = fact;
            line([fg(TUI_MUTED)(label)]);
            line([
                fg(tone === "positive" ? TUI_SUCCESS : TUI_TEXT)(
                    clippedTo(value, width),
                ),
            ]);
        }
        line();
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
function modelHelpNode(renderer: RenderContext, width: number): BoxRenderable {
    const page = new BoxRenderable(renderer, {
        width,
        height: MODEL_HELP_LINES.length,
        flexShrink: 0,
        flexDirection: "column",
    });
    for (const [term, meaning] of MODEL_HELP_LINES) {
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

const MODEL_HELP_TERM_WIDTH = 14;

/**
 * A term and what it means, or a lone string for a heading or a blank line.
 */
const MODEL_HELP_LINES: readonly (readonly [string, string?])[] = [
    ["The two lists"],
    ["Shortlist", "the models you keep. Ordered by you, not by provider."],
    ["All models", "every model your connected providers offer."],
    ["Top picks", "models Vera is built and tested against."],
    [""],
    ["Marks"],
    ["●", "the model this conversation is running."],
    ["✓", "on Shortlist: answered a live probe, so its abilities are known."],
    ["shortlisted", "on All models: already on your shortlist."],
    ["top pick", "a model Vera is built and tested against."],
    ["▼ ▶", "an open or closed section. ←→ opens and closes it."],
    [""],
    ["Keys"],
    ["⏎", "run this model. On All models it does not add it."],
    ["^s", "add the highlighted model to the shortlist, or remove it."],
    ["^n", "give a shortlisted model a short name of your own."],
    ["^⇧r ^v", "probe a model, or every model you keep."],
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
    const option = state.options[state.selectedIndex];
    const described = option !== undefined && option.section === undefined;
    if (described && option.detailFacts !== undefined) {
        // The name, a blank, two lines per fact, a blank, and the note.
        return 3 + option.detailFacts.length * 2
            + wrappedTo(option.note ?? "", width).length;
    }
    // The name, the source, a blank, two lines per fact, and a blank under them.
    const facts = described
        ? 3 + modelDetailFacts(state, option).length * 2 + 1
        : 0;
    return facts;
}

type ModelDetailFact = readonly [string, string, ("positive" | undefined)?];

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
    facts.push(["Images", option.images === true ? "yes" : "not known"]);
    facts.push(["Model ID", option.model ?? "—"]);
    if (option.recommended === true) {
        facts.push(["Curation", "top pick", "positive"]);
    }
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
    onTab?: (tab: TuiModelPickerTab) => void,
    onConfigure?: () => void,
): void {
    const tab = state.kind === "model" ? state.tab ?? "all" : undefined;
    const stripPane = modelStripPane(state);
    const stop = modelStripStop(state);
    // The help page keeps the field so that tabbing onto it does not lift the
    // tabs and everything under them by three lines. It draws inert, without
    // the caret, since this page holds nothing to filter.
    // A pane whose whole list is two fixed answers has nothing to filter, and
    // an empty field above them reads as a row the cursor has landed on.
    const searchable = state.kind !== "extension"
        && state.kind !== "pool_verify_scope"
        && state.kind !== "catalog_refresh_scope";
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
    if (searchable) {
        const search = dialogSearchNode(
            renderer,
            state.query,
            "Search",
            tab !== "help",
        );
        box.add(search);
        nodes.push(search);
    }
    if (stop !== undefined && stripPane !== undefined) {
        const strip = modelTabStripNode(
            renderer,
            stop,
            {
                pool: modelTabRows(stripPane.allOptions, "pool").length,
                all: modelTabRows(stripPane.allOptions, "all").length,
            },
            pickerContentWidth(renderer, state),
            tab === undefined || tab === "help" ? undefined : modelPaneNote(state),
            onTab,
            onConfigure,
        );
        box.add(strip);
        nodes.push(strip);
    }

    if (tab === "help") {
        const page = modelHelpNode(renderer, pickerCardWidth(renderer, state));
        box.add(page);
        nodes.push(page);
        const footer = dialogFooterNode(
            renderer,
            pickerFooter(state, pickerCardWidth(renderer, state)),
        );
        box.add(footer);
        nodes.push(footer);
        box.height = "auto";
        return;
    }

    // The list and the facts about the highlighted row sit side by side, so the
    // rows go into a column of their own rather than straight onto the card.
    const split = modelPaneSplit(renderer, state);
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
        ? pickerContentWidth(renderer, state)
        : split.listWidth - MODEL_LIST_RULE_GAP;

    const availableRows = pickerMaxRows(
        renderer,
        (stop === undefined ? 0 : MODEL_TAB_STRIP_HEIGHT) + subtitleLines,
    );
    const rows = windowedDisplayRows(
        listDisplayRows(state),
        state.selectedIndex,
        tab === "all"
            ? Math.min(availableRows, MODEL_ALL_MAX_ROWS)
            : availableRows,
    );
    let lines = 0;
    if (rows.length === 0) {
        const empty = new TextRenderable(renderer, {
            content: `${DIALOG_GUTTER}${emptyPickerMessage(state)}`,
            fg: TUI_MUTED,
            width: "100%",
            height: 1,
        });
        listColumn.add(empty);
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
    const sharedOnScreen = new Map<string, number>();
    for (const option of state.options) {
        if (option.sharedGroup === undefined) continue;
        sharedOnScreen.set(
            option.sharedGroup,
            (sharedOnScreen.get(option.sharedGroup) ?? 0) + 1,
        );
    }
    let tinted = false;
    const optionNodes = dialogOptionRows(renderer, rows.flatMap((row) =>
        row.kind === "option"
            ? [{
                label: digitQuickSelect(state)
                        && state.query === ""
                        && row.index < 9
                    ? `${row.index + 1}. ${row.option.label}`
                    : row.option.label,
                marker: optionMarker(state, row.option),
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
                meta: optionMeta(state, row.option, detailed),
                active: row.index === state.selectedIndex,
                current: row.option.section !== undefined
                    || isCurrentOption(state, row.option),
                ...dialogRowPointer(pointer, row.index),
            }]
            : []
    ), rowWidth);
    let optionNodeIndex = 0;
    rows.forEach((row, position) => {
        const node = row.kind === "group"
            ? dialogGroupHeaderNode(renderer, row.label, position > 0)
            : optionNodes[optionNodeIndex++]!;
        lines += row.kind === "group" ? (position > 0 ? 2 : 1) : 1;
        listColumn.add(node);
        nodes.push(node);
    });
    if (split !== undefined && body !== undefined) {
        // The facts fill a column as tall as the list beside them, so a model
        // that carries more of them never moves a row.
        lines = Math.max(lines, modelDetailHeight(state, split.detailWidth));
        listColumn.height = lines;
        const detail = modelDetailNode(
            renderer,
            state,
            split.detailWidth,
            lines,
        );
        body.add(detail);
        nodes.push(detail);
        body.height = lines;
    }

    // The same block the column would have carried, under the list instead of
    // beside it. The pane keeps what it says at every width and gives up only
    // the second column, which is what the terminal actually ran out of.
    if (split === undefined) {
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

    const footer = dialogFooterNode(
        renderer,
        pickerFooter(state, pickerCardWidth(renderer, state)),
    );
    box.add(footer);
    nodes.push(footer);
    box.height = "auto";
}

// The strip, breathing room, its one-line collection explanation, and another
// blank before the rows. The explanation is content of its own, not a label
// attached to either the tabs above or the list below.
const MODEL_TAB_STRIP_HEIGHT = 4;
const MODEL_ALL_MAX_ROWS = 28;

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

/**
 * The name a tab is drawn with, read from the one list that names them, so
 * prose that points at a tab cannot drift from the tab's own label.
 */
function modelTabLabel(tab: TuiModelPickerTab): string {
    return MODEL_TAB_LABELS.find(([id]) => id === tab)?.[1] ?? tab;
}

const MODEL_TAB_DESCRIPTIONS: Readonly<Record<TuiModelPickerTab, string>> = {
    defaults: "Every job Vera runs a model for, and the model it runs.",
    pool: "Models you keep close. ^s pins one here, or unpins it.",
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
): BoxRenderable {
    const strip = new BoxRenderable(renderer, {
        width: "100%",
        height: MODEL_TAB_STRIP_HEIGHT,
        flexDirection: "column",
    });
    const chips = new BoxRenderable(renderer, {
        width: "100%",
        height: 1,
        flexDirection: "row",
    });
    const fullNames = MODEL_TAB_LABELS.map(([id, label]) => {
        const count = counts[id];
        return count === undefined ? label : `${label} (${count})`;
    });
    const namesWithoutCounts = MODEL_TAB_LABELS.map(([, label]) => label);
    const stripWidth = (names: readonly string[], gap: number, pad = 1) =>
        names.reduce(
            (total, name) => total + Bun.stringWidth(name) + pad * 2,
            0,
        )
        + gap * MODEL_TAB_LABELS.length
        // The active Providers stop carries padding on both sides.
        + Bun.stringWidth(" Providers ^e ");
    const shortened = (names: readonly string[]) =>
        names.map((name) =>
            name.startsWith("All models")
                ? name.replace("All models", "All")
                : name
        );
    // How many models a collection holds is the first thing asked of a
    // shortlist, so the counts are the last thing given up: the strip tightens
    // its gaps and shortens its longest name before it drops them.
    const rungs: readonly (readonly [readonly string[], number, number])[] = [
        [fullNames, 2, 1],
        [fullNames, 1, 1],
        [shortened(fullNames), 1, 1],
        [namesWithoutCounts, 2, 1],
        [namesWithoutCounts, 1, 1],
        [shortened(namesWithoutCounts), 1, 1],
        // The last rung gives up the padding inside the chips, which costs the
        // highlight its margin but keeps every stop on the strip. A stop the
        // user cannot see is a stop they cannot reach.
        [shortened(namesWithoutCounts), 1, 0],
    ];
    const [names, gap, pad] = rungs.find(([candidate, spacing, padding]) =>
        stripWidth(candidate, spacing, padding) <= width
    ) ?? rungs.at(-1)!;
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
        const chip = new TextRenderable(renderer, {
            content: new StyledText([
                id === tab
                    ? fg(TUI_BACKGROUND)(bg(TUI_ACCENT)(text))
                    : fg(TUI_ACCENT)(text),
            ]),
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
        chips.add(new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_PANEL)(" ".repeat(gap))]),
            flexShrink: 0,
            height: 1,
        }));
    });
    // The last stop on the strip. It swaps what the card lists rather than
    // what the model list shows, so it keeps a key of its own as well, but it
    // highlights and answers to ⇥ like the chips before it.
    const chord = tuiKeyHint("open_providers").split(" ")[0] ?? "";
    const configure = new TextRenderable(renderer, {
        content: new StyledText(
            tab === "providers"
                ? [fg(TUI_BACKGROUND)(bg(TUI_ACCENT)(` Providers ${chord} `))]
                : [fg(TUI_ACCENT)("Providers "), fg(TUI_MUTED)(chord)],
        ),
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
    return strip;
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
            ...(selected?.value !== undefined
                    && isRefreshableProvider(selected.value)
                ? [tuiKeyHint("refresh_catalog")]
                : []),
            ...(state.parent?.kind === "model" ? ["⇥ tabs"] : []),
            state.parent === undefined ? "esc close" : "esc back",
        ].join(" · ");
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
            ...(selected?.provider === undefined
                ? []
                : [{ text: tuiKeyHint("verify_model"), drop: 2 }]),
            ...(selected?.provider !== undefined
                    && isRefreshableProvider(selected.provider)
                ? [{ text: tuiKeyHint("refresh_catalog"), drop: 4 }]
                : []),
            // Behind the single-model key, since the sweep is the rarer of the
            // two and the one that costs a call per row.
            ...(state.tab === "pool"
                ? [{ text: tuiKeyHint("verify_pool"), drop: 3 }]
                : []),
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
            // Only where there is something folded to reveal, and it names the
            // direction the key would take you rather than the state you are
            // in, so the hint stays an instruction on both passes.
            ...(hasFoldedRows(state)
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
        || (state.kind === "model" && state.tab === "defaults");
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

/** The mark that hangs left of a row's label, if the row has one. */
function optionMarker(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): string | undefined {
    if (option.section !== undefined) {
        return option.sectionCollapsed === true ? "▶" : "▼";
    }
    if (state.kind === "provider") {
        if (option.action === true) {
            return "+";
        }
        return option.connected === true ? "✓" : undefined;
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

function optionMeta(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
    detailed = false,
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
        && !detailed
        && (option.inTopPicks === true || !isProviderGrouped(state))
    ) {
        separated({ text: option.provider });
    }
    // Vera's own curation, as a fact among the others rather than a view the
    // user has to know about: a row that is a top pick says so wherever it is
    // listed, the provider sections and search results included.
    if (option.recommended === true && option.inTopPicks !== true) {
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
        separated({ text: "unavail" });
    }
    // Only a yes is worth a word. The question this answers is whether an
    // attachment will go through, so the mark being there is the answer and
    // its absence means do not count on it.
    if (option.images === true && !detailed) {
        separated({ text: "images", tone: "positive" });
    }
    if (option.pooledRank !== undefined) {
        // On the Pool tab every row is pooled, so the column answers the other
        // question: a probed row earns a mark and an unprobed one earns
        // nothing. The word "unverified" on most of the rows at once says less
        // than a mark on the few that have been probed, and what the highlighted
        // row's own state is gets spelled out in the column beside the list.
        // Elsewhere the pool is what the column is for: the catalog is where
        // models are picked up, and a row with nothing here is one the pool
        // does not hold.
        if (state.tab === "pool") {
            if (option.unverified !== true) {
                separated({ text: "✓", tone: "positive" });
            }
        } else {
            separated({ text: "shortlisted", tone: "positive" });
        }
    }
    return parts.length === 0 ? undefined : parts;
}

function emptyPickerMessage(state: TuiAnySettingsPickerState): string {
    if (state.kind === "extension") {
        return "No options available";
    }
    if (state.kind === "model" && state.tab === "pool") {
        return "No shortlisted models match. Tab switches to All models.";
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
    const options = modelPickerOptions(
        state.allOptions,
        tab,
        state.collapsed ?? [],
        "",
        state.revealAll === true,
        state.assignmentOptions ?? [],
        state.actionOptions ?? [],
    );
    return {
        ...state,
        tab,
        options,
        query: "",
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
            state.revealAll === true,
            state.assignmentOptions ?? [],
            state.actionOptions ?? [],
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
            label: modelRowLabel(model),
            description: model.description,
            searchText: `${model.provider} ${model.model}${
                poolEntry.get(value)?.entry.poolName === undefined
                    ? ""
                    : ` ${poolEntry.get(value)?.entry.poolName}`
            }`,
            provider: model.provider,
            model: model.model,
            ...(model.hiddenByDefault === undefined
                ? {}
                : { hiddenByDefault: model.hiddenByDefault }),
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
): readonly TuiSettingsPickerOption[] {
    if (tab === "help") {
        return [];
    }
    if (tab === "actions") {
        return actionOptions;
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
        );
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
    revealAll = false,
    assignmentOptions: readonly TuiSettingsPickerOption[] = [],
    actionOptions: readonly TuiSettingsPickerOption[] = [],
): readonly TuiSettingsPickerOption[] {
    // Search reaches a folded row whether or not the pane is revealed. Typing
    // an id is naming a model outright, and a list that answers "no such
    // model" to a model it holds is worse than a long list.
    const rows = modelTabRows(
        allOptions,
        tab,
        revealAll || query !== "",
        assignmentOptions,
        actionOptions,
    );
    const matched = query === "" ? rows : matching(rows, query);
    // Neither list is sectioned by provider: the pool is one short list, and a
    // assignment row is a job, which has no provider to be grouped under.
    if ((tab === "pool" || tab === "defaults" || tab === "actions")
        && query === ""
    ) {
        return matched;
    }
    if (tab === "defaults" || tab === "actions") {
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
    return modelPickerOptions(
        state.allOptions,
        state.tab ?? "all",
        [],
        state.query,
        state.revealAll === true,
        state.assignmentOptions ?? [],
        state.actionOptions ?? [],
    ).flatMap((option) => option.section === undefined ? [] : [option.section]);
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
    const options = modelPickerOptions(
        state.allOptions,
        state.tab ?? "all",
        collapsed,
        state.query,
        state.revealAll === true,
        state.assignmentOptions ?? [],
        state.actionOptions ?? [],
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
        // The clear row carries no model, which is what unbinds the slot.
        return {
            kind,
            assignment: state.modelAssignment ?? "extra",
            ...(value === REVIEWER_CLEAR_VALUE ? {} : {
                ...(option.provider === undefined
                    ? {}
                    : { provider: option.provider }),
                ...(option.model === undefined ? {} : { model: option.model }),
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
                        : kind === "permission_settings"
                            ? "Permissions"
                            : kind === "reviewer_settings"
                                ? "Reviewer"
                                : kind === "reviewer"
                                    ? "Select reviewer"
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
