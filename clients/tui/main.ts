import {
    BoxRenderable,
    CliRenderEvents,
    decodePasteBytes,
    fg,
    MarkdownRenderable,
    ScrollBoxRenderable,
    stripAnsiSequences,
    SyntaxStyle,
    StyledText,
    TextRenderable,
    createCliRenderer,
    KeyEvent,
    RGBA,
    type CliRenderer,
    type Renderable,
    type Selection,
    type MouseEvent,
} from "@opentui/core";
import { randomUUID } from "node:crypto";

import { AsyncLocalStorage } from "node:async_hooks";
import { sourceVersion } from "../../src/build-info.ts";
import { openFileInEditor, veraConfigPath } from "../editor.ts";
import { tuiComposerOverlayInset } from "./appearance.ts";
import {
    buildJumpRows,
    handleJumpMenuKey,
    jumpMenuLines,
    openJumpMenu as openJumpMenuState,
    type JumpMenuState,
    type JumpOrigin,
    type JumpRow,
} from "./jump.ts";
import { registerTuiParsers } from "./parsers.ts";
import {
    createTuiFlightRecorder,
    type TuiFlightRecorder,
} from "./flight-recorder.ts";
import {
    installTerminalRestoreOnExit,
    watchTerminalLoss,
} from "./terminal-restore.ts";
import { readLatestHostStartupTiming } from "./host-startup-diagnostics.ts";

import {
    APP_PADDING_BOTTOM,
    APP_PADDING_TOP,
    DIALOG_BACKGROUND_Z_INDEX,
    DIALOG_CARD_Z_INDEX,
    DIALOG_SCRIM_Z_INDEX,
    refreshDialogChrome,
    registerDialogCard,
    type DialogRowPointer,
} from "./dialog-chrome.ts";

import {
    isToolApprovalUiRequestUpdate,
    isTimelineReplyUpdate,
    isUserQuestionUiRequestUpdate,
    type AgentUpdate,
    type AttachmentRef,
    type ClientCommand,
    type UiRequestUpdate,
} from "../../src/engine/protocol.ts";
import type {
    DeveloperSettingsPatch,
    ModelSettingsPatch,
    ModelTurnSettings,
} from "../../src/engine/model-settings.ts";
import type { ModelReasoningEffort, UserMessage } from "../../src/model/types.ts";
import type {
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import { levelsForModel } from "../../src/model/catalog-view.ts";
import { isRefreshableProvider } from "../../src/model/refreshable-providers.ts";
import { derivedModelName } from "../../src/config/model-catalog.ts";
import {
    configuredModelAssignments,
    loadOptionalVeraConfig,
    updateVeraConfigDefaults,
    type VeraProviderId,
    tipsEnabled as configuredTipsEnabled,
    type VeraExtensionConfig,
} from "../../src/config.ts";
import {
    loadPoolFile,
    poolFileIssueNotices,
} from "../../src/model/pool-file-loader.ts";
import { poolReachability } from "../../src/model/assignment-reachability.ts";
import type {
    ModelAssignmentId,
    ModelAssignmentRow,
} from "../../src/config/model-assignments.ts";
import { bundledClientExtensions } from "../../src/extensions/bundled-client.ts";
import { invokeDirectClientExtensionCommand } from "../../src/extensions/client.ts";
import {
    type ClientExtensionRegistry,
} from "../../src/extensions/client-registry.ts";
import {
    composeSuggesterDismissalKey,
    findActiveComposeSuggester,
} from "./compose-suggester.ts";
import type {
    VeraClientConsultRequest,
    VeraClientConsultResult,
    VeraClientModelSettingsPatch,
    VeraClientModelSettingsUpdateResult,
    VeraClientPickerRequest,
    VeraClientPickerResult,
    VeraClientAgentCreateRequest,
    VeraClientAgentOpenRequest,
    VeraClientAgentMessageRequest,
    VeraExtensionDisposer,
} from "../../src/sdk/extensions.ts";
import type { VeraClientContextSnapshot } from "../../src/sdk/context.ts";
import type { ExtensionCommandDescriptor } from "../../src/extensions/commands.ts";
import {
    listExtensions,
    installExtension,
    removeExtension,
    setExtensionEnabled,
} from "../../src/extensions/manager.ts";
import {
    extensionTarget,
    renderExtensionInstallPreview,
    renderExtensionList,
    renderExtensionMutation,
    type ExtensionManagerCommand,
} from "../../src/extensions/manager-command.ts";
import type {
    TuiTimelinePickerState,
    TuiTimelinePickerTransition,
} from "./timeline-picker.ts";
import { createAgentThroughHost, resumeAgentThroughHost } from
    "../../src/host/agent-start-client.ts";
import type { AttachedAgentClient } from "../../src/host/attached-client.ts";
import type { BackgroundAgentsSnapshot } from "../../src/host/background-agents.ts";
import { listSessionsForExtension } from "./session-listing-projection.ts";
import type { VeraClientSessionListRequest } from "../../src/sdk/extensions.ts";
import {
    listAgentPageThroughHost,
    listAgentsThroughHost,
    type ListAgentsOptions,
    type ListedAgentsPage,
} from "../../src/host/agent-list-client.ts";
import {
    trashSessionThroughHost,
    type TrashSessionResult,
} from "../../src/host/session-trash-client.ts";
import {
    renameSessionThroughHost,
    type RenameSessionResult,
} from "../../src/host/session-rename-client.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import {
    HOST_CAPABILITY_HARNESS_MESSAGES,
    HOST_CAPABILITY_SESSION_SCOPED_STATE,
} from "../../src/host/capabilities.ts";
import {
    findOrStartResidentHost,
    hostEntrypointMismatchNotice,
} from "../host/launch.ts";
import {
    createTuiApprovalView,
    tuiApprovalHint,
} from "./approval.ts";
import {
    createTuiQuestionView,
} from "./question.ts";
import { applyTuiUiRequestUpdate } from "./ui-request-queue.ts";
import { createTuiSidebar } from "./sidebar.ts";
import { tuiTranscriptAtBottom } from "./transcript-scroll.ts";
import {
    TUI_TRANSCRIPT_INITIAL_WINDOW,
    TUI_TRANSCRIPT_MATERIALIZE_BATCH,
    TUI_TRANSCRIPT_MATERIALIZE_BUFFER,
    tuiTranscriptEntryIsVisible,
    tuiTranscriptEvictableRows,
    tuiTranscriptNeedsEarlierEntries,
    tuiTranscriptPrependRange,
    tuiTranscriptTailRange,
} from "./transcript-window.ts";
import { TuiAgentPane } from "./agent-pane.ts";
import { createTuiExperimentalHost } from "./experimental-tui-host.ts";
import { createTuiHostedAgentSurface } from "./hosted-agent-surface.ts";
import {
    createTuiClientExtensionAgentsAdapter,
} from "./client-extension-agents.ts";
import { createConfiguredTuiAgentClients } from "./configured-agent-client.ts";
import {
    configuredTuiClientExtensions,
    createTuiClientExtensionHostController,
    createTuiClientExtensionHostStarter,
} from "./client-extension-host.ts";
import {
    captureTuiExtensionComposeTarget,
    isCurrentTuiExtensionComposeTarget,
    type TuiExtensionComposeTarget,
} from "./client-extension-compose.ts";
import {
    clientExtensionReloadFailed,
    clientExtensionReloadStarted,
    clientExtensionReloadSucceeded,
    reloadTuiClientExtensions,
} from "./client-extension-reload.ts";
import { TuiHostedPanePersistence } from "./hosted-pane-persistence.ts";
import { TuiHostedSidebarAgent } from "./hosted-sidebar-agent.ts";
import {
    requireIdentifiedTuiAgentClient,
    type IdentifiedTuiAgentClient,
    type TuiAgentClient,
} from "./agent-client.ts";
export type { TuiAgentClient } from "./agent-client.ts";
import {
    resolveTuiHostedAgentAddressing,
    routeTuiAgentMessage,
    type TuiHostedAgentAddressing,
    visibleTuiAgentMentions,
} from "./agent-message-routing.ts";
import {
    renderTuiDiagnostics,
    type TuiClientExtensionReloadSnapshot,
    type TuiDiagnosticsScope,
    type TuiDiagnosticsSnapshot,
} from "./diagnostics.ts";
import { readProcessMemory } from "./process-memory.ts";
import {
    createTuiDiagnosticsDialogView,
    handleTuiDiagnosticsDialogKey,
    type TuiDiagnosticsDialogState,
} from "./diagnostics-dialog.ts";
import {
    diagnoseVeraProcesses,
    renderVeraDoctor,
    type VeraDoctorReport,
} from "../process-doctor.ts";
import {
    defaultStashRoot,
    summarizeStash,
} from "../../src/store/preimage-stash.ts";
import {
    defaultModelFailureLedgerPath,
    modelFailureNudge,
    readModelFailures,
    summariseModelFailures,
} from "../../src/store/model-failures.ts";
import {
    defaultFailureReportDirectory,
    failureReportConsultInput,
    failureReportMarkdown,
    writeFailureReport,
} from "../../src/store/failure-report.ts";
import {
    diagnoseProviders,
    renderProviderDoctor,
} from "../provider-doctor.ts";
import { copyTuiText, countTuiCharacters } from "./clipboard.ts";
import {
    createTuiCommandPaletteView,
    handleTuiCommandPaletteKey,
    handleTuiCommandPaletteScroll,
    startTuiCommandPalette,
    updateTuiCommandPaletteCommands,
    type TuiCommandPaletteState,
} from "./command-palette.ts";
import {
    createTuiHelpView,
    handleTuiHelpKey,
    handleTuiHelpScroll,
    startTuiHelp,
    updateTuiHelpCommands,
    type TuiHelpState,
} from "./help.ts";
import {
    createConfiguredBuiltinTuiCommandRegistry,
    extensionCommandResultText,
    registerExtensionTuiCommands,
    renderTuiArgumentSuggestions,
    renderTuiCommandSuggestions,
    tuiCommandSuggestionWidth,
    tuiSuggestionGaps,
    tuiSuggestionWindow,
    tuiArgumentCompletion,
    tuiArgumentSuggestions,
    tuiCommandScope,
    tuiWithArgument,
    type TuiCommandAction,
    type TuiCommandCatalogEntry,
    type TuiPaletteEntry,
} from "./commands.ts";
import {
    COMPOSER_PLACEHOLDER,
    createTuiComposer,
    createTuiComposerPanel,
    TUI_COMPOSER_MAX_TEXT_ROWS,
    TUI_COMPOSER_MIN_TEXT_ROWS,
    tuiComposerPanelRows,
} from "./composer.ts";
import {
    fitTuiAppearance,
    resolveTuiAppearance,
    tuiComposerContentIndent,
    type TuiAppearance,
} from "./appearance.ts";
import { renderTuiActivityAnimation } from "./activity-pulse.ts";
import { TuiBodyFocusController } from "./body-focus.ts";
import {
    createTuiPermissionsConfirmView,
    handleTuiPermissionsConfirmKey,
} from "./permissions-confirm.ts";
import {
    createTuiSessionTrashConfirmView,
    handleTuiSessionTrashConfirmKey,
} from "./session-trash-confirm.ts";
import {
    createTuiProviderForgetConfirmView,
    handleTuiProviderForgetConfirmKey,
    tuiProviderForgetDecision,
} from "./provider-forget-confirm.ts";
import {
    createTuiAdmissionDialogView,
    handleTuiAdmissionDialogKey,
    startTuiAdmissionDialog,
    type TuiAdmissionDialogState,
} from "./admission-dialog.ts";
import { renderTuiHeldAddress } from "./addressing.ts";
import { searchSessionsThroughHost } from "../../src/host/session-search-client.ts";
import { parseRawInputEvent, tuiInterruptAction } from "./interrupt.ts";
import { createTuiLinesView } from "./lines-view.ts";
import { wheelCursor } from "./list-window.ts";
import {
    applyWorkIndex,
    handleWorkTabKey,
    startWorkTab,
    workTabAction,
    workTabViewState,
    type WorkTabState,
} from "./work-tab.ts";
import {
    applyWorkspaceWorkIndex,
    clampWorkspaceRailColumns,
    handleWorkspaceSidebarKey,
    openWorkspaceSelection,
    refreshWorkspaceSidebarSessions,
    startWorkspaceSidebar,
    workspaceRailColumns,
    workspaceSidebarLayout,
    workspaceSidebarSessions,
    workspaceSidebarViewState,
    type WorkspaceSidebarAction,
    type WorkspaceSidebarState,
} from "./workspace-sidebar.ts";
import {
    applySearchFailure,
    applySearchResults,
    handleSearchOverlayKey,
    openSelected,
    searchOverlayViewState,
    searchSelectionOf,
    searchSelections,
    startSearchOverlay,
    type SearchOverlayState,
} from "./search-overlay.ts";
import {
    attentionNotice,
    attentionNoticeSequence,
    newAttentionRows,
    parseTerminalFocusEvent,
    FOCUS_REPORTING_OFF,
    FOCUS_REPORTING_ON,
} from "./attention-notice.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";
import type {
    SessionSearchQuery,
    SessionSearchResults,
} from "../../src/store/session-search.ts";
import { isTranscriptSelection, selectionSpeaker } from "./selection.ts";
import {
    renderTuiQuote,
    tuiQuoteMarker,
    withQuote,
    type TuiQuote,
} from "./quote.ts";
import {
    needsYouChipColumns,
    renderTuiCompactionHint,
    renderTuiIdleHint,
    renderTuiStatusDetailsRows,
    renderTuiStatusSegments,
    tuiStatusSnapshot,
    statusToneColor,
    type TuiStatusChunk,
} from "./status.ts";
import { watchWorkspaceBranch } from "./workspace-branch.ts";
import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerScroll,
    handleTuiSettingsPickerKey,
    tuiPickerViewportRows,
    startTuiReviewerMenu,
    startTuiReviewerPicker,
    startTuiSettingsMenu,
    startTuiContextLimitPicker,
    startTuiDeveloperMenu,
    startTuiDeveloperValuePicker,
    startTuiSettingsPicker,
    switchedModelTab,
    syncTuiModelPicker,
    startTuiReasoningPicker,
    startTuiSessionPicker,
    startTuiExtensionPicker,
    startTuiProviderPicker,
    tuiPickerAfterSelection,
    withTuiPickerParent,
    type TuiSettingsMenuTarget,
    type TuiAnySettingsPickerState,
    type TuiReviewerSlot,
    startTuiModelAssignmentPicker,
    startTuiPoolVerifyScopePicker,
    tuiModelActionOptions,
    startTuiCatalogRefreshScopePicker,
    tuiModelAssignmentOptions,
    type TuiSettingsPickerState,
    type TuiSettingsPickerTransition,
    type TuiExtensionPickerAction,
    type TuiExtensionPickerTransition,
    createTuiProviderFormView,
    handleTuiProviderFormKey,
    handleTuiProviderFormPaste,
    startTuiProviderForm,
    type TuiProviderFormState,
    type TuiProviderFormTransition,
} from "./settings-picker.ts";
import {
    createTuiSecretPromptView,
    handleTuiSecretPromptKey,
    handleTuiSecretPromptPaste,
    startTuiSecretPrompt,
    type TuiSecretPromptState,
} from "./secret-prompt.ts";
import {
    createTuiNamePromptView,
    handleTuiNamePromptKey,
    handleTuiNamePromptPaste,
    startTuiNamePrompt,
    type TuiNamePromptState,
    type TuiNamePromptTransition,
} from "./name-prompt.ts";
import {
    activeTuiKeymap,
    installTuiKeymap,
    isTuiComposerClearKey,
    isTuiKeyScope,
    tuiComposerWordDeleteDirection,
    tuiBindingId,
    tuiChord,
    tuiKeyChord,
    tuiKeyHint,
} from "./keymap.ts";
import { resolveTuiKeymap } from "./keybindings.ts";
import type { AgentCatalogUpdate } from "../../src/engine/protocol.ts";

/** The agent list a /agent surface renders, as the host last reported it. */
type TuiAgentCatalog = {
    readonly worn: string;
    readonly agents: AgentCatalogUpdate["agents"];
    readonly notices: readonly string[];
};
type TuiAgentCatalogRow = AgentCatalogUpdate["agents"][number];
import {
    composeDialStrip,
    DIAL_HUD_CAP,
    DIAL_HUD_RECENT_CAP,
    handleDialStripKey,
    openDialStrip,
    renderDialStrip,
    DIAL_EXIT_SEPARATOR,
    type DialPair,
    type DialPoolEntry,
    type DialStripState,
} from "./dials.ts";
import { paintDialHud } from "./dial-paint.ts";
import {
    recordTuiTipShown,
    selectTuiTip,
    TUI_TIPS,
    type TuiTip,
    type TuiTipContext,
} from "./tips.ts";
import {
    beginTuiTipLaunch,
    saveTuiTipState,
    type TuiTipState,
} from "./tips-store.ts";
import { createRenderCoalescer } from "./render-coalescer.ts";
import {
    createAuthStorage,
    unreadableAuthStoragePath,
    type AuthStorage,
} from "../../src/providers/auth-storage.ts";
import {
    configuredProviders,
    findConfiguredProvider,
    findProvider,
    isProviderConnected,
} from "../../src/providers/registry.ts";
import { loginOpenAICodex } from "../../src/providers/openai-codex-oauth.ts";
import { renderPermissionInspection } from "./permission-inspection.ts";
import {
    createTuiPreferencesListView,
    handleTuiPreferencesListKey,
    handleTuiPreferencesListScroll,
    startTuiPreferencesList,
    syncTuiPreferencesList,
    type TuiPreferencesListState,
} from "./preferences-list.ts";
import {
    renderResumeHint,
    resolveResumeTarget,
    resolveContinueTarget,
    type TuiStartTarget,
} from "./session-target.ts";
export type {
    AttachTuiTarget,
    CreateTuiTarget,
    ResumeTuiTarget,
    TuiStartTarget,
} from "./session-target.ts";
import {
    applyTuiTimelineReply,
    createTuiTimelinePickerView,
    handleTuiTimelineKey,
    startTuiTimelinePicker,
} from "./timeline-picker.ts";
import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_ELEMENT,
    TUI_HUD,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_TEXT,
    applyTuiTheme,
    appendTuiExtensionBlock,
    appendTuiError,
    appendTuiNotice,
    appendTuiThought,
    dropTuiThinking,
    toggleTuiThinking,
    toggleTuiToolDetails,
    applyAgentUpdate,
    userEntryShows,
    beginNextQueuedTuiTurn,
    beginTuiAdmission,
    dropTuiAdmission,
    beginTuiTurn,
    createTuiState,
    failTuiConnection,
    queueTuiPrompt,
    renderTuiEntry,
    renderTuiQueuedPrompt,
    tuiPoolListing,
    setTuiWorkspaceRoot,
    tuiDisplayPath,
    tuiEntryMarginTop,
    type TuiState,
    type TuiTranscriptEntry,
} from "./state.ts";
import {
    resolveTuiTheme,
    tuiHandleActiveColor,
    tuiHandleColor,
    VERA_TUI_THEME,
} from "./theme.ts";
import {
    loadTuiActivityAnimationPreference,
    loadTuiActivityAnimationIntervalPreference,
    loadTuiActivityAnimationWidthPreference,
    loadTuiSidebarWidth,
    saveTuiSidebarWidth,
    loadTuiKeybindingOverlay,
    loadTuiPinnedSessionIds,
    loadTuiRecentSessionId,
    loadTuiThemePreference,
    loadTuiWorkspaceSidebarDocked,
    loadTuiWorkspaceSidebarWidth,
    saveTuiPinnedSessionIds,
    saveTuiRecentSessionId,
    saveTuiThemePreference,
    saveTuiWorkspaceSidebarDocked,
    saveTuiWorkspaceSidebarWidth,
} from "./theme-preference.ts";
import { createTuiDiff } from "./diff.ts";
import { materializeDroppedImage } from "./dropped-image.ts";
import { createTuiUserEntry } from "./user-entry.ts";
import {
    createTuiToolHeader,
    createTuiToolRow,
    updateTuiToolHeader,
    updateTuiToolRow,
} from "./tool-row.ts";
import {
    createTuiThinkingWindow,
    updateTuiThinkingWindow,
} from "./thinking-window.ts";
import {
    createTuiMarkdownEntry,
    tuiMarkdownEntryContent,
} from "./markdown-entry.ts";
import {
    createTuiGutterEntry,
    tuiGutterContent,
    tuiGutterWidth,
} from "./gutter.ts";

registerTuiParsers();

// The palette has no other advertisement: it is a chord, not a slash command in
// the composer's list, so the idle status line is where you find out it exists.
const READY_HINT = `ready · ${tuiKeyHint("open_palette")}`;
const MODEL_PICKER_HINT = tuiKeyHint("open_model_picker");
const HUD_HINT = tuiKeyHint("dials.open");
const WORKING_HINT = `esc stop · ${tuiKeyHint("interrupt")}`;
const STOPPING_HINT = "stopping…";
/** How much of a connection failure the status line carries. */
const CONNECTION_FAILURE_HINT_LIMIT = 44;

/**
 * Failure signatures already named on screen. Per run rather than per session:
 * one mention is the point, and switching sessions is not new information.
 */
const raisedModelFailureSignatures = new Set<string>();

const FAILURE_REPORT_SUMMARY_TOKENS = 600;

const FAILURE_REPORT_PROMPT =
    "You are reading a list of model failures recorded by a coding tool."
    + " Write a short plain summary for someone filing a bug report: what is"
    + " failing, how often, and what it looks like. State only what the list"
    + " shows.";

function shortConnectionFailure(message: string): string {
    const line = message.split("\n")[0]?.trim() ?? "";
    return line.length > CONNECTION_FAILURE_HINT_LIMIT
        ? `${line.slice(0, CONNECTION_FAILURE_HINT_LIMIT - 1)}…`
        : line;
}
// The question overlay owns the choose/cancel hint now, so the status line only
// carries the waiting phase and the global interrupt.
const QUESTION_HINT = `question waiting · ${tuiKeyHint("interrupt")}`;
const COPY_NOTICE_DURATION_MS = 1_500;
const MODE_TOAST_DURATION_MS = 2_500;
const STATUS_REFRESH_INTERVAL_MS = 100;
const DIRECT_EXTENSION_COMMAND_TIMEOUT_MS = 2_000;
const SYMMETRIC_WAVE_FRAME_INTERVAL_MS = 360;
const SHIMMER_FRAME_INTERVAL_MS = 40;
const DEFAULT_ACTIVITY_FRAME_INTERVAL_MS = 160;
const ACTIVE_GRID_TRAIL = "#B8B6D9";
const SESSION_SWITCH_TIMEOUT_MS = 15_000;
const POINTER_HOVER_DELAY_MS = 25;
/**
 * Two plain escapes in this window open the timeline picker, the same gesture
 * /rewind is. One press arms the window; any other key disarms it, so typing
 * between presses never counts as a double press.
 */
const DOUBLE_ESCAPE_REWIND_WINDOW_MS = 500;
/** Rows the composer, the status band and a little transcript need. */
const SUGGESTIONS_RESERVED_ROWS = 12;

/**
 * Whether an answer closes a stretch of tool work. Thoughts and notices do not
 * count: a rule that fires on every turn stops marking anything.
 */
function assistantFollowsTools(
    entries: readonly TuiTranscriptEntry[],
    index: number,
): boolean {
    if (entries[index]?.kind !== "assistant") return false;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const kind = entries[cursor]?.kind;
        if (kind === "user" || kind === "assistant") return false;
        if (kind === "tool" || kind === "tool_header" || kind === "diff") {
            return true;
        }
    }
    return false;
}

function truncateFooterLine(text: string, width: number): string {
    const characters = Array.from(text);
    const limit = Math.max(1, width);
    return characters.length <= limit
        ? text
        : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

function displayModeLabel(label: string): string {
    return `${label.slice(0, 1).toUpperCase()}${label.slice(1)}`;
}

function tuiContextSnapshot(
    measurement: TuiState["context"],
    settings: TuiState["modelSettings"],
): VeraClientContextSnapshot {
    if (measurement === undefined) {
        return { availability: "unavailable" };
    }
    const model = settings?.model === undefined
        ? undefined
        : {
            model: settings.model,
            ...(settings.provider === undefined
                ? {}
                : { provider: settings.provider }),
            ...(measurement.capacity === undefined
                ? {}
                : { capacity: measurement.capacity }),
        };
    const projection = measurement.projection === undefined
        ? undefined
        : {
            estimatedTokens: measurement.projection.estimatedTokens,
            components: measurement.projection.components.map((component) => ({
                kind: component.kind,
                id: component.id,
                owner: component.owner,
                source: component.source,
                displayName: component.displayName,
                count: component.count,
                estimatedTokens: component.estimatedTokens,
            })),
        };
    return {
        availability: model !== undefined
                && measurement.capacity !== undefined
                && projection !== undefined
            ? "available"
            : "partial",
        ...(model === undefined ? {} : { model }),
        headline: {
            tokens: measurement.tokens,
            estimated: measurement.estimated,
        },
        ...(projection === undefined ? {} : { projection }),
        ...(measurement.compaction === undefined
            ? {}
            : { compaction: measurement.compaction }),
    };
}

export interface TuiDependencies {
    readonly client: TuiAgentClient;
    readonly appearance?: TuiAppearance;
    readonly copyText?: (text: string) => Promise<void>;
    readonly openConfigure?: () => Promise<void>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    /** One page of the session listing, with the facts the caller named. */
    readonly listSessionPage?: (
        options: ListAgentsOptions,
    ) => Promise<ListedAgentsPage>;
    /**
     * The four ways to reach another session, each handed the identity of the
     * one being left rather than closing over it.
     *
     * They used to read the current client from the scope that started the TUI,
     * which was true exactly once: after the first switch that binding pointed
     * at a session the user had already left, and cloning would have cloned it.
     */
    readonly createSession?: (workspace: string) => Promise<TuiAgentClient>;
    readonly createAgent?: (
        workspace: string,
        approvalMode?: string,
        lifetime?: "ephemeral" | "durable",
    ) => Promise<TuiAgentClient>;
    readonly branchAgent?: (
        agentId: string,
        approvalMode?: string,
        lifetime?: "ephemeral" | "durable",
        initialMessages?: readonly UserMessage[],
        hideInheritedMessages?: boolean,
        signal?: AbortSignal,
    ) => Promise<TuiAgentClient>;
    readonly syncAgentContext?: (
        agentId: string,
        signal?: AbortSignal,
    ) => Promise<{
        readonly outcome:
            | "synced"
            | "unchanged"
            | "busy"
            | "stale_cursor"
            | "not_found"
            | "failed";
        readonly turns: number;
    }>;
    readonly attachAgent?: (agentId: string) => Promise<TuiAgentClient>;
    readonly cloneSession?: (agentId: string) => Promise<TuiAgentClient>;
    readonly forkSession?: (
        agentId: string,
        boundaryId: string,
    ) => Promise<{ readonly client: TuiAgentClient; readonly prompt: UserMessage }>;
    readonly resumeSession?: (sessionPath: string) => Promise<TuiAgentClient>;
    /**
     * Scan the host's transcripts. Absent when this client reaches no host
     * that can search, which the overlay states rather than showing as an
     * empty past.
     */
    readonly searchSessions?: (
        query: SessionSearchQuery,
    ) => Promise<SessionSearchResults>;
    readonly reconnectSession?: (agentId: string) => Promise<TuiAgentClient>;
    readonly onSessionEntered?: (agentId: string) => void;
    readonly initialDraft?: TuiDraft;
    /** Notice lines shown in the transcript before anything else happens. */
    readonly startupNotices?: readonly string[];
    readonly sessionSwitchTimeoutMs?: number;
    readonly trashSession?: (sessionId: string) => Promise<TrashSessionResult>;
    readonly renameSession?: (
        sessionId: string,
        name: string | null,
    ) => Promise<RenameSessionResult>;
    readonly disabledBuiltinExtensions?: readonly string[];
    readonly clientExtensions?: readonly VeraExtensionConfig[];
    readonly loadClientExtensionConfiguration?: () => {
        readonly disabledBuiltinExtensions: readonly string[];
        readonly clientExtensions: readonly VeraExtensionConfig[];
    };
    readonly build?: {
        readonly clientVersion: string;
        readonly clientEntrypoint: string;
        readonly hostEntrypoint?: string;
        readonly hostPid?: number;
        readonly hostStartedAt?: string;
    };
    /** Overrides the read-only process sampler for deterministic TUI tests. */
    readonly doctor?: () => Promise<VeraDoctorReport>;
    /** Overrides `~/.vera/auth.json`, so a test never reads real credentials. */
    readonly authStorage?: AuthStorage;
    /** Overrides the browser hand-off a provider's OAuth row would run. */
    readonly loginProvider?: (
        providerId: string,
        onAuthorizationUrl: (url: string) => void,
    ) => Promise<void>;
    readonly flightRecorder?: TuiFlightRecorder;
    /** Overrides the terminal renderer, so a test can boot in-process. */
    readonly createRenderer?: () => Promise<CliRenderer>;
}

export interface TuiDraft {
    readonly text: string;
    readonly attachmentIds: readonly string[];
}

/**
 * What the TUI reports when it closes.
 *
 * Empty, and deliberately still a type: switching sessions used to end the TUI
 * and ask the caller to start another one against the session that was picked,
 * so this carried the handover. The host is resident and already holds every
 * session, so a switch is a detach and an attach with the renderer left alone,
 * and there is nothing left to hand over.
 */
export interface TuiExit {
    /** The session attached when the TUI closed, for a caller that logs it. */
    readonly agentId?: string;
}

function requireIdentifiedClient(
    client: TuiAgentClient,
): IdentifiedTuiAgentClient {
    return requireIdentifiedTuiAgentClient(client);
}

export interface TuiStartOptions {
    readonly confirmBusyUpgrade?: (error: Error) => boolean | Promise<boolean>;
}

function removeSessionPickerOption(
    picker: TuiSettingsPickerState | undefined,
    sessionId: string,
): TuiSettingsPickerState | undefined {
    if (picker?.kind !== "session") return picker;
    const allOptions = picker.allOptions.filter(
        (option) => option.sessionId !== sessionId,
    );
    const options = picker.options.filter(
        (option) => option.sessionId !== sessionId,
    );
    return {
        ...picker,
        allOptions,
        options,
        selectedIndex: Math.min(
            picker.selectedIndex,
            Math.max(0, options.length - 1),
        ),
    };
}

if (import.meta.main) {
    await startConfiguredTui({
        type: "create",
        workspace: process.cwd(),
    });
}

export async function startConfiguredTui(
    target: TuiStartTarget,
    options: TuiStartOptions = {},
): Promise<void> {
    installTerminalRestoreOnExit();
    // Optional on purpose: the host owns the config, and the only fields read
    // here are the client's own extension lists. Requiring the file made
    // `vera attach` against an already-running host fail on a fresh machine.
    const config = loadOptionalVeraConfig({ projectRoot: process.cwd() });
    let host = await findOrStartResidentHost({
        projectRoot: process.cwd(),
        ...(options.confirmBusyUpgrade === undefined
            ? {}
            : { confirmBusyUpgrade: options.confirmBusyUpgrade }),
    });
    const resolvedTarget = target.type === "continue"
        ? resolveContinueTarget(
            await listAgentsThroughHost(host.socket_path),
            loadTuiRecentSessionId(),
        )
        : target.type === "resume"
        ? resolveResumeTarget(
            await listAgentsThroughHost(host.socket_path),
            target.sessionPath,
        )
        : target;
    let agentId = resolvedTarget.type === "create"
        ? (await createAgentThroughHost(
            host.socket_path,
            resolvedTarget.workspace,
            undefined,
            undefined,
            resolvedTarget.startupProfile,
        )).id
        : resolvedTarget.type === "resume"
            ? (await resumeAgentThroughHost(
                host.socket_path,
                resolvedTarget.sessionPath,
            )).id
            : resolvedTarget.agentId;
    const agentClients = createConfiguredTuiAgentClients(() => host.socket_path);
    const client = await agentClients.attach(agentId);
    const flightRecorder = createTuiFlightRecorder();
    flightRecorder.sessionEntered(agentId);
    const rememberSession = (enteredAgentId: string): void => {
        saveTuiRecentSessionId(enteredAgentId);
    };
    try {
        rememberSession(agentId);
    } catch (error) {
        process.stderr.write(`${recentSessionSaveFailure(error)}\n`);
    }
    // One call, not a loop: the TUI attaches to whatever session the user moves
    // to without closing, so there is no longer a "start me again against this
    // other session" answer for a caller to act on.
    const attach = (id: string) => agentClients.attach(id);
    try {
        const listAgents = () => listAgentsThroughHost(host.socket_path);
        const listSessionPage = (options: ListAgentsOptions) =>
            listAgentPageThroughHost(host.socket_path, options);
        const mismatchNotice = hostEntrypointMismatchNotice(host);
        // A pool file the parser had to reduce still produced a pool, so this
        // says so instead of failing: the entries that were dropped are the
        // ones the user thinks are in force.
        const startupNotices = [
            ...(mismatchNotice === undefined ? [] : [mismatchNotice]),
            ...poolFileIssueNotices(
                loadPoolFile({ projectRoot: process.cwd() }).issues,
            ),
        ];
        const exit = await startTui({
            client,
            appearance: resolveTuiAppearance(config?.tui),
            ...(startupNotices.length === 0 ? {} : { startupNotices }),
            listAgents,
            listSessionPage,
            createSession: async (workspace) => {
                const createStartedAt = performance.now();
                const created = await createAgentThroughHost(
                    host.socket_path,
                    workspace,
                );
                flightRecorder.record({
                    type: "session_switch_phase_completed",
                    operation: "clear",
                    phase: "create",
                    durationMs: Math.round(performance.now() - createStartedAt),
                });
                const attachStartedAt = performance.now();
                const attached = await attach(created.id);
                flightRecorder.record({
                    type: "session_switch_phase_completed",
                    operation: "clear",
                    phase: "attach",
                    durationMs: Math.round(performance.now() - attachStartedAt),
                });
                return attached;
            },
            createAgent: agentClients.create,
            branchAgent: agentClients.branch,
            syncAgentContext: agentClients.sync,
            attachAgent: agentClients.attach,
            cloneSession: agentClients.clone,
            forkSession: agentClients.fork,
            resumeSession: agentClients.resume,
            // Read through the host rather than the session directory: the
            // host owns which profile's transcripts are the live ones, and a
            // client that resolved the path itself could search a different
            // profile from the one it is attached to.
            searchSessions: (query) =>
                searchSessionsThroughHost(host.socket_path, query),
            reconnectSession: async (currentAgentId) => {
                // No confirmation here, unlike at startup: the renderer owns
                // the screen and stdin by now, and a readline prompt would
                // draw into the alternate screen and hand back a terminal
                // without raw mode. Declining surfaces the error with its
                // recovery commands instead, which the user runs elsewhere.
                host = await findOrStartResidentHost({
                    projectRoot: process.cwd(),
                    confirmBusyUpgrade: () => false,
                });
                return attach(currentAgentId);
            },
            onSessionEntered: rememberSession,
            trashSession: (sessionId) =>
                trashSessionThroughHost(host.socket_path, sessionId),
            renameSession: (sessionId, name) =>
                renameSessionThroughHost(host.socket_path, sessionId, name),
            ...(config?.disabled_builtin_extensions === undefined
                ? {}
                : {
                    disabledBuiltinExtensions:
                        config.disabled_builtin_extensions,
                }),
            ...(config?.extensions === undefined
                ? {}
                : { clientExtensions: config.extensions }),
            loadClientExtensionConfiguration() {
                const latest = loadOptionalVeraConfig({ projectRoot: process.cwd() });
                return {
                    disabledBuiltinExtensions:
                        latest?.disabled_builtin_extensions ?? [],
                    clientExtensions: latest?.extensions ?? [],
                };
            },
            build: {
                clientVersion: sourceVersion(import.meta.dir),
                clientEntrypoint: import.meta.path,
                ...(host.entrypoint === undefined
                    ? {}
                    : { hostEntrypoint: host.entrypoint }),
                hostPid: host.pid,
                hostStartedAt: host.started_at,
            },
            flightRecorder,
        });
        process.stdout.write(renderResumeHint(exit.agentId));
    } catch (error) {
        flightRecorder.record({
            type: "client_failed",
            error: error instanceof Error ? error.message : String(error),
        });
        client.close();
        throw error;
    } finally {
        flightRecorder.close("tui_returned");
    }
}

export async function startTui(
    dependencies: TuiDependencies,
): Promise<TuiExit> {
    /**
     * The session currently on screen.
     *
     * Reassigned by switchToClient rather than fixed for the life of the TUI:
     * moving to another session is a detach and an attach, and everything that
     * talks to the host reads this binding at the moment it sends.
     */
    let client = dependencies.client;
    const flightRecorder = dependencies.flightRecorder;
    flightRecorder?.sessionEntered(client.agentId ?? "unknown");
    const configuredAppearance = dependencies.appearance
        ?? resolveTuiAppearance();
    setTuiWorkspaceRoot(client.workspace ?? process.cwd());
    const renderer = await (dependencies.createRenderer?.()
        ?? createCliRenderer({
            exitOnCtrlC: false,
            targetFps: 30,
        }));
    let appearance = fitTuiAppearance(configuredAppearance, renderer.width);
    let composerContentIndent = tuiComposerContentIndent(appearance);
    let composerHorizontalInset = composerContentIndent * 2;
    const entrySpacing = {
        message: appearance.messageSpacing,
        toolGroup: appearance.toolGroupSpacing,
    };
    const copyText = dependencies.copyText
        ?? ((text: string) => copyTuiText(text, renderer));
    let sessionTitle: string | undefined;
    let mainHeaderVisible = true;
    let sidebarSessionTitle: string | undefined;
    let sidebarHeaderVisible = true;
    applyTerminalTitle();
    refreshTerminalTitle();
    let themeName = loadTuiThemePreference();
    let activityAnimation = loadTuiActivityAnimationPreference();
    const activityAnimationInterval =
        loadTuiActivityAnimationIntervalPreference();
    const activityAnimationWidth = loadTuiActivityAnimationWidthPreference();
    const sidebarWidth = loadTuiSidebarWidth();
    const hostedPanePersistence = new TuiHostedPanePersistence();
    let theme = await resolveTuiTheme(renderer, themeName);
    applyTuiTheme(theme);

    let state = createTuiState();
    let appendTranscriptRenderable: (
        node: Renderable,
    ) => VeraExtensionDisposer = () => {
        throw new Error("Native transcript is not ready");
    };
    for (const notice of dependencies.startupNotices ?? []) {
        state = appendTuiNotice(state, notice);
    }
    let shuttingDown = false;
    let clientSurfaceReady = false;
    let transcriptSeeded = false;
    const deferredKeymapNotices: string[] = [];
    // The arrival notice lands twice on purpose: once before the history
    // rebuild, which floats it above the transcript, and once after, so it is
    // also the last line the reader reaches.
    let pendingBackNotice: string | undefined;
    const experimentalTuiHost = createTuiExperimentalHost({
        renderer,
        theme,
        workspace: () => client.workspace ?? process.cwd(),
        transcript: () => state.entries.flatMap((entry) =>
            (entry.kind === "user" || entry.kind === "assistant")
                && entry.text.length > 0
                ? [{ role: entry.kind, text: entry.text }]
                : []
        ),
        onFailure: (extensionId, message) => {
            if (shuttingDown) return;
            state = appendTuiNotice(
                state,
                `${extensionId}: experimental TUI view failed: ${message}`,
            );
        },
        onRenderRequested: () => {
            if (clientSurfaceReady) renderState();
        },
        appendTranscriptRenderable: (node) => appendTranscriptRenderable(node),
    });
    let connectionFailed = false;
    let connectionFailure: string | undefined;
    let statusNotice: string | undefined;
    let statusNoticeVersion = 0;
    // What each in-flight change asked for, so a rejection can name it. The
    // status line reports the effective values once a change lands.
    const requestedModelChanges = new Map<string, {
        readonly subject: string;
        readonly patch: ModelSettingsPatch;
        readonly target: TuiAgentClient;
    }>();
    const requestedPermissionChanges = new Map<string, string>();
    let abortRequested = false;

    function applyTerminalTitle(): void {
        renderer.setTerminalTitle(
            sessionTitle === undefined || sessionTitle.length === 0
                ? "Vera"
                : `${sessionTitle} · Vera`,
        );
    }

    function fallbackSessionTitle(text: string): string | undefined {
        const title = text.replaceAll(/\s+/g, " ").trim().slice(0, 80);
        return title.length === 0 ? undefined : title;
    }

    function adoptFallbackSessionTitle(
        text: string,
        injectedPrefix?: number,
    ): void {
        if (sessionTitle !== undefined) {
            return;
        }
        // What an extension prepended was sent but never shown, so it does not
        // name the session either.
        const visible = injectedPrefix !== undefined
                && injectedPrefix > 0
                && injectedPrefix < text.length
            ? text.slice(injectedPrefix)
            : text;
        const title = fallbackSessionTitle(visible);
        if (title === undefined) {
            return;
        }
        sessionTitle = title;
        applyTerminalTitle();
    }

    function refreshTerminalTitle(): void {
        const agentId = client.agentId;
        if (agentId === undefined || dependencies.listAgents === undefined) {
            return;
        }
        void dependencies.listAgents().then((agents) => {
            if (shuttingDown || agentId !== client.agentId) {
                return;
            }
            sessionTitle = agents.find((agent) => agent.id === agentId)?.title;
            applyTerminalTitle();
            if (clientSurfaceReady) renderState();
        }).catch(() => {
            // The title keeps its last value when the host cannot be reached.
        });
    }

    function toggleMainHeader(): void {
        mainHeaderVisible = !mainHeaderVisible;
        renderState();
    }

    function toggleSidebarHeader(): void {
        if (hostedSidebar.pane === undefined) return;
        sidebarHeaderVisible = !sidebarHeaderVisible;
        renderState();
    }

    let pendingUiRequest: UiRequestUpdate | undefined;
    const queuedUiRequests: UiRequestUpdate[] = [];
    let followTranscriptAfterUiRequest = false;
    let timelinePicker: TuiTimelinePickerState | undefined;
    let settingsPicker: TuiAnySettingsPickerState | undefined;
    let settingsPickerAgent: TuiAgentClient | undefined;
    let pendingExtensionPicker: {
        readonly resolve: (result: VeraClientPickerResult) => void;
        readonly reject: (error: unknown) => void;
        readonly removeAbortListener: () => void;
    } | undefined;
    const pendingExtensionSettings = new Map<
        string,
        {
            readonly target: TuiAgentClient;
            readonly resolve: (
                result: VeraClientModelSettingsUpdateResult,
            ) => void;
            readonly reject: (error: unknown) => void;
            readonly removeAbortListener: () => void;
        }
    >();
    const extensionSettingsListeners = new Set<
        (settings: NonNullable<typeof state.modelSettings>) => void
    >();
    const extensionAgentTarget = new AsyncLocalStorage<TuiAgentClient>();
    let clientExtensionRegistry: ClientExtensionRegistry | undefined;
    const keybindingOverlay = loadTuiKeybindingOverlay();
    const announcedKeymapNotices = new Set<string>();
    /** The dial strip, open only while it is on screen. */
    let dialStrip: DialStripState | undefined;
    /** The last catalog the host sent, which /agent opens against. */
    let agentCatalog: TuiAgentCatalog | undefined;
    /** Suggesters escape put away, for the rest of this session. */
    const dismissedComposeSuggesters = new Set<string>();

    const pendingAgentCatalogs = new Map<
        string,
        (catalog: TuiAgentCatalog | undefined) => void
    >();
    let messageInterceptPending = false;
    let secretPrompt: TuiSecretPromptState | undefined;
    let namePrompt: TuiNamePromptState | undefined;
    let providerForm: TuiProviderFormState | undefined;
    let preferencesList: TuiPreferencesListState | undefined;
    /** The picker pane the preferences list was opened over, restored on close. */
    let preferencesListParent: TuiSettingsPickerState | undefined;
    let commandPalette: TuiCommandPaletteState | undefined;
    let workTab: WorkTabState | undefined;
    /**
     * The workspace side bar, mounted or not.
     *
     * A dock rather than an overlay: it remains beside the conversation while
     * the composer is active. Only its focused state claims bare keys; chords
     * pass through so ctrl+e can focus or remove the dock.
     */
    let workspaceSidebar: WorkspaceSidebarState | undefined;
    /** A dock can remain visible while typing; only focused docks claim keys. */
    let workspaceSidebarFocused = false;
    let workspaceSidebarDocked = loadTuiWorkspaceSidebarDocked();
    let workspaceRailPreferred = loadTuiWorkspaceSidebarWidth();
    /**
     * The row columns the side bar is currently drawn as a rail in, or nothing
     * while it is closed or drawn as a card. Held so the transcript beside it
     * is only reflowed when the layout actually changes.
     */
    let workspaceRail: number | undefined;
    let workspaceRailDragging = false;
    /** Client state. A pin orders one person's list and never reaches a host. */
    let workspacePinnedIds: readonly string[] = loadTuiPinnedSessionIds();
    let searchOverlay: SearchOverlayState | undefined;
    /**
     * The last index the host sent, held whether or not the tab is open: the
     * counts and the notifications are facts about the machine, and they do
     * not start existing when someone happens to look.
     */
    let workIndex: WorkIndexSnapshot | undefined;
    let jumpMenu: JumpMenuState | undefined;
    // Where the user was before switching anywhere: the single back target,
    // deliberately not a stack, so /back always means "where I started".
    // Only the id is held; the path and title are resolved when used, from
    // the same listing every other session surface reads.
    let backOriginId: string | undefined;
    // The origin's name at hop time, for the arrival notice. The notice
    // fires once right after the switch, so a later rename is fine to miss.
    let backOriginTitle: string | undefined;
    /**
     * Assumed focused until the terminal says otherwise. A terminal that does
     * not answer focus reporting would otherwise be treated as never watched,
     * and every approval would ring the bell under the person's nose.
     */
    let terminalFocused = true;
    let stopWatchingWorkIndex: (() => void) | undefined;
    let searchInFlight = false;
    /**
     * The transcript row a search asked to land on, and the session it lives
     * in, until it is on screen.
     *
     * The session is half the target, not decoration: closing the overlay
     * paints the conversation that was already open, and a target that only
     * named a row would be spent on that paint before the session it belongs
     * to had loaded.
     */
    let pendingSearchTarget: {
        readonly sessionId: string;
        readonly entryId: string;
    } | undefined;
    let queuedSearch: SessionSearchQuery | undefined;
    let help: TuiHelpState | undefined;
    let diagnosticsDialog: TuiDiagnosticsDialogState | undefined;
    let diagnosticsScope: TuiDiagnosticsScope = "session";
    let diagnosticsSessionPath: string | undefined;
    let diagnosticsWorkerPid: number | undefined;
    let diagnosticsSupervisorPid: number | undefined;
    let diagnosticsProcessMemory: ReadonlyMap<number, number> = new Map();
    let diagnosticsSessionPathResolved = false;
    let diagnosticsGeneration = 0;
    let doctorDialog: TuiDiagnosticsDialogState | undefined;
    let doctorInspectionGeneration = 0;
    let extensionsDialog: TuiDiagnosticsDialogState | undefined;
    let hostExtensionCommands: readonly ExtensionCommandDescriptor[] = [];
    let disposeHostExtensionCommands = (): void => {};
    let extensionCommandsGeneration = 0;
    let confirmingFullAccess = false;
    let confirmingFullAccessAgent: TuiAgentClient | undefined;
    /**
     * The pool add whose name prompt is still owed, if any. Naming is offered
     * once, at the moment the entry appears, and skipping it is a plain escape.
     */
    let pendingPoolName: {
        readonly requestId: string;
        readonly provider: string;
        readonly model: string;
        readonly label: string;
    } | undefined;
    interface PoolChangeUndo {
        readonly action: "add" | "remove";
        readonly provider: string;
        readonly model: string;
        readonly poolName?: string;
    }
    const pendingPoolChanges = new Map<string, PoolChangeUndo>();
    const pendingPoolUndos = new Map<string, {
        readonly undo: PoolChangeUndo;
        readonly completesOnSettings: boolean;
    }>();
    let poolChangeUndo: PoolChangeUndo | undefined;
    let admissionDialog: TuiAdmissionDialogState | undefined;
    /**
     * A probe of every model the user keeps, one at a time. Sequential because
     * each entry is a live call to a provider, and a burst of them is the
     * shape rate limits are written against.
     */
    /** In-flight catalog refreshes, by request, so the reply can name one. */
    const catalogRefreshes = new Map<string, string>();
    /**
     * A refresh of several providers, one at a time. Sequential for the same
     * reason the probe sweep is: each entry is a live call, and what comes
     * back is counted against what was there before so the sweep can say what
     * actually changed.
     */
    let catalogRefreshSweep: {
        readonly queue: readonly string[];
        index: number;
        readonly results: {
            provider: string;
            before: number;
            after?: number;
        }[];
        requestId?: string;
    } | undefined;
    let poolVerifySweep: {
        readonly queue: readonly { readonly provider: string; readonly model: string }[];
        readonly total: number;
        index: number;
        answered: number;
        requestId?: string;
    } | undefined;
    /** The model pane the dialog covered, put back when the dialog leaves. */
    let admissionReturnPicker: TuiSettingsPickerState | undefined;
    /**
     * The settings change each in-flight admission was meant to end in,
     * applied when its "added" verdict lands. Keyed by requestId rather than
     * held on the dialog: hiding the dialog must not lose the switch.
     */
    let sessionTrashCandidate: {
        readonly sessionId: string;
        readonly label: string;
    } | undefined;
    let sessionTrashPending = false;
    /**
     * The credential `delete` asked to forget, waiting on the confirmation.
     *
     * It carries the pane to reopen because the connect list is read off disk:
     * forgetting changes the disk, so the pane is rebuilt rather than patched.
     */
    let providerForgetCandidate: {
        readonly providerId: string;
        readonly label: string;
        readonly pane: TuiSettingsPickerState | undefined;
    } | undefined;
    let commandSuggestionIndex = 0;
    /** Whether the highlighted row was chosen rather than merely first. */
    let commandSuggestionMoved = false;
    /** The argument values on offer, empty whenever the list is commands. */
    let argumentSuggestions: readonly string[] = [];
    /** Names an extension offers after an `@`, replaced wholesale. */
    let extensionMentions: readonly string[] = [];
    // Who an extension says the next message is going to. The client only
    // shows the name; it does not know what makes a message go there.
    let extensionAddressee: string | undefined;
    let workingSince: number | undefined;
    let phaseSince: number | undefined;
    let activity = "thinking";
    let themeApplicationVersion = 0;
    let pendingThemePreview: ReturnType<typeof setTimeout> | undefined;
    /**
     * Bumped by every switch, so the update pump reading the session being left
     * can tell that it is stale and stop instead of writing that session's
     * updates into the transcript of the one now on screen.
     */
    let clientGeneration = 0;
    /** Bumped whenever keyboard ownership moves between agent composers. */
    let composeSurfaceGeneration = 0;
    let resumeListVersion = 0;
    let promptSubmitting = false;
    let sessionSwitchPending = false;
    let sessionSwitchActivity = "starting new session…";
    let sessionSwitchStartedAt: number | undefined;
    let sessionSwitchOperation: string | undefined;
    let sessionSwitchBufferedUpdates: AgentUpdate[] = [];
    let sessionSwitchClearingMain = false;
    let extensionCommandPending = false;
    let clientExtensionReloadPending = false;
    let clientExtensionReload: TuiClientExtensionReloadSnapshot = {
        status: "never",
        loadedExtensionIds: [],
        failures: [],
    };
    let extensionCommandActivity: string | undefined;
    let sidebarPromptSubmitting = false;
    let extensionCommandsLoading =
        dependencies.client.listExtensionCommands !== undefined
        && dependencies.client.failed !== true;
    let runningBackgroundAgents = 0;
    let runningBackgroundAgentNames: readonly string[] = [];
    let currentAgentHasParent = false;
    let stopWatchingBackgroundAgents: (() => void) | undefined;
    let pendingSessionRename: {
        readonly requestId: string;
        /** Restored to the composer if the rename never lands, when it came from one. */
        readonly commandText?: string;
    } | undefined;
    let pendingSidebarSessionRename: {
        readonly requestId: string;
        readonly commandText?: string;
    } | undefined;
    /**
     * Consults in flight, keyed by request. Several may run at once: an
     * extension with more than one seat asks them all in parallel.
     */
    const pendingConsults = new Map<string, {
        readonly resolve: (result: VeraClientConsultResult) => void;
        readonly reject: (reason: Error) => void;
    }>();
    const hostedSidebar = new TuiHostedSidebarAgent({
        onUpdate(update, current) {
            handleSidebarAgentUpdate(update, current);
            if (update.type === "user_prompt") {
                appendPendingSidebarContextNotice(current);
            }
            renderSidebarAgent(current);
            if (
                update.type === "ui_request"
                || update.type === "ui_request_closed"
            ) {
                focusActiveSurface();
            }
        },
        onFailure(error, current) {
            if (current !== hostedSidebar.pane) return;
            rejectPendingExtensionSettingsFor(current.client, error);
            sidebar.append("agent", `Connection failed: ${error.message}`);
            renderState();
        },
    });
    let pendingSidebarContextNotice: {
        readonly agentId: string;
        readonly text: string;
    } | undefined;
    function appendPendingSidebarContextNotice(
        side: TuiAgentPane<IdentifiedTuiAgentClient>,
    ): void {
        const notice = pendingSidebarContextNotice;
        if (notice?.agentId !== side.agentId) return;
        side.state.state = appendTuiNotice(
            side.state.state,
            notice.text,
            "soft",
        );
        pendingSidebarContextNotice = undefined;
    }
    let submitAfterImageAttachment = false;
    let pendingImages: Array<{
        requestId: string;
        path?: string;
        id?: string;
        name?: string;
    }> = [];
    /** Scratch copies of dropped images, held until the host has the bytes. */
    const droppedImageReleases = new Map<string, () => Promise<void>>();
    if (dependencies.initialDraft !== undefined) {
        pendingImages = dependencies.initialDraft.attachmentIds.map((id) => ({
            requestId: randomUUID(),
            id,
        }));
    }
    const finished = Promise.withResolvers<TuiExit>();
    let disabledBuiltinExtensions =
        dependencies.disabledBuiltinExtensions ?? [];
    const commandRegistry = createConfiguredBuiltinTuiCommandRegistry(
        disabledBuiltinExtensions,
    );
    let configuredClientExtensions = configuredTuiClientExtensions(
        disabledBuiltinExtensions,
        dependencies.clientExtensions,
    );
    const hostedAgentSurface = createTuiHostedAgentSurface({
        owner: () => hostedSidebar.owner,
        hasAgent: () => hostedSidebar.pane !== undefined,
        layout: () => sidebar.layout(),
        isFocused: () => sidebar.isFocused(),
        cycleSidebarLayout: () => sidebar.cycleLayout(),
        setSidebarFocused,
        focusComposer: () => composer.focus(),
        renderState,
        renderStatus,
        requestRender: () => renderer.requestRender(),
    });
    const startConfiguredClientExtensionHost =
        createTuiClientExtensionHostStarter({
            extensions: () => configuredClientExtensions,
            currentModelSettings: () => focusedAgentState().modelSettings,
            currentContext: () => tuiContextSnapshot(
                focusedAgentState().context,
                focusedAgentState().modelSettings,
            ),
            compose: {
                capture(): TuiExtensionComposeTarget | undefined {
                    const target = extensionAgentTarget.getStore();
                    return target === undefined ? undefined
                        : captureTuiExtensionComposeTarget({
                            client: target,
                            clientGeneration,
                            surfaceGeneration: composeSurfaceGeneration,
                        });
                },
                insert(_extensionId, opaqueTarget, text) {
                    const target = opaqueTarget as TuiExtensionComposeTarget;
                    if (!isCurrentExtensionComposeTarget(target)) {
                        return { status: "stale" };
                    }
                    composer.insertComposerText(text);
                    renderCommandSuggestions();
                    renderState();
                    return { status: "accepted" };
                },
                focus(_extensionId, opaqueTarget) {
                    const target = opaqueTarget as TuiExtensionComposeTarget;
                    if (!isCurrentExtensionComposeTarget(target)) {
                        return { status: "stale" };
                    }
                    if (
                        !clientSurfaceReady
                        || !composerBox.visible
                        || activeOverlayFocus() !== undefined
                    ) {
                        return { status: "ineligible" };
                    }
                    composer.focus();
                    flightRecorder?.record({
                        type: "focus_changed",
                        surface: sidebar.isFocused()
                            ? "sidebar_composer"
                            : "main_composer",
                    });
                    return { status: "accepted" };
                },
            },
            updateModelSettings: requestExtensionModelSettingsUpdate,
            subscribeModelSettings(listener) {
                extensionSettingsListeners.add(listener);
                return () => {
                    extensionSettingsListeners.delete(listener);
                };
            },
            requestPicker: (request, signal) =>
                requestExtensionPicker(request, signal),
            requestConsult: (request, signal) =>
                requestExtensionConsult(request, signal),
            openSidebar(extensionId) {
                hostedSidebar.claim(extensionId);
                sidebar.setHeader(undefined);
                sidebarHeaderVisible = true;
                sidebar.open();
                renderState();
            },
            appendSidebar(extensionId, block) {
                requireSidebarOwner(extensionId);
                sidebar.append(block.label, block.text, block.speaker);
                renderSidebarJump();
            },
            clearSidebar(extensionId) {
                requireSidebarOwner(extensionId);
                sidebar.clear();
            },
            closeSidebar(extensionId) {
                requireSidebarOwner(extensionId);
                closeSidebarPane(extensionId);
            },
            setMentions(names) {
                extensionMentions = names;
                if (clientSurfaceReady) {
                    renderCommandSuggestions();
                }
            },
            setAddressing(name) {
                extensionAddressee = name;
                renderState();
            },
            agents: createTuiClientExtensionAgentsAdapter({
                primary: () => client,
                sidebar: () => hostedSidebar.pane,
                sidebarMention: () => hostedSidebar.mention,
                createAgent: dependencies.createAgent,
                branchAgent: dependencies.branchAgent,
            syncAgentContext: dependencies.syncAgentContext,
            contextSynchronized(agentId, turns) {
                const side = hostedSidebar.pane;
                if (side === undefined || side.agentId !== agentId) return;
                const text = `Caught up with ${turns} new ${
                    turns === 1 ? "turn" : "turns"
                } from the primary conversation.`;
                pendingSidebarContextNotice = { agentId, text };
            },
                attachAgent: dependencies.attachAgent,
                adoptAgent: (
                    extensionId,
                    next,
                    pane,
                    mention,
                    attachmentLifetime,
                    initialApprovalMode,
                    statusLabel,
                    signal,
                ) => openExtensionAgent(
                    extensionId,
                    next,
                    pane,
                    false,
                    mention,
                    attachmentLifetime,
                    initialApprovalMode,
                    statusLabel,
                    signal,
                ),
            }),
            experimentalTui: {
                ...experimentalTuiHost.adapter,
                agentSurface: hostedAgentSurface,
            },
            ...(dependencies.listSessionPage === undefined ? {} : {
                listSessions: (request: VeraClientSessionListRequest) =>
                    listSessionsForExtension(
                        dependencies.listSessionPage!,
                        request,
                    ),
            }),
            readThread() {
                return state.entries
                    .filter((entry) =>
                        (entry.kind === "user" || entry.kind === "assistant")
                        && entry.text.length > 0)
                    .map((entry) => ({
                        role: entry.kind as "user" | "assistant",
                        text: entry.text,
                    }));
            },
            appendTranscript(block) {
                state = appendTuiExtensionBlock(state, block.label, block.text);
                renderState();
            },
            postNotice(text, noticeOptions) {
                state = appendTuiNotice(state, text, noticeOptions?.tone);
                renderState();
                if (
                    noticeOptions?.replay === true
                    && client.supportsHostCapability?.(
                        HOST_CAPABILITY_HARNESS_MESSAGES,
                    ) === true
                ) {
                    void client.send({
                        type: "append_harness_message",
                        text,
                        tone: noticeOptions.tone ?? "primary",
                    });
                }
            },
            commandRegistry,
            onFailure(failure, failureSink) {
                const summary = `${failure.extensionId ?? failure.path}: ${failure.message}`;
                if (failureSink !== undefined) {
                    failureSink.push(summary);
                } else {
                    state = appendTuiNotice(state, summary);
                }
            },
        });
    const clientExtensionHost = createTuiClientExtensionHostController(
        startConfiguredClientExtensionHost,
        (registry) => {
            clientExtensionRegistry = registry;
            refreshKeymap();
            if (registry === undefined) {
                extensionMentions = [];
                extensionAddressee = undefined;
                commandPalette = undefined;
                help = undefined;
                const attached = hostedSidebar.release();
                if (attached !== undefined) {
                    rejectPendingExtensionSettingsFor(
                        attached.client,
                        new Error("The client extension host closed"),
                    );
                    // Reloading an extension generation removes the pane it
                    // owned. During TUI shutdown the pane was already released
                    // above, so its durable restore record must survive.
                    forgetPersistedAgentPane();
                }
                void attached?.detach().catch(() => attached.close());
                clearSidebarEntryNodes();
                sidebar.clear();
                sidebarSessionTitle = undefined;
                sidebar.setHeader(undefined);
                sidebarHeaderVisible = true;
                sidebar.close();
            }
            if (clientSurfaceReady) {
                renderCommandSuggestions();
                renderState();
            }
        },
    );
    await clientExtensionHost.reload();
    refreshKeymap();
    const directClientExtensions = bundledClientExtensions();
    for (const extension of directClientExtensions) {
        if (
            extension.commands.some(
                (command) => command.source !== extension.id,
            )
        ) {
            throw new Error(
                `Direct extension ${extension.id} returned a command for another source`,
            );
        }
        registerExtensionTuiCommands(
            commandRegistry,
            extension.commands,
            "direct",
        );
    }
    /**
     * Rebuild the one table the TUI dispatches from.
     *
     * Static rows, whatever the extension generation registered, and the
     * user's `keybindings` block go through one merge, so dispatch, footer
     * hints and the help pane cannot disagree about where a key lives. Run
     * again after an extension reload, since the chords on offer changed.
     */
    function refreshKeymap(): void {
        const resolution = resolveTuiKeymap({
            extensions: (clientExtensionRegistry?.keybindings() ?? []).map(
                (descriptor) => ({
                    id: descriptor.id,
                    keys: descriptor.keys,
                    description: descriptor.description,
                    ...(isTuiKeyScope(descriptor.scope)
                        ? { scope: descriptor.scope }
                        : {}),
                    ...(descriptor.remappable === undefined
                        ? {}
                        : { remappable: descriptor.remappable }),
                    ...(descriptor.hint === undefined
                        ? {}
                        : { hint: descriptor.hint }),
                }),
            ),
            overlay: keybindingOverlay,
        });
        installTuiKeymap(resolution.bindings);
        // Said once per distinct set. A reload that changes nothing about the
        // keys must not repeat the banner it already showed.
        for (const notice of resolution.notices) {
            if (announcedKeymapNotices.has(notice)) continue;
            announcedKeymapNotices.add(notice);
            // The first history rebuilds the transcript from the session, so a
            // notice settled before it would be painted and then dropped.
            if (transcriptSeeded) {
                state = appendTuiNotice(state, notice);
            } else {
                deferredKeymapNotices.push(notice);
            }
        }
    }

    function coreHelpCommands(): readonly TuiCommandCatalogEntry[] {
        const hostCommandNames = new Set(
            hostExtensionCommands.map((command) => command.name),
        );
        return commandRegistry.registeredCommands().filter(
            (command) => !hostCommandNames.has(command.name),
        );
    }

    function registeredPaletteEntries(): readonly TuiPaletteEntry[] {
        // Every command that belongs in the palette declares its own row, so
        // there is nothing left to synthesize from the slash catalog.
        return commandRegistry.registeredPaletteActions();
    }

    let markdownStyle = createMarkdownStyle(theme);
    function createMarkdownStyle(activeTheme: typeof theme): SyntaxStyle {
        return SyntaxStyle.fromStyles({
        default: { fg: activeTheme.text },
        "markup.heading": { fg: activeTheme.accent, bold: true },
        // Assistant prose uses a quieter base foreground, but emphasis is a
        // deliberate signal and must not inherit that muted color.
        "markup.strong": { fg: activeTheme.text, bold: true },
        "markup.italic": { fg: activeTheme.text, italic: true },
        "markup.raw": { fg: activeTheme.code },
        "markup.raw.block": { fg: activeTheme.code },
        "markup.list": { fg: activeTheme.accent },
        "markup.quote": { fg: activeTheme.muted, italic: true },
        "markup.link": { fg: activeTheme.accent, underline: true },
        "markup.link.label": { fg: activeTheme.accent },
        "markup.link.url": { fg: activeTheme.muted, underline: true },
        comment: { fg: activeTheme.muted, italic: true },
        string: { fg: activeTheme.success },
        number: { fg: activeTheme.notice },
        boolean: { fg: activeTheme.notice },
        keyword: { fg: activeTheme.accent },
        type: { fg: activeTheme.notice },
        "type.builtin": { fg: activeTheme.notice },
        function: { fg: activeTheme.accent },
        "function.call": { fg: activeTheme.accent },
        constant: { fg: activeTheme.notice },
        operator: { fg: activeTheme.muted },
        conceal: { fg: activeTheme.muted },
        });
    }

    const transcript = new ScrollBoxRenderable(renderer, {
        id: "transcript",
        flexGrow: 1,
        width: "100%",
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
        wrapperOptions: {
            paddingRight: appearance.transcriptPaddingRight,
        },
        contentOptions: {
            flexDirection: "column",
            gap: 0,
            paddingTop: 0,
            paddingBottom: 1,
            paddingLeft: appearance.transcriptPaddingLeft,
        },
    });
    appendTranscriptRenderable = (node) => {
        const container = new BoxRenderable(renderer, {
            id: `extension-transcript-${randomUUID()}`,
            width: "100%",
        });
        container.add(node);
        let active = true;
        transcript.add(container);
        return async () => {
            if (!active) return;
            active = false;
            transcript.remove(container.id);
            container.remove(node.id);
            container.destroy();
        };
    };

    const JUMP_TO_BOTTOM_LABEL =
        ` ↓ Jump to bottom · ${tuiKeyHint("jump_to_bottom")} `;
    const jumpToBottomText = new TextRenderable(renderer, {
        id: "jump-to-bottom-text",
        content: JUMP_TO_BOTTOM_LABEL,
        fg: theme.background,
        bg: theme.accent,
        width: "100%",
        height: 1,
    });
    const jumpToBottom = new BoxRenderable(renderer, {
        id: "jump-to-bottom",
        position: "absolute",
        width: JUMP_TO_BOTTOM_LABEL.length,
        height: 1,
        backgroundColor: theme.accent,
        zIndex: 4,
        visible: false,
        onMouseDown: () => {
            transcript.scrollTo(transcript.scrollHeight);
            renderJumpToBottom();
        },
    });
    jumpToBottom.add(jumpToBottomText);

    // The sidebar gets the same pill, shortened: the column is narrow, and the
    // key jumps the transcript, so there is nothing to name here but the way
    // back down.
    const SIDEBAR_JUMP_LABEL = " \u2193 Jump to bottom ";
    const sidebarJumpText = new TextRenderable(renderer, {
        id: "sidebar-jump-text",
        content: SIDEBAR_JUMP_LABEL,
        fg: theme.background,
        bg: theme.accent,
        width: "100%",
        height: 1,
    });
    const sidebarJump = new BoxRenderable(renderer, {
        id: "sidebar-jump",
        position: "absolute",
        width: SIDEBAR_JUMP_LABEL.length,
        height: 1,
        backgroundColor: theme.accent,
        zIndex: 4,
        visible: false,
        onMouseDown: () => {
            sidebar.scrollToBottom();
            renderJumpToBottom();
        },
    });
    sidebarJump.add(sidebarJumpText);

    const placeholder = new TextRenderable(renderer, {
        id: "placeholder",
        content: "Start a conversation with Vera.",
        fg: TUI_MUTED,
        width: "100%",
        marginLeft: appearance.activityIndent,
    });
    transcript.add(placeholder);

    const transcriptEntryWindow = new BoxRenderable(renderer, {
        id: "transcript-entry-window",
        width: "100%",
        flexDirection: "column",
        flexShrink: 0,
    });
    const transcriptWindowTopSpacer = new BoxRenderable(renderer, {
        id: "transcript-window-top-spacer",
        width: "100%",
        height: 0,
        flexShrink: 0,
    });
    const transcriptWindowBottomSpacer = new BoxRenderable(renderer, {
        id: "transcript-window-bottom-spacer",
        width: "100%",
        height: 0,
        visible: false,
        flexShrink: 0,
    });
    transcriptEntryWindow.add(transcriptWindowTopSpacer);
    transcriptEntryWindow.add(transcriptWindowBottomSpacer);
    transcript.add(transcriptEntryWindow);

    // Parallel sparse arrays: both use the reduced transcript index as their
    // contract. A missing slot means that entry has not been materialized,
    // while a present node and kind must be assigned or deleted together.
    const entryNodes: (TextRenderable | MarkdownRenderable | BoxRenderable)[] = [];
    const entryNodeKinds: TuiTranscriptEntry["kind"][] = [];
    let materializedEntryStart = 0;
    let materializedEntryEnd = 0;
    /**
     * The rows an entry occupied while it was materialized.
     *
     * The spacer stands in for released entries, so a released entry's height
     * has to come back the same or the rows below it shift under the reader.
     * A measurement is exact where the estimate is not, which is what keeps
     * releasing and rebuilding a batch free of any scroll correction. Width
     * changes what an entry measures, so the whole cache is dropped on resize.
     */
    const measuredEntryRows: number[] = [];
    let measuredEntryRowsWidth = 0;
    let pendingTranscriptScrollRestore: {
        readonly scrollTop: number;
        readonly atBottom: boolean;
    } | undefined;
    /**
     * The entry the reader was reading and where it sat in the viewport, to be
     * put back once the layout it is waiting on has run.
     *
     * Anything that changes what stands above the viewport moves every row
     * below it: a width change, and materializing entries the spacer was
     * standing in for. A laid-out node says exactly how far, where the row
     * estimate the spacer was built from only guesses.
     */
    let pendingTranscriptScrollAnchor: {
        readonly index: number;
        readonly offset: number;
    } | undefined;
    const sidebarEntryNodes: (
        TextRenderable | MarkdownRenderable | BoxRenderable
    )[] = [];
    const sidebarEntryNodeKinds: TuiTranscriptEntry["kind"][] = [];
    let sidebarEntryGeneration = 0;

    function clearSidebarEntryNodes(): void {
        while (sidebarEntryNodes.length > 0) {
            sidebarEntryNodes.pop()?.destroyRecursively();
            sidebarEntryNodeKinds.pop();
        }
    }

    /** Close the attached peer without ending its durable session. */
    function closeSidebarPane(extensionId?: string): void {
        const attached = hostedSidebar.release(extensionId);
        if (attached !== undefined) {
            rejectPendingExtensionSettingsFor(
                attached.client,
                new Error("The sidebar agent closed"),
            );
        }
        pendingSidebarSessionRename = undefined;
        forgetPersistedAgentPane();
        sidebarSessionTitle = undefined;
        void attached?.detach().catch(() => attached.close());
        clearSidebarEntryNodes();
        sidebar.clear();
        sidebar.setHeader(undefined);
        sidebarHeaderVisible = true;
        sidebar.close();
        setSidebarFocused(false);
        composer.focus();
        renderState();
    }

    const statusText = new TextRenderable(renderer, {
        id: "status",
        content: READY_HINT,
        fg: TUI_MUTED,
        height: 1,
        flexGrow: 1,
        flexShrink: 1,
    });
    const activityHintText = new TextRenderable(renderer, {
        id: "activity-hint",
        content: "",
        fg: TUI_MUTED,
        height: 1,
        flexShrink: 0,
        alignSelf: "flex-end",
    });
    const dialCardTitle = new TextRenderable(renderer, {
        id: "dial-card-title",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: 3,
        flexShrink: 0,
    });
    const dialCardHint = new TextRenderable(renderer, {
        id: "dial-card-hint",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        flexShrink: 0,
    });
    const dialCard = new BoxRenderable(renderer, {
        id: "dial-card",
        // No border, and so no border styling option either: OpenTUI's
        // BoxRenderable reads any of them as "this box wants a border" and
        // overrides `border: false`. The HUD's own ground is what separates
        // it from the screen, the way the other overlays are drawn.
        border: false,
        backgroundColor: TUI_HUD?.background ?? TUI_PANEL,
        height: 6,
        marginLeft: appearance.composerMarginHorizontal,
        marginRight: appearance.composerMarginHorizontal,
        marginBottom: 1,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: appearance.composerPaddingHorizontal + 1,
        paddingRight: appearance.composerPaddingHorizontal + 1,
        flexDirection: "column",
        zIndex: DIALOG_CARD_Z_INDEX,
        focusable: true,
        visible: false,
    });
    dialCard.add(dialCardTitle);
    dialCard.add(dialCardHint);
    const backgroundStatusText = new TextRenderable(renderer, {
        id: "background-status",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 2,
    });
    // The details sit in a panel of their own rather than loose under the
    // composer: the composer is where the session is typed into, and this is
    // what the session currently is. One border says the two are separate
    // things without a heading having to say it.
    const statusCard = new BoxRenderable(renderer, {
        id: "status-card",
        border: false,
        width: "100%",
        height: "auto",
        flexDirection: "column",
    });
    statusCard.add(backgroundStatusText);
    const workspaceBranch = watchWorkspaceBranch(
        process.cwd(),
        () => renderer.requestRender(),
    );
    // A text node paints only the cells its glyphs fill, so the status rows
    // would show the transcript through every gap in the line, and through the
    // spaces inside it. The band that backs them is this box rather than a
    // sibling behind them: a sibling is sized from the rows' heights, which say
    // nothing about whether the rows are drawn, so every surface that hid a
    // status row left the paint behind. Held together, hiding the rows hides
    // the band, and one height serves the composer's margin as well.
    const statusBand = new BoxRenderable(renderer, {
        id: "status-band",
        position: "absolute",
        left: 0,
        bottom: APP_PADDING_BOTTOM,
        width: "100%",
        height: "auto",
        flexDirection: "column",
        // The rows are indented from the band, not from themselves: a text
        // node laid out as a flex child does not carry its own padding. The
        // indent clears the frame above and its padding, so these rows start
        // in the same column as the text inside it.
        paddingLeft: composerContentIndent,
        paddingRight: composerContentIndent,
        zIndex: DIALOG_BACKGROUND_Z_INDEX,
    });
    const hostedModeText = new TextRenderable(renderer, {
        id: "hosted-mode-status",
        content: "",
        fg: TUI_MUTED,
        height: 1,
        flexShrink: 0,
        alignSelf: "flex-end",
        visible: false,
    });
    // The transient activity gets the row above. This row keeps the place on
    // the left and the hosted mode controls on the right throughout a turn.
    const placeRow = new BoxRenderable(renderer, {
        id: "place-row",
        width: "100%",
        height: "auto",
        flexDirection: "row",
    });
    statusCard.flexGrow = 1;
    statusCard.flexShrink = 1;
    placeRow.add(statusCard);
    placeRow.add(hostedModeText);
    const activityRow = new BoxRenderable(renderer, {
        id: "activity-row",
        width: "100%",
        height: 1,
        flexDirection: "row",
    });
    activityRow.add(statusText);
    activityRow.add(activityHintText);
    statusBand.add(activityRow);
    statusBand.add(placeRow);

    // Read here rather than passed in: tips are a client-side display choice,
    // and the host has no say in them.
    const tipsConfig = loadOptionalVeraConfig();
    const tipsEnabled = tipsConfig === undefined
        || configuredTipsEnabled(tipsConfig);
    // Tips read their own launch counter on the way in, so the count advances
    // once per start no matter how many tips the run goes on to show.
    let tipState: TuiTipState = tipsEnabled
        ? beginTuiTipLaunch()
        : { launches: 0, history: {} };
    // The line above the composer, cleared on the next submit. The overlay's
    // own line is chosen separately: an overlay is a place the user went
    // looking for keys, so it is allowed a tip even when the transcript one
    // has already been spent this turn.
    let composerTip: string | undefined;
    let workingLastRender = false;
    let pickerTipKind: string | undefined;

    const composerTipText = new TextRenderable(renderer, {
        id: "composer-tip",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        paddingLeft: 0,
        visible: false,
    });

    // Text taken from one pane and waiting to ride along with the next
    // message. One at a time: a second selection replaces it, which is what a
    // person who selects again means.
    let pendingQuote: TuiQuote | undefined;

    const quoteText = new TextRenderable(renderer, {
        id: "pending-quote",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });
    // Quote controls are footer state for the shared composer. Keeping them in
    // the status band puts them below the input regardless of which pane the
    // quoted text came from.
    statusBand.add(quoteText);

    const heldAddressText = new TextRenderable(renderer, {
        id: "held-address",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });

    const queuedPromptText = new TextRenderable(renderer, {
        id: "queued-prompt",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });

    const composer = createTuiComposer(
        renderer,
        // Called with the editor's value, which is not what submitPrompt's
        // parameter means.
        () => submitPrompt(),
        attachPastedImage,
    );
    composer.onCommandDelete = () => {
        if (
            composer.plainText.length === 0
            || anyOverlayOpen()
        ) return false;
        composer.clearComposer();
        renderCommandSuggestions();
        renderState();
        return true;
    };
    composer.onImageChipRemoved = (requestId) => {
        releaseDroppedImage(requestId);
        pendingImages = pendingImages.filter(
            (image) => image.requestId !== requestId,
        );
        if (pendingImages.length === 0) {
            submitAfterImageAttachment = false;
        }
        renderState();
    };
    if (dependencies.initialDraft !== undefined) {
        composer.setComposerText(dependencies.initialDraft.text);
        for (const image of pendingImages) {
            composer.attachImageChip(image.requestId);
        }
    }
    const timelinePickerView = createTuiTimelinePickerView(renderer);
    const settingsPickerView = createTuiSettingsPickerView(renderer);
    const secretPromptView = createTuiSecretPromptView(renderer);
    const namePromptView = createTuiNamePromptView(renderer);
    const providerFormView = createTuiProviderFormView(renderer);
    const preferencesListView = createTuiPreferencesListView(renderer);
    const commandPaletteView = createTuiCommandPaletteView(renderer);
    const workTabView = createTuiLinesView(renderer, "work-tab");
    const workspaceSidebarView = createTuiLinesView(
        renderer,
        "workspace-sidebar",
        { panelBackground: false, railDivider: true },
    );
    const searchOverlayView = createTuiLinesView(renderer, "search-overlay");
    const helpView = createTuiHelpView(renderer);
    const diagnosticsDialogView = createTuiDiagnosticsDialogView(renderer, {
        showScopeTabs: true,
    });
    const extensionsDialogView = createTuiDiagnosticsDialogView(renderer, {
        id: "extensions-dialog",
        title: "Extensions",
        footerText: "Managed installs stay outside the Vera release.",
        skipFirstLine: false,
        sections: new Set(["Extensions", "Extension install", "Extension install plan (dry run)"]),
    });
    const doctorDialogView = createTuiDiagnosticsDialogView(renderer, {
        id: "doctor-dialog",
        title: "Doctor",
        footerText: "Read-only; no processes are stopped.",
        pendingText: "checking process health…",
        sections: new Set([
            "Process summary",
            "Issues",
            "High CPU activity",
        ]),
    });
    const permissionsConfirmView = createTuiPermissionsConfirmView(renderer);
    const admissionDialogView = createTuiAdmissionDialogView(renderer);
    const sessionTrashConfirmView =
        createTuiSessionTrashConfirmView(renderer);
    const providerForgetConfirmView =
        createTuiProviderForgetConfirmView(renderer);
    const approvalView = createTuiApprovalView(renderer);
    const questionView = createTuiQuestionView(renderer);
    [
        timelinePickerView,
        settingsPickerView,
        secretPromptView,
        namePromptView,
        providerFormView,
        preferencesListView,
        commandPaletteView,
        helpView,
        diagnosticsDialogView,
        extensionsDialogView,
        doctorDialogView,
        permissionsConfirmView,
        admissionDialogView,
        sessionTrashConfirmView,
        providerForgetConfirmView,
        approvalView,
        questionView,
    ].forEach((view) => registerDialogCard(view.box));

    const commandSuggestionsText = new TextRenderable(renderer, {
        id: "command-suggestions-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
    });
    // Use the same full-width band and content indent as the status row. The
    // band spans the screen, so it carries the ground rather than a raised
    // surface: a panel shade here reads as a slab wider than the composer it
    // completes. The blank top row separates the strip from a transcript that
    // has filled every available line.
    const commandSuggestionsBox = new BoxRenderable(renderer, {
        id: "command-suggestions",
        border: false,
        position: "absolute",
        ...tuiComposerOverlayInset(appearance),
        bottom: 7,
        height: 1,
        paddingTop: 1,
        backgroundColor: theme.background,
        zIndex: 5,
        visible: false,
    });
    commandSuggestionsBox.add(commandSuggestionsText);
    composer.onContentChange = renderCommandSuggestions;

    const jumpMenuText = new TextRenderable(renderer, {
        id: "jump-menu-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
    });
    // A quick detour, not a workspace: the menu hangs off the composer at the
    // status row that announces its targets, rather than taking the screen
    // the way the work tab does.
    const jumpMenuBox = new BoxRenderable(renderer, {
        id: "jump-menu",
        border: true,
        borderStyle: "rounded",
        borderColor: theme.element,
        focusedBorderColor: theme.element,
        title: " Jump ",
        position: "absolute",
        left: tuiComposerOverlayInset(appearance).paddingLeft,
        width: 40,
        height: 3,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.panel,
        zIndex: 5,
        visible: false,
        onMouseDown: (event) => {
            if (jumpMenu === undefined) return;
            const lines = jumpMenuLines(jumpMenu, jumpMenuContentWidth());
            const line = lines[event.y - jumpMenuBox.y - 1];
            if (line?.rowIndex === undefined) return;
            const row = jumpMenu.rows[line.rowIndex];
            if (row !== undefined) runJumpTo(row);
        },
    });
    jumpMenuBox.add(jumpMenuText);

    /**
     * How many rows the status band takes under the composer. The suggestion
     * strip floats outside the layout flow and has to clear that band, so the
     * margin is kept here rather than read back off the box.
     */
    let composerMarginRows = 2;

    function setComposerMargin(rows: number): void {
        composerMarginRows = rows;
        composerBox.marginBottom = rows;
        workspaceSidebarView.setBottomInset(composerBox.height + rows);
        positionCommandSuggestions();
    }

    function positionCommandSuggestions(): void {
        // One more than the rows under the strip: `bottom` is where the box's
        // bottom edge sits, so without it the strip's last row lands on the
        // composer's top border instead of the row above it.
        commandSuggestionsBox.bottom = composerBox.height
            + composerMarginRows
            + experimentalTuiHost.bottomInsetRows()
            + (composerTipText.visible ? 1 : 0)
            + (quoteText.visible ? 1 : 0)
            + (heldAddressText.visible ? 1 : 0)
            + 1;
        jumpMenuBox.bottom = commandSuggestionsBox.bottom;
    }

    const modeToastText = new TextRenderable(renderer, {
        id: "mode-toast-text",
        content: "",
        fg: theme.text,
        bg: theme.panel,
        width: "100%",
        height: 1,
    });
    const modeToast = new BoxRenderable(renderer, {
        id: "mode-toast",
        position: "absolute",
        // Positioned against the shared app, not either pane, with enough
        // inset to read as a floating notice rather than terminal chrome.
        top: 1,
        right: 2,
        width: 1,
        height: 3,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        paddingRight: 2,
        backgroundColor: theme.panel,
        zIndex: 4,
        visible: false,
    });
    modeToast.add(modeToastText);
    let modeToastVersion = 0;

    const {
        panel: composerBox,
        status: composerStatusText,
        rule: composerRule,
    } = createTuiComposerPanel(renderer, composer, {
        marginHorizontal: appearance.composerMarginHorizontal,
        paddingHorizontal: appearance.composerPaddingHorizontal,
        boundaryColor: appearance.composerBoundaryColor ?? theme.element,
    });
    workspaceSidebarView.setBottomInset(
        composerBox.height + composerMarginRows,
    );
    // The attention chip at the head of the status row is a click target,
    // and it does what its label says: the hint reads /work, so the click
    // opens the work tab. Width zero means no chip is on screen.
    let needsYouChipWidth = 0;
    composerStatusText.onMouseDown = (event) => {
        if (needsYouChipWidth === 0) return;
        if (event.x - composerStatusText.x >= needsYouChipWidth) return;
        openWorkTab();
    };
    let composerTextRows = TUI_COMPOSER_MIN_TEXT_ROWS;
    let requestedComposerTextRows = TUI_COMPOSER_MIN_TEXT_ROWS;
    function resizeComposer(requestedRows: number): void {
        requestedComposerTextRows = requestedRows;
        const terminalCap = Math.max(
            TUI_COMPOSER_MIN_TEXT_ROWS,
            Math.floor(renderer.height / 4),
        );
        const nextRows = Math.min(
            requestedRows,
            TUI_COMPOSER_MAX_TEXT_ROWS,
            terminalCap,
        );
        if (nextRows === composerTextRows) return;
        composerTextRows = nextRows;
        composer.height = nextRows;
        composerBox.height = tuiComposerPanelRows(nextRows);
        workspaceSidebarView.setBottomInset(
            composerBox.height + composerMarginRows,
        );
        positionCommandSuggestions();
        renderer.requestRender();
    }
    composer.onTypedRowsChange = resizeComposer;

    const bodyFocus = new TuiBodyFocusController();
    // Everything the sidebar sits beside: the conversation and what hangs off
    // it, but not the composer, so the split ends where typing begins.
    const upper = new BoxRenderable(renderer, {
        id: "upper",
        flexGrow: 1,
        flexDirection: "column",
        gap: 1,
    });
    const app = new BoxRenderable(renderer, {
        id: "app",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        // The whole screen carries the theme's background. Painting it here
        // rather than under the surfaces that need it is what keeps a strip of
        // a different shade from showing wherever one of them is hidden.
        backgroundColor: theme.background,
        paddingTop: APP_PADDING_TOP,
        paddingBottom: APP_PADDING_BOTTOM,
        onMouseDrag: (event: MouseEvent) => {
            bodyFocus.noteDrag();
            if (!workspaceRailDragging) return;
            event.preventDefault();
            event.stopPropagation();
            resizeWorkspaceRailAt(event.x);
        },
        onMouseDragEnd: () => bodyFocus.noteDrag(),
        onMouseUp: (event: MouseEvent) => {
            if (workspaceRailDragging) {
                workspaceRailDragging = false;
                workspaceSidebarView.box.borderColor = theme.element;
                event.stopPropagation();
                if (workspaceRailPreferred !== undefined) {
                    try {
                        saveTuiWorkspaceSidebarWidth(workspaceRailPreferred);
                    } catch {
                        // The rail keeps the width reached in this session.
                    }
                }
                return;
            }
            if (bodyFocus.release(anyOverlayOpen())) {
                composer.focus();
            }
        },
    });
    const sidebar = createTuiSidebar({
        renderer,
        transcript: upper,
        theme: sidebarTheme(),
        syntaxStyle: markdownStyle,
        ...(sidebarWidth === undefined ? {} : { initialWidth: sidebarWidth }),
        onWidthChanged: (columns) => {
            try {
                saveTuiSidebarWidth(columns);
            } catch {
                // A width that could not be saved is not worth interrupting a
                // drag over; the sidebar keeps it for this session.
            }
        },
        onHeaderClick: toggleSidebarHeader,
        onMainHeaderClick: toggleMainHeader,
        onPanelRelease: () => {
            if (hostedSidebar.pane === undefined || anyOverlayOpen()) return;
            // Pointer input never chooses the addressed agent; Ctrl+G owns
            // that. It does return typing focus after either transcript is
            // clicked or selected, matching the main pane.
            composer.focus();
            renderState();
        },
        // Clicking the column is how you talk to it: with one seat there is no
        // question who, and typing the name again is the part nobody wants.
        onPanelClick: () => {
            if (hostedSidebar.pane !== undefined) {
                return;
            }
            const declared = clientExtensionRegistry
                ?.experimentalHostedAgentAddressing(hostedSidebar.owner);
            const first = declared?.secondary ?? visibleMentions()[0];
            if (first === undefined) return;
            // Already addressing someone (even with a trailing space): a
            // second click must not stack another mention.
            if (/(?:^|\s)@\S*\s*$/.test(composer.plainText)) return;
            composer.setComposerText(
                composer.plainText.length === 0
                    ? `@${first} `
                    : `${composer.plainText} @${first} `,
            );
            setSidebarFocused(true);
            composer.focus();
            renderCommandSuggestions();
            renderState();
        },
        onLayoutChanged: () => {
            renderJumpToBottom();
            renderSidebarJump();
            renderCommandSuggestions();
            const settings = focusedAgentState().modelSettings;
            if (settings !== undefined) notifyExtensionSettings(settings);
        },
    });

    async function openExtensionAgent(
        extensionId: string,
        next: IdentifiedTuiAgentClient,
        pane: "main" | "sidebar",
        replaceSidebarOwner = false,
        mention?: string,
        attachmentLifetime: "ephemeral" | "durable" = "durable",
        initialApprovalMode?: string,
        statusLabel?: string,
        signal?: AbortSignal,
    ): Promise<void> {
        signal?.throwIfAborted();
        if (pane === "main") {
            switchToClient(next, undefined, { preserveSidebar: true });
            return;
        }
        const previousSidebarAgent = hostedSidebar.pane;
        if (previousSidebarAgent !== undefined) {
            rejectPendingExtensionSettingsFor(
                previousSidebarAgent.client,
                new Error("The sidebar agent changed"),
            );
        }
        await hostedSidebar.adopt({
            extensionId,
            client: next,
            replaceOwner: replaceSidebarOwner,
            mention,
            attachmentLifetime,
            initialApprovalMode,
            statusLabel,
            signal,
            activate(_attached, previousModeLabel) {
                rememberOpenPaneGroup();
                sidebarSessionTitle = undefined;
                pendingSidebarSessionRename = undefined;
                clearSidebarEntryNodes();
                sidebar.clear();
                sidebar.setHeader(undefined);
                sidebarHeaderVisible = true;
                sidebar.open();
                setSidebarFocused(true);
                hostedSidebar.start();
                requestAgentSettings(next);
                renderState();
                if (
                    previousModeLabel !== undefined
                    && statusLabel !== undefined
                    && previousModeLabel !== statusLabel
                ) {
                    showModeToast(
                        `Switched from ${displayModeLabel(previousModeLabel)} to ${displayModeLabel(statusLabel)} mode`,
                    );
                }
            },
        });
    }

    function focusedAgentClient(): TuiAgentClient {
        return sidebar.isFocused() && hostedSidebar.pane !== undefined
            ? hostedSidebar.pane.client
            : client;
    }

    function isCurrentExtensionComposeTarget(
        target: TuiExtensionComposeTarget,
    ): boolean {
        return isCurrentTuiExtensionComposeTarget(target, {
            client: focusedAgentClient(),
            clientGeneration,
            surfaceGeneration: composeSurfaceGeneration,
            sessionSwitchPending,
        });
    }

    function focusedAgentState(): TuiState {
        return sidebar.isFocused() && hostedSidebar.pane !== undefined
            ? hostedSidebar.pane.state.state
            : state;
    }

    /** The pool as the strip needs it: identity, name, and published levels. */
    function dialPool(): readonly DialPoolEntry[] {
        return (focusedAgentState().modelSettings?.pooled ?? []).map(
            (entry) => ({
                provider: entry.provider,
                model: entry.model,
                ...(entry.poolName === undefined
                    ? {}
                    : { poolName: entry.poolName }),
                levels: entry.levels.map((level) => level.id),
                ...(entry.defaultLevel === undefined
                    ? {}
                    : { defaultLevel: entry.defaultLevel }),
                available: entry.available,
            }),
        );
    }

    /**
     * Level facts for models the pool has no ready entry for, from the
     * catalog the host already sends. Facts only: these never become rows.
     */
    function dialCatalog(): readonly DialPoolEntry[] {
        return (focusedAgentState().modelSettings?.availableModels ?? []).map(
            (entry) => ({
                provider: entry.provider,
                model: entry.model,
                levels: entry.levels.map((level) => level.id),
                ...(entry.defaultLevel === undefined
                    ? {}
                    : { defaultLevel: entry.defaultLevel }),
            }),
        );
    }

    function committedDialPair(): DialPair | undefined {
        const settings = focusedAgentState().modelSettings;
        return settings === undefined ? undefined : {
            ...(settings.provider === undefined
                ? {}
                : { provider: settings.provider }),
            model: settings.model,
            ...(settings.reasoningEffort === undefined
                ? {}
                : { effort: settings.reasoningEffort }),
        };
    }

    /**
     * Show the strip. Nothing is sent, nothing changes: the strip proposes.
     *
     * The recents come from the session's own model-setting history, which is
     * re-read here so the next open reflects whatever this session did since.
     */
    function openDials(): void {
        const target = focusedAgentClient();
        if (
            target.supportsHostCapability?.(
                HOST_CAPABILITY_SESSION_SCOPED_STATE,
            ) === false
        ) {
            state = appendTuiNotice(
                state,
                "This host does not support session-scoped state, so the dial strip is unavailable.",
            );
            renderState();
            return;
        }
        const catalog = agentCatalog;
        void target.send({
            type: "get_session_model_settings_history",
            requestId: randomUUID(),
        }).catch(() => {
            // A history the host would not answer leaves the strip with the
            // current pair and admitted pool, which is still useful.
        });
        const composition = composeDialStrip({
            current: committedDialPair(),
            recents: (focusedAgentState().modelSettingsHistory ?? []).map(
                (entry) => ({
                    ...(entry.settings.provider === undefined
                        ? {}
                        : { provider: entry.settings.provider }),
                    model: entry.settings.model,
                    ...(entry.settings.reasoningEffort === undefined
                        ? {}
                        : { effort: entry.settings.reasoningEffort }),
                }),
            ),
            pool: dialPool(),
            catalog: dialCatalog(),
            includePool: true,
            cap: DIAL_HUD_CAP,
            recentCap: DIAL_HUD_RECENT_CAP,
        });
        dialStrip = openDialStrip(composition, committedDialPair(), {
            agents: catalog?.agents.map((agent) => agent.name),
            currentAgent: catalog?.worn ?? focusedAgentState().agent?.name,
            agentPostures: Object.fromEntries(
                catalog?.agents.flatMap((agent) =>
                    agent.posture === undefined
                        ? []
                        : [[agent.name, agent.posture] as const]
                ) ?? [],
            ),
            agentForbiddenAccess: Object.fromEntries(
                catalog?.agents.flatMap((agent) =>
                    agent.forbiddenAccess === undefined
                        ? []
                        : [[agent.name, agent.forbiddenAccess] as const]
                ) ?? [],
            ),
            permissionModes: ["readonly", "ask", "auto"],
            currentPermission: focusedAgentState().approvalMode,
        });
        renderState();
        focusActiveSurface();
        if (catalog === undefined) {
            void requestAgentCatalog(target).then((loaded) => {
                if (dialStrip === undefined || loaded === undefined) return;
                const agents = loaded.agents.map((agent) => agent.name);
                dialStrip = {
                    ...dialStrip,
                    agents,
                    agentIndex: Math.max(0, agents.indexOf(loaded.worn)),
                    openedAgent: loaded.worn,
                    agentPostures: Object.fromEntries(
                        loaded.agents.flatMap((agent) =>
                            agent.posture === undefined
                                ? []
                                : [[agent.name, agent.posture] as const]
                        ),
                    ),
                    agentForbiddenAccess: Object.fromEntries(
                        loaded.agents.flatMap((agent) =>
                            agent.forbiddenAccess === undefined
                                ? []
                                : [[agent.name, agent.forbiddenAccess] as const]
                        ),
                    ),
                };
                renderState();
            });
        }
    }

    /**
     * The agent surface: what is live, and how to change it.
     *
     * A readout first. Switching is the loud action it also offers, and `[d]`
     * writes the session's pair into the highlighted agent's file — the only
     * write into an agent a wire command can do.
     */
    async function openAgentPicker(): Promise<void> {
        const target = focusedAgentClient();
        let catalog = agentCatalog;
        if (catalog === undefined) {
            catalog = await requestAgentCatalog(target);
        }
        if (catalog === undefined) {
            state = appendTuiNotice(
                state,
                "This host does not support agents.",
            );
            renderState();
            return;
        }
        for (const notice of catalog.notices) {
            state = appendTuiNotice(state, notice, "soft");
        }
        while (true) {
            const current = agentCatalog ?? catalog;
            const result = await requestExtensionPicker({
                title: "Agents",
                subtitle:
                    "Switching agents re-reads the prefix, so the next turn is slower once.",
                rows: current.agents.map((agent) => ({
                    id: agent.name,
                    label: agent.scope === "extension" && agent.name !== "default"
                        ? `${agent.name} (ext)`
                        : agent.name,
                    description: describeAgentRow(agent),
                    current: agent.name === current.worn,
                })),
                selectedId: current.worn,
                actions: [
                    { id: "wear", label: "switch", keys: ["enter"] },
                    {
                        id: "default",
                        label: "save session pair as default",
                        keys: ["d"],
                    },
                ],
            }, new AbortController().signal);
            if (result.outcome === "cancelled") return;
            const agent = current.agents.find(
                (candidate) => candidate.name === result.rowId,
            );
            if (agent === undefined) return;
            if (result.actionId === "wear") {
                wearAgent(agent.name);
                return;
            }
            if (!agent.writable) {
                state = appendTuiNotice(
                    state,
                    `${agent.name} is registered by an extension, so its file cannot be written.`,
                );
                renderState();
                continue;
            }
            const pair = committedDialPair();
            const named = pair === undefined ? undefined : dialPool().find(
                (entry) =>
                    entry.model === pair.model
                    && (pair.provider === undefined
                        || entry.provider === pair.provider),
            )?.poolName;
            if (named === undefined) {
                // The agent file names a pool entry, so a model with no pool
                // name has nothing to write. Saying so beats writing an id the
                // format does not carry.
                state = appendTuiNotice(
                    state,
                    "Name this model in /model before saving it as an agent default.",
                );
                renderState();
                continue;
            }
            void target.send({
                type: "update_agent_default_pair",
                requestId: randomUUID(),
                name: agent.name,
                pair: {
                    name: named,
                    ...(pair?.effort === undefined ? {} : { effort: pair.effort }),
                },
            }).catch(() => undefined);
            state = appendTuiNotice(
                state,
                `${agent.name}: default pair is now ${named}${
                    pair?.effort === undefined ? "" : `·${pair.effort}`
                }.`,
                "soft",
            );
            renderState();
        }
    }

    function describeAgentRow(agent: TuiAgentCatalogRow): string {
        return [
            agent.tools === undefined
                ? "all tools"
                : `${agent.tools.length} tool${
                    agent.tools.length === 1 ? "" : "s"
                }`,
            agent.skills === undefined
                ? "all skills"
                : `${agent.skills.length} skill${
                    agent.skills.length === 1 ? "" : "s"
                }`,
            `posture: ${agent.posture ?? "host default"}`,
            ...(agent.defaultPair === undefined ? [] : [
                `default ${agent.defaultPair.name}${
                    agent.defaultPair.effort === undefined
                        ? ""
                        : `·${agent.defaultPair.effort}`
                }`,
            ]),
        ].join(" · ");
    }

    /** Enqueued, never applied here: the host decides where in the queue it lands. */
    function wearAgent(name: string): void {
        void focusedAgentClient().send({
            type: "wear_agent",
            requestId: randomUUID(),
            name,
        }).catch((error) => {
            state = appendTuiNotice(
                state,
                error instanceof Error ? error.message : String(error),
            );
            renderState();
        });
        if (focusedAgentState().working) {
            state = appendTuiNotice(
                state,
                `${name}: queued; applies after the current work.`,
                "soft",
            );
            renderState();
        }
    }

    function requestAgentCatalog(
        target: TuiAgentClient,
    ): Promise<TuiAgentCatalog | undefined> {
        const requestId = randomUUID();
        return new Promise((resolve) => {
            pendingAgentCatalogs.set(requestId, resolve);
            void target.send({ type: "list_agents", requestId }).catch(() => {
                pendingAgentCatalogs.delete(requestId);
                resolve(undefined);
            });
            // A host that answers nothing must not leave /agent hanging.
            setTimeout(() => {
                if (pendingAgentCatalogs.delete(requestId)) resolve(undefined);
            }, 5_000);
        });
    }

    function closeDials(): void {
        dialStrip = undefined;
        renderState();
        focusActiveSurface();
    }

    /**
     * A ui_request from the agent (approval, question) owns the screen. Any
     * picker or menu the user had open locally is not part of answering it,
     * and activeOverlayFocus() ranks several of them above the request, so
     * left open they paint over or steal focus from it instead of yielding.
     */
    function closeTransientOverlaysForUiRequest(): void {
        dialStrip = undefined;
        settingsPicker = undefined;
        commandPalette = undefined;
        help = undefined;
        workTab = undefined;
        workspaceSidebar = undefined;
        searchOverlay = undefined;
        queuedSearch = undefined;
        workTabView.surface.visible = false;
        workspaceSidebarView.surface.visible = false;
        searchOverlayView.surface.visible = false;
        doctorDialog = undefined;
        diagnosticsDialog = undefined;
        jumpMenu = undefined;
        jumpMenuBox.visible = false;
    }

    /** The pair as the next request will carry it. Nothing reaches the API now. */
    function commitDials(
        pair: DialPair,
        agent: string | undefined,
        permission: string | undefined,
    ): void {
        const target = focusedAgentClient();
        const opened = dialStrip;
        closeDials();
        if (opened?.opened === undefined
            || pair.model !== opened.opened.model
            || pair.provider !== opened.opened.provider
            || pair.effort !== opened.opened.effort) {
            void target.send({
                type: "update_session_model_settings",
                requestId: randomUUID(),
                patch: {
                    ...(pair.provider === undefined
                        ? {}
                        : { provider: pair.provider }),
                    model: pair.model,
                    reasoningEffort: pair.effort ?? null,
                },
            }).catch(reportConnectionError);
        }
        if (agent !== undefined && agent !== opened?.openedAgent) {
            wearAgent(agent);
        }
        if (permission !== undefined
            && permission !== opened?.openedPermission) {
            requestPermissionsChange(permission, target, "session");
        }
    }

    function setSidebarFocused(focused: boolean): void {
        if (sidebar.isFocused() !== focused) {
            composeSurfaceGeneration += 1;
        }
        sidebar.setFocused(focused);
        flightRecorder?.record({
            type: "focus_changed",
            surface: focused ? "sidebar_composer" : "main_composer",
        });
        const settings = focusedAgentState().modelSettings;
        if (settings !== undefined) notifyExtensionSettings(settings);
    }

    function focusedUiRequest(): UiRequestUpdate | undefined {
        return sidebar.isFocused() && hostedSidebar.pane !== undefined
            ? hostedSidebar.pane.state.pendingUiRequest
            : pendingUiRequest;
    }

    function focusedAbortRequested(): boolean {
        return sidebar.isFocused() && hostedSidebar.pane !== undefined
            ? hostedSidebar.pane.state.abortRequested
            : abortRequested;
    }

    function focusedAgentCanAbort(): boolean {
        const focused = focusedAgentState();
        return focused.working || focused.compactingSince !== undefined;
    }

    function abortFocusedAgent(): void {
        if (sidebar.isFocused() && hostedSidebar.pane !== undefined) {
            hostedSidebar.pane.state.abortRequested = true;
            hostedSidebar.pane.state.activity = "stopping";
            void hostedSidebar.pane.client.send({ type: "abort" })
                .catch(reportConnectionError);
            return;
        }
        abortRequested = true;
        activity = "stopping";
        sendCommand({ type: "abort" });
    }

    function visibleMentions(): readonly string[] {
        const declared = clientExtensionRegistry
            ?.experimentalHostedAgentAddressing(hostedSidebar.owner);
        return visibleTuiAgentMentions({
            declared,
            hasSidebar: hostedSidebar.pane !== undefined,
            sidebarMention: hostedSidebar.mention,
            extensionMentions,
        });
    }

    function hostedAgentAddressing(): TuiHostedAgentAddressing {
        const declared = clientExtensionRegistry
            ?.experimentalHostedAgentAddressing(hostedSidebar.owner);
        return resolveTuiHostedAgentAddressing({
            declared,
            hasSidebar: hostedSidebar.pane !== undefined,
            sidebarMention: hostedSidebar.mention,
            sidebarAgentId: hostedSidebar.pane?.agentId,
        });
    }

    function sidebarTranscriptWidth(): number {
        return Math.max(
            1,
            (sidebar.layout() === "sidebar"
                ? renderer.terminalWidth - 1
                : sidebar.width()) - 2,
        );
    }

    function mainTranscriptWidth(): number {
        return Math.max(
            1,
            renderer.terminalWidth
                - (sidebar.isShown() ? sidebar.width() + 1 : 0)
                - 4,
        );
    }

    function rememberOpenPaneGroup(): void {
        hostedPanePersistence.remember({
            mainAgentId: client.agentId,
            sidebarAgentId: hostedSidebar.pane?.agentId,
            owner: hostedSidebar.owner,
            mention: hostedSidebar.mention,
            statusLabel: hostedSidebar.modeLabel,
            attachmentLifetime: hostedSidebar.attachmentLifetime,
        });
    }

    function forgetPersistedAgentPane(mainAgentId = client.agentId): void {
        hostedPanePersistence.forget(mainAgentId);
    }

    /**
     * One rendered transcript block: the entry's own renderable, wrapped in
     * the marker column unless it draws its own chrome edge to edge.
     */
    function createTuiEntryNode(
        id: string,
        entry: TuiTranscriptEntry,
        marginTop: number,
        separated: boolean,
    ): TextRenderable | MarkdownRenderable | BoxRenderable {
        const inner = entry.kind === "user" ? marginTop : 0;
        const markdownNode = entry.kind === "diff"
            ? undefined
            : createTuiMarkdownEntry(
                renderer,
                id,
                entry,
                markdownStyle,
                // Assistant prose stays readable but yields to the session
                // chrome and user-authored prompts in the visual hierarchy.
                entry.kind === "assistant" || entry.kind === "notification"
                    ? TUI_MUTED
                    : TUI_TEXT,
                inner,
            );
        const node = entry.kind === "tool"
            ? createTuiToolRow(renderer, id, entry, inner)
            : entry.kind === "tool_header"
            ? createTuiToolHeader(renderer, id, entry, inner)
            : entry.kind === "user"
            ? createTuiUserEntry(renderer, id, entry, inner)
            : entry.kind === "diff"
            ? createTuiDiff(
                renderer,
                id,
                tuiDisplayPath(entry.path),
                entry.patch,
                markdownStyle,
                inner,
            )
            : entry.kind === "thinking"
            ? createTuiThinkingWindow(renderer, id, entry, inner)
            : markdownNode ?? new TextRenderable(renderer, {
                id,
                content: renderTuiEntry(entry),
                width: "100%",
                wrapMode: "word",
                selectable: true,
                marginTop: inner,
            });
        // The user band is chrome that owns its full width, so it keeps the
        // left edge rather than being pushed off the marker column.
        return entry.kind === "user"
            ? node
            : createTuiGutterEntry(
                renderer,
                id,
                entry,
                node,
                marginTop,
                separated,
                {
                    width: tuiGutterWidth(entry, appearance.activityIndent),
                    separatorVisible: appearance.separatorVisible,
                    separatorColor: appearance.transcriptSeparatorColor
                        ?? theme.element,
                    separatorSpacingBefore:
                        appearance.separatorSpacingBefore,
                    separatorSpacingAfter: appearance.separatorSpacingAfter,
                },
            );
    }

    function renderSidebarAgent(
        pane: TuiAgentPane<IdentifiedTuiAgentClient>,
    ): void {
        if (pane !== hostedSidebar.pane) return;
        const entries = pane.state.state.entries;
        const changedKindAt = entries.findIndex((entry, index) =>
            sidebarEntryNodes[index] !== undefined
            && sidebarEntryNodeKinds[index] !== entry.kind
        );
        const retained = changedKindAt === -1
            ? Math.min(entries.length, sidebarEntryNodes.length)
            : changedKindAt;
        const discarded = sidebarEntryNodes.splice(retained);
        sidebarEntryNodeKinds.splice(retained);

        entries.forEach((entry, index) => {
            const wrapper = sidebarEntryNodes[index];
            if (wrapper !== undefined) {
                wrapper.visible = tuiTranscriptEntryIsVisible(entry);
                const existing = tuiGutterContent(wrapper);
                if (
                    existing instanceof MarkdownRenderable
                    && existing.content !== tuiMarkdownEntryContent(entry)
                ) {
                    existing.content = tuiMarkdownEntryContent(entry);
                } else if (
                    entry.kind === "tool"
                    && existing instanceof BoxRenderable
                ) {
                    updateTuiToolRow(existing, entry);
                } else if (
                    entry.kind === "tool_header"
                    && existing instanceof BoxRenderable
                ) {
                    updateTuiToolHeader(existing, entry);
                } else if (
                    entry.kind === "thinking"
                    && existing instanceof BoxRenderable
                ) {
                    updateTuiThinkingWindow(existing, entry);
                } else if (
                    (entry.kind === "thought"
                        || entry.kind === "notice"
                        || entry.kind === "inbox")
                    && existing instanceof TextRenderable
                ) {
                    existing.content = renderTuiEntry(entry);
                }
                return;
            }

            const id = `sidebar-entry-${++sidebarEntryGeneration}`;
            const node = createTuiEntryNode(
                id,
                entry,
                tuiEntryMarginTop(entries, index, entrySpacing),
                assistantFollowsTools(entries, index),
            );
            node.visible = entry.kind !== "tool" || entry.hidden !== true;
            sidebarEntryNodes.push(node);
            sidebarEntryNodeKinds.push(entry.kind);
        });
        sidebar.replaceRendered(sidebarEntryNodes.map((node, index) => ({
            node,
            speaker: entries[index]?.kind === "user" ? "you" : "agent",
        })));
        for (const node of discarded) node.destroyRecursively();
        renderSidebarJump();
        renderState();
    }

    function handleSidebarAgentUpdate(
        update: AgentUpdate,
        pane: TuiAgentPane<IdentifiedTuiAgentClient>,
    ): void {
        if (pane !== hostedSidebar.pane) return;
        if (update.type === "ui_request") {
            setSidebarFocused(true);
        }
        if (
            (update.type === "session_name"
                || update.type === "session_name_rejected")
            && update.requestId === pendingSidebarSessionRename?.requestId
        ) {
            const pending = pendingSidebarSessionRename;
            pendingSidebarSessionRename = undefined;
            if (update.type === "session_name") {
                sidebarSessionTitle = update.name ?? undefined;
                pane.state.state = appendTuiNotice(
                    pane.state.state,
                    update.name === null
                        ? "session name cleared"
                        : `session renamed: ${update.name}`,
                );
            } else {
                if (
                    pending.commandText !== undefined
                    && composer.expandedText().length === 0
                ) {
                    composer.setComposerText(pending.commandText);
                }
                pane.state.state = appendTuiError(
                    pane.state.state,
                    update.reason === "invalid"
                        ? "Session name must be 1 to 200 UTF-8 bytes"
                        : "Could not rename this conversation",
                );
            }
        }
        if (update.type === "turn_finished") {
            pane.state.state = beginNextQueuedTuiTurn(pane.state.state);
            if (pane.state.state.working) {
                pane.state.workingSince = Date.now();
                pane.state.phaseSince = pane.state.workingSince;
                pane.state.activity = "thinking";
            } else {
                pane.state.workingSince = undefined;
                pane.state.phaseSince = undefined;
                pane.state.activity = "ready";
            }
        }
        if (update.type === "model_settings") {
            settleExtensionModelSettings(update, pane.client);
            const change = requestedModelChanges.get(update.requestId);
            if (change?.target === pane.client) {
                requestedModelChanges.delete(update.requestId);
            }
            if (
                change?.target === pane.client
                && update.updatedDefaults === true
            ) {
                // A settings change the user just made reports itself and
                // then gets out of the way: it is a receipt, not something
                // the transcript needs read.
                pane.state.state = appendTuiNotice(
                    pane.state.state,
                    defaultModelChangeNotice(change.patch, update.settings),
                    "soft",
                );
            }
            if (
                sidebar.isFocused()
                && pane.state.state.modelSettings !== undefined
            ) {
                notifyExtensionSettings(pane.state.state.modelSettings);
            }
        } else if (update.type === "model_settings_rejected") {
            settleExtensionModelSettings(update, pane.client);
            const change = requestedModelChanges.get(update.requestId);
            if (change?.target === pane.client) {
                requestedModelChanges.delete(update.requestId);
                pane.state.state = appendTuiError(
                    pane.state.state,
                    rejectionNotice(change.subject, update.reason),
                );
            }
        } else if (update.type === "permissions") {
            requestedPermissionChanges.delete(update.requestId);
        } else if (update.type === "permissions_rejected") {
            const subject = requestedPermissionChanges.get(update.requestId);
            requestedPermissionChanges.delete(update.requestId);
            if (subject !== undefined) {
                pane.state.state = appendTuiError(
                    pane.state.state,
                    rejectionNotice(subject, update.reason),
                );
            }
        }
    }
    upper.add(transcript);
    upper.add(experimentalTuiHost.transcriptBottom);
    app.add(experimentalTuiHost.transcriptTop);
    app.add(sidebar.body);
    app.add(jumpToBottom);
    app.add(sidebarJump);
    app.add(modeToast);
    const overlayScrim = new BoxRenderable(renderer, {
        id: "overlay-scrim",
        position: "absolute",
        // Stretched from above the app's top padding to the bottom of the
        // screen. An absolute child is laid out inside its parent's content
        // box and its height is clamped to it, so top and bottom rather than a
        // height: either alone leaves an undimmed bar at one end.
        left: 0,
        top: -APP_PADDING_TOP,
        bottom: -APP_PADDING_BOTTOM,
        width: "100%",
        height: "100%",
        // Enough to push the transcript behind the card, not enough to erase
        // it. A heavier wash reads fine on paper and fails on the dark themes,
        // where the ground is already near black and the text lands on top of
        // it: what is behind a dialog still has to be legible as context.
        backgroundColor: RGBA.fromInts(0, 0, 0, 150),
        zIndex: DIALOG_SCRIM_Z_INDEX,
        visible: false,
    });
    app.add(overlayScrim);
    app.add(experimentalTuiHost.overlay);
    upper.add(queuedPromptText);
    app.add(commandSuggestionsBox);
    app.add(jumpMenuBox);
    app.add(approvalView.box);
    app.add(questionView.box);
    app.add(timelinePickerView.box);
    // Clicking a row is the pointer's version of ⏎ on it, and hovering is the
    // pointer's version of ↑↓. Each surface only says where its cursor lives;
    // `rowPointer` supplies the behaviour, so the two input paths cannot drift.
    //
    // The wheel is a third path and a separate one: it is bound per overlay
    // below, and it moves the cursor without activating anything. All three end
    // up at the same cursor, so a change to what a row means has to be made in
    // the surface's key handler, which is the only place all three meet.
    timelinePickerView.pointer = rowPointer((index) => {
        if (timelinePicker === undefined) return;
        // The rewind flow reuses one overlay for two lists. On the action
        // screen the rows are the actions themselves, so there is no cursor to
        // move first; the digit press below carries the choice.
        if (timelinePicker.screen !== "select") return;
        timelinePicker = { ...timelinePicker, selectedIndex: index };
    });
    settingsPickerView.pointer = rowPointer((index) => {
        if (settingsPicker === undefined) return;
        settingsPicker = { ...settingsPicker, selectedIndex: index };
    });
    settingsPickerView.onTab = (tab) => {
        // The strip is on screen on the connect pane too, and a chip on it
        // leaves that pane for the collection it names.
        const pane = settingsPicker?.kind === "provider"
            ? settingsPicker.parent
            : settingsPicker;
        if (pane === undefined || pane.kind !== "model") {
            return;
        }
        settingsPicker = switchedModelTab(pane, tab);
        renderState();
    };
    settingsPickerView.onConfigure = () => {
        if (settingsPicker?.kind === "provider") return;
        if (settingsPicker?.kind !== "model") return;
        openProviderPicker(settingsPicker);
    };
    preferencesListView.pointer = rowPointer((index) => {
        if (preferencesList === undefined) return;
        preferencesList = { ...preferencesList, selectedIndex: index };
    });
    commandPaletteView.pointer = rowPointer((index) => {
        if (commandPalette === undefined) return;
        commandPalette = { ...commandPalette, selectedIndex: index };
    });
    helpView.pointer = rowPointer((index) => {
        if (help === undefined) return;
        help = { ...help, selectedIndex: index };
    });
    // The approval and question dialogs are answered by number, not by a
    // moving highlight, so a click sends the row's own digit.
    approvalView.pointer = rowPointer(() => {}, "digit");
    questionView.pointer = rowPointer(() => {}, "digit");
    // The pane windows itself around the cursor, so the wheel moves the cursor
    // and lets the window follow, the same way ctrl+d and ctrl+u do.
    settingsPickerView.box.onMouseScroll = (event) => {
        const scroll = event.scroll;
        if (settingsPicker === undefined || scroll === undefined) return;
        const transition = handleTuiSettingsPickerScroll(settingsPicker, scroll);
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        applySettingsPickerTransition(transition);
    };
    app.add(settingsPickerView.box);
    app.add(secretPromptView.box);
    app.add(namePromptView.surface);
    app.add(providerFormView.surface);
    // Every windowed overlay takes the wheel, not just the one it was built for
    // first. The handlers are the same three lines because the movement itself
    // lives in list-window.ts.
    preferencesListView.box.onMouseScroll = (event) => {
        if (preferencesList === undefined || event.scroll === undefined) return;
        const transition = handleTuiPreferencesListScroll(
            preferencesList,
            event.scroll,
        );
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        preferencesList = transition.state;
        renderState();
    };
    commandPaletteView.box.onMouseScroll = (event) => {
        if (commandPalette === undefined || event.scroll === undefined) return;
        const transition = handleTuiCommandPaletteScroll(
            commandPalette,
            event.scroll,
        );
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        commandPalette = transition.state;
        renderState();
    };
    helpView.box.onMouseScroll = (event) => {
        if (help === undefined || event.scroll === undefined) return;
        const transition = handleTuiHelpScroll(help, event.scroll);
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        help = transition.state;
        renderState();
    };
    app.add(preferencesListView.surface);
    app.add(commandPaletteView.surface);
    // Hover moves the cursor and a click acts on it, the same as every other
    // overlay: a row the arrows can reach is a row the mouse can reach.
    workTabView.pointer = {
        hover: (rowId) => {
            if (workTab === undefined || workTab.selectedId === rowId) return;
            workTab = { ...workTab, selectedId: rowId };
            renderState();
        },
        activate: (rowId) => {
            if (workTab === undefined) return;
            const open = { ...workTab, selectedId: rowId };
            workTab = open;
            const action = workTabAction(open.index, rowId);
            if (action !== undefined) runWorkTabAction(open, action);
        },
    };
    // Hover moves the cursor and a click activates the row it landed on, the
    // same as every other list: a row the arrows can reach is a row the mouse
    // can reach.
    workspaceSidebarView.pointer = {
        hover: (rowId) => {
            if (workspaceSidebar === undefined) return;
            if (workspaceSidebar.selectedId === rowId) return;
            workspaceSidebar = { ...workspaceSidebar, selectedId: rowId };
            renderState();
        },
        activate: (rowId) => {
            if (workspaceSidebar === undefined) return;
            const open = { ...workspaceSidebar, selectedId: rowId };
            workspaceSidebar = open;
            const action = openWorkspaceSelection(open, rowId);
            if (action !== undefined) runWorkspaceSidebarAction(action);
        },
    };
    workspaceSidebarView.box.onMouseDown = (event: MouseEvent) => {
        const occupied = workspaceSidebarView.railColumns();
        if (
            occupied === undefined
            || event.x !== occupied - 1
        ) return;
        event.preventDefault();
        event.stopPropagation();
        workspaceRailDragging = true;
        workspaceSidebarView.box.borderColor = theme.accent;
    };
    searchOverlayView.pointer = {
        hover: (rowId) => {
            const selected = searchSelectionOf(rowId);
            if (searchOverlay === undefined || selected === undefined) return;
            searchOverlay = { ...searchOverlay, selected };
            renderState();
        },
        activate: (rowId) => {
            const selected = searchSelectionOf(rowId);
            if (searchOverlay === undefined || selected === undefined) return;
            searchOverlay = { ...searchOverlay, selected };
            const action = openSelected(searchOverlay);
            if (action !== undefined) runSearchOverlayAction(action);
        },
    };
    // The card windows itself around the cursor, so a wheel that moved the
    // window on its own would leave enter pointing at a row off screen.
    workTabView.box.onMouseScroll = (event) => {
        if (workTab === undefined || event.scroll === undefined) return;
        const rows = workTab.index.rows;
        const at = rows.findIndex((row) => row.id === workTab?.selectedId);
        const next = wheelCursor(Math.max(0, at), rows.length, event.scroll);
        const selectedId = next === undefined ? undefined : rows[next]?.id;
        if (selectedId === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        workTab = { ...workTab, selectedId };
        renderState();
    };
    workspaceSidebarView.box.onMouseScroll = (event) => {
        if (workspaceSidebar === undefined || event.scroll === undefined) return;
        const open = workspaceSidebar;
        const rows = workspaceSidebarLayout(open, {
            columns: renderer.width,
            now: new Date(),
        }).selectable;
        const at = rows.indexOf(open.selectedId ?? "");
        const next = wheelCursor(Math.max(0, at), rows.length, event.scroll);
        const selectedId = next === undefined ? undefined : rows[next];
        if (selectedId === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        workspaceSidebar = { ...open, selectedId };
        renderState();
    };
    searchOverlayView.box.onMouseScroll = (event) => {
        if (searchOverlay === undefined || event.scroll === undefined) return;
        const selections = searchSelections(searchOverlay);
        const at = selections.findIndex((candidate) =>
            candidate.sessionId === searchOverlay?.selected?.sessionId
            && candidate.hitIndex === searchOverlay.selected.hitIndex);
        const next = wheelCursor(
            Math.max(0, at),
            selections.length,
            event.scroll,
        );
        const selected = next === undefined ? undefined : selections[next];
        if (selected === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        searchOverlay = { ...searchOverlay, selected };
        renderState();
    };
    app.add(workTabView.surface);
    app.add(workspaceSidebarView.surface);
    app.add(searchOverlayView.surface);
    app.add(helpView.box);
    app.add(diagnosticsDialogView.box);
    app.add(extensionsDialogView.box);
    app.add(doctorDialogView.box);
    app.add(permissionsConfirmView.box);
    app.add(admissionDialogView.surface);
    app.add(sessionTrashConfirmView.surface);
    app.add(providerForgetConfirmView.surface);
    app.add(composerTipText);
    app.add(experimentalTuiHost.footer);
    app.add(experimentalTuiHost.composerAdornment);
    // Pinned beside the composer, not written into the transcript: a mode the
    // transcript announces is a mode that scrolls out of sight.
    app.add(heldAddressText);
    app.add(dialCard);
    app.add(composerBox);
    app.add(statusBand);
    renderer.root.add(app);
    clientSurfaceReady = true;
    composer.focus();
    flightRecorder?.record({
        type: "focus_changed",
        surface: "main_composer",
    });
    renderStatus();

    // Beside the renderer's own reader rather than instead of it. Node hands
    // every `data` listener the same chunk, so this observes without
    // consuming, which is the only way to see these: the key parser drops the
    // focus sequences before any keypress handler runs.
    const watchTerminalFocus = (chunk: Buffer | string): void => {
        const focus = parseTerminalFocusEvent(
            typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
        if (focus !== undefined) terminalFocused = focus === "focus_in";
    };
    process.stdin.on("data", watchTerminalFocus);

    const stopWatchingTerminal = watchTerminalLoss(() => renderer.destroy());

    renderer.on(CliRenderEvents.DESTROY, () => {
        stopWatchingTerminal();
        flightRecorder?.record({ type: "renderer_destroyed" });
        shuttingDown = true;
        renderCoalescer.stop();
        clearInterval(statusTimer);
        stopWatchingBackgroundAgents?.();
        stopWatchingBackgroundAgents = undefined;
        stopWatchingWorkIndex?.();
        stopWatchingWorkIndex = undefined;
        process.stdin.off("data", watchTerminalFocus);
        writeTerminal(FOCUS_REPORTING_OFF);
        const picker = pendingExtensionPicker;
        pendingExtensionPicker = undefined;
        picker?.removeAbortListener();
        picker?.resolve({ outcome: "cancelled" });
        for (const pending of pendingExtensionSettings.values()) {
            pending.removeAbortListener();
            pending.reject(new Error("TUI is closing"));
        }
        pendingExtensionSettings.clear();
        const attachedSidebar = hostedSidebar.release();
        void Promise.all([
            clientExtensionHost.close(),
            attachedSidebar?.detach(),
        ])
            .catch(() => undefined)
            .then(() => experimentalTuiHost.close())
            .then(() => client.detach().catch(() => client.close()))
            .then(() => {
                finished.resolve(
                    client.agentId === undefined
                        ? {}
                        : { agentId: client.agentId },
                );
            });
    });

    /** The column's share of whichever theme is current. */
    function sidebarTheme() {
        return {
            handle: tuiHandleColor(theme),
            handleActive: tuiHandleActiveColor(theme),
            muted: theme.muted,
            text: theme.text,
        };
    }

    const renderCoalescer = createRenderCoalescer({ render: renderState });

    renderer.on(CliRenderEvents.FRAME, () => {
        settleTranscriptScrollState();
        measureMaterializedTranscriptEntries();
        // Materializing and releasing both write the nodes and the spacers
        // they touch, so neither needs a repaint of the rest of the screen.
        // At most one runs per frame: releasing what was just built would
        // rebuild it on the next frame.
        // A pending search target owns the window until its row is on screen.
        // Moving it in the same frame would release the row the scroll is
        // about to reach.
        if (
            pendingSearchTarget === undefined
            && !maybeSnapTranscriptWindowToTail()
            && !maybeMaterializeEarlierTranscriptEntries()
            && !maybeMaterializeLaterTranscriptEntries()
        ) {
            maybeEvictTranscriptEntries();
        }
        if (pendingTranscriptScrollAnchor !== undefined) {
            // The rows that just arrived have no position until a layout runs,
            // and the frame about to be painted is the one that would show
            // them in the wrong place.
            renderer.root.calculateLayout();
            applyTranscriptScrollAnchor();
        }
        showSearchTarget();
    });

    const statusTimer = setInterval(() => {
        renderStatus();
        refreshTimedSurfaces();
    }, activityAnimation === "shimmer"
        ? activityAnimationInterval ?? SHIMMER_FRAME_INTERVAL_MS
        : STATUS_REFRESH_INTERVAL_MS);
    watchBackgroundAgents(dependencies.client);
    watchWorkIndex(dependencies.client);
    // Asked for once, at startup: a terminal that answers reports every change
    // from here on, and one that does not leaves `terminalFocused` true, which
    // is the quiet default.
    writeTerminal(FOCUS_REPORTING_ON);

    renderer.on(CliRenderEvents.RESIZE, () => {
        overlayScrim.width = renderer.width;
        appearance = fitTuiAppearance(configuredAppearance, renderer.width);
        composerContentIndent = tuiComposerContentIndent(appearance);
        composerHorizontalInset = composerContentIndent * 2;
        composerBox.marginLeft = appearance.composerMarginHorizontal;
        composerBox.marginRight = appearance.composerMarginHorizontal;
        composerBox.paddingLeft = appearance.composerPaddingHorizontal;
        composerBox.paddingRight = appearance.composerPaddingHorizontal;
        dialCard.marginLeft = appearance.composerMarginHorizontal;
        dialCard.marginRight = appearance.composerMarginHorizontal;
        dialCard.paddingLeft = appearance.composerPaddingHorizontal + 1;
        dialCard.paddingRight = appearance.composerPaddingHorizontal + 1;
        statusBand.paddingLeft = composerContentIndent;
        statusBand.paddingRight = composerContentIndent;
        const suggestionInset = tuiComposerOverlayInset(appearance);
        commandSuggestionsBox.left = suggestionInset.left;
        commandSuggestionsBox.right = suggestionInset.right;
        commandSuggestionsBox.paddingLeft = suggestionInset.paddingLeft;
        commandSuggestionsBox.paddingRight = suggestionInset.paddingRight;
        transcript.content.paddingLeft = appearance.transcriptPaddingLeft;
        transcript.wrapper.paddingRight = appearance.transcriptPaddingRight;
        sidebar.refit();
        if (transcriptFollowsBottom()) {
            pendingTranscriptScrollRestore = { scrollTop: 0, atBottom: true };
        } else {
            captureTranscriptScrollAnchor();
        }
        resizeComposer(requestedComposerTextRows);
        renderState();
    });
    renderer.on(CliRenderEvents.SELECTION, (selection: Selection) => {
        const uiRequest = focusedUiRequest();
        const copyableNodes = uiRequest !== undefined
                && isToolApprovalUiRequestUpdate(uiRequest)
            ? [approvalView.detailsText]
            : uiRequest !== undefined
                    && isUserQuestionUiRequestUpdate(uiRequest)
                ? [questionView.detailsText]
                : entryNodes;
        const quotable = [
            ...state.entries.flatMap((entry, index) => {
                const node = entryNodes[index];
                return node === undefined ? [] : [{
                    node,
                    // Quoting the user's own words back is a different act
                    // from quoting the agent, and the attribution has to say
                    // which one happened.
                    speaker: entry.kind === "user" ? "you" : "agent",
                }];
            }),
            ...sidebar.blocks(),
        ];
        if (
            isTranscriptSelection(selection, [
                ...copyableNodes,
                ...sidebar.blocks().map((block) => block.node),
                // An extension view is text on the same screen, so the same
                // drag has to copy it. The slot is the whole boundary: the
                // selection walks up to it from whatever line it landed on.
                experimentalTuiHost.overlay,
                experimentalTuiHost.transcriptTop,
                experimentalTuiHost.transcriptBottom,
            ])
        ) {
            void copyTranscriptSelection(selection);
        }
        const speaker = selectionSpeaker(selection, quotable);
        const selected = speaker === undefined ? "" : selection.getSelectedText();
        // Only while an extension has somewhere to send it. With nobody else
        // in the conversation, quoting hands the agent its own words back,
        // and arming every plain copy with a quote changes what the next
        // message says without the sender asking for it.
        if (
            visibleMentions().length > 0 && speaker !== undefined
            && selected.trim().length > 0
        ) {
            pendingQuote = { source: speaker, text: selected };
            // A drag leaves the composer unfocused, which is right when the
            // selection was only a copy. It has just become the start of a
            // message, so the next keystroke has to land in the composer.
            if (!anyOverlayOpen()) {
                composer.focus();
            }
            renderState();
        }
    });

    /**
     * The moment a plain escape last landed while idle. Two consecutive
     * escapes within the window open the timeline picker. Every keypress
     * disarms it first thing in `handleKeypress`, and the paste handler
     * disarms it too, so anything at all between the two presses — even an
     * escape that closed an overlay, a typed key, or a pasted image chip that
     * never lands in `plainText` — breaks the pair. Only the qualifying idle
     * branch re-arms it. The timestamp is `performance.now()`, which a system
     * clock correction cannot move.
     */
    let lastIdleEscapeAt: number | undefined;

    // The composer takes pastes through its own renderable handler, but the
    // secret prompt is a plain box drawn over whatever is behind it, so the
    // paste has to be routed here. Ahead of the composer, which would otherwise
    // end up with the key as visible text in the transcript.
    renderer.keyInput.on("paste", (event) => {
        // A paste is input between the two presses, and a pasted image chip
        // is draft content even though it never lands in `plainText`, so a
        // paste always disarms the pair rather than leaving an armed first
        // escape to pair across it.
        lastIdleEscapeAt = undefined;
        if (
            providerForm !== undefined
            && providerFormView.surface.visible
        ) {
            event.preventDefault();
            event.stopPropagation();
            providerForm = handleTuiProviderFormPaste(
                providerForm,
                stripAnsiSequences(decodePasteBytes(event.bytes)),
            );
            renderState();
            return;
        }
        if (
            namePrompt !== undefined
            && namePromptView.surface.visible
        ) {
            event.preventDefault();
            event.stopPropagation();
            namePrompt = handleTuiNamePromptPaste(
                namePrompt,
                stripAnsiSequences(decodePasteBytes(event.bytes)),
            );
            renderState();
            return;
        }
        if (secretPrompt === undefined) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        secretPrompt = handleTuiSecretPromptPaste(
            secretPrompt,
            stripAnsiSequences(decodePasteBytes(event.bytes)),
        );
        renderState();
    });

    renderer.keyInput.on("keypress", handleKeypress);
    let lastInputRecordAt = 0;

    /**
     * Every key the TUI acts on arrives here, overlays included. Pointer input
     * is routed back through it (see `pressKey`) rather than growing a second
     * decision path per overlay: a click on a row has to mean exactly what ⏎ on
     * that row means, and the only way to guarantee that is for it to be the
     * same call.
     */
    function handleKeypress(key: KeyEvent): void {
        const inputAt = Date.now();
        if (inputAt - lastInputRecordAt >= 250) {
            lastInputRecordAt = inputAt;
            flightRecorder?.record({
                type: "raw_input_received",
                surface: activeFlightSurface(),
                control: key.ctrl || key.meta || key.super || key.hyper,
            });
            queueMicrotask(() => {
                // The key may synchronously destroy the renderer (for example,
                // ctrl+c while idle), taking the composer's EditBuffer with it.
                if (shuttingDown) return;
                flightRecorder?.record({
                    type: "composer_observed",
                    characters: Array.from(composer.expandedText()).length,
                    surface: activeFlightSurface(),
                });
            });
        }
        // Every keypress disarms the rewind pair unless the branch below
        // re-arms it: the pair must be two consecutive escapes with nothing
        // between them, not even an escape that closed an overlay or cleared
        // a draft. Captured first so the branch can still see the previous
        // press across the disarm.
        const previousIdleEscapeAt = lastIdleEscapeAt;
        lastIdleEscapeAt = undefined;
        if (parseRawInputEvent(key)?.type === "open_palette") {
            key.preventDefault();
            key.stopPropagation();
            // A second ctrl+p closes the palette, so the chord toggles rather
            // than reopening a palette that is already in front of you.
            if (commandPalette !== undefined) {
                commandPalette = undefined;
                commandPaletteView.surface.visible = false;
                composer.focus();
                renderState();
                return;
            }
            if (!sessionSwitchPending && !anyOverlayOpen()) {
                openCommandPalette();
            }
            return;
        }
        if (
            isTuiComposerClearKey(key)
            && composer.focused
            && composer.plainText.length > 0
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            composer.clearComposer();
            renderCommandSuggestions();
            renderState();
            return;
        }
        const wordDeleteDirection = tuiComposerWordDeleteDirection(key);
        if (
            wordDeleteDirection !== undefined
            && composer.focused
            && composer.plainText.length > 0
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            if (wordDeleteDirection === "backward") {
                composer.deleteWordBackward();
            } else {
                composer.deleteWordForward();
            }
            renderCommandSuggestions();
            renderState();
            return;
        }
        if (parseRawInputEvent(key)?.type === "interrupt") {
            // A trash in flight still consumes ctrl+c: it is destructive, it
            // is bounded by its own deadline, and the confirmation card is on
            // screen. A pending session switch does not, because the switch
            // has no cancel and swallowing the chord left no way to quit a
            // host that was slow to answer.
            if (sessionTrashPending) {
                key.preventDefault();
                key.stopPropagation();
                return;
            }
            if (
                !focusedAgentCanAbort()
                && composer.focused
                && composer.plainText.length > 0
                && !anyOverlayOpen()
            ) {
                key.preventDefault();
                key.stopPropagation();
                composer.clearComposer();
                renderCommandSuggestions();
                renderState();
                return;
            }
            const action = tuiInterruptAction(
                key,
                focusedAgentState().working,
                focusedAbortRequested(),
                focusedAgentState().compactingSince !== undefined,
            );
            key.preventDefault();
            key.stopPropagation();
            if (action === "quit") {
                renderer.destroy();
            } else if (action === "abort") {
                abortFocusedAgent();
                renderStatus();
            }
            return;
        }

        // The menu owns the keyboard while it is open: arrows move, enter
        // jumps, escape closes, and everything else is swallowed.
        if (jumpMenu !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            const action = handleJumpMenuKey(jumpMenu, key.name);
            if (action.kind === "cancel") {
                closeJumpMenu();
            } else if (action.kind === "jump") {
                runJumpTo(action.row);
            } else {
                jumpMenu = action.state;
                renderJumpMenu();
            }
            return;
        }

        // The strip owns the keyboard while it is open, after the escape
        // hatches above it. Every key here either moves the highlight, commits,
        // cancels, or bounces the keystroke into the composer.
        if (dialStrip !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            const action = handleDialStripKey(
                dialStrip,
                key as {
                    name: string;
                    ctrl?: boolean;
                    shift?: boolean;
                    sequence?: string;
                },
                tuiBindingId("dials", key),
            );
            if (action.kind === "state") {
                dialStrip = action.state;
                renderState();
            } else if (action.kind === "cancel") {
                closeDials();
            } else if (action.kind === "commit") {
                commitDials(action.pair, action.agent, action.permission);
            }
            return;
        }

        const uiRequest = focusedUiRequest();
        if (
            uiRequest !== undefined
            && isUserQuestionUiRequestUpdate(uiRequest)
        ) {
            // Arrow keys move the highlight (no engine message); numbers, Enter,
            // and Escape resolve the question. Selection stays client-local.
            const result = questionView.handleKey(uiRequest, key);
            if (result.handled) {
                key.preventDefault();
                key.stopPropagation();
                if (result.response !== undefined) {
                    void focusedAgentClient().send(result.response)
                        .catch(reportConnectionError);
                    if (sidebar.isFocused() && hostedSidebar.pane !== undefined) {
                        hostedSidebar.pane.state.activity = "thinking";
                    } else {
                        activity = "thinking";
                    }
                    focusActiveSurface();
                }
                renderState();
                return;
            }
        } else if (
            uiRequest !== undefined
            && isToolApprovalUiRequestUpdate(uiRequest)
        ) {
            // ←/→ move the button highlight (no engine message); digits, Enter,
            // and Escape resolve the approval. Selection stays client-local.
            const result = approvalView.handleKey(uiRequest, key);
            if (result.handled) {
                key.preventDefault();
                key.stopPropagation();
                if (result.response !== undefined) {
                    void focusedAgentClient().send(result.response)
                        .catch(reportConnectionError);
                    if (sidebar.isFocused() && hostedSidebar.pane !== undefined) {
                        hostedSidebar.pane.state.activity = "thinking";
                    } else {
                        activity = "thinking";
                    }
                    focusActiveSurface();
                }
                renderState();
                return;
            }
        }

        // Engine-owned prompts outrank every extension surface in key routing,
        // matching their focus and z-order priority.
        if (uiRequest === undefined && experimentalTuiHost.hasModal()) {
            key.preventDefault();
            key.stopPropagation();
            experimentalTuiHost.handleKey(key);
            return;
        }
        if (uiRequest === undefined
            && experimentalTuiHost.hasFocus()
            && experimentalTuiHost.handleKey(key)) {
            key.preventDefault();
            key.stopPropagation();
            return;
        }

        if (
            !composer.focused
            && activeOverlayFocus() === undefined
            && tuiBindingId("unfocused", key) === "focus_composer"
        ) {
            key.preventDefault();
            key.stopPropagation();
            composer.focus();
            renderState();
            return;
        }

        if (
            !composer.focused
            && activeOverlayFocus() === undefined
            && tuiBindingId("unfocused", key) === "open_help"
        ) {
            key.preventDefault();
            key.stopPropagation();
            openHelp();
            return;
        }

        if (sessionTrashCandidate !== undefined) {
            if (sessionTrashPending) {
                key.preventDefault();
                key.stopPropagation();
                return;
            }
            const result = handleTuiSessionTrashConfirmKey(key);
            key.preventDefault();
            key.stopPropagation();
            if (result !== undefined) {
                if (result === "confirm") {
                    beginSessionTrash(sessionTrashCandidate);
                } else {
                    sessionTrashCandidate = undefined;
                    state = appendTuiNotice(state, "conversation kept");
                    focusActiveSurface();
                    renderState();
                }
            }
            return;
        }

        if (providerForgetCandidate !== undefined) {
            const result = handleTuiProviderForgetConfirmKey(key);
            key.preventDefault();
            key.stopPropagation();
            if (result === "confirm") {
                forgetProviderCredential(providerForgetCandidate);
            } else if (result === "cancel") {
                const kept = providerForgetCandidate;
                providerForgetCandidate = undefined;
                state = appendTuiNotice(
                    state,
                    `kept the stored ${kept.label} credential`,
                );
                focusActiveSurface();
                renderState();
            }
            return;
        }

        if (timelinePicker !== undefined) {
            const transition = handleTuiTimelineKey(
                timelinePicker,
                key,
                randomUUID,
            );
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applyTimelineTransition(transition);
                return;
            }
        }

        if (confirmingFullAccess) {
            const result = handleTuiPermissionsConfirmKey(key);
            if (result !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                confirmingFullAccess = false;
                if (result === "confirm") {
                    requestPermissionsChange(
                        "full_access",
                        confirmingFullAccessAgent,
                    );
                } else {
                    state = appendTuiNotice(state, "full access unchanged");
                }
                confirmingFullAccessAgent = undefined;
                focusActiveSurface();
                renderState();
                return;
            }
        }

        // Blocking like the trash confirm: every key stops here while the
        // dialog is up, so nothing underneath can act on a stray press.
        if (admissionDialog !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            const action = handleTuiAdmissionDialogKey(
                admissionDialog,
                dialogAdmission(),
                key,
            );
            if (action === undefined) {
                return;
            }
            if (action === "retry") {
                const requestId = requestPoolAdmission(
                    admissionDialog.provider,
                    admissionDialog.model,
                    true,
                );
                admissionDialog = { ...admissionDialog, requestId };
                renderState();
                return;
            }
            if (action === "hide") {
                // The probes keep running; the transcript notice is their
                // surface from here.
                closeAdmissionDialog(false);
                return;
            }
            // Dismissing after an "added" verdict reopens the picker rebuilt
            // from the refreshed pool, which is where the new row now lives.
            closeAdmissionDialog(dialogAdmission()?.verdict === "added");
            return;
        }

        // Ahead of the picker: the prompt is drawn over the pane that opened
        // it, so it takes the keys while it is up.
        if (providerForm !== undefined) {
            const transition = handleTuiProviderFormKey(providerForm, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applyProviderFormTransition(providerForm, transition);
                return;
            }
        }

        if (namePrompt !== undefined) {
            const transition = handleTuiNamePromptKey(
                namePrompt,
                key,
            );
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applySessionRenamePromptTransition(
                    namePrompt,
                    transition,
                );
                return;
            }
        }

        if (secretPrompt !== undefined) {
            const transition = handleTuiSecretPromptKey(secretPrompt, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applySecretPromptTransition(secretPrompt, transition);
                return;
            }
        }

        if (settingsPicker !== undefined) {
            const viewportRows = tuiPickerViewportRows(renderer, settingsPicker);
            const transition = settingsPicker.kind === "extension"
                ? handleTuiSettingsPickerKey(settingsPicker, key, viewportRows)
                : handleTuiSettingsPickerKey(settingsPicker, key, viewportRows);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applySettingsPickerTransition(transition);
                return;
            }
        }

        if (preferencesList !== undefined) {
            const transition = handleTuiPreferencesListKey(preferencesList, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                preferencesList = transition.state;
                if (transition.remove !== undefined) {
                    // The row's own kind picks the command. The two tiers live in
                    // different stores, so one command covering both would have
                    // to guess which store an ID belongs to.
                    sendCommand({
                        type: transition.remove.kind === "grant"
                            ? "remove_permission_grant"
                            : "remove_permission_preference",
                        requestId: randomUUID(),
                        id: transition.remove.id,
                    });
                }
                if (preferencesList === undefined) {
                    preferencesListView.surface.visible = false;
                    settingsPicker = preferencesListParent;
                    preferencesListParent = undefined;
                    if (settingsPicker === undefined) {
                        composer.focus();
                    } else {
                        settingsPickerView.update(settingsPicker);
                        settingsPickerView.box.focus();
                    }
                }
                renderState();
                return;
            }
        }

        if (workspaceSidebar !== undefined && workspaceSidebarFocused) {
            const open = workspaceSidebar;
            const transition = handleWorkspaceSidebarKey(
                open,
                key,
                new Date(),
                renderer.width,
            );
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                workspaceSidebar = transition.state ?? open;
                if (transition.action !== undefined) {
                    runWorkspaceSidebarAction(transition.action);
                } else {
                    renderState();
                    focusActiveSurface();
                }
                return;
            }
        }

        if (workTab !== undefined) {
            const open = workTab;
            const transition = handleWorkTabKey(open, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                workTab = transition.state;
                if (transition.action !== undefined) {
                    // Resolved against the state the key was pressed in. A
                    // transition that acts carries no state, so reading the
                    // row after the assignment would read the closed tab and
                    // find nothing to open.
                    runWorkTabAction(open, transition.action);
                } else {
                    renderState();
                    focusActiveSurface();
                }
                return;
            }
        }

        if (searchOverlay !== undefined) {
            const transition = handleSearchOverlayKey(searchOverlay, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                searchOverlay = transition.state;
                if (transition.action !== undefined) {
                    runSearchOverlayAction(transition.action);
                } else {
                    renderState();
                    focusActiveSurface();
                }
                return;
            }
        }

        if (commandPalette !== undefined) {
            const transition = handleTuiCommandPaletteKey(commandPalette, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                commandPalette = transition.state;
                if (transition.selection !== undefined) {
                    const selected = transition.selection;
                    commandPalette = undefined;
                    runPaletteAction(selected);
                    // The palette closed under the action, and every early
                    // return inside it would otherwise leave nothing focused.
                    // Re-reading the surface here means an action that opened a
                    // pane still lands on the pane.
                    focusActiveSurface();
                } else {
                    renderState();
                    focusActiveSurface();
                }
                return;
            }
        }

        if (help !== undefined) {
            const transition = handleTuiHelpKey(help, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                help = transition.state;
                renderState();
                focusActiveSurface();
                return;
            }
        }

        if (doctorDialog !== undefined) {
            const action = handleTuiDiagnosticsDialogKey(key);
            if (action !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                if (action === "dismiss") {
                    doctorInspectionGeneration += 1;
                    doctorDialog = undefined;
                    focusActiveSurface();
                    renderState();
                    return;
                }
                if (doctorDialog.copyReady === false) {
                    return;
                }
                const text = doctorDialog.text;
                void copyText(text).then(() => {
                    if (doctorDialog?.text !== text) return;
                    doctorDialog = { text, copyStatus: "copied" };
                    renderState();
                }).catch(() => {
                    if (doctorDialog?.text !== text) return;
                    doctorDialog = { text, copyStatus: "failed" };
                    renderState();
                });
                return;
            }
        }

        if (extensionsDialog !== undefined) {
            const action = handleTuiDiagnosticsDialogKey(key);
            if (action !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                if (action === "dismiss") {
                    extensionsDialog = undefined;
                    focusActiveSurface();
                    renderState();
                    return;
                }
                if (extensionsDialog.copyReady === false) return;
                const text = extensionsDialog.text;
                void copyText(text).then(() => {
                    if (extensionsDialog?.text !== text) return;
                    extensionsDialog = { ...extensionsDialog, copyStatus: "copied" };
                    renderState();
                }).catch(() => {
                    if (extensionsDialog?.text !== text) return;
                    extensionsDialog = { ...extensionsDialog, copyStatus: "failed" };
                    renderState();
                });
                return;
            }
        }

        if (diagnosticsDialog !== undefined) {
            const action = handleTuiDiagnosticsDialogKey(key, true);
            if (action !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                if (action === "dismiss") {
                    diagnosticsGeneration += 1;
                    diagnosticsDialog = undefined;
                    diagnosticsSessionPath = undefined;
                    diagnosticsSessionPathResolved = false;
                    focusActiveSurface();
                    renderState();
                    return;
                }
                if (action === "switch_scope") {
                    diagnosticsScope = diagnosticsScope === "session"
                        ? "vera"
                        : "session";
                    diagnosticsDialog = {
                        text: renderTuiDiagnostics({
                            ...diagnosticsSnapshot(),
                            sessionPath: diagnosticsSessionPath,
                        }),
                        scope: diagnosticsScope,
                        copyReady: diagnosticsScope === "vera"
                            || diagnosticsSessionPathResolved,
                    };
                    renderState();
                    return;
                }
                if (diagnosticsDialog.copyReady === false) {
                    return;
                }
                const text = diagnosticsDialog.text;
                void copyText(text).then(() => {
                    if (diagnosticsDialog?.text !== text) return;
                    diagnosticsDialog = {
                        ...diagnosticsDialog,
                        copyStatus: "copied",
                    };
                    renderState();
                }).catch(() => {
                    if (diagnosticsDialog?.text !== text) return;
                    diagnosticsDialog = {
                        ...diagnosticsDialog,
                        copyStatus: "failed",
                    };
                    renderState();
                });
                return;
            }
        }

        if (
            argumentSuggestions.length > 0
            && commandSuggestionsBox.visible
            && !key.ctrl
            && !key.meta
            && !key.super
            && !key.hyper
            && !key.shift
        ) {
            if (key.name === "up" || key.name === "down") {
                key.preventDefault();
                key.stopPropagation();
                commandSuggestionIndex = key.name === "up"
                    ? Math.max(0, commandSuggestionIndex - 1)
                    : Math.min(
                        argumentSuggestions.length - 1,
                        commandSuggestionIndex + 1,
                    );
                renderCommandSuggestions();
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                const typed = activeCompletion()?.prefix;
                const selected = argumentSuggestions[commandSuggestionIndex];
                // Already typed whole: there is nothing left to choose, so
                // Enter sends the command instead of re-inserting the name.
                if (
                    selected !== undefined
                    && selected.toLowerCase() !== typed?.toLowerCase()
                ) {
                    key.preventDefault();
                    key.stopPropagation();
                    // Chosen, not sent: the rest of the command is still
                    // being typed.
                    composer.setComposerText(
                        tuiWithArgument(composer.plainText, selected),
                    );
                    renderCommandSuggestions();
                    return;
                }
            }
        }

        if (
            composer.plainText === "/"
            && commandSuggestionsBox.visible
            && !key.ctrl
            && !key.meta
            && !key.super
            && !key.hyper
            && !key.shift
        ) {
            const suggestions = commandRegistry.suggestions("/");
            if (key.name === "up" || key.name === "k") {
                key.preventDefault();
                key.stopPropagation();
                commandSuggestionIndex = Math.max(0, commandSuggestionIndex - 1);
                commandSuggestionMoved = true;
                renderCommandSuggestions();
                return;
            }
            if (key.name === "down" || key.name === "j") {
                key.preventDefault();
                key.stopPropagation();
                commandSuggestionIndex = Math.min(
                    suggestions.length - 1,
                    commandSuggestionIndex + 1,
                );
                commandSuggestionMoved = true;
                renderCommandSuggestions();
                return;
            }
            const runs = key.name === "return" || key.name === "enter";
            const completes =
                tuiBindingId("composer", key) === "complete_command";
            if (runs || (completes && commandSuggestionMoved)) {
                const selected = suggestions[commandSuggestionIndex];
                if (selected !== undefined) {
                    key.preventDefault();
                    key.stopPropagation();
                    composer.setComposerText(`/${selected.name}`);
                    // Completing picks the command and leaves it there, since
                    // one that takes an argument is not finished being typed.
                    if (runs) submitPrompt();
                    return;
                }
            }
        }

        const composeSuggester = activeComposeSuggester();
        if (
            (key.name === "return" || key.name === "enter")
            && !key.ctrl
            && !key.shift
            && !key.meta
            && composeSuggester !== undefined
        ) {
            key.preventDefault();
            key.stopPropagation();
            dismissedComposeSuggesters.add(
                composeSuggesterDismissalKey(composeSuggester),
            );
            wearAgent(composeSuggester.agent);
            renderCommandSuggestions();
            renderState();
            composer.focus();
            return;
        }

        // Ahead of clearing the composer, because putting away an offer you
        // did not ask for should not also throw away what you were writing.
        if (
            key.name === "escape"
            && !key.ctrl
            && !key.shift
            && !key.meta
            && activeComposeSuggester() !== undefined
        ) {
            key.preventDefault();
            key.stopPropagation();
            const suggester = activeComposeSuggester();
            if (suggester !== undefined) {
                dismissedComposeSuggesters.add(
                    composeSuggesterDismissalKey(suggester),
                );
            }
            renderCommandSuggestions();
            renderState();
            composer.focus();
            return;
        }

        // Ahead of clearing the composer, so dropping a quote does not also
        // throw away the message being written to send it with.
        if (
            key.name === "escape"
            && !key.ctrl
            && !key.shift
            && !key.meta
            && pendingQuote !== undefined
        ) {
            key.preventDefault();
            key.stopPropagation();
            pendingQuote = undefined;
            renderState();
            composer.focus();
            return;
        }

        if (
            key.name === "escape"
            && !key.ctrl
            && !key.shift
            && !key.meta
            && composer.plainText.length > 0
        ) {
            key.preventDefault();
            key.stopPropagation();
            composer.clearComposer();
            renderCommandSuggestions();
            renderState();
            composer.focus();
            return;
        }

        // Two plain escapes while idle open the timeline picker, the same
        // gesture /rewind is. The clear branch above already took any escape
        // with text, and a working agent's escape belongs to the stop handling
        // at the end, so both keys here see an idle, empty composer. The first
        // press only arms the window; the second one acts. Both are claimed
        // even when they do not act, so the focused surface never receives a
        // stray escape that could blur it and swallow the next keystroke.
        if (
            key.name === "escape"
            && !key.ctrl
            && !key.shift
            && !key.meta
            && !anyOverlayOpen()
            && !sessionSwitchPending
            && !focusedAgentState().working
            && focusedAgentState().queuedPrompts.length === 0
        ) {
            key.preventDefault();
            key.stopPropagation();
            const now = performance.now();
            const doubled = previousIdleEscapeAt !== undefined
                && now - previousIdleEscapeAt <= DOUBLE_ESCAPE_REWIND_WINDOW_MS;
            lastIdleEscapeAt = now;
            if (!doubled) return;
            lastIdleEscapeAt = undefined;
            if (sidebar.isFocused() && hostedSidebar.pane !== undefined) {
                // Rewind manages the main conversation only, matching /rewind.
                showStatusNotice(
                    "Switch to Vera with Ctrl+G to manage its conversation",
                );
                return;
            }
            applyTimelineTransition(startTuiTimelinePicker(randomUUID()));
            return;
        }

        if (tuiBindingId("composer", key) === "complete_command") {
            const completing = activeCompletion();
            if (completing !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                // A highlighted row is a choice already made with the arrow
                // keys, so Tab takes it rather than typing the shared prefix
                // of rows the user has already moved past.
                const highlighted = argumentSuggestions[commandSuggestionIndex];
                if (
                    highlighted !== undefined
                    && highlighted.toLowerCase()
                        !== completing.prefix.toLowerCase()
                ) {
                    composer.setComposerText(
                        tuiWithArgument(composer.plainText, highlighted),
                    );
                    renderCommandSuggestions();
                    return;
                }
                const completed = tuiArgumentCompletion(
                    completing.values,
                    completing.prefix,
                );
                if (completed !== undefined) {
                    composer.setComposerText(
                        tuiWithArgument(composer.plainText, completed),
                    );
                    renderCommandSuggestions();
                }
                return;
            }
            const completion = commandRegistry.completion(composer.plainText);
            if (completion !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                composer.setComposerText(completion);
                renderCommandSuggestions();
                return;
            }
            if (commandRegistry.suggestions(composer.plainText).length > 0) {
                // A complete slash command has nothing left to complete. Do
                // not let the textarea's default Tab behavior move the
                // cursor or change focus.
                key.preventDefault();
                key.stopPropagation();
                return;
            }
        }

        // The toggle is one chord in both directions, so the close arm runs
        // before the open arm and before the overlay guard: the pane is not an
        // overlay, and the chord that opened it has to reach back through it.
        if (tuiBindingId("global", key) === "toggle_workspace_sidebar") {
            if (workspaceSidebar !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                if (workspaceSidebarFocused) {
                    closeWorkspaceSidebar();
                } else {
                    workspaceSidebarFocused = true;
                    composer.blur();
                    renderState();
                    focusActiveSurface();
                }
                return;
            }
            if (!anyOverlayOpen()) {
                key.preventDefault();
                key.stopPropagation();
                openWorkspaceSidebar();
                return;
            }
        }

        if (
            tuiBindingId("global", key) === "toggle_thinking"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            const side = sidebar.isFocused() ? hostedSidebar.pane : undefined;
            const wasFollowing = side === undefined
                ? transcript.scrollTop
                    >= transcript.scrollHeight - transcript.viewport.height
                : sidebar.isFollowing();
            if (side === undefined) {
                state = toggleTuiThinking(state);
            } else {
                side.state.state = toggleTuiThinking(side.state.state);
                renderSidebarAgent(side);
            }
            renderState();
            // A reader who scrolled away from the live edge keeps that place.
            // Expanding a fold is inspection, not new transcript activity.
            if (wasFollowing) {
                if (side === undefined) {
                    transcript.scrollTo(transcript.scrollHeight);
                } else {
                    sidebar.scrollToBottom();
                }
            }
            return;
        }

        if (
            tuiBindingId("global", key) === "toggle_session_header"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            if (sidebar.isFocused() && hostedSidebar.pane !== undefined) {
                toggleSidebarHeader();
            } else {
                toggleMainHeader();
            }
            return;
        }

        if (
            tuiBindingId("global", key) === "dials.open"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            openDials();
            return;
        }

        if (
            tuiBindingId("global", key) === "open_model_picker"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            openModelPicker();
            return;
        }

        if (
            tuiBindingId("global", key) === "jump.open"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            openJumpMenuOverlay();
            return;
        }

        if (
            tuiBindingId("conversation", key) === "toggle_tool_details"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            // Read this before the fold changes the transcript height. Once
            // expanded, the old bottom can look like a manually scrolled view.
            const side = sidebar.isFocused() ? hostedSidebar.pane : undefined;
            const wasFollowing = side === undefined
                ? transcript.scrollTop
                    >= transcript.scrollHeight - transcript.viewport.height
                : sidebar.isFollowing();
            if (side === undefined) {
                state = toggleTuiToolDetails(state);
            } else {
                side.state.state = toggleTuiToolDetails(side.state.state);
                renderSidebarAgent(side);
            }
            renderState();
            if (wasFollowing) {
                if (side === undefined) {
                    transcript.scrollTo(transcript.scrollHeight);
                } else {
                    sidebar.scrollToBottom();
                }
            } else {
                const activeState = side?.state.state ?? state;
                const lastToolGroup = activeState.entries.findLastIndex((entry) =>
                    entry.kind === "tool_header"
                    && entry.detailLines !== undefined
                );
                if (side === undefined && lastToolGroup >= 0) {
                    transcript.scrollChildIntoView(`entry-${lastToolGroup}`);
                }
            }
            return;
        }

        const scrollBinding = anyOverlayOpen()
            ? undefined
            : tuiBindingId("conversation", key);
        const scrollLines = scrollBinding === "scroll_line_up"
            ? -1
            : scrollBinding === "scroll_line_down"
            ? 1
            : scrollBinding === "scroll_half_page_up"
            ? -Math.max(1, Math.floor(transcript.viewport.height / 2))
            : scrollBinding === "scroll_half_page_down"
            ? Math.max(1, Math.floor(transcript.viewport.height / 2))
            : undefined;
        if (scrollBinding === "jump_to_bottom" || scrollLines !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            if (scrollLines === undefined) {
                transcript.scrollTo(transcript.scrollHeight);
            } else {
                transcript.scrollBy(scrollLines);
            }
            renderJumpToBottom(scrollLines === undefined);
            return;
        }

        // Through the merged table rather than the registry's own chords, so a
        // chord the user moved in tui.json reaches the extension that owns the
        // id rather than the place the extension originally asked for.
        const extensionKey = tuiChord(key);
        const bound = extensionKey === undefined
            ? undefined
            : activeTuiKeymap().find((binding) =>
                binding.keys.includes(extensionKey)
            );
        // A row in the static table names the extension that owns it under a
        // different id than the row's own, so both are candidates.
        const boundId = bound?.extensionId ?? bound?.id;
        const extensionBinding = boundId === undefined
            ? undefined
            : clientExtensionRegistry?.keybindings().find((binding) =>
                binding.id === boundId
            );
        if (extensionBinding !== undefined && !anyOverlayOpen()) {
            key.preventDefault();
            key.stopPropagation();
            const target = focusedAgentClient();
            void extensionAgentTarget.run(target, () =>
                clientExtensionRegistry!.invokeKeybinding(
                    extensionBinding.id,
                    client.workspace ?? process.cwd(),
                )
            ).catch((error) => {
                state = appendTuiNotice(
                    state,
                    error instanceof Error ? error.message : String(error),
                );
                renderState();
            });
            return;
        }

        const action = tuiInterruptAction(
            key,
            focusedAgentState().working,
            focusedAbortRequested(),
            focusedAgentState().compactingSince !== undefined,
        );
        if (action === "pass") {
            return;
        }

        key.preventDefault();
        key.stopPropagation();

        if (action === "quit") {
            renderer.destroy();
            return;
        }
        if (action === "abort") {
            abortFocusedAgent();
            renderStatus();
        }
    }

    /**
     * Press a key the user did not press. `KeyEvent` carries the whole shape
     * `handleKeypress` reads, so a synthetic press is indistinguishable from a
     * real one once it is in there.
     */
    function pressKey(name: string, sequence = name): void {
        handleKeypress(new KeyEvent({
            name,
            sequence,
            raw: sequence,
            ctrl: false,
            meta: false,
            shift: false,
            option: false,
            number: /^[0-9]$/.test(sequence),
            eventType: "press",
            source: "raw",
        }));
    }

    /**
     * The pointer behaviour every overlay row gets, expressed once.
     *
     * `moveCursor` is the only thing a surface has to supply: how to put its
     * own highlight on row `index`. Hovering is that move; clicking is that
     * move followed by the key the row's highlight responds to, which is ⏎ for
     * a list and the row's own digit for the numbered dialogs.
     */
    function rowPointer(
        moveCursor: (index: number) => void,
        key: "return" | "digit" = "return",
    ): DialogRowPointer {
        if (key === "digit") {
            // No hover: these rows carry their own number and are not reached
            // by a moving highlight, so there is nothing for the pointer to
            // preview.
            return { activate: (index) => pressKey(String(index)) };
        }
        let hoverTimer: ReturnType<typeof setTimeout> | undefined;
        return {
            hover: (index) => {
                clearTimeout(hoverTimer);
                hoverTimer = setTimeout(() => {
                    hoverTimer = undefined;
                    if (shuttingDown) return;
                    moveCursor(index);
                    renderState();
                }, POINTER_HOVER_DELAY_MS);
            },
            activate: (index) => {
                clearTimeout(hoverTimer);
                hoverTimer = undefined;
                moveCursor(index);
                pressKey("return", "\r");
            },
        };
    }

    /**
     * Ask the attached session for the state the status line reports.
     *
     * Replayed history carries the transcript and context only, so an
     * attachment that does not ask stays blank about the model and, worse,
     * silent about full access until some later update happens to arrive.
     */
    function requestAgentSettings(target: TuiAgentClient): void {
        void target.send({
            type: "get_model_settings",
            requestId: randomUUID(),
        }).catch(reportConnectionError);
        void target.send({
            type: "get_permissions",
            requestId: randomUUID(),
        }).catch(reportConnectionError);
    }

    function requestSessionSettings(): void {
        requestAgentSettings(client);
    }

    void receiveAgentUpdates();
    if (client.failed !== true) {
        void loadExtensionCommands();
        requestSessionSettings();
    }
    void restorePersistedAgentPane();
    if (workspaceSidebarDocked) {
        openWorkspaceSidebar({ focus: false, persist: false });
    }

    async function restorePersistedAgentPane(): Promise<void> {
        const mainAgentId = client.agentId;
        if (dependencies.attachAgent === undefined) return;
        try {
            await hostedPanePersistence.restore(mainAgentId, {
                attach: async (agentId) =>
                    requireIdentifiedClient(
                        await dependencies.attachAgent!(agentId),
                    ),
                isCurrent: () =>
                    !shuttingDown && client.agentId === mainAgentId,
                adopt: (saved, next) =>
                    openExtensionAgent(
                        saved.owner,
                        next,
                        "sidebar",
                        false,
                        saved.mention,
                        "durable",
                        undefined,
                        saved.statusLabel,
                    ),
            });
        } catch (error) {
            if (shuttingDown || client.agentId !== mainAgentId) return;
            state = appendTuiError(
                state,
                `Could not restore paired pane: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState();
        }
    }

    /**
     * `interceptedText` carries the text an extension asked to send instead of
     * what the user typed. Its presence is also what stops a second trip
     * through the interceptors.
     */
    function diagnosticsSnapshot(): TuiDiagnosticsSnapshot {
        return {
            state,
            activity,
            elapsed: elapsedWorkingTime(),
            scope: diagnosticsScope,
            sessionId: client.agentId,
            workspace: client.workspace ?? process.cwd(),
            runningBackgroundAgents,
            processes: [
                { role: "client" as const, pid: process.pid },
                ...(dependencies.build?.hostPid === undefined
                    ? []
                    : [{ role: "host" as const, pid: dependencies.build.hostPid }]),
                ...(diagnosticsWorkerPid === undefined
                    ? []
                    : [{ role: "worker" as const, pid: diagnosticsWorkerPid }]),
                ...(diagnosticsSupervisorPid === undefined
                    ? []
                    : [{ role: "supervisor" as const, pid: diagnosticsSupervisorPid }]),
            ].map((entry) => ({
                ...entry,
                ...(diagnosticsProcessMemory.get(entry.pid) === undefined
                    ? {}
                    : { rssBytes: diagnosticsProcessMemory.get(entry.pid) }),
            })),
            stash: summarizeStash(),
            stashRoot: defaultStashRoot(),
            modelFailures: summariseModelFailures(readModelFailures()),
            modelFailureLedgerPath: defaultModelFailureLedgerPath(),
            build: dependencies.build,
            extensions: configuredClientExtensions,
            clientExtensionReload,
            startup: readLatestHostStartupTiming(),
        };
    }

    /**
     * A model failing the same way again is worth one line saying so, because
     * the per-turn error alone reads as Vera breaking rather than as a pattern
     * with somewhere to look.
     */
    function noticeRepeatedModelFailure(current: TuiState): TuiState {
        const nudge = modelFailureNudge(
            readModelFailures(),
            raisedModelFailureSignatures,
        );        if (nudge === undefined) return current;
        raisedModelFailureSignatures.add(nudge.signature);
        return appendTuiNotice(current, nudge.text, "soft");
    }

    /**
     * Writes what the ledger holds to a file someone can read and send on.
     * A model summarises it when a working one is running, but the file is
     * written either way: the summary is a convenience, the record is the
     * point, and the model most likely to be asked is the one that failed.
     */
    async function writeFailureReportFile(): Promise<void> {
        const records = readModelFailures();
        if (records.length === 0) {
            state = appendTuiNotice(
                state,
                "No model failures have been recorded.",
                "soft",
            );
            renderState();
            return;
        }
        const settings = state.modelSettings;
        const failing = settings !== undefined
            && records.some((record) =>
                record.model === settings.model
                && (settings.provider === undefined
                    || record.provider === settings.provider)
            );
        let summary: string | undefined;
        let note: string | undefined;
        if (settings === undefined) {
            note = "No model is running, so the report has no summary.";
        } else if (failing) {
            note = `Summary skipped: ${settings.model} is the model that is`
                + ` failing. Switch with /model, then run /failure-report`
                + ` again.`;
        } else {
            try {
                const result = await requestExtensionConsult({
                    model: settings.model,
                    ...(settings.provider === undefined
                        ? {}
                        : { provider: settings.provider }),
                    systemPrompt: FAILURE_REPORT_PROMPT,
                    messages: [{
                        role: "user",
                        content: failureReportConsultInput(records),
                    }],
                    maxTokens: FAILURE_REPORT_SUMMARY_TOKENS,
                }, new AbortController().signal);
                summary = result.text;
            } catch (error) {
                note = `No summary: ${
                    error instanceof Error ? error.message : String(error)
                }`;
            }
        }
        const at = new Date();
        try {
            const path = writeFailureReport(
                defaultFailureReportDirectory(),
                failureReportMarkdown({
                    records,
                    at,
                    ...(summary === undefined ? {} : { summary }),
                }),
                at,
            );
            state = appendTuiNotice(
                state,
                note === undefined
                    ? `Failure report written to ${path}`
                    : `Failure report written to ${path}. ${note}`,
                "soft",
            );
        } catch (error) {
            state = appendTuiError(
                state,
                `Could not write the failure report: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        renderState();
    }

    function submitPrompt(
        interceptedText?: string,
        injectedPrefix?: number,
    ): void {
        // Reached from awaited continuations that can resolve after the
        // renderer is destroyed, when the composer's EditBuffer is gone.
        if (shuttingDown) return;
        flightRecorder?.record({
            type: "submit_requested",
            characters: Array.from(
                interceptedText ?? composer.expandedText(),
            ).length,
            surface: activeFlightSurface(),
            blocked: promptSubmitting
                || sessionSwitchPending
                || pendingSessionRename
                || pendingSidebarSessionRename
                || extensionCommandPending
                || sidebarPromptSubmitting
                || messageInterceptPending,
        });
        if (
            promptSubmitting
            || sessionSwitchPending
            || pendingSessionRename
            || pendingSidebarSessionRename
            || extensionCommandPending
            || sidebarPromptSubmitting
            || messageInterceptPending
        ) {
            return;
        }
        const typed = interceptedText ?? composer.expandedText().trim();
        // A slash command is addressed to the client, so a quote waiting to be
        // sent stays waiting rather than being folded into an argument.
        const quoted = interceptedText === undefined && !typed.startsWith("/")
            ? pendingQuote
            : undefined;
        const prompt = withQuote(typed, quoted);
        if (prompt.length === 0 && pendingImages.length === 0) {
            return;
        }
        // Typing is the signal the tip has been read or ignored. The next one
        // is picked in the gap after this turn, not now.
        composerTip = undefined;
        if (quoted !== undefined) {
            pendingQuote = undefined;
        }
        // Slash commands belong to the client's own registry, so they never
        // reach an interceptor. Everything else is offered once.
        if (
            interceptedText === undefined
            && prompt.length > 0
            && !prompt.startsWith("/")
            && clientExtensionRegistry?.hasMessageInterceptors() === true
        ) {
            offerMessageToExtensions(prompt);
            return;
        }
        if (
            !prompt.startsWith("/")
            && hostedSidebar.pane !== undefined
            && routeVisibleAgentPrompt(prompt)
        ) {
            return;
        }

        const commandAction = prompt.length === 0
            ? undefined
            : commandRegistry.dispatch(prompt);
        if (
            commandAction === undefined
            && extensionCommandsLoading
            && prompt.startsWith("/")
        ) {
            state = appendTuiNotice(
                state,
                "Extension commands are still loading",
            );
            renderState();
            return;
        }
        if (
            commandAction !== undefined
            && sidebar.isFocused()
            && hostedSidebar.pane !== undefined
            && tuiCommandScope(commandAction) === "main_session"
        ) {
            composer.clearComposer();
            showStatusNotice(
                "Switch to Vera with Ctrl+G to manage its conversation",
            );
            renderState();
            return;
        }
        if (commandAction?.type === "command_error") {
            state = appendTuiNotice(state, commandAction.message);
            renderState();
            return;
        }
        if (commandAction?.type === "show_extensions") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            try {
                extensionsDialog = {
                    text: renderExtensionList(listExtensions({
                        projectRoot: process.cwd(),
                        ...(commandAction.scope === undefined
                            ? {}
                            : { scope: commandAction.scope }),
                    })),
                    copyReady: true,
                };
            } catch (error) {
                extensionsDialog = {
                    text: `Extensions\n\nCould not read extension state: ${
                        error instanceof Error ? error.message : String(error)
                    }\n`,
                    copyReady: true,
                };
            }
            renderState();
            focusActiveSurface();
            return;
        }
        if (commandAction?.type === "manage_extensions") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            const command = commandAction.command;
            if (command.operation === "reload") {
                state = appendTuiNotice(
                    state,
                    "Client extensions reload now; restart the resident host for host-side capabilities.",
                );
                renderState();
                submitPrompt("/reload-extensions");
                return;
            }
            try {
                const target = extensionTarget(command, process.cwd());
                let text: string;
                if (command.operation === "install") {
                    const result = installExtension(command.source, target, {
                        dryRun: command.dryRun,
                    });
                    text = renderExtensionInstallPreview(result.preview)
                        + (result.record === undefined
                            ? ""
                            : `\nInstalled ${result.record.id} in the ${result.preview.scope} scope.\n`);
                } else if (command.operation === "enable" || command.operation === "disable") {
                    const record = setExtensionEnabled(
                        command.id,
                        command.operation === "enable",
                        target,
                    );
                    text = renderExtensionMutation(
                        command.operation,
                        record,
                        command.scope,
                    );
                } else {
                    const record = removeExtension(command.id, target);
                    text = renderExtensionMutation("remove", record, command.scope);
                }
                if (command.operation !== "install" || !command.dryRun) {
                    text += "\nClient extensions reload now; restart the resident host for host-side capabilities.\n";
                }
                extensionsDialog = { text, copyReady: true };
                renderState();
                focusActiveSurface();
                if (command.operation !== "install" || !command.dryRun) {
                    submitPrompt("/reload-extensions");
                }
            } catch (error) {
                state = appendTuiError(
                    state,
                    `Extension operation failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                renderState();
            }
            return;
        }
        if (commandAction?.type === "reload_client_extensions") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            if (clientExtensionReloadPending) {
                state = appendTuiNotice(
                    state,
                    "Client extensions are already reloading",
                );
                renderState();
                return;
            }
            clientExtensionReloadPending = true;
            clientExtensionReload = clientExtensionReloadStarted();
            if (diagnosticsDialog !== undefined) {
                diagnosticsDialog = {
                    ...diagnosticsDialog,
                    text: renderTuiDiagnostics({
                        ...diagnosticsSnapshot(),
                        sessionPath: diagnosticsSessionPath,
                    }),
                };
            }
            void reloadTuiClientExtensions({
                configuration: {
                    disabledBuiltinExtensions,
                    clientExtensions: configuredClientExtensions,
                },
                refreshConfiguration:
                    dependencies.loadClientExtensionConfiguration,
                applyConfiguration(configuration) {
                    disabledBuiltinExtensions =
                        configuration.disabledBuiltinExtensions;
                    configuredClientExtensions = configuration.clientExtensions;
                },
                host: clientExtensionHost,
                start(signal, extensions, failures) {
                    return startConfiguredClientExtensionHost(
                        signal,
                        extensions,
                        failures,
                    );
                },
            }).then((loadedExtensionIds) => {
                if (shuttingDown) return;
                clientExtensionReload =
                    clientExtensionReloadSucceeded(loadedExtensionIds);
                if (diagnosticsDialog !== undefined) {
                    diagnosticsDialog = {
                        ...diagnosticsDialog,
                        text: renderTuiDiagnostics({
                            ...diagnosticsSnapshot(),
                            sessionPath: diagnosticsSessionPath,
                        }),
                    };
                }
                state = appendTuiNotice(state, "Client extensions reloaded");
                renderState();
                focusActiveSurface();
            }).catch((error) => {
                if (shuttingDown) return;
                const outcome = clientExtensionReloadFailed(
                    error,
                    clientExtensionHost.current()?.loadedExtensionIds() ?? [],
                );
                clientExtensionReload = outcome.snapshot;
                if (diagnosticsDialog !== undefined) {
                    diagnosticsDialog = {
                        ...diagnosticsDialog,
                        text: renderTuiDiagnostics({
                            ...diagnosticsSnapshot(),
                            sessionPath: diagnosticsSessionPath,
                        }),
                    };
                }
                state = appendTuiNotice(
                    state,
                    outcome.notice,
                );
                renderState();
                focusActiveSurface();
            }).finally(() => {
                clientExtensionReloadPending = false;
            });
            return;
        }
        if (commandAction?.type === "show_diagnostics") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            diagnosticsScope = "session";
            diagnosticsSessionPath = undefined;
            diagnosticsWorkerPid = undefined;
            diagnosticsSupervisorPid = undefined;
            diagnosticsProcessMemory = new Map();
            const generation = ++diagnosticsGeneration;
            const agentId = client.agentId;
            const resolvingSessionPath = agentId !== undefined
                && dependencies.listAgents !== undefined;
            diagnosticsSessionPathResolved = !resolvingSessionPath;
            diagnosticsDialog = {
                text: renderTuiDiagnostics({
                    ...diagnosticsSnapshot(),
                }),
                scope: diagnosticsScope,
                copyReady: diagnosticsSessionPathResolved,
            };
            renderState();
            focusActiveSurface();
            if (agentId !== undefined && dependencies.listAgents !== undefined) {
                void dependencies.listAgents().then(async (agents) => {
                    const listed = agents.find((agent) => agent.id === agentId);
                    const sessionPath = listed?.session_path;
                    if (
                        diagnosticsDialog === undefined
                        || diagnosticsGeneration !== generation
                        || client.agentId !== agentId
                    ) return;
                    diagnosticsSessionPathResolved = true;
                    diagnosticsWorkerPid = listed?.worker_pid;
                    diagnosticsSupervisorPid = listed?.supervisor_pid;
                    const processPids = [
                        process.pid,
                        dependencies.build?.hostPid,
                        diagnosticsWorkerPid,
                        diagnosticsSupervisorPid,
                    ].filter((pid): pid is number => pid !== undefined);
                    diagnosticsProcessMemory = await readProcessMemory(processPids);
                    if (
                        diagnosticsDialog === undefined
                        || diagnosticsGeneration !== generation
                        || client.agentId !== agentId
                    ) return;
                    if (sessionPath === undefined) {
                        diagnosticsDialog = {
                            text: renderTuiDiagnostics(diagnosticsSnapshot()),
                            scope: diagnosticsScope,
                            copyReady: true,
                        };
                        renderState();
                        return;
                    }
                    diagnosticsSessionPath = sessionPath;
                    diagnosticsDialog = {
                        text: renderTuiDiagnostics({
                            ...diagnosticsSnapshot(),
                            sessionPath,
                        }),
                        scope: diagnosticsScope,
                        copyReady: true,
                    };
                    renderState();
                }).catch(() => {
                    if (
                        diagnosticsDialog === undefined
                        || diagnosticsGeneration !== generation
                        || client.agentId !== agentId
                    ) return;
                    diagnosticsSessionPathResolved = true;
                    diagnosticsDialog = {
                        ...diagnosticsDialog,
                        copyReady: true,
                    };
                    renderState();
                });
            }
            return;
        }
        if (commandAction?.type === "show_doctor") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            doctorDialog = {
                text: "Vera doctor\n\nChecking process health…\n",
                copyReady: false,
            };
            renderState();
            focusActiveSurface();
            const inspectProcesses = dependencies.doctor
                ?? diagnoseVeraProcesses;
            const inspectionGeneration = ++doctorInspectionGeneration;
            void inspectProcesses().then((report) => {
                if (
                    shuttingDown
                    || doctorDialog === undefined
                    || doctorInspectionGeneration !== inspectionGeneration
                ) return;
                const strayCount = report.processes.filter(
                    (candidate) => candidate.stray,
                ).length;
                // The dialog has no way to ask for a confirmation and act on
                // it, so it points at the CLI, which does, rather than
                // reporting strays with no next step.
                const processText = strayCount > 0
                    ? `${renderVeraDoctor(report)}\nRun \`vera doctor\` in a terminal to stop ${
                        strayCount === 1 ? "it" : "them"
                    }.\n`
                    : renderVeraDoctor(report);
                doctorDialog = { text: processText, copyReady: false };
                renderState();
                focusActiveSurface();
                // Offline only. The dialog has no way to ask for a network
                // probe, so it never makes one: `vera doctor
                // --check-providers` owns that.
                void diagnoseProviders(loadOptionalVeraConfig(), {
                    authStorage,
                }).then(
                    (providers) => {
                        if (
                            shuttingDown
                            || doctorDialog === undefined
                            || doctorInspectionGeneration
                                !== inspectionGeneration
                        ) return;
                        doctorDialog = {
                            text: `${processText}\n${renderProviderDoctor(providers)}`,
                        };
                        renderState();
                        focusActiveSurface();
                    },
                ).catch(() => {
                    if (
                        shuttingDown
                        || doctorDialog === undefined
                        || doctorInspectionGeneration !== inspectionGeneration
                    ) return;
                    doctorDialog = { text: processText };
                    renderState();
                    focusActiveSurface();
                });
            }).catch((error) => {
                if (
                    shuttingDown
                    || doctorDialog === undefined
                    || doctorInspectionGeneration !== inspectionGeneration
                ) return;
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                doctorDialog = {
                    text: [
                        "Vera doctor",
                        "",
                        `Process inspection failed: ${message}`,
                        "",
                        "No processes were stopped.",
                        "",
                    ].join("\n"),
                };
                renderState();
                focusActiveSurface();
            });
            return;
        }
        if (commandAction?.type === "write_failure_report") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            void writeFailureReportFile();
            return;
        }
        if (commandAction?.type === "show_pool") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            state = appendTuiNotice(
                state,
                tuiPoolListing(state.modelSettings?.pooled),
            );
            renderState();
            return;
        }
        if (commandAction?.type === "show_defaults") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            openModelPicker();
            settingsPicker = switchedModelTab(
                settingsPicker as TuiSettingsPickerState,
                "defaults",
            );
            renderState();
            return;
        }
        if (commandAction?.type === "open_providers") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            openProviderPicker();
            return;
        }
        if (commandAction?.type === "pool_current_model") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            const provider = state.modelSettings?.provider;
            const model = state.modelSettings?.model;
            if (provider === undefined || model === undefined) {
                state = appendTuiError(
                    state,
                    "No model is running yet, so there is nothing to pin",
                );
                renderState();
                return;
            }
            // The same request the picker's pool key sends, so the write, the
            // refusal wording and the transcript notice are one path.
            requestPoolAdmission(provider, model);
            return;
        }
        if (commandAction?.type === "run_extension") {
            const directExtension = directClientExtensions.find(
                (extension) =>
                    commandAction.origin === "direct"
                    && extension.id === commandAction.source,
            );
            if (state.working && commandAction.origin === "host") {
                state = appendTuiNotice(
                    state,
                    "Extension commands are available when the agent is idle",
                );
                renderState();
                return;
            }
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            if (
                (commandAction.origin === "direct"
                    && directExtension === undefined)
                || (commandAction.origin === "client"
                    && clientExtensionRegistry === undefined)
                || (commandAction.origin === "host"
                    && client.runExtensionCommand === undefined)
            ) {
                composer.setComposerText(prompt);
                state = appendTuiError(
                    state,
                    `${commandAction.source}: command unavailable`,
                );
                renderState();
                return;
            }
            extensionCommandPending = true;
            extensionCommandActivity = `running /${commandAction.command}`;
            renderStatus();
            const extensionSubmittedImages = [...pendingImages];
            const extensionTarget = focusedAgentClient();
            const invocation = commandAction.origin === "host"
                ? client.runExtensionCommand!(
                    commandAction.command,
                    commandAction.argumentsText,
                )
                : commandAction.origin === "client"
                ? extensionAgentTarget.run(extensionTarget, () =>
                    clientExtensionRegistry!.invokeCommand(
                        commandAction.command,
                        commandAction.argumentsText,
                        client.workspace ?? process.cwd(),
                        undefined,
                        extensionSubmittedImages.length,
                        extensionSubmittedImages.flatMap((image) =>
                            image.path === undefined ? [] : [image.path]
                        ),
                    )
                )
                : invokeDirectClientExtensionCommand(
                    directExtension!,
                    commandAction.command,
                    commandAction.argumentsText,
                    { timeoutMs: DIRECT_EXTENSION_COMMAND_TIMEOUT_MS },
                );
            void invocation.then((result) => {
                if (
                    commandAction.origin === "client"
                    && extensionSubmittedImages.length > 0
                ) {
                    const submitted = new Set(
                        extensionSubmittedImages.map((image) => image.requestId),
                    );
                    pendingImages = pendingImages.filter(
                        (image) => !submitted.has(image.requestId),
                    );
                }
                if (shuttingDown || result === undefined) {
                    return;
                }
                if (result.body.kind === "client_action") {
                    if (result.body.action === "show_help") {
                        help = startTuiHelp(
                            coreHelpCommands(),
                            hostExtensionCommands,
                        );
                    }
                } else if (result.body.kind !== "handled") {
                    state = appendTuiNotice(
                        state,
                        extensionCommandResultText({
                            version: 1,
                            source: result.source,
                            body: result.body,
                        }),
                    );
                }
            }).catch((error) => {
                if (shuttingDown) {
                    return;
                }
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                state = appendTuiNotice(
                    state,
                    `${commandAction.source}/${commandAction.command}: ${message}`,
                );
                if (composer.plainText.length === 0) {
                    composer.setComposerText(prompt);
                    renderCommandSuggestions();
                }
            }).finally(() => {
                if (!shuttingDown) {
                    extensionCommandPending = false;
                    extensionCommandActivity = undefined;
                    renderState();
                    focusActiveSurface();
                }
            });
            return;
        }
        if (
            connectionFailed
            && commandAction?.type !== "open_resume_picker"
            && commandAction?.type !== "open_theme_picker"
            && commandAction?.type !== "create_session"
            && commandAction?.type !== "reconnect"
        ) {
            // Refusing without saying so reads as a frozen composer: the text
            // stays put and nothing else changes on screen.
            state = appendTuiError(
                state,
                "Disconnected from the host. Run /reconnect to restore this"
                    + " session, or ctrl+c to quit.",
            );
            renderState();
            return;
        }
        if (commandAction?.type === "update_model") {
            composer.clearComposer();
            // A typed model runs as typed. The pool is a shortlist, not a
            // gate, so nothing is added here; `provider/model` names a
            // provider, a bare name keeps the running one.
            const typed = commandAction.model.trim();
            // A pool name is that entry's identity, so it names the provider
            // too; anything else is read as the user typed it.
            const named = state.modelSettings?.pooled?.find(
                (entry) => entry.poolName === typed,
            );
            if (named !== undefined) {
                requestModelSettingsChange(
                    { provider: named.provider, model: named.model },
                    `model → ${typed}`,
                    `the model to ${typed}`,
                );
                renderState();
                return;
            }
            const separator = typed.indexOf("/");
            const provider = separator > 0 ? typed.slice(0, separator) : undefined;
            const model = separator > 0 ? typed.slice(separator + 1) : typed;
            if (model.length === 0) {
                state = appendTuiError(state, `"${typed}" is not a model name`);
                renderState();
                return;
            }
            requestModelSettingsChange(
                {
                    model,
                    ...(provider === undefined ? {} : { provider }),
                },
                `model → ${typed}`,
                `the model to ${typed}`,
            );
            renderState();
            return;
        }
        if (commandAction?.type === "open_model_picker") {
            composer.clearComposer();
            openModelPicker();
            return;
        }
        if (commandAction?.type === "update_reasoning") {
            composer.clearComposer();
            requestModelSettingsChange(
                { reasoningEffort: commandAction.reasoningEffort },
                `reasoning → ${commandAction.reasoningEffort}`,
                `reasoning to ${commandAction.reasoningEffort}`,
            );
            renderState();
            return;
        }
        if (commandAction?.type === "open_reasoning_picker") {
            composer.clearComposer();
            openReasoningPicker();
            return;
        }
        if (commandAction?.type === "update_permissions") {
            composer.clearComposer();
            if (commandAction.mode === "full_access") {
                confirmingFullAccess = true;
                confirmingFullAccessAgent = focusedAgentClient();
                focusActiveSurface();
            } else {
                requestPermissionsChange(
                    commandAction.mode,
                    focusedAgentClient(),
                    commandAction.scope ?? "global",
                );
            }
            renderState();
            return;
        }
        if (commandAction?.type === "open_preferences_list") {
            composer.clearComposer();
            openPreferencesList();
            return;
        }
        if (commandAction?.type === "open_permissions_picker") {
            composer.clearComposer();
            openPermissionsPicker();
            return;
        }
        if (commandAction?.type === "open_agent_picker") {
            composer.clearComposer();
            void openAgentPicker();
            return;
        }
        if (commandAction?.type === "wear_agent") {
            composer.clearComposer();
            wearAgent(commandAction.name);
            return;
        }
        if (commandAction?.type === "open_theme_picker") {
            composer.clearComposer();
            openThemePicker();
            return;
        }
        if (commandAction?.type === "open_settings_menu") {
            composer.clearComposer();
            openSettingsMenu();
            return;
        }
        if (commandAction?.type === "open_configure") {
            composer.clearComposer();
            renderCommandSuggestions();
            void openConfigureEditor();
            return;
        }
        if (commandAction?.type === "open_command_palette") {
            composer.clearComposer();
            openCommandPalette();
            return;
        }
        if (commandAction?.type === "open_help") {
            composer.clearComposer();
            openHelp(commandAction.tab);
            return;
        }
        if (commandAction?.type === "prefill_composer") {
            composer.setComposerText(commandAction.text);
            renderCommandSuggestions();
            renderState();
            composer.focus();
            return;
        }
        if (commandAction?.type === "open_work_tab") {
            composer.clearComposer();
            renderCommandSuggestions();
            openWorkTab();
            return;
        }
        if (commandAction?.type === "open_search") {
            composer.clearComposer();
            renderCommandSuggestions();
            openSearchOverlay();
            return;
        }
        if (commandAction?.type === "open_resume_picker") {
            composer.clearComposer();
            renderCommandSuggestions();
            if (dependencies.listAgents === undefined) {
                state = appendTuiError(state, "Session listing is unavailable");
                renderState();
                return;
            }
            const version = ++resumeListVersion;
            const targetAgentId = focusedAgentClient().agentId;
            settingsPicker = startTuiSessionPicker(
                [],
                targetAgentId,
                true,
            );
            focusActiveSurface();
            renderState();
            void dependencies.listAgents().then((agents) => {
                if (
                    shuttingDown
                    || version !== resumeListVersion
                    || settingsPicker?.kind !== "session"
                ) {
                    return;
                }
                settingsPicker = startTuiSessionPicker(
                    agents,
                    targetAgentId,
                    false,
                    new Date(),
                    false,
                    hostedPanePersistence.groups,
                );
                focusActiveSurface();
                renderState();
            }).catch((error) => {
                if (
                    !shuttingDown
                    && version === resumeListVersion
                    && settingsPicker?.kind === "session"
                ) {
                    const message = error instanceof Error
                        ? error.message
                        : String(error);
                    state = appendTuiError(
                        state,
                        `Could not list sessions: ${message}`,
                    );
                    settingsPicker = undefined;
                    focusActiveSurface();
                    renderState();
                }
            });
            return;
        }
        if (commandAction?.type === "open_subagents_picker") {
            composer.clearComposer();
            renderCommandSuggestions();
            if (dependencies.listAgents === undefined) {
                state = appendTuiError(state, "Session listing is unavailable");
                renderState();
                return;
            }
            const version = ++resumeListVersion;
            const targetAgentId = focusedAgentClient().agentId;
            settingsPicker = startTuiSessionPicker(
                [],
                targetAgentId,
                true,
            );
            focusActiveSurface();
            renderState();
            void dependencies.listAgents().then((agents) => {
                if (
                    shuttingDown
                    || version !== resumeListVersion
                    || settingsPicker?.kind !== "session"
                ) {
                    return;
                }
                const currentId = targetAgentId;
                // Children only: the row for the session already on screen
                // would cost a keypress to step past on the way to a child.
                const children = agents.filter(
                    (agent) => agent.parent_id === currentId,
                );
                if (children.length === 0) {
                    settingsPicker = undefined;
                    state = appendTuiNotice(
                        state,
                        "This conversation has no subagents",
                    );
                    focusActiveSurface();
                    renderState();
                    return;
                }
                settingsPicker = startTuiSessionPicker(
                    children,
                    currentId,
                    false,
                    new Date(),
                    true,
                );
                focusActiveSurface();
                renderState();
            }).catch((error) => {
                if (
                    !shuttingDown
                    && version === resumeListVersion
                    && settingsPicker?.kind === "session"
                ) {
                    const message = error instanceof Error
                        ? error.message
                        : String(error);
                    state = appendTuiError(
                        state,
                        `Could not list sessions: ${message}`,
                    );
                    settingsPicker = undefined;
                    focusActiveSurface();
                    renderState();
                }
            });
            return;
        }
        if (commandAction?.type === "go_back") {
            composer.clearComposer();
            renderCommandSuggestions();
            runBack();
            return;
        }
        if (commandAction?.type === "go_to_parent") {
            composer.clearComposer();
            renderCommandSuggestions();
            if (dependencies.listAgents === undefined) {
                state = appendTuiError(state, "Session listing is unavailable");
                renderState();
                return;
            }
            const targetAgentId = focusedAgentClient().agentId;
            void dependencies.listAgents().then((agents) => {
                if (shuttingDown) {
                    return;
                }
                const current = agents.find(
                    (agent) => agent.id === targetAgentId,
                );
                const parent = current?.parent_id === undefined
                    ? undefined
                    : agents.find((agent) => agent.id === current.parent_id);
                if (parent === undefined) {
                    state = appendTuiNotice(
                        state,
                        "This conversation has no parent",
                    );
                    renderState();
                    return;
                }
                beginSessionResume(parent.session_path, parent.id);
            }).catch((error) => {
                if (shuttingDown) return;
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                state = appendTuiError(
                    state,
                    `Could not find the parent conversation: ${message}`,
                );
                renderState();
            });
            return;
        }
        if (commandAction?.type === "reconnect") {
            composer.clearComposer();
            const currentAgentId = client.agentId;
            if (
                !connectionFailed
                || dependencies.reconnectSession === undefined
                || currentAgentId === undefined
            ) {
                state = appendTuiError(
                    state,
                    connectionFailed
                        ? "Reconnecting this session is unavailable"
                        : "The host connection is already active",
                );
                renderState();
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "restarting host…";
            renderState();
            void withSessionSwitchDeadline(
                dependencies.reconnectSession(currentAgentId),
                discardSwitchTarget,
            ).then((next) => {
                if (shuttingDown) {
                    discardSwitchTarget(next);
                    return;
                }
                switchToClient(next);
            }).catch((error) => {
                if (shuttingDown) return;
                sessionSwitchPending = false;
                state = appendTuiError(
                    state,
                    `Could not reconnect: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                renderState();
            });
            return;
        }
        if (commandAction?.type === "create_session") {
            composer.clearComposer();
            const clearingSidebar = sidebar.isFocused()
                && hostedSidebar.pane !== undefined;
            // A blank peer has nothing useful to reset. Treating a second
            // clear as close makes it possible to get rid of an empty pane
            // without requiring a separate close command.
            const clearingBlankSidebar = clearingSidebar
                && !sidebarEntryNodes.some((node) => node.visible);
            if (clearingBlankSidebar) {
                closeSidebarPane();
                return;
            }
            if (
                clearingSidebar
                    ? dependencies.createAgent === undefined
                    : dependencies.createSession === undefined
            ) {
                state = appendTuiError(
                    state,
                    "Starting a new session is unavailable",
                );
                renderState();
                return;
            }
            if (sessionSwitchPending) {
                return;
            }
            const workspace = focusedAgentClient().workspace;
            if (workspace === undefined) {
                state = appendTuiError(
                    state,
                    "Current session workspace is unavailable",
                );
                renderState();
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "starting new session…";
            sessionSwitchStartedAt = performance.now();
            sessionSwitchOperation = "clear";
            sessionSwitchBufferedUpdates = [];
            sessionSwitchClearingMain = !clearingSidebar;
            flightRecorder?.record({
                type: "session_switch_started",
                operation: "clear",
                target: clearingSidebar ? "sidebar" : "main",
            });
            const previousState = clearingSidebar ? undefined : state;
            if (!clearingSidebar) {
                state = createTuiState();
                clearTranscriptNodes();
                renderState();
            } else {
                renderStatus();
            }
            const nextSession = clearingSidebar
                ? dependencies.createAgent!(
                    workspace,
                    hostedSidebar.initialApprovalMode
                        ?? focusedAgentState().approvalMode,
                    hostedSidebar.attachmentLifetime,
                )
                : dependencies.createSession!(workspace);
            void withSessionSwitchDeadline(
                nextSession,
                discardSwitchTarget,
            ).then(async (next) => {
                if (shuttingDown) {
                    discardSwitchTarget(next);
                    return;
                }
                if (clearingSidebar) {
                    await openExtensionAgent(
                        hostedSidebar.owner ?? "vera.tui.agent-attachments",
                        requireIdentifiedClient(next),
                        "sidebar",
                        true,
                        hostedSidebar.mention,
                        hostedSidebar.attachmentLifetime,
                        hostedSidebar.initialApprovalMode,
                    );
                    recordSessionSwitchOutcome("completed");
                    sessionSwitchPending = false;
                    return;
                }
                switchToClient(next);
            }).catch((error) => {
                if (shuttingDown) {
                    return;
                }
                sessionSwitchPending = false;
                if (previousState !== undefined) {
                    state = previousState;
                    for (const update of sessionSwitchBufferedUpdates) {
                        state = applyAgentUpdate(state, update);
                    }
                    clearTranscriptNodes();
                }
                sessionSwitchBufferedUpdates = [];
                recordSessionSwitchOutcome("failed", error);
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                state = appendTuiError(
                    state,
                    `Could not start a new session: ${message}`,
                );
                renderState();
            });
            return;
        }
        if (commandAction?.type === "clone_session") {
            composer.clearComposer();
            if (dependencies.cloneSession === undefined) {
                state = appendTuiError(
                    state,
                    "Cloning this session is unavailable",
                );
                renderState();
                return;
            }
            const sourceAgentId = client.agentId;
            if (sourceAgentId === undefined) {
                state = appendTuiError(
                    state,
                    "Current session ID is unavailable",
                );
                renderState();
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "cloning session…";
            renderStatus();
            void withSessionSwitchDeadline(
                dependencies.cloneSession(sourceAgentId),
                discardSwitchTarget,
            ).then((next) => {
                if (shuttingDown) {
                    discardSwitchTarget(next);
                    return;
                }
                switchToClient(next);
            }).catch((error) => {
                if (shuttingDown) return;
                sessionSwitchPending = false;
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                state = appendTuiError(
                    state,
                    `Could not clone this session: ${message}`,
                );
                renderState();
            });
            return;
        }
        if (commandAction?.type === "compact_session") {
            composer.clearComposer();
            // No reply is awaited: the compaction updates the engine already
            // emits say what happened, and they are the same ones an automatic
            // compaction produces.
            void client.send({ type: "compact", requestId: randomUUID() })
                .catch((error) => {
                    composer.setComposerText(prompt);
                    reportConnectionError(error);
                });
            showStatusNotice("summarizing earlier messages…");
            return;
        }
        if (commandAction?.type === "update_session_name") {
            const requestId = randomUUID();
            composer.clearComposer();
            const target = focusedAgentClient();
            if (target !== client) {
                pendingSidebarSessionRename = { requestId, commandText: prompt };
                void target.send({
                    type: "update_session_name",
                    requestId,
                    name: commandAction.name,
                }).catch((error) => {
                    if (pendingSidebarSessionRename?.requestId !== requestId) {
                        return;
                    }
                    pendingSidebarSessionRename = undefined;
                    if (composer.expandedText().length === 0) {
                        composer.setComposerText(prompt);
                    }
                    reportConnectionError(error);
                });
                showStatusNotice(
                    commandAction.name === null
                        ? "clearing peer session name…"
                        : "renaming peer session…",
                );
                return;
            }
            pendingSessionRename = { requestId, commandText: prompt };
            void target.send({
                type: "update_session_name",
                requestId,
                name: commandAction.name,
            }).catch((error) => {
                if (pendingSessionRename?.requestId !== requestId) return;
                pendingSessionRename = undefined;
                if (composer.expandedText().length === 0) {
                    composer.setComposerText(prompt);
                }
                reportConnectionError(error);
            });
            showStatusNotice(
                commandAction.name === null
                    ? "clearing session name…"
                    : "renaming session…",
            );
            return;
        }
        if (commandAction?.type === "open_rewind") {
            if (
                state.working
                || state.queuedPrompts.length > 0
                || pendingUiRequest !== undefined
                || timelinePicker !== undefined
            ) {
                state = appendTuiNotice(
                    state,
                    "Rewind is available when the agent is idle.",
                );
                renderState();
                return;
            }
            composer.clearComposer();
            applyTimelineTransition(startTuiTimelinePicker(randomUUID()));
            return;
        }
        if (commandAction?.type === "open_fork") {
            if (
                state.working
                || state.queuedPrompts.length > 0
                || pendingUiRequest !== undefined
                || timelinePicker !== undefined
            ) {
                state = appendTuiNotice(
                    state,
                    "Fork is available when the agent is idle.",
                );
                renderState();
                return;
            }
            composer.clearComposer();
            applyTimelineTransition(startTuiTimelinePicker(
                randomUUID(),
                "fork",
            ));
            return;
        }

        if (pendingImages.some((image) => image.id === undefined)) {
            submitAfterImageAttachment = true;
            state = appendTuiNotice(state, "Wait for the image attachment to finish.");
            renderState();
            return;
        }
        // The chips carry the order the user sees, which reordering the text
        // can change; `pendingImages` only carries the order they arrived in.
        const chipOrder = composer.imageChipRequestIds();
        const attachments = chipOrder
            .flatMap((requestId) => {
                const image = pendingImages.find(
                    (candidate) => candidate.requestId === requestId,
                );
                return image?.id === undefined ? [] : [{
                    id: image.id,
                    ...(image.name === undefined ? {} : { name: image.name }),
                }];
            });
        const attachmentIds = attachments.map((attachment) => attachment.id);
        if (attachmentIds.length > 0) {
            const submittedRequestIds = new Set(
                pendingImages.map((image) => image.requestId),
            );
            // A prompt sent mid-turn is queued by the host, so the transcript
            // shows it queued rather than opening a turn of its own.
            const queueing = state.working;
            promptSubmitting = true;
            renderStatus();
            flightRecorder?.record({ type: "submit_dispatched" });
            void client.send({
                type: "prompt",
                content: prompt,
                attachmentIds,
            }).then(() => {
                flightRecorder?.record({ type: "submit_accepted" });
                promptSubmitting = false;
                if (shuttingDown) return;
                if (composer.expandedText().trim() === prompt) {
                    composer.rememberSubmittedText(prompt);
                    composer.clearComposer();
                }
                pendingImages = pendingImages.filter(
                    (image) => !submittedRequestIds.has(image.requestId),
                );
                if (queueing) {
                    state = queueTuiPrompt(state, prompt);
                } else {
                    if (
                        !userEntryShows(state.entries.at(-1), prompt, attachments)
                    ) {
                        state = beginTuiTurn(state, prompt, attachments);
                    } else if (!state.working) {
                        state = { ...state, working: true };
                    }
                    adoptFallbackSessionTitle(prompt);
                    workingSince ??= Date.now();
                    phaseSince = workingSince;
                    activity = "thinking";
                }
                renderState();
            }).catch((error) => {
                flightRecorder?.record({
                    type: "submit_failed",
                    error: error instanceof Error ? error.message : String(error),
                });
                promptSubmitting = false;
                reportConnectionError(error);
            });
            return;
        }
        composer.rememberSubmittedText(prompt);
        composer.clearComposer();
        state = state.working
            ? queueTuiPrompt(state, prompt)
            : beginTuiTurn(state, prompt, attachments, injectedPrefix);
        adoptFallbackSessionTitle(prompt, injectedPrefix);
        if (workingSince === undefined) {
            workingSince = Date.now();
            phaseSince = workingSince;
            activity = "thinking";
        }
        renderState();
        pendingImages = [];
        sendCommand({
            type: "prompt",
            content: prompt,
            ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
        });
    }

    function routeVisibleAgentPrompt(prompt: string): boolean {
        const side = hostedSidebar.pane;
        if (side === undefined || client.agentId === undefined) return false;
        const route = routeTuiAgentMessage(
            prompt,
            sidebar.isFocused() ? "sidebar" : "main",
            [
                { agentId: client.agentId, pane: "main" },
                {
                    agentId: side.agentId,
                    pane: "sidebar",
                    mention: hostedSidebar.mention ?? side.agentId,
                },
            ],
            hostedAgentAddressing(),
        );
        if (route.kind === "unknown") {
            state = appendTuiNotice(state, `No open agent named @${route.mention}`);
            renderState();
            return true;
        }
        if (route.kind === "focus") {
            setSidebarFocused(route.pane === "sidebar");
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            renderState();
            return true;
        }
        const sendsToSidebar = route.targets.some(
            (target) => target.pane === "sidebar",
        );
        const sendsToMain = route.targets.some((target) => target.pane === "main");
        if (sendsToSidebar) {
            const submittedImages = [...pendingImages];
            const imagePaths = pendingImages.flatMap((image) =>
                image.path === undefined ? [] : [image.path]
            );
            if (imagePaths.length !== pendingImages.length) {
                state = appendTuiNotice(
                    state,
                    "Every sidebar image needs a readable source path",
                );
                renderState();
                return true;
            }
            const controller = new AbortController();
            sidebarPromptSubmitting = true;
            void attachImagesToSidebar(side, imagePaths, controller.signal)
                .then(async (attachments) => {
                    if (shuttingDown) return;
                    await side.client.send({
                        type: "prompt",
                        content: route.text,
                        ...(attachments.length === 0
                            ? {}
                            : {
                                attachmentIds: attachments.map(
                                    (attachment) => attachment.id,
                                ),
                            }),
                    });
                    if (
                        !userEntryShows(
                            side.state.state.entries.at(-1),
                            route.text,
                            attachments,
                        )
                    ) {
                        side.state.state = side.state.state.working
                            ? queueTuiPrompt(side.state.state, route.text)
                            : beginTuiTurn(
                                side.state.state,
                                route.text,
                                attachments,
                            );
                    } else if (!side.state.state.working) {
                        side.state.state = {
                            ...side.state.state,
                            working: true,
                        };
                    }
                    side.state.workingSince ??= Date.now();
                    side.state.phaseSince ??= side.state.workingSince;
                    side.state.activity = "thinking";
                    if (sendsToMain) {
                        sidebarPromptSubmitting = false;
                        submitPrompt(route.text);
                        return;
                    }
                    // The send above can resolve after the renderer is
                    // destroyed; the composer's EditBuffer is gone with it.
                    if (shuttingDown) return;
                    if (composer.expandedText().trim() === prompt) {
                        composer.rememberSubmittedText(prompt);
                        composer.clearComposer();
                    }
                    const sent = new Set(
                        submittedImages.map((image) => image.requestId),
                    );
                    pendingImages = pendingImages.filter(
                        (image) => !sent.has(image.requestId),
                    );
                })
                .catch((error) => {
                    side.state.state = {
                        ...side.state.state,
                        working: false,
                    };
                    side.state.workingSince = undefined;
                    side.state.phaseSince = undefined;
                    state = appendTuiNotice(
                        state,
                        error instanceof Error ? error.message : String(error),
                    );
                    renderState();
                }).finally(() => {
                    sidebarPromptSubmitting = false;
                    renderState();
                });
            return true;
        }
        if (sendsToMain && route.text === prompt) return false;
        if (sendsToMain) {
            submitPrompt(route.text);
            return true;
        }
        composer.rememberSubmittedText(prompt);
        composer.clearComposer();
        pendingImages = [];
        renderCommandSuggestions();
        renderState();
        return true;
    }

    async function attachImagesToSidebar(
        side: TuiAgentPane<IdentifiedTuiAgentClient>,
        imagePaths: readonly string[],
        signal: AbortSignal,
    ): Promise<readonly AttachmentRef[]> {
        return Promise.all(imagePaths.map((path) =>
            side.attachImage(randomUUID(), path, signal)
        ));
    }

    /**
     * A handled message still enters submit history and clears the composer:
     * the user submitted it, and an extension acting on it is not a reason to
     * lose the text or leave it sitting in the box.
     */
    function offerMessageToExtensions(prompt: string): void {
        messageInterceptPending = true;
        renderStatus();
        void clientExtensionRegistry!.interceptMessage({
            text: prompt,
            workspace: client.workspace ?? process.cwd(),
            imageCount: pendingImages.length,
        }).then((decision) => {
            messageInterceptPending = false;
            if (shuttingDown) return;
            if (decision.kind === "handled") {
                if (composer.expandedText().trim() === prompt) {
                    composer.rememberSubmittedText(prompt);
                    composer.clearComposer();
                }
                renderState();
                return;
            }
            submitPrompt(
                decision.kind === "replace" ? decision.text : prompt,
                decision.kind === "replace" ? decision.injectedPrefix : undefined,
            );
        }).catch((error) => {
            messageInterceptPending = false;
            if (shuttingDown) return;
            state = appendTuiNotice(
                state,
                error instanceof Error ? error.message : String(error),
            );
            renderState();
        });
    }

    /**
     * The host stores an attachment out of band, so a paste does not wait for
     * the turn to end. The image sits on the composer as a chip and rides
     * whichever prompt the user sends next.
     */
    function attachPastedImage(path: string): void {
        const requestId = randomUUID();
        pendingImages.push({ requestId, path });
        composer.attachImageChip(requestId);
        renderState();
        void materializeDroppedImage(path).then(({ path: taken, release }) => {
            if (!pendingImages.some((image) => image.requestId === requestId)) {
                void release();
                return;
            }
            droppedImageReleases.set(requestId, release);
            sendCommand({ type: "attach_image", requestId, path: taken });
        });
    }

    function releaseDroppedImage(requestId: string): void {
        const release = droppedImageReleases.get(requestId);
        if (release === undefined) return;
        droppedImageReleases.delete(requestId);
        void release();
    }

    async function receiveAgentUpdates(): Promise<void> {
        // The session this pump belongs to. A switch bumps the counter, and the
        // await below can still resolve afterwards with an update from the
        // session the user just left.
        const generation = clientGeneration;
        const source = client;
        try {
            while (!shuttingDown && generation === clientGeneration) {
                const update = await source.receive();
                if (shuttingDown || generation !== clientGeneration) {
                    return;
                }
                if (
                    sessionSwitchPending
                    && sessionSwitchOperation === "clear"
                    && sessionSwitchClearingMain
                ) {
                    sessionSwitchBufferedUpdates.push(update);
                    continue;
                }
                if (
                    update.type === "image_attached"
                    || update.type === "image_attachment_rejected"
                ) {
                    releaseDroppedImage(update.requestId);
                    const imageIndex = pendingImages.findIndex(
                        (image) => image.requestId === update.requestId,
                    );
                    if (imageIndex === -1) continue;
                    if (update.type === "image_attached") {
                        pendingImages[imageIndex] = {
                            ...pendingImages[imageIndex],
                            requestId: update.requestId,
                            id: update.attachment.id,
                            name: update.attachment.name,
                        };
                        showStatusNotice(
                            `attached ${update.attachment.name} · ${pendingImages.length} pending`,
                        );
                        if (
                            submitAfterImageAttachment
                            && pendingImages.every((image) => image.id !== undefined)
                        ) {
                            submitAfterImageAttachment = false;
                            queueMicrotask(submitPrompt);
                        }
                    } else {
                        submitAfterImageAttachment = false;
                        const [rejected] = pendingImages.splice(imageIndex, 1);
                        if (rejected !== undefined) {
                            composer.removeImageChip(rejected.requestId);
                        }
                        state = appendTuiError(
                            state,
                            `Could not attach image: ${update.error}`,
                        );
                        renderState();
                    }
                    composer.focus();
                    continue;
                }
                if (
                    update.type === "consult_result"
                    || update.type === "consult_rejected"
                ) {
                    const pending = pendingConsults.get(update.requestId);
                    if (pending === undefined) continue;
                    if (update.type === "consult_result") {
                        pending.resolve({
                            text: update.text,
                            model: update.model,
                            ...(update.provider === undefined
                                ? {}
                                : { provider: update.provider }),
                        });
                    } else {
                        pending.reject(new Error(update.reason));
                    }
                    continue;
                }
                if (
                    update.type === "session_name"
                    || update.type === "session_name_rejected"
                ) {
                    if (update.requestId !== pendingSessionRename?.requestId) {
                        continue;
                    }
                    const pending = pendingSessionRename;
                    pendingSessionRename = undefined;
                    if (update.type === "session_name") {
                        state = appendTuiNotice(
                            state,
                            update.name === null
                                ? "session name cleared"
                                : `session renamed: ${update.name}`,
                        );
                        if (update.name === null) {
                            sessionTitle = undefined;
                            refreshTerminalTitle();
                        } else {
                            sessionTitle = update.name;
                            applyTerminalTitle();
                        }
                    } else {
                        if (
                            pending.commandText !== undefined
                            && composer.expandedText().length === 0
                        ) {
                            composer.setComposerText(pending.commandText);
                        }
                        state = appendTuiError(
                            state,
                            update.reason === "invalid"
                                ? "Session name must be 1 to 200 UTF-8 bytes"
                                : "Could not rename this session",
                        );
                    }
                    if (
                        update.type === "session_name"
                        && settingsPicker?.kind === "session"
                    ) {
                        void refreshSessionPicker();
                    }
                    renderState();
                    if (!anyOverlayOpen()) {
                        composer.focus();
                    }
                    focusActiveSurface();
                    continue;
                }
                if (
                    update.type === "ui_request"
                    || update.type === "ui_request_closed"
                ) {
                    if (update.type === "ui_request") {
                        if (pendingUiRequest === undefined) {
                            followTranscriptAfterUiRequest = transcript.scrollTop
                                >= transcript.scrollHeight
                                    - transcript.viewport.height;
                        }
                        // Requests must reveal the pane that owns them. A
                        // hidden question otherwise disables composer UI while
                        // looking like neither agent needs an answer.
                        setSidebarFocused(false);
                        finishThoughtPhase();
                        phaseSince = undefined;
                        activity = update.request.type === "tool_approval"
                            ? "waiting for approval"
                            : "waiting for answer";
                    } else {
                        phaseSince = undefined;
                        activity = "resuming";
                    }
                    const previousRequest = pendingUiRequest;
                    pendingUiRequest = applyTuiUiRequestUpdate(
                        pendingUiRequest,
                        queuedUiRequests,
                        update,
                    );
                    if (
                        previousRequest === undefined
                        && pendingUiRequest !== undefined
                    ) {
                        closeTransientOverlaysForUiRequest();
                    }
                    if (pendingUiRequest !== previousRequest) {
                        renderState();
                        if (
                            update.type === "ui_request_closed"
                            && pendingUiRequest === undefined
                            && followTranscriptAfterUiRequest
                        ) {
                            transcript.scrollTo(transcript.scrollHeight);
                            followTranscriptAfterUiRequest = false;
                            renderJumpToBottom();
                        }
                        focusActiveSurface();
                    }
                    continue;
                }
                if (isTimelineReplyUpdate(update)) {
                    if (timelinePicker !== undefined) {
                        applyTimelineTransition(
                            applyTuiTimelineReply(
                                timelinePicker,
                                update,
                                randomUUID,
                            ),
                        );
                    }
                    continue;
                }
                if (
                    update.type === "model_settings"
                    || update.type === "model_settings_rejected"
                ) {
                    const poolChange = pendingPoolChanges.get(update.requestId);
                    pendingPoolChanges.delete(update.requestId);
                    if (
                        poolChange !== undefined
                        && update.type === "model_settings"
                    ) {
                        poolChangeUndo = poolChange;
                    }
                    const pendingUndo = pendingPoolUndos.get(update.requestId);
                    pendingPoolUndos.delete(update.requestId);
                    if (
                        pendingUndo?.completesOnSettings === true
                        && update.type === "model_settings"
                    ) {
                        poolChangeUndo = undefined;
                        showStatusNotice("shortlist change undone");
                    } else if (
                        pendingUndo !== undefined
                        && update.type === "model_settings_rejected"
                    ) {
                        poolChangeUndo = pendingUndo.undo;
                        if (settingsPicker?.kind === "model") {
                            settingsPicker = {
                                ...settingsPicker,
                                canUndoPoolChange: true,
                            };
                        }
                        state = appendTuiError(
                            state,
                            rejectionNotice("undo that shortlist change", update.reason),
                        );
                    }
                    settleExtensionModelSettings(update, client);
                    const change = requestedModelChanges.get(
                        update.requestId,
                    );
                    if (change?.target === client) {
                        requestedModelChanges.delete(update.requestId);
                    }
                    if (
                        change?.target === client
                        && update.type === "model_settings"
                        && update.updatedDefaults === true
                    ) {
                        state = appendTuiNotice(
                            state,
                            defaultModelChangeNotice(
                                change.patch,
                                update.settings,
                            ),
                            "soft",
                        );
                    } else if (
                        change?.target === client
                        && update.type === "model_settings_rejected"
                    ) {
                        state = appendTuiError(
                            state,
                            rejectionNotice(change.subject, update.reason),
                        );
                    }
                }
                observeActivity(update);
                if (
                    update.type === "pool_admission_result"
                    && retryPoolAdmission(update.requestId, update.verdict)
                ) {
                    renderState();
                    continue;
                }
                state = applyAgentUpdate(state, update);
                if (
                    update.type === "compaction"
                    && update.phase === "finished"
                    && update.outcome !== "busy"
                    // The turn that took this compaction down with it is still
                    // unwinding, and it is the one the user asked to stop.
                    // Clearing here drops the stop indicator while the thing
                    // being stopped is still running.
                    && update.stoppedWithTurn !== true
                ) {
                    abortRequested = false;
                }
                if (
                    update.type === "turn_finished"
                    && update.outcome === "error"
                ) {
                    state = noticeRepeatedModelFailure(state);
                }
                if (update.type === "agent_catalog") {
                    agentCatalog = {
                        worn: update.worn,
                        agents: update.agents,
                        notices: update.notices,
                    };
                    pendingAgentCatalogs.get(update.requestId)?.(agentCatalog);
                    pendingAgentCatalogs.delete(update.requestId);
                }
                if (update.type === "agent_worn" && agentCatalog !== undefined) {
                    agentCatalog = { ...agentCatalog, worn: update.name };
                }
                if (update.type === "model_settings") {
                }
                if (
                    update.type === "pool_admission_result"
                    && poolVerifySweepResult(update.requestId, update.verdict)
                ) {
                    renderState();
                    continue;
                }
                if (update.type === "pool_admission_result") {
                    const pendingUndo = pendingPoolUndos.get(update.requestId);
                    if (
                        pendingUndo !== undefined
                        && update.verdict === "added"
                        && pendingUndo.undo.poolName !== undefined
                    ) {
                        pendingPoolUndos.delete(update.requestId);
                        const nameRequestId = randomUUID();
                        pendingPoolUndos.set(nameRequestId, {
                            undo: pendingUndo.undo,
                            completesOnSettings: true,
                        });
                        sendCommand({
                            type: "pool_name",
                            requestId: nameRequestId,
                            provider: update.provider,
                            model: update.model,
                            name: pendingUndo.undo.poolName,
                        });
                    } else if (
                        pendingUndo !== undefined
                        && update.verdict !== "added"
                    ) {
                        pendingPoolUndos.delete(update.requestId);
                        poolChangeUndo = pendingUndo.undo;
                        if (settingsPicker?.kind === "model") {
                            settingsPicker = {
                                ...settingsPicker,
                                canUndoPoolChange: true,
                            };
                        }
                    }
                }
                if (
                    update.type === "pool_admission_result"
                    && pendingPoolName?.requestId === update.requestId
                ) {
                    const pending = pendingPoolName;
                    pendingPoolName = undefined;
                    if (update.verdict === "added" && namePrompt === undefined) {
                        namePrompt = startTuiNamePrompt(
                            {
                                kind: "pool",
                                provider: pending.provider,
                                model: pending.model,
                            },
                            pending.label,
                            settingsPicker?.kind === "model"
                                ? settingsPicker
                                : undefined,
                        );
                        focusActiveSurface();
                    }
                }
                if (
                    update.type === "model_settings"
                    && state.modelSettings !== undefined
                    && !sidebar.isFocused()
                ) {
                    notifyExtensionSettings(state.modelSettings);
                }
                if (
                    update.type === "model_settings"
                    && settingsPicker?.kind === "model"
                ) {
                    // The same route the permissions list takes below: the
                    // open pane is rebuilt from the snapshot the host sent,
                    // never from a local guess about what the edit did.
                    settingsPicker = syncTuiModelPicker(
                        settingsPicker,
                        state.modelSettings,
                    );
                    if (poolChangeUndo !== undefined) {
                        settingsPicker = {
                            ...settingsPicker,
                            canUndoPoolChange: true,
                        };
                    }
                }
                if (
                    (update.type === "model_settings"
                        || update.type === "model_settings_rejected")
                    && catalogRefreshSweepResult(
                        update.requestId,
                        update.type === "model_settings",
                    )
                ) {
                    // The sweep owns its own reporting.
                } else if (
                    (update.type === "model_settings"
                        || update.type === "model_settings_rejected")
                    && catalogRefreshes.has(update.requestId)
                ) {
                    const provider = catalogRefreshes.get(update.requestId)!;
                    catalogRefreshes.delete(update.requestId);
                    if (update.type === "model_settings_rejected") {
                        // The remembered list is still in place: a provider
                        // that could not be asked is not a provider whose
                        // models went away.
                        showStatusNotice(
                            `could not ask ${provider}, its saved list stands`,
                        );
                    } else {
                        const count = (state.modelSettings?.availableModels ?? [])
                            .filter((entry) => entry.provider === provider)
                            .length;
                        showStatusNotice(`${provider}: ${count} models`);
                    }
                }
                if (
                    update.type === "model_settings"
                    && settingsPicker?.kind === "reviewer_settings"
                ) {
                    // Same rule: the rows read the host's snapshot, not a
                    // local guess about what the choice did.
                    settingsPicker = withTuiPickerParent(
                        startTuiReviewerMenu(state.modelSettings?.reviewerDefault),
                        settingsPicker.parent,
                    );
                }
                if (update.type === "permissions" && preferencesList !== undefined) {
                    // How a removal becomes visible: the engine answers with a
                    // full refreshed inspection rather than an acknowledgement,
                    // so the list is never rebuilt from a local guess about
                    // what the removal did.
                    preferencesList = syncTuiPreferencesList(
                        preferencesList,
                        state.permissionInspection,
                    );
                }
                if (update.type === "permissions") {
                    requestedPermissionChanges.delete(update.requestId);
                }
                if (update.type === "permissions_rejected") {
                    // A mode change and a preferences-list removal share this
                    // update, so the request decides which one is being
                    // reported rather than whichever pane happens to be open.
                    const subject = requestedPermissionChanges.get(
                        update.requestId,
                    );
                    requestedPermissionChanges.delete(update.requestId);
                    if (subject !== undefined) {
                        state = appendTuiError(
                            state,
                            rejectionNotice(subject, update.reason),
                        );
                    } else if (preferencesList !== undefined) {
                        state = appendTuiError(
                            state,
                            update.reason === "unavailable"
                                ? "Removing permissions is unavailable on this host"
                                : "That permission could not be removed",
                        );
                    }
                }
                if (update.type === "history") {
                    const userTexts = update.entries
                        .filter((entry) => entry.kind === "user")
                        .map((entry) => entry.text);
                    composer.loadSubmittedTexts(userTexts);
                    if (userTexts[0] !== undefined) {
                        adoptFallbackSessionTitle(userTexts[0]);
                    }
                    clearTranscriptNodes();
                    transcriptSeeded = true;
                    for (const notice of deferredKeymapNotices.splice(0)) {
                        state = appendTuiNotice(state, notice);
                    }
                    // An attach delivers empty rebuilds before the real one;
                    // placing the end copy on one of those stacks it against
                    // the arrival copy at the top instead of after the
                    // transcript.
                    if (
                        pendingBackNotice !== undefined
                        && update.entries.length > 0
                    ) {
                        state = appendTuiNotice(state, pendingBackNotice);
                        pendingBackNotice = undefined;
                    }
                }
                if (
                    update.type === "turn_finished"
                    || update.type === "agent_failed"
                ) {
                    abortRequested = false;
                    finishStreamingAssistant();
                    if (update.type === "agent_failed") {
                        pendingUiRequest = undefined;
                        timelinePicker = undefined;
                        settingsPicker = undefined;
                    } else {
                        state = beginNextQueuedTuiTurn(state);
                    }
                    if (state.working) {
                        workingSince = Date.now();
                        phaseSince = workingSince;
                        activity = "thinking";
                    } else {
                        workingSince = undefined;
                        phaseSince = undefined;
                        activity = "ready";
                    }
                }
                // State is applied per update above; the repaint is what
                // coalesces, so a burst of deltas paints once a frame.
                renderCoalescer.request(update.type);

                if (update.type === "agent_failed") {
                    rejectPendingExtensionSettingsFor(
                        client,
                        new Error(update.detail),
                    );
                    focusActiveSurface();
                    // The agent stream is terminal, but the attachment also
                    // carries host lifecycle. Keep listening so `host stop`
                    // becomes the ordinary recoverable disconnected state.
                    continue;
                }

                if (
                    !state.working
                    && pendingUiRequest === undefined
                    && timelinePicker === undefined
                ) {
                    focusActiveSurface();
                }
            }
        } catch (error) {
            // A pump left behind by a switch fails on its closed connection.
            // That is the switch working, not the new session losing its host.
            if (generation === clientGeneration) {
                rejectPendingExtensionSettingsFor(client, error);
                reportConnectionError(error);
            }
        }
    }

    function sendCommand(command: ClientCommand): void {
        if (command.type === "prompt") {
            flightRecorder?.record({ type: "submit_dispatched" });
        }
        void client.send(command).then(() => {
            if (command.type === "prompt") {
                flightRecorder?.record({ type: "submit_accepted" });
            }
        }).catch((error) => {
            if (command.type === "prompt") {
                flightRecorder?.record({
                    type: "submit_failed",
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            reportConnectionError(error);
        });
    }

    function requestExtensionModelSettingsUpdate(
        patch: VeraClientModelSettingsPatch,
        signal: AbortSignal,
    ): Promise<VeraClientModelSettingsUpdateResult> {
        if (signal.aborted) {
            return Promise.reject(signal.reason);
        }
        const requestId = randomUUID();
        const target = extensionAgentTarget.getStore() ?? focusedAgentClient();
        return new Promise((resolve, reject) => {
            const onAbort = (): void => {
                pendingExtensionSettings.delete(requestId);
                requestedModelChanges.delete(requestId);
                reject(signal.reason);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            // An extension edit is a settings edit like any other: it says what
            // it asked for while it is in flight, and a refusal names the same
            // thing rather than leaving the user to guess what was tried.
            const subject = modelPatchSubject(patch);
            requestedModelChanges.set(requestId, { subject, patch, target });
            showStatusNotice(`model → ${describeModelPatch(patch)}`);
            pendingExtensionSettings.set(requestId, {
                target,
                resolve,
                reject,
                removeAbortListener: () =>
                    signal.removeEventListener("abort", onAbort),
            });
            void target.send({
                type: "update_model_settings",
                requestId,
                patch,
            }).catch((error) => {
                pendingExtensionSettings.delete(requestId);
                requestedModelChanges.delete(requestId);
                signal.removeEventListener("abort", onAbort);
                reject(error);
            });
        });
    }

    function settleExtensionModelSettings(
        update: Extract<
            AgentUpdate,
            { type: "model_settings" | "model_settings_rejected" }
        >,
        target: TuiAgentClient,
    ): void {
        const pending = pendingExtensionSettings.get(update.requestId);
        if (pending === undefined || pending.target !== target) return;
        pendingExtensionSettings.delete(update.requestId);
        pending.removeAbortListener();
        pending.resolve(update.type === "model_settings"
            ? { status: "accepted", settings: update.settings }
            : { status: "rejected", reason: update.reason });
    }

    function rejectPendingExtensionSettingsFor(
        target: TuiAgentClient,
        reason: unknown,
    ): void {
        for (const [requestId, pending] of pendingExtensionSettings) {
            if (pending.target !== target) continue;
            pendingExtensionSettings.delete(requestId);
            requestedModelChanges.delete(requestId);
            pending.removeAbortListener();
            pending.reject(reason);
        }
    }

    function notifyExtensionSettings(
        settings: NonNullable<typeof state.modelSettings>,
    ): void {
        for (const listener of extensionSettingsListeners) {
            try {
                listener(structuredClone(settings));
            } catch {
                // One extension listener cannot stop client updates.
            }
        }
    }

    function requireSidebarOwner(extensionId: string): void {
        hostedSidebar.requireOwner(extensionId);
    }

    /**
     * The user's own name for a pooled model, swapped for the id the provider
     * knows. An extension is handed whatever was typed, and a pool name is the
     * client's data to resolve.
     */
    function resolvePooledModel(
        request: VeraClientConsultRequest,
    ): VeraClientConsultRequest {
        const wanted = request.model.toLowerCase();
        for (const entry of state.modelSettings?.pooled ?? []) {
            if (entry.poolName?.toLowerCase() !== wanted) continue;
            return {
                ...request,
                model: entry.model,
                ...(request.provider === undefined
                    ? { provider: entry.provider }
                    : {}),
            };
        }
        return request;
    }

    function requestExtensionConsult(
        consultRequest: VeraClientConsultRequest,
        signal: AbortSignal,
    ): Promise<VeraClientConsultResult> {
        const request = resolvePooledModel(consultRequest);
        if (signal.aborted) {
            return Promise.reject(signal.reason as Error);
        }
        const requestId = randomUUID();
        return new Promise<VeraClientConsultResult>((resolve, reject) => {
            const settle = (): void => {
                signal.removeEventListener("abort", onAbort);
                pendingConsults.delete(requestId);
            };
            const onAbort = (): void => {
                settle();
                reject(signal.reason as Error);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            pendingConsults.set(requestId, {
                resolve: (result) => {
                    settle();
                    resolve(result);
                },
                reject: (reason) => {
                    settle();
                    reject(reason);
                },
            });
            sendCommand({
                type: "consult",
                requestId,
                model: request.model,
                ...(request.provider === undefined
                    ? {}
                    : { provider: request.provider }),
                ...(request.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: request.reasoningEffort }),
                ...(request.systemPrompt === undefined
                    ? {}
                    : { systemPrompt: request.systemPrompt }),
                messages: request.messages.map((message) => ({
                    role: message.role,
                    content: message.content,
                })),
                ...(request.maxTokens === undefined
                    ? {}
                    : { maxTokens: request.maxTokens }),
            });
        });
    }

    function requestExtensionPicker(
        request: VeraClientPickerRequest,
        signal: AbortSignal,
    ): Promise<VeraClientPickerResult> {
        if (signal.aborted) {
            return Promise.reject(signal.reason);
        }
        if (pendingExtensionPicker !== undefined || anyOverlayOpen()) {
            return Promise.reject(
                new Error("Another client surface is already open"),
            );
        }
        const supported = new Set(["enter", "d", "s", "delete", "backspace"]);
        const actions: TuiExtensionPickerAction[] = request.actions.flatMap(
            (action) => action.keys.map((key) => {
                if (!supported.has(key)) {
                    throw new Error(
                        `Unsupported extension picker key: ${key}`,
                    );
                }
                return {
                    id: action.id,
                    key: key as TuiExtensionPickerAction["key"],
                    label: action.label,
                };
            }),
        );
        settingsPicker = startTuiExtensionPicker(
            request.title,
            request.rows,
            request.selectedId,
            actions,
            request.subtitle,
        );
        composer.blur();
        renderState();
        focusActiveSurface();
        return new Promise((resolve, reject) => {
            const onAbort = (): void => {
                if (pendingExtensionPicker?.resolve !== resolve) {
                    return;
                }
                pendingExtensionPicker = undefined;
                settingsPicker = undefined;
                focusActiveSurface();
                renderState();
                reject(signal.reason);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            pendingExtensionPicker = {
                resolve,
                reject,
                removeAbortListener: () =>
                    signal.removeEventListener("abort", onAbort),
            };
        });
    }

    async function loadExtensionCommands(): Promise<void> {
        if (client.listExtensionCommands === undefined) {
            return;
        }
        const generation = ++extensionCommandsGeneration;
        try {
            const commands = await client.listExtensionCommands();
            if (generation !== extensionCommandsGeneration) {
                return;
            }
            disposeHostExtensionCommands();
            const disposers: (() => void)[] = [];
            hostExtensionCommands = commands;
            const commandsBySource = Map.groupBy(
                commands,
                (command) => command.source,
            );
            for (const [source, sourceCommands] of commandsBySource) {
                try {
                    disposers.push(registerExtensionTuiCommands(
                        commandRegistry,
                        sourceCommands,
                    ));
                } catch (error) {
                    const message = error instanceof Error
                        ? error.message
                        : String(error);
                    state = appendTuiNotice(
                        state,
                        `${source}: ${message}`,
                    );
                }
            }
            disposeHostExtensionCommands = () => {
                for (const dispose of disposers) {
                    dispose();
                }
            };
            if (commandPalette !== undefined) {
                commandPalette = updateTuiCommandPaletteCommands(
                    commandPalette,
                    registeredPaletteEntries(),
                );
            }
            if (help !== undefined) {
                help = updateTuiHelpCommands(
                    help,
                    coreHelpCommands(),
                    hostExtensionCommands,
                );
            }
            renderCommandSuggestions();
            renderState();
        } catch (error) {
            if (shuttingDown || generation !== extensionCommandsGeneration) {
                return;
            }
            const message = error instanceof Error
                ? error.message
                : String(error);
            state = appendTuiError(
                state,
                `Could not load extension commands: ${message}`,
            );
            renderState();
        } finally {
            if (generation === extensionCommandsGeneration) {
                extensionCommandsLoading = false;
            }
        }
    }

    /**
     * How to focus the overlay in front, or nothing when the composer is it.
     *
     * Held as a lookup rather than folded into `focusActiveSurface` so the same
     * answer serves the question "is the composer the surface this key belongs
     * to", which is what the unfocused-state keys ask.
     */
    function activeOverlayFocus(): (() => void) | undefined {
        if (dialStrip !== undefined) {
            return () => dialCard.focus();
        }
        const uiRequest = focusedUiRequest();
        if (
            uiRequest !== undefined
            && isToolApprovalUiRequestUpdate(uiRequest)
        ) {
            return () => approvalView.focus();
        }
        if (
            uiRequest !== undefined
            && isUserQuestionUiRequestUpdate(uiRequest)
        ) {
            return () => questionView.focus();
        }
        if (experimentalTuiHost.hasModal()) {
            return () => experimentalTuiHost.focus();
        }
        if (timelinePicker !== undefined) {
            return () => timelinePickerView.box.focus();
        }
        if (commandPalette !== undefined) {
            return () => commandPaletteView.box.focus();
        }
        if (workTab !== undefined) {
            return () => workTabView.box.focus();
        }
        if (workspaceSidebar !== undefined && workspaceSidebarFocused) {
            return () => workspaceSidebarView.box.focus();
        }
        if (searchOverlay !== undefined) {
            return () => searchOverlayView.box.focus();
        }
        if (help !== undefined) {
            return () => helpView.box.focus();
        }
        if (doctorDialog !== undefined) {
            return () => doctorDialogView.focus();
        }
        if (extensionsDialog !== undefined) {
            return () => extensionsDialogView.focus();
        }
        if (diagnosticsDialog !== undefined) {
            return () => diagnosticsDialogView.focus();
        }
        if (confirmingFullAccess) {
            return () => permissionsConfirmView.box.focus();
        }
        if (admissionDialog !== undefined) {
            return () => admissionDialogView.box.focus();
        }
        if (sessionTrashCandidate !== undefined) {
            return () => sessionTrashConfirmView.box.focus();
        }
        if (providerForgetCandidate !== undefined) {
            return () => providerForgetConfirmView.box.focus();
        }
        if (providerForm !== undefined) {
            return () => providerFormView.box.focus();
        }
        if (namePrompt !== undefined) {
            return () => namePromptView.box.focus();
        }
        if (secretPrompt !== undefined) {
            return () => secretPromptView.box.focus();
        }
        if (settingsPicker !== undefined) {
            return () => settingsPickerView.box.focus();
        }
        if (preferencesList !== undefined) {
            return () => preferencesListView.box.focus();
        }
        return undefined;
    }

    let recordedFocusSurface: string | undefined;

    function focusActiveSurface(): void {
        const overlay = activeOverlayFocus();
        const surface = overlay !== undefined
            ? "overlay"
            : sidebar.isFocused()
            ? "sidebar_composer"
            : "main_composer";
        if (
            overlay === undefined
            && composer.focused
            && recordedFocusSurface === surface
        ) {
            return;
        }
        composer.blur();
        recordedFocusSurface = surface;
        if (overlay !== undefined) {
            overlay();
            flightRecorder?.record({ type: "focus_changed", surface });
            return;
        }
        composer.focus();
        flightRecorder?.record({ type: "focus_changed", surface });
    }

    function activeFlightSurface(): string {
        if (activeOverlayFocus() !== undefined) return "overlay";
        return sidebar.isFocused() ? "sidebar_composer" : "main_composer";
    }

    function applyTimelineTransition(
        transition: TuiTimelinePickerTransition,
    ): void {
        timelinePicker = transition.state;
        if (transition.composerText !== undefined) {
            composer.setComposerText(transition.composerText);
        }
        if (transition.command !== undefined) {
            sendCommand(transition.command);
        }
        if (transition.forkBoundaryId !== undefined) {
            beginFork(transition.forkBoundaryId);
            return;
        }
        if (timelinePicker === undefined) {
            timelinePickerView.box.visible = false;
            if (pendingUiRequest === undefined) {
                composer.focus();
            }
        } else {
            composer.blur();
            timelinePickerView.update(timelinePicker);
            if (pendingUiRequest === undefined) {
                timelinePickerView.box.focus();
            }
        }
        renderState();
    }

    /**
     * Give every session switch a deadline.
     *
     * A pending switch swallows the palette and refuses new prompts, so a host
     * request that never settles would strand the client with no way back. On
     * timeout the caller's rejection path runs, the old session stays attached,
     * and a late answer is discarded rather than swapped in behind the user.
     */
    function withSessionSwitchDeadline<T>(
        request: Promise<T>,
        discardLate: (value: T) => void,
    ): Promise<T> {
        let timedOut = false;
        let timeout: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                timedOut = true;
                reject(new Error("timed out"));
            }, dependencies.sessionSwitchTimeoutMs ?? SESSION_SWITCH_TIMEOUT_MS);
            // The deadline only matters to a TUI that is still on screen.
            // Left referenced, quitting mid-switch would hold the process open
            // until it fired.
            timeout.unref?.();
        });
        void request.then((value) => {
            if (timedOut) {
                discardLate(value);
            }
        }, () => undefined);
        return Promise.race([request, deadline]).finally(() => {
            clearTimeout(timeout);
        });
    }

    function recordSessionSwitchOutcome(
        outcome: "completed" | "failed",
        error?: unknown,
    ): void {
        if (sessionSwitchStartedAt === undefined) return;
        flightRecorder?.record({
            type: `session_switch_${outcome}`,
            operation: sessionSwitchOperation ?? "unknown",
            durationMs: Math.round(performance.now() - sessionSwitchStartedAt),
            ...(error === undefined
                ? {}
                : { error: error instanceof Error ? error.message : String(error) }),
        });
        sessionSwitchStartedAt = undefined;
        sessionSwitchOperation = undefined;
        sessionSwitchBufferedUpdates = [];
        sessionSwitchClearingMain = false;
    }

    /** Drop a session the client asked for but can no longer use. */
    function discardSwitchTarget(next: TuiAgentClient): void {
        void next.detach().catch(() => next.close());
    }

    function beginFork(boundaryId: string): void {
        timelinePicker = undefined;
        timelinePickerView.box.visible = false;
        if (dependencies.forkSession === undefined) {
            state = appendTuiError(state, "Forking this session is unavailable");
            composer.focus();
            renderState();
            return;
        }
        const sourceAgentId = client.agentId;
        if (sourceAgentId === undefined) {
            state = appendTuiError(state, "Current session ID is unavailable");
            composer.focus();
            renderState();
            return;
        }
        sessionSwitchPending = true;
        sessionSwitchActivity = "forking session…";
        renderState();
        void withSessionSwitchDeadline(
            dependencies.forkSession(sourceAgentId, boundaryId),
            (result) => discardSwitchTarget(result.client),
        ).then((result) => {
            if (shuttingDown) {
                void result.client.detach().catch(() => result.client.close());
                return;
            }
            // The prompt the fork was taken before comes back to the composer,
            // which is the whole point of forking there rather than cloning.
            switchToClient(result.client, {
                text: result.prompt.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(""),
                attachmentIds: result.prompt.content.flatMap((part) =>
                    part.type === "image_attachment"
                        ? [part.attachmentId]
                        : []
                ),
            });
        }).catch((error) => {
            if (shuttingDown) return;
            sessionSwitchPending = false;
            const message = error instanceof Error ? error.message : String(error);
            state = appendTuiError(
                state,
                `Could not fork this session: ${message}`,
            );
            composer.focus();
            renderState();
        });
    }

    function reportConnectionError(error: unknown): void {
        if (shuttingDown || connectionFailed) {
            return;
        }
        connectionFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        for (const pending of pendingConsults.values()) {
            pending.reject(new Error(message));
        }
        pendingConsults.clear();
        for (const image of pendingImages) {
            composer.removeImageChip(image.requestId);
        }
        pendingImages = [];
        submitAfterImageAttachment = false;
        const interruptedRename = pendingSessionRename;
        pendingSessionRename = undefined;
        const interruptedSidebarRename = pendingSidebarSessionRename;
        pendingSidebarSessionRename = undefined;
        if (
            interruptedRename?.commandText !== undefined
            && composer.expandedText().length === 0
        ) {
            composer.setComposerText(interruptedRename.commandText);
        }
        if (
            interruptedSidebarRename?.commandText !== undefined
            && composer.expandedText().length === 0
        ) {
            composer.setComposerText(interruptedSidebarRename.commandText);
        }
        pendingUiRequest = undefined;
        queuedUiRequests.length = 0;
        timelinePicker = undefined;
        settingsPicker = undefined;
        namePrompt = undefined;
        providerForm = undefined;
        commandPalette = undefined;
        help = undefined;
        confirmingFullAccess = false;
        admissionDialog = undefined;
        admissionReturnPicker = undefined;
        sessionTrashCandidate = undefined;
        sessionTrashPending = false;
        abortRequested = false;
        workingSince = undefined;
        phaseSince = undefined;
        activity = "disconnected";
        connectionFailure = message;
        state = failTuiConnection(state);
        renderState();
        composer.focus();
    }

    /**
     * What the pool looks like right now, which is what every relevance
     * predicate is written against. Read fresh each time rather than cached:
     * pooling a model is exactly the kind of thing that should retire the tip
     * telling you to pool one.
     */
    function tipContext(inModelPicker: boolean): TuiTipContext {
        const pooled = state.modelSettings?.pooled ?? [];
        return {
            launches: tipState.launches,
            pooledCount: pooled.length,
            namedPoolCount: pooled.filter((entry) =>
                entry.poolName !== undefined
            ).length,
            anyVerified: pooled.some((entry) => entry.verified),
            inModelPicker,
        };
    }

    /**
     * The built-in tips plus whatever extensions registered, read fresh so a
     * later-loading extension's tips join the pool without a restart.
     */
    function tipPool(): readonly TuiTip[] {
        const registered = clientExtensionRegistry?.tips() ?? [];
        if (registered.length === 0) return TUI_TIPS;
        return [
            ...TUI_TIPS,
            ...registered.map((descriptor) => ({
                id: descriptor.id,
                text: () => descriptor.text,
                cooldownLaunches: descriptor.cooldownLaunches,
                isRelevant: (context: TuiTipContext) =>
                    descriptor.isRelevant(context),
            })),
        ];
    }

    /**
     * A tip to show, recorded as shown. Returns nothing when tips are off,
     * when nothing is eligible, or when the pool is exhausted for this launch.
     */
    function takeTip(inModelPicker: boolean): string | undefined {
        if (!tipsEnabled) return undefined;
        const tip = selectTuiTip(
            tipContext(inModelPicker),
            tipState.history,
            tipPool(),
        );
        if (tip === undefined) return undefined;
        tipState = {
            launches: tipState.launches,
            history: recordTuiTipShown(
                tip.id,
                tipState.history,
                tipState.launches,
            ),
        };
        saveTuiTipState(tipState);
        return tip.text(tipContext(inModelPicker));
    }

    function transcriptEntryText(entry: TuiTranscriptEntry): string {
        return entry.kind === "diff"
            ? `${entry.path}\n${entry.patch}`
            : entry.text;
    }

    function transcriptEstimatedRows(text: string, width: number): number {
        return text.split("\n").reduce((rows, line) => {
            const length = Math.max(1, Array.from(line).length);
            return rows + Math.max(1, Math.ceil(length / Math.max(1, width)));
        }, 0);
    }

    function invalidateMeasuredEntryRows(): void {
        const width = mainTranscriptWidth();
        if (width === measuredEntryRowsWidth) return;
        measuredEntryRowsWidth = width;
        measuredEntryRows.length = 0;
    }

    function measureTranscriptEntryNode(index: number): void {
        const node = entryNodes[index];
        if (node === undefined) return;
        const margin = node.marginTop;
        const rows = node.height + (typeof margin === "number" ? margin : 0);
        if (rows > 0) measuredEntryRows[index] = rows;
    }

    /**
     * Records what every materialized entry currently occupies.
     *
     * A laid-out node is the only exact answer: the estimate is a character
     * count over the width and knows nothing of the borders and gutters the
     * boxed kinds draw. Measuring the window on every frame keeps the estimate
     * to entries that have never been on screen.
     */
    function measureMaterializedTranscriptEntries(): void {
        invalidateMeasuredEntryRows();
        for (
            let index = materializedEntryStart;
            index < materializedEntryEnd;
            index += 1
        ) {
            measureTranscriptEntryNode(index);
        }
    }

    function transcriptEntryRows(
        entries: readonly TuiTranscriptEntry[],
        index: number,
    ): number {
        if (!tuiTranscriptEntryIsVisible(entries[index])) return 0;
        return measuredEntryRows[index] ?? estimateTranscriptEntryRows(
            entries,
            index,
        );
    }

    function estimateTranscriptEntryRows(
        entries: readonly TuiTranscriptEntry[],
        index: number,
    ): number {
        const entry = entries[index];
        if (entry === undefined) return 0;
        // A folded tool row is not laid out, so it occupies no rows the spacer
        // has to stand in for.
        if (!tuiTranscriptEntryIsVisible(entry)) return 0;
        const width = Math.max(
            8,
            mainTranscriptWidth()
                - tuiGutterWidth(entry, appearance.activityIndent)
                - 1,
        );
        const margin = tuiEntryMarginTop(entries, index, entrySpacing);
        if (entry.kind === "thinking") {
            // Reasoning still arriving is one clipped row however much has
            // arrived, so its height never depends on its text.
            return margin + 1;
        }
        return margin + Math.max(
            1,
            transcriptEstimatedRows(transcriptEntryText(entry), width),
        );
    }

    function estimatedTranscriptRows(
        entries: readonly TuiTranscriptEntry[],
        start: number,
        end: number,
    ): number {
        invalidateMeasuredEntryRows();
        let rows = 0;
        for (let index = Math.max(0, start); index < end; index += 1) {
            rows += transcriptEntryRows(entries, index);
        }
        return rows;
    }

    function updateTranscriptEntryNode(
        wrapper: TextRenderable | MarkdownRenderable | BoxRenderable,
        entry: TuiTranscriptEntry,
    ): void {
        wrapper.visible = entry.kind !== "tool" || entry.hidden !== true;
        const existing = tuiGutterContent(wrapper);
        if (
            existing instanceof MarkdownRenderable
            && existing.content !== tuiMarkdownEntryContent(entry)
        ) {
            existing.content = tuiMarkdownEntryContent(entry);
        }
        if (entry.kind === "tool" && existing instanceof BoxRenderable) {
            updateTuiToolRow(existing, entry);
        }
        if (
            entry.kind === "tool_header"
            && existing instanceof BoxRenderable
        ) {
            updateTuiToolHeader(existing, entry);
        }
        if (
            entry.kind === "thinking"
            && existing instanceof BoxRenderable
        ) {
            updateTuiThinkingWindow(existing, entry);
        }
        if (
            (entry.kind === "thought"
                || entry.kind === "notice"
                || entry.kind === "inbox")
            && existing instanceof TextRenderable
        ) {
            existing.content = renderTuiEntry(entry);
        }
    }

    function createTranscriptEntryNode(
        entries: readonly TuiTranscriptEntry[],
        index: number,
    ): TextRenderable | MarkdownRenderable | BoxRenderable {
        const entry = entries[index];
        if (entry === undefined) {
            throw new Error(`Transcript entry ${index} is unavailable`);
        }
        const node = createTuiEntryNode(
            `entry-${index}`,
            entry,
            tuiEntryMarginTop(entries, index, entrySpacing),
            assistantFollowsTools(entries, index),
        );
        updateTranscriptEntryNode(node, entry);
        entryNodes[index] = node;
        entryNodeKinds[index] = entry.kind;
        return node;
    }

    function destroyTranscriptEntryNode(index: number): void {
        entryNodes[index]?.destroyRecursively();
        delete entryNodes[index];
        delete entryNodeKinds[index];
    }

    /** Children run [top spacer, materialized entries…, bottom spacer]. */
    function transcriptWindowChildIndex(index: number): number {
        return 1 + index - materializedEntryStart;
    }

    function addTranscriptEntryNode(
        node: TextRenderable | MarkdownRenderable | BoxRenderable,
        index: number,
    ): void {
        transcriptEntryWindow.add(node, transcriptWindowChildIndex(index));
    }

    function updateTranscriptSpacers(
        entries: readonly TuiTranscriptEntry[],
    ): void {
        // A box holds a row even at height 0, which at the ends of the window
        // is a blank band above the first entry or below the last. Hiding an
        // empty spacer is what keeps those ends flush.
        const above = estimatedTranscriptRows(entries, 0, materializedEntryStart);
        const below = estimatedTranscriptRows(
            entries,
            materializedEntryEnd,
            entries.length,
        );
        transcriptWindowTopSpacer.height = above;
        transcriptWindowTopSpacer.visible = above > 0;
        transcriptWindowBottomSpacer.height = below;
        transcriptWindowBottomSpacer.visible = below > 0;
    }

    /** The first materialized entry with any row inside the viewport. */
    function topmostVisibleTranscriptEntry(): number | undefined {
        const top = transcript.viewport.screenY;
        for (
            let index = materializedEntryStart;
            index < materializedEntryEnd;
            index += 1
        ) {
            const node = entryNodes[index];
            if (node === undefined || !node.visible) continue;
            if (node.screenY + node.height > top) return index;
        }
        return undefined;
    }

    /**
     * Puts the anchored entry back where it sat, once a layout has run.
     *
     * The correction is the difference between two laid-out positions, so it
     * carries no estimate of its own.
     */
    function applyTranscriptScrollAnchor(): void {
        const anchor = pendingTranscriptScrollAnchor;
        if (anchor === undefined) return;
        pendingTranscriptScrollAnchor = undefined;
        const node = entryNodes[anchor.index];
        if (node === undefined) return;
        const offset = node.screenY - transcript.viewport.screenY;
        if (offset === anchor.offset) return;
        transcript.scrollTo(transcript.scrollTop + offset - anchor.offset);
    }

    function captureTranscriptScrollAnchor(): void {
        pendingTranscriptScrollAnchor = undefined;
        const index = topmostVisibleTranscriptEntry();
        if (index === undefined) return;
        const node = entryNodes[index];
        if (node === undefined) return;
        pendingTranscriptScrollAnchor = {
            index,
            offset: node.screenY - transcript.viewport.screenY,
        };
    }

    function transcriptFollowsBottom(): boolean {
        return tuiTranscriptAtBottom(
            transcript.scrollTop,
            transcript.scrollHeight,
            transcript.viewport.height,
        );
    }

    /**
     * Releases nodes for entries that no longer exist.
     *
     * The entry list shrinks whenever a turn ends and its thinking row is
     * dropped. A node past the end of the list is outside every index the
     * update pass walks, so nothing else would ever destroy it.
     */
    function trimTranscriptWindow(length: number): void {
        for (let index = length; index < entryNodes.length; index += 1) {
            destroyTranscriptEntryNode(index);
        }
        entryNodes.length = Math.min(entryNodes.length, length);
        entryNodeKinds.length = entryNodes.length;
        measuredEntryRows.length = Math.min(measuredEntryRows.length, length);
        materializedEntryEnd = Math.min(materializedEntryEnd, length);
        materializedEntryStart = Math.min(
            materializedEntryStart,
            materializedEntryEnd,
        );
    }

    function renderTranscriptEntries(
        entries: readonly TuiTranscriptEntry[],
    ): void {
        trimTranscriptWindow(entries.length);

        if (entries.length === 0) {
            transcriptWindowTopSpacer.height = 0;
            transcriptWindowTopSpacer.visible = false;
            transcriptWindowBottomSpacer.height = 0;
            transcriptWindowBottomSpacer.visible = false;
            return;
        }

        if (materializedEntryEnd === 0 && entryNodes.length === 0) {
            const initial = tuiTranscriptTailRange(entries.length);
            materializedEntryStart = initial.start;
            materializedEntryEnd = initial.start;
        }

        // Entries appended while the reader is scrolled away stay behind the
        // bottom spacer until they scroll into reach, so a long session does
        // not rebuild its whole tail on every arriving row.
        let materializeTo = transcriptFollowsBottom()
            ? entries.length
            : Math.min(materializedEntryEnd, entries.length);

        const changedKindAt = entries.findIndex((entry, index) =>
            entryNodes[index] !== undefined
            && entryNodeKinds[index] !== entry.kind
        );
        if (changedKindAt !== -1) {
            materializeTo = Math.max(materializeTo, materializedEntryEnd);
            pendingTranscriptScrollRestore = {
                scrollTop: transcript.scrollTop,
                atBottom: tuiTranscriptAtBottom(
                    transcript.scrollTop,
                    transcript.scrollHeight,
                    transcript.viewport.height,
                ),
            };
            for (
                let index = changedKindAt;
                index < materializedEntryEnd;
                index += 1
            ) {
                destroyTranscriptEntryNode(index);
            }
            materializedEntryEnd = changedKindAt;
        }

        for (
            let index = materializedEntryStart;
            index < materializedEntryEnd;
            index += 1
        ) {
            const node = entryNodes[index];
            const entry = entries[index];
            if (node !== undefined && entry !== undefined) {
                updateTranscriptEntryNode(node, entry);
            }
        }

        for (let index = materializedEntryEnd; index < materializeTo; index += 1) {
            addTranscriptEntryNode(
                createTranscriptEntryNode(entries, index),
                index,
            );
        }
        materializedEntryEnd = Math.max(materializedEntryEnd, materializeTo);
        updateTranscriptSpacers(entries);
    }

    function materializeEarlierTranscriptEntries(
        entries: readonly TuiTranscriptEntry[],
    ): boolean {
        const range = tuiTranscriptPrependRange(materializedEntryStart);
        if (range.start === range.end) return false;
        captureTranscriptScrollAnchor();
        materializedEntryStart = range.start;
        for (let index = range.start; index < range.end; index += 1) {
            addTranscriptEntryNode(
                createTranscriptEntryNode(entries, index),
                index,
            );
        }
        updateTranscriptSpacers(entries);
        return true;
    }

    function materializeLaterTranscriptEntries(
        entries: readonly TuiTranscriptEntry[],
    ): boolean {
        const end = Math.min(
            entries.length,
            materializedEntryEnd + TUI_TRANSCRIPT_MATERIALIZE_BATCH,
        );
        if (end <= materializedEntryEnd) return false;
        for (let index = materializedEntryEnd; index < end; index += 1) {
            addTranscriptEntryNode(
                createTranscriptEntryNode(entries, index),
                index,
            );
        }
        materializedEntryEnd = end;
        // Nothing above the viewport changed, so the reader's position holds
        // on its own; only the spacer standing in for the rest shrinks.
        updateTranscriptSpacers(entries);
        return true;
    }

    function nodeTranscriptRows(index: number): number | undefined {
        const node = entryNodes[index];
        if (node === undefined) return undefined;
        const margin = node.marginTop;
        return node.height + (typeof margin === "number" ? margin : 0);
    }

    /**
     * Releases entries that have moved far enough outside the viewport.
     *
     * Without this the window only ever grows, so reaching the top of a long
     * session materializes all of it and holds it for the rest of the run.
     * Each released entry's measured height goes into the spacer that replaces
     * it, so releasing moves nothing the reader can see.
     */
    function evictTranscriptEntries(
        entries: readonly TuiTranscriptEntry[],
    ): boolean {
        const materializedAbove = Math.max(
            0,
            transcript.scrollTop - transcriptWindowTopSpacer.height,
        );
        const materializedBelow = Math.max(
            0,
            transcript.scrollHeight
                - transcriptWindowBottomSpacer.height
                - transcript.scrollTop
                - transcript.viewport.height,
        );
        const headroom = materializedEntryEnd
            - materializedEntryStart
            - TUI_TRANSCRIPT_INITIAL_WINDOW;
        if (headroom <= 0) return false;

        const aboveBudget = tuiTranscriptEvictableRows({
            scrollTop: transcript.scrollTop,
            viewportHeight: transcript.viewport.height,
            spacerHeight: transcriptWindowTopSpacer.height,
        });
        if (aboveBudget > 0 && materializedAbove > 0) {
            const limit = Math.min(
                materializedEntryStart + TUI_TRANSCRIPT_MATERIALIZE_BATCH,
                materializedEntryStart + headroom,
            );
            let released = 0;
            let index = materializedEntryStart;
            while (index < limit) {
                const rows = nodeTranscriptRows(index);
                if (rows === undefined || released + rows > aboveBudget) break;
                measureTranscriptEntryNode(index);
                released += rows;
                index += 1;
            }
            if (index > materializedEntryStart) {
                for (let drop = materializedEntryStart; drop < index; drop += 1) {
                    destroyTranscriptEntryNode(drop);
                }
                materializedEntryStart = index;
                updateTranscriptSpacers(entries);
                return true;
            }
        }

        const belowBudget = tuiTranscriptEvictableRows({
            scrollTop: materializedBelow,
            viewportHeight: transcript.viewport.height,
            spacerHeight: 0,
        });
        if (belowBudget <= 0) return false;
        const floor = Math.max(
            materializedEntryStart,
            materializedEntryEnd - TUI_TRANSCRIPT_MATERIALIZE_BATCH,
            materializedEntryEnd - headroom,
        );
        let released = 0;
        let index = materializedEntryEnd;
        while (index > floor) {
            const rows = nodeTranscriptRows(index - 1);
            if (rows === undefined || released + rows > belowBudget) break;
            measureTranscriptEntryNode(index - 1);
            released += rows;
            index -= 1;
        }
        if (index === materializedEntryEnd) return false;
        for (let drop = index; drop < materializedEntryEnd; drop += 1) {
            destroyTranscriptEntryNode(drop);
        }
        materializedEntryEnd = index;
        updateTranscriptSpacers(entries);
        return true;
    }

    function maybeEvictTranscriptEntries(): boolean {
        if (state.entries.length === 0) return false;
        return evictTranscriptEntries(state.entries);
    }

    /**
     * Rebuilds the window as the tail, for a reader who jumped to the bottom.
     *
     * Walking the window down a batch a frame would take hundreds of frames
     * from the top of a long session, and every batch would move the bottom
     * the reader asked to land on.
     */
    function setTranscriptWindow(
        entries: readonly TuiTranscriptEntry[],
        start: number,
        end: number,
    ): void {
        for (let index = materializedEntryStart; index < materializedEntryEnd; index += 1) {
            measureTranscriptEntryNode(index);
            destroyTranscriptEntryNode(index);
        }
        materializedEntryStart = start;
        materializedEntryEnd = start;
        for (let index = start; index < end; index += 1) {
            addTranscriptEntryNode(
                createTranscriptEntryNode(entries, index),
                index,
            );
        }
        materializedEntryEnd = end;
        updateTranscriptSpacers(entries);
        pendingTranscriptScrollAnchor = undefined;
    }

    function snapTranscriptWindowToTail(
        entries: readonly TuiTranscriptEntry[],
    ): void {
        const tail = tuiTranscriptTailRange(entries.length);
        setTranscriptWindow(entries, tail.start, tail.end);
        transcript.scrollTo(transcript.scrollHeight);
        // The rebuilt rows have no measured height until the next layout, so
        // the bottom is claimed again once they do.
        pendingTranscriptScrollRestore = { scrollTop: 0, atBottom: true };
    }

    function setTranscriptWindowAround(
        entries: readonly TuiTranscriptEntry[],
        index: number,
    ): void {
        const start = Math.max(
            0,
            Math.min(
                index - Math.floor(TUI_TRANSCRIPT_INITIAL_WINDOW / 2),
                entries.length - TUI_TRANSCRIPT_INITIAL_WINDOW,
            ),
        );
        setTranscriptWindow(
            entries,
            start,
            Math.min(entries.length, start + TUI_TRANSCRIPT_INITIAL_WINDOW),
        );
    }

    function settleTranscriptScrollState(): void {
        const restore = pendingTranscriptScrollRestore;
        if (restore !== undefined) {
            pendingTranscriptScrollRestore = undefined;
            pendingTranscriptScrollAnchor = undefined;
            transcript.scrollTo(
                restore.atBottom ? transcript.scrollHeight : restore.scrollTop,
            );
        }
        applyTranscriptScrollAnchor();
    }

    function maybeMaterializeEarlierTranscriptEntries(): boolean {
        if (state.entries.length === 0) return false;
        if (!tuiTranscriptNeedsEarlierEntries({
            materializedStart: materializedEntryStart,
            scrollTop: transcript.scrollTop,
            viewportHeight: transcript.viewport.height,
            spacerTop: transcriptWindowTopSpacer.screenY
                - transcript.viewport.screenY
                + transcript.scrollTop,
            spacerHeight: transcriptWindowTopSpacer.height,
        })) {
            return false;
        }
        return materializeEarlierTranscriptEntries(state.entries);
    }

    function maybeMaterializeLaterTranscriptEntries(): boolean {
        if (materializedEntryEnd >= state.entries.length) return false;
        const buffer = Math.max(1, transcript.viewport.height)
            * TUI_TRANSCRIPT_MATERIALIZE_BUFFER;
        const materializedEdge = transcript.scrollHeight
            - transcriptWindowBottomSpacer.height;
        if (
            transcript.scrollTop + transcript.viewport.height + buffer
                < materializedEdge
        ) {
            return false;
        }
        return materializeLaterTranscriptEntries(state.entries);
    }

    function maybeSnapTranscriptWindowToTail(): boolean {
        if (state.entries.length === 0) return false;
        if (materializedEntryEnd >= state.entries.length) return false;
        if (!transcriptFollowsBottom()) return false;
        snapTranscriptWindowToTail(state.entries);
        return true;
    }

    function renderState(): void {
        if (shuttingDown) {
            return;
        }
        const uiRequest = focusedUiRequest();
        experimentalTuiHost.render();

        placeholder.visible = state.entries.length === 0;
        // The transcript tip appears in the gap after a turn, which is the one
        // moment the user is reading rather than typing, and it is gone by the
        // time the next turn starts. Armed by the turn ending rather than by
        // the idle state itself, so the line does not come straight back in
        // the frames between a submit and the turn actually starting.
        if (tipsEnabled && workingLastRender && !state.working) {
            composerTip = takeTip(false);
        }
        workingLastRender = state.working;
        composerTipText.content = composerTip === undefined
            ? new StyledText([])
            // Text nodes lay their content out from column zero, so the
            // optical indent beside the composer is written in rather than
            // set as padding.
            : new StyledText([
                fg(TUI_ACCENT)(
                    `${" ".repeat(appearance.composerTipIndent)}Tip `,
                ),
                fg(TUI_MUTED)(composerTip),
            ]);
        composerTipText.visible = composerTip !== undefined
            && !anyOverlayOpen();
        renderHeldAddress();
        composer.placeholder = extensionAddressee === undefined
            ? sidebar.isFocused() && hostedSidebar.mention !== undefined
                ? `Message ${hostedSidebar.mention}\u2026`
                : COMPOSER_PLACEHOLDER
            : `Message ${extensionAddressee}\u2026`;
        renderPendingQuote();
        const focusedState = focusedAgentState();
        const queuedPrompt = renderTuiQueuedPrompt(focusedState);
        queuedPromptText.content = queuedPrompt.length === 0
            ? ""
            : `${" ".repeat(appearance.composerMarginHorizontal)}${queuedPrompt}`;
        queuedPromptText.visible = focusedState.queuedPrompts.length > 0;
        approvalView.box.visible = uiRequest?.request.type
            === "tool_approval";
        questionView.box.visible = uiRequest?.request.type
            === "user_question";
        // A model, directory, and approval mode do not explain either pending
        // request. Both cards replace the composer and status band until the
        // user answers, so no status text can paint across their final row.
        statusText.visible = !(approvalView.box.visible
            || questionView.box.visible);
        statusBand.visible = !(approvalView.box.visible
            || questionView.box.visible);
        timelinePickerView.box.visible = uiRequest === undefined
            && timelinePicker !== undefined;
        // Over the connect pane it was opened from, so the pane is still there
        // to go back to when the key is saved or the prompt is abandoned.
        providerFormView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && providerForm !== undefined;
        namePromptView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && providerForm === undefined
            && namePrompt !== undefined;
        secretPromptView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && namePrompt === undefined
            && providerForm === undefined
            && secretPrompt !== undefined;
        settingsPickerView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && secretPrompt === undefined
            && namePrompt === undefined
            && providerForm === undefined
            && settingsPicker !== undefined;
        preferencesListView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && settingsPicker === undefined
            && preferencesList !== undefined;
        commandPaletteView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && settingsPicker === undefined
            && secretPrompt === undefined
            && preferencesList === undefined
            && commandPalette !== undefined;
        workTabView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && workTab !== undefined;
        applyWorkspaceRail();
        workspaceSidebarView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && (
                settingsPicker === undefined
                || workspaceStaysBesideSettingsPicker(settingsPicker)
            )
            && commandPalette === undefined
            && workTab === undefined
            && workspaceSidebar !== undefined
            && (workspaceRail !== undefined || workspaceSidebarFocused);
        searchOverlayView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && workTab === undefined
            && searchOverlay !== undefined;
        helpView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && workTab === undefined
            && searchOverlay === undefined
            && help !== undefined;
        doctorDialogView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && help === undefined
            && diagnosticsDialog === undefined
            && extensionsDialog === undefined
            && doctorDialog !== undefined;
        diagnosticsDialogView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && help === undefined
            && doctorDialog === undefined
            && extensionsDialog === undefined
            && diagnosticsDialog !== undefined;
        extensionsDialogView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && help === undefined
            && doctorDialog === undefined
            && diagnosticsDialog === undefined
            && extensionsDialog !== undefined;
        permissionsConfirmView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && confirmingFullAccess;
        admissionDialogView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && sessionTrashCandidate === undefined
            && providerForgetCandidate === undefined
            && !confirmingFullAccess
            && admissionDialog !== undefined;
        sessionTrashConfirmView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && sessionTrashCandidate !== undefined;
        providerForgetConfirmView.surface.visible = uiRequest === undefined
            && timelinePicker === undefined
            && sessionTrashCandidate === undefined
            && providerForgetCandidate !== undefined;
        const overlayVisible = dialStrip !== undefined
            || jumpMenuBox.visible
            || approvalView.box.visible
            || questionView.box.visible
            || timelinePickerView.box.visible
            || settingsPickerView.box.visible
            || preferencesListView.surface.visible
            || commandPaletteView.surface.visible
            || workTabView.surface.visible
            // A rail stands beside the transcript rather than over it, so the
            // scrim that dims the screen behind a card would be dimming the
            // half of it the reader is still reading.
            || (workspaceSidebarView.surface.visible && workspaceRail === undefined)
            || searchOverlayView.surface.visible
            || helpView.box.visible
            || doctorDialogView.box.visible
            || diagnosticsDialogView.box.visible
            || extensionsDialogView.box.visible
            || permissionsConfirmView.box.visible
            || admissionDialogView.surface.visible
            || sessionTrashConfirmView.surface.visible
            || providerForgetConfirmView.surface.visible
            || namePromptView.surface.visible
            || providerFormView.surface.visible
            || secretPromptView.box.visible
            || experimentalTuiHost.hasModal();
        // The scrim carries the whole fade: its translucent fill composites
        // the glyphs behind it as well as the cell backgrounds, so the chrome
        // needs no attenuation of its own. Fading it a second time left the
        // composer and status band darker than the transcript beside them.
        overlayScrim.visible = overlayVisible;
        // Ordinary modals leave the conversation and composer in place as
        // dimmed context. The scrim sits above them and below the active card.
        // Approval and question cards are different: they replace the composer
        // until the pending engine request is answered.
        composerBox.visible = uiRequest === undefined;
        renderCommandSuggestions();
        if (
            uiRequest !== undefined
            && isToolApprovalUiRequestUpdate(uiRequest)
        ) {
            approvalView.update(uiRequest);
        }
        if (
            uiRequest !== undefined
            && isUserQuestionUiRequestUpdate(uiRequest)
        ) {
            questionView.update(uiRequest);
        }
        if (timelinePicker !== undefined) {
            timelinePickerView.update(timelinePicker);
        }
        if (settingsPicker === undefined) {
            pickerTipKind = undefined;
            settingsPickerView.tip = undefined;
        } else if (tipsEnabled && pickerTipKind !== settingsPicker.kind) {
            // One tip per pane, chosen when the pane opens. Rechoosing on
            // every keystroke would make the line flicker under the search
            // query, and the pane is one place, not one place per row.
            pickerTipKind = settingsPicker.kind;
            settingsPickerView.tip = takeTip(settingsPicker.kind === "model");
        }
        if (settingsPicker !== undefined) {
            settingsPickerView.update(settingsPicker);
            fitSettingsPickerBesideWorkspace(settingsPicker);
        }
        if (secretPrompt !== undefined) {
            secretPromptView.update(secretPrompt);
        }
        if (namePrompt !== undefined) {
            namePromptView.update(namePrompt);
        }
        if (providerForm !== undefined) {
            providerFormView.update(providerForm);
        }
        if (preferencesList !== undefined) {
            preferencesListView.update(preferencesList);
        }
        if (commandPalette !== undefined) {
            commandPaletteView.update(commandPalette);
        }
        if (workTab !== undefined) {
            workTabView.update(
                workTabViewState(workTab, workTabView.contentWidth()),
            );
        }
        if (workspaceSidebar !== undefined) {
            workspaceSidebarView.update(workspaceSidebarViewState(
                workspaceSidebar,
                renderer.width,
                new Date(),
                workspaceRail,
                workspaceSidebarFocused,
                activityFrame(),
            ));
        }
        if (searchOverlay !== undefined) {
            searchOverlayView.update(searchOverlayViewState(
                searchOverlay,
                searchOverlayView.contentWidth(),
            ));
        }
        if (help !== undefined) {
            helpView.update(help);
        }
        if (doctorDialog !== undefined) {
            doctorDialogView.update(doctorDialog);
        }
        if (diagnosticsDialog !== undefined) {
            diagnosticsDialogView.update(diagnosticsDialog);
        }
        if (extensionsDialog !== undefined) {
            extensionsDialogView.update(extensionsDialog);
        }
        if (sessionTrashCandidate !== undefined) {
            sessionTrashConfirmView.update(sessionTrashCandidate.label);
        }
        if (providerForgetCandidate !== undefined) {
            providerForgetConfirmView.update(providerForgetCandidate.label);
        }
        if (admissionDialog !== undefined) {
            admissionDialogView.update(admissionDialog, dialogAdmission());
        }

        renderTranscriptEntries(state.entries);

        showSearchTarget();
        renderStatus();
    }

    /**
     * Put the row a search matched on screen, once the session it lives in has
     * finished drawing.
     *
     * The whole point of searching is to land on the message that matched, so
     * a transcript that opened at its end has not answered the query yet. The
     * target is held until the row exists, because the session it belongs to
     * is still loading when the search hands it over, and cleared either way
     * once it does: a match that scrolled is done, and one whose row never
     * arrived is not worth chasing through the next conversation.
     */
    function showSearchTarget(): void {
        const target = pendingSearchTarget;
        if (target === undefined || client.agentId !== target.sessionId) {
            return;
        }
        const index = state.entries.findIndex((entry) =>
            entry.kind !== "diff" && entry.entryId === target.entryId
        );
        // Nothing on screen yet means the session is still loading, so the
        // target waits. A drawn transcript without the row means the row is
        // gone, and chasing it through later paints of the same session would
        // scroll the reader away from wherever they had moved to.
        if (index === -1) {
            if (state.entries.length > 0) pendingSearchTarget = undefined;
            return;
        }
        if (entryNodes[index] === undefined) {
            // Built in one step rather than a batch a frame: the target stays
            // outside the window until the scroll reaches it, and the window
            // would release each batch again before the next one arrived.
            setTranscriptWindowAround(state.entries, index);
            // The rows have no measured height until the next layout, so the
            // scroll waits a frame for one.
            return;
        }
        pendingSearchTarget = undefined;
        transcript.scrollChildIntoView(`entry-${index}`);
    }

    /**
     * Redraw the surfaces whose rows state how long ago something happened.
     *
     * Both read the clock rather than a value the host sent, so a tab left
     * open would go on saying "2m ago" about something from this morning. The
     * host only sends a new index when the work changes, which for a session
     * waiting on an answer is never.
     *
     * Only these two, and only while open: a full repaint on every tick would
     * rebuild the transcript to move one word.
     */
    function refreshTimedSurfaces(): void {
        if (workTab !== undefined) {
            workTabView.update(
                workTabViewState(workTab, workTabView.contentWidth()),
            );
        }
        applyWorkspaceRail();
        if (workspaceSidebar !== undefined) {
            workspaceSidebarView.update(workspaceSidebarViewState(
                workspaceSidebar,
                renderer.width,
                new Date(),
                workspaceRail,
                workspaceSidebarFocused,
                activityFrame(),
            ));
        }
        if (searchOverlay !== undefined) {
            searchOverlayView.update(searchOverlayViewState(
                searchOverlay,
                searchOverlayView.contentWidth(),
            ));
        }
    }

    /**
     * Whether some overlay owns the screen. Bare keybindings and body focus
     * both have to stand down while one is open, and they have to agree on
     * when, so they ask the same question here.
     */
    function anyOverlayOpen(): boolean {
        return dialStrip !== undefined
            || experimentalTuiHost.hasModal()
            || focusedUiRequest() !== undefined
            || timelinePicker !== undefined
            || secretPrompt !== undefined
            || namePrompt !== undefined
            || providerForm !== undefined
            || settingsPicker !== undefined
            || preferencesList !== undefined
            || commandPalette !== undefined
            || workTab !== undefined
            || searchOverlay !== undefined
            || help !== undefined
            || doctorDialog !== undefined
            || diagnosticsDialog !== undefined
            || extensionsDialog !== undefined
            || confirmingFullAccess
            || admissionDialog !== undefined
            || sessionTrashCandidate !== undefined
            || providerForgetCandidate !== undefined
            || jumpMenu !== undefined;
    }

    function clearTranscriptNodes(): void {
        if (state.entries.length > 0) {
            pendingTranscriptScrollRestore = {
                scrollTop: transcript.scrollTop,
                atBottom: tuiTranscriptAtBottom(
                    transcript.scrollTop,
                    transcript.scrollHeight,
                    transcript.viewport.height,
                ),
            };
        } else {
            pendingTranscriptScrollRestore = undefined;
        }
        experimentalTuiHost.clearTranscriptRenderables();
        for (const node of entryNodes) {
            node?.destroyRecursively();
        }
        entryNodes.length = 0;
        entryNodeKinds.length = 0;
        measuredEntryRows.length = 0;
        materializedEntryStart = 0;
        materializedEntryEnd = 0;
        pendingTranscriptScrollAnchor = undefined;
        transcriptWindowTopSpacer.height = 0;
        transcriptWindowTopSpacer.visible = false;
        transcriptWindowBottomSpacer.height = 0;
        transcriptWindowBottomSpacer.visible = false;
    }

    // The surface openers below are shared by three callers: a slash command, a
    // palette row, and a /settings menu entry. Keeping them here means the three
    // routes cannot drift into opening the same picker with different arguments.

    function openReviewerMenu(parent?: TuiSettingsPickerState): void {
        settingsPicker = withTuiPickerParent(
            startTuiReviewerMenu(state.modelSettings?.reviewerDefault),
            parent,
        );
        renderState();
        focusActiveSurface();
    }

    function openReviewerPicker(
        slot: TuiReviewerSlot,
        parent?: TuiSettingsPickerState,
    ): void {
        const reviewer = state.modelSettings?.reviewerDefault;
        settingsPicker = withTuiPickerParent(
            startTuiReviewerPicker(
                slot,
                state.modelSettings?.pooled,
                slot === "primary" ? reviewer?.primary : reviewer?.fallback,
                state.modelSettings?.availableModels,
            ),
            parent,
        );
        renderState();
        focusActiveSurface();
    }

    /**
     * The primary is required, so clearing it means the fallback has nothing to
     * sit behind: the whole reviewer is cleared instead. Clearing the failsafe
     * alone keeps the primary and sends `null` for the second slot.
     */
    function reviewerPatchFor(
        selection: { slot: TuiReviewerSlot; provider?: string; model?: string },
    ): ModelSettingsPatch["reviewer"] {
        const chosen = selection.model === undefined ? undefined : {
            model: selection.model,
            ...(selection.provider === undefined
                ? {}
                : { provider: selection.provider }),
        };
        const current = state.modelSettings?.reviewerDefault;
        if (selection.slot === "primary") {
            if (chosen === undefined) return null;
            return {
                primary: chosen,
                ...(current?.fallback === undefined
                    ? {}
                    : { fallback: current.fallback }),
            };
        }
        if (current?.mode !== "fixed" || current.primary === undefined) {
            // A failsafe is the second entry of a route with no first entry.
            return undefined;
        }
        return { primary: current.primary, fallback: chosen ?? null };
    }

    function reviewerToast(
        selection: { slot: TuiReviewerSlot; provider?: string; model?: string },
    ): string {
        const name = selection.model === undefined
            ? "default"
            : selection.model;
        return selection.slot === "primary" ? name : `failsafe ${name}`;
    }

    function openModelPicker(parent?: TuiSettingsPickerState): void {
        if (parent === undefined) settingsPickerAgent = focusedAgentClient();
        const targetState = focusedAgentState();
        settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
            "model",
            targetState.modelSettings?.model,
            targetState.modelSettings?.reasoningEffort,
            targetState.approvalMode,
            targetState.modelSettings?.availableModels,
            undefined,
            targetState.modelSettings?.provider,
            undefined,
            targetState.modelSettings?.pooled,
        ), parent);
        settingsPicker = {
            ...settingsPicker,
            assignmentOptions: tuiModelAssignmentOptions(
                currentModelAssignmentRows(),
                targetState.modelSettings?.model,
                targetState.modelSettings?.reasoningEffort,
                targetState.modelSettings?.contextLimit,
            ),
            actionOptions: tuiModelActionOptions(
                refreshableProvidersOf(
                    targetState.modelSettings?.availableModels,
                ),
                {
                    hasPool: (targetState.modelSettings?.pooled?.length ?? 0)
                        > 0,
                },
            ),
        };
        // Auth changes happen outside the host's original model snapshot.
        // Refresh here so reopening the picker also repairs a stale model pane
        // that was kept underneath the provider picker.
        requestAgentSettings(focusedAgentClient());
        renderState();
        focusActiveSurface();
    }

    /** The connected providers whose model list can be fetched again. */
    function refreshableProvidersOf(
        models: readonly { readonly provider: string }[] | undefined,
    ): readonly string[] {
        const named = new Set<string>();
        for (const model of models ?? []) {
            if (isRefreshableProvider(model.provider)) {
                named.add(model.provider);
            }
        }
        return [...named].toSorted();
    }

    /** How many models the current snapshot holds for one provider. */
    function catalogSizeOf(provider: string): number {
        return (state.modelSettings?.availableModels ?? [])
            .filter((entry) => entry.provider === provider)
            .length;
    }

    /**
     * Read at the moment the pane opens rather than held from startup: config
     * and the pool are both files the user may have just edited, and this is
     * the surface that claims to show what they say.
     */
    function currentModelAssignmentRows(): readonly ModelAssignmentRow[] {
        const configured = loadOptionalVeraConfig();
        if (configured === undefined) {
            return [];
        }
        return configuredModelAssignments(
            configured,
            poolReachability(loadPoolFile({ projectRoot: process.cwd() }).merged),
        );
    }

    function openModelAssignmentPicker(
        assignment: ModelAssignmentId,
        parent?: TuiSettingsPickerState,
    ): void {
        const targetState = focusedAgentState();
        const row = currentModelAssignmentRows().find((entry) => entry.assignment === assignment);
        settingsPicker = withTuiPickerParent(
            startTuiModelAssignmentPicker(
                assignment,
                row?.label ?? assignment,
                row?.intent ?? "",
                targetState.modelSettings?.pooled,
            ),
            parent,
        );
        renderState();
        focusActiveSurface();
    }

    /**
     * Writes the chosen model onto the assignment, or unbinds it. The write is
     * to the config file because an assignment is a setting, and the host reads
     * that file when a session starts, so the change is live from the next
     * session on with nothing to restart.
     */
    function bindModelAssignmentFromPicker(
        selection: {
            readonly assignment: ModelAssignmentId;
            readonly provider?: string;
            readonly model?: string;
            readonly reasoningEffort?: ModelReasoningEffort;
        },
    ): void {
        const unbinding = selection.model === undefined;
        try {
            updateVeraConfigDefaults({
                model_assignment: {
                    assignment: selection.assignment,
                    binding: unbinding ? null : {
                        models: [{
                            name: derivedModelName(
                                selection.provider as VeraProviderId,
                                selection.model as string,
                            ),
                            provider: selection.provider as VeraProviderId,
                            model: selection.model as string,
                            ...(selection.reasoningEffort === undefined
                                ? {}
                                : { reasoning_effort: selection.reasoningEffort }),
                        }],
                    },
                },
            });
        } catch (error) {
            state = appendTuiError(
                state,
                `Could not write the assignment: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState();
            return;
        }
        state = appendTuiNotice(
            state,
            unbinding
                ? `${selection.assignment} unset. New sessions use it.`
                : `${selection.assignment} → ${
                    selection.reasoningEffort === undefined
                        ? selection.model
                        : `${selection.model} (${selection.reasoningEffort})`
                }. New sessions use it.`,
            "soft",
        );
    }

    async function openConfigureEditor(): Promise<void> {
        renderer.suspend();
        try {
            await (dependencies.openConfigure ?? (() =>
                openFileInEditor(veraConfigPath())))();
            state = appendTuiNotice(
                state,
                "Configure editor closed. Settings apply to new sessions; a"
                + " changed extension list needs a restart.",
            );
        } catch (error) {
            state = appendTuiError(
                state,
                `Could not open config: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            renderer.resume();
            renderState();
            focusActiveSurface();
        }
    }

    /**
     * The level facts for one model, looked up off the wire rather than a
     * flat effort list, so a pane renders exactly what this model offers.
     *
     * A ready pool entry wins over the runnable list: admission narrowed its
     * levels to the ones this key actually verified, and the catalog's full
     * list would offer settings the engine will refuse. A model in neither
     * list (unrecognised, e.g. reached through the `/model <name>` escape
     * hatch) is treated the same as a model with an empty `levels` array: no
     * facts about it have reached the client.
     */
    function modelLevelFacts(
        provider: string | undefined,
        model: string | undefined,
        source: TuiState = focusedAgentState(),
    ): {
        readonly levels: readonly ReasoningLevel[];
        readonly defaultLevel?: ReasoningLevelId;
    } | undefined {
        if (model === undefined) return undefined;
        return levelsForModel(
            provider,
            model,
            source.modelSettings?.pooled ?? [],
            source.modelSettings?.availableModels ?? [],
        );
    }

    function currentModelLevels(): readonly ReasoningLevel[] {
        const targetState = focusedAgentState();
        return modelLevelFacts(
            targetState.modelSettings?.provider,
            targetState.modelSettings?.model,
            targetState,
        )?.levels ?? [];
    }

    function openReasoningPicker(parent?: TuiSettingsPickerState): void {
        if (parent === undefined) settingsPickerAgent = focusedAgentClient();
        const targetState = focusedAgentState();
        // An empty (or unresolved) level list means this model has no
        // reasoning control at all. A card with no rows is indistinguishable
        // from the TUI ignoring the key, so say why there is nothing to pick.
        // This is presentation only: the engine still decides what it will
        // accept.
        const levels = currentModelLevels();
        if (levels.length === 0) {
            state = appendTuiNotice(
                state,
                `${
                    targetState.modelSettings === undefined
                        ? "this model"
                        : `${targetState.modelSettings.provider}/${targetState.modelSettings.model}`
                } has no reasoning effort setting`,
            );
            renderState();
            return;
        }
        const current = modelLevelFacts(
            targetState.modelSettings?.provider,
            targetState.modelSettings?.model,
            targetState,
        );
        settingsPicker = withTuiPickerParent(startTuiReasoningPicker(
            levels,
            current?.defaultLevel,
            targetState.modelSettings?.reasoningEffort,
        ), parent);
        renderState();
        focusActiveSurface();
    }

    function openPermissionsPicker(parent?: TuiSettingsPickerState): void {
        if (parent === undefined) settingsPickerAgent = focusedAgentClient();
        const targetState = focusedAgentState();
        if (targetState.permissionInspection !== undefined) {
            const notice = renderPermissionInspection(
                targetState.permissionInspection,
            );
            if (sidebar.isFocused() && hostedSidebar.pane !== undefined) {
                hostedSidebar.pane.state.state = appendTuiNotice(
                    hostedSidebar.pane.state.state,
                    notice,
                );
                renderSidebarAgent(hostedSidebar.pane);
            } else {
                state = appendTuiNotice(state, notice);
            }
        }
        settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
            "permissions",
            targetState.modelSettings?.model,
            targetState.modelSettings?.reasoningEffort,
            targetState.approvalMode,
            targetState.modelSettings?.availableModels,
            undefined,
            undefined,
            targetState.permissionInspection?.availableModes,
        ), parent);
        renderState();
        focusActiveSurface();
    }

    function openThemePicker(parent?: TuiSettingsPickerState): void {
        settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
            "theme",
            state.modelSettings?.model,
            state.modelSettings?.reasoningEffort,
            state.approvalMode,
            state.modelSettings?.availableModels,
            themeName,
        ), parent);
        renderState();
        focusActiveSurface();
    }

    function openPreferencesList(parent?: TuiSettingsPickerState): void {
        // Opened from the cached inspection, then refreshed by the reply to
        // this fetch. Without the fetch the list could be stale, since a
        // client is only sent an inspection at startup and when something
        // changes it.
        preferencesList = startTuiPreferencesList(state.permissionInspection);
        // Its own overlay rather than a picker pane, so the pane it came from
        // is held here instead of on the state, and closing puts it back.
        preferencesListParent = parent;
        sendCommand({ type: "get_permissions", requestId: randomUUID() });
        composer.blur();
        focusActiveSurface();
        renderState();
    }

    /**
     * The store this client reads and writes credentials through, opened once.
     *
     * The TUI touches `~/.vera/auth.json` directly rather than asking the host
     * to write it. The host re-reads the file
     * on every credential check, so a key saved here is in effect on the next
     * turn with nothing to notify.
     */
    const authStorage: AuthStorage = dependencies.authStorage
        ?? createAuthStorage({
            onQuarantine(quarantinePath) {
                state = appendTuiError(
                    state,
                    `The old credential file could not be read and was moved to ${quarantinePath}`,
                );
                renderState();
            },
        });
    if (dependencies.authStorage === undefined) {
        // Said once, at the point where the pane would otherwise just look
        // empty for no stated reason. The store is left alone until something
        // is actually written to it.
        const unreadable = unreadableAuthStoragePath();
        if (unreadable !== undefined) {
            state = appendTuiError(
                state,
                `${unreadable} could not be read, so no provider shows as connected. Connecting one rewrites it.`,
            );
        }
    }
    /** Providers with a browser sign-in already running, so Enter cannot start a second. */
    const connectingProviders = new Set<string>();

    /**
     * Whether Vera already holds a credential, with an unreadable store read as
     * "no". The pane is a list of what to connect, so a broken `auth.json`
     * should show everything as unconnected rather than throw inside a keypress.
     */
    function providerConnected(provider: Parameters<typeof isProviderConnected>[0]): boolean {
        try {
            return isProviderConnected(provider, { authStorage });
        } catch {
            return false;
        }
    }

    /**
     * The declaration form, opened on a provider that already exists. The key
     * is read back so saving without touching it keeps it, rather than the
     * blank field reading as "no key" and silently dropping one.
     */
    function openProviderEditForm(
        provider: string,
        parent?: TuiSettingsPickerState,
    ): void {
        const declaration = loadOptionalVeraConfig()?.providers?.[provider];
        if (declaration === undefined) {
            return;
        }
        let apiKey: string | undefined;
        try {
            const stored = authStorage.getCredential(provider);
            apiKey = stored?.type === "api_key" ? stored.key : undefined;
        } catch {
            apiKey = undefined;
        }
        providerForm = startTuiProviderForm(parent, {
            id: provider,
            baseUrl: declaration.base_url,
            protocol: declaration.protocol,
            credential: declaration.credential,
            ...(apiKey === undefined ? {} : { apiKey }),
        });
        settingsPicker = undefined;
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function openProviderPicker(
        parent?: TuiSettingsPickerState,
        options: {
            readonly selected?: string;
            readonly subtitle?: string;
        } = {},
    ): void {
        const config = loadOptionalVeraConfig();
        const providers = configuredProviders(config);
        const declared = new Set(Object.keys(config?.providers ?? {}));
        const moved = new Set(Object.keys(config?.provider_endpoints ?? {}));
        settingsPicker = withTuiPickerParent(
            startTuiProviderPicker(
                providers.map((provider) => ({
                    id: provider.id,
                    label: provider.label,
                    group: provider.group === "popular"
                        ? "Popular"
                        : "Providers",
                    // A provider pointed somewhere other than where it ships
                    // says so on its own row: it is the more surprising fact
                    // about it than which credential it takes.
                    ...(moved.has(provider.id)
                        ? { hint: provider.baseUrl ?? "" }
                        : provider.hint === undefined
                        ? {}
                        : { hint: provider.hint }),
                    connected: providerConnected(provider),
                    ...(declared.has(provider.id) ? { declared: true } : {}),
                    ...(provider.fixedEndpoint === true
                        ? {}
                        : { endpointEditable: true }),
                })),
                options,
            ),
            parent,
        );
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    /**
     * Connect one provider, by whatever it is that provider wants.
     *
     * A row that needs no credential says so rather than pretending to connect,
     * since a check mark appearing for a step that never happened is the one
     * thing this pane cannot afford to get wrong.
     */
    function connectProvider(
        providerId: string,
        pane: TuiSettingsPickerState | undefined,
    ): void {
        const provider = findConfiguredProvider(
            providerId,
            loadOptionalVeraConfig(),
        );
        if (provider === undefined) {
            return;
        }
        if (
            provider.credential === "api_key"
            || provider.credential === "api_key_optional"
        ) {
            secretPrompt = startTuiSecretPrompt(provider, pane);
            settingsPicker = undefined;
            composer.blur();
            renderState();
            focusActiveSurface();
            return;
        }
        // Everything below this point answers in the transcript, so the pane
        // goes away first. A notice written behind an open card is a notice the
        // user has to dismiss a modal to discover, and the sign-in URL is the
        // one line they cannot afford to miss.
        settingsPicker = undefined;
        closeSettingsPickerSurface();
        if (provider.credential === "none") {
            state = appendTuiNotice(
                state,
                `${provider.label} needs no credentials${
                    provider.envVar === undefined
                        ? ""
                        : `, point it elsewhere with ${provider.envVar}`
                }`,
                // A standing fact about the provider, not something to do.
                "soft",
            );
            renderState();
            return;
        }
        // Enter can still land twice, from two trips into the pane, and the
        // callback listener binds a fixed port: a second run would fail on the
        // first one's own server.
        if (connectingProviders.has(provider.id)) {
            return;
        }
        connectingProviders.add(provider.id);
        state = appendTuiNotice(
            state,
            `opening a browser to sign in to ${provider.label}…`,
            // Vera saying what it is doing. The line worth the eye is the URL
            // that follows, which is the one the user has to act on.
            "soft",
        );
        renderState();
        void (dependencies.loginProvider ?? defaultLoginProvider)(
            provider.id,
            (url) => {
                state = appendTuiNotice(state, `sign in at ${url}`);
                renderState();
            },
        ).then(() => {
            connectingProviders.delete(provider.id);
            state = appendTuiNotice(state, `connected to ${provider.label}`, "soft");
            renderState();
        }, (error: unknown) => {
            connectingProviders.delete(provider.id);
            state = appendTuiError(
                state,
                `could not connect to ${provider.label}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState();
        });
    }

    /**
     * Ask before forgetting the credential Vera itself stored for a provider.
     *
     * Only a stored secret can be forgotten. `isProviderConnected` counts an
     * environment variable as connected too, and removing nothing while saying
     * "forgotten" would leave the row still marked and the key still in use, so
     * that case names the variable instead. Those cases never reach the
     * confirmation: there is nothing to confirm.
     */
    function forgetProvider(
        providerId: string,
        pane: TuiSettingsPickerState | undefined,
    ): void {
        const provider = findConfiguredProvider(
            providerId,
            loadOptionalVeraConfig(),
        );
        if (provider === undefined) {
            return;
        }
        let stored;
        try {
            stored = authStorage.getCredential(provider.id);
        } catch {
            stored = undefined;
        }
        const decision = tuiProviderForgetDecision(
            provider,
            stored !== undefined,
            provider.envVar === undefined
                ? undefined
                : process.env[provider.envVar],
        );
        // A row that cannot be forgotten answers on the pane itself, under the
        // title, with the cursor still on the row the key was pressed on.
        // Nothing is being confirmed, so nothing has to be stepped away from.
        if (decision.kind === "explain") {
            openProviderPicker(pane, {
                selected: provider.id,
                subtitle: decision.message,
            });
            return;
        }
        providerForgetCandidate = {
            providerId: provider.id,
            label: provider.label,
            pane,
        };
        composer.blur();
        providerForgetConfirmView.update(provider.label);
        renderState();
        focusActiveSurface();
    }

    /**
     * Delete the credential the confirmation named.
     *
     * Nothing checks the store again: `forgetProvider` read it one keypress
     * ago, and a second read would only disagree with what the card promised.
     */
    function forgetProviderCredential(candidate: {
        readonly providerId: string;
        readonly label: string;
        readonly pane: TuiSettingsPickerState | undefined;
    }): void {
        providerForgetCandidate = undefined;
        settingsPicker = undefined;
        closeSettingsPickerSurface();
        try {
            authStorage.deleteCredential(candidate.providerId);
        } catch (error) {
            state = appendTuiError(
                state,
                `could not forget the ${candidate.label} credential: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState();
            return;
        }
        state = appendTuiNotice(
            state,
            `forgot the stored ${candidate.label} credential`,
        );
        requestAgentSettings(focusedAgentClient());
        // Reopened rather than patched: the mark on every row is read from the
        // store, and the store just changed.
        openProviderPicker(candidate.pane, { selected: candidate.providerId });
    }

    async function defaultLoginProvider(
        providerId: string,
        onAuthorizationUrl: (url: string) => void,
    ): Promise<void> {
        if (providerId !== "openai-codex") {
            throw new Error(`No sign-in flow for provider ${providerId}`);
        }
        await loginOpenAICodex({ authStorage, onAuthorizationUrl });
    }

    /**
     * The declaration form, finished or abandoned.
     *
     * The declaration goes to `config.json` and nowhere else. The pane writes
     * the same file a user can still edit by hand, so a refusal from the config
     * writer comes straight back to the form rather than being softened here.
     */
    /**
     * The endpoint form for a provider Vera ships.
     *
     * Prefilled with wherever it answers today, which is the shipped host
     * until the user moves it. A region, a proxy, or a gateway is the same
     * provider somewhere else, so the host is theirs to set.
     */
    function openProviderEndpointForm(
        providerId: string,
        parent?: TuiSettingsPickerState,
    ): void {
        const config = loadOptionalVeraConfig();
        const provider = findConfiguredProvider(providerId, config);
        if (provider === undefined || provider.fixedEndpoint === true) {
            return;
        }
        let apiKey: string | undefined;
        try {
            const stored = authStorage.getCredential(providerId);
            apiKey = stored?.type === "api_key" ? stored.key : undefined;
        } catch {
            apiKey = undefined;
        }
        providerForm = startTuiProviderForm(parent, {
            id: providerId,
            baseUrl: provider.baseUrl ?? "",
            protocol: "openai-chat",
            credential: provider.credential === "none" ? "none" : "api_key",
            shipped: true,
            ...(apiKey === undefined ? {} : { apiKey }),
        });
        settingsPicker = undefined;
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function applyProviderFormTransition(
        form: TuiProviderFormState,
        transition: TuiProviderFormTransition,
    ): void {
        providerForm = transition.state;
        if (providerForm !== undefined) {
            renderState();
            return;
        }
        const submitted = transition.submitted;
        if (submitted === undefined) {
            settingsPicker = form.parent;
            renderState();
            focusActiveSurface();
            return;
        }
        try {
            updateVeraConfigDefaults(
                submitted.shipped === true
                    ? {
                        provider_endpoint: {
                            id: submitted.id,
                            url: submitted.restore === true
                                ? null
                                : submitted.declaration.base_url,
                        },
                    }
                    : {
                        custom_provider: {
                            id: submitted.id,
                            declaration: submitted.declaration,
                        },
                    },
            );
        } catch (error) {
            providerForm = {
                ...form,
                field: "base_url",
                error: error instanceof Error ? error.message : String(error),
            };
            renderState();
            focusActiveSurface();
            return;
        }
        // A rename is a move, not a second declaration: the old entry and the
        // credential under the old name both go, or the pane comes back
        // showing a provider nobody asked for.
        if (submitted.replaces !== undefined) {
            try {
                updateVeraConfigDefaults({
                    custom_provider: {
                        id: submitted.replaces,
                        declaration: null,
                    },
                });
                authStorage.deleteCredential(submitted.replaces);
            } catch (error) {
                state = appendTuiError(
                    state,
                    `renamed to ${submitted.id}, but ${submitted.replaces} `
                        + `could not be removed: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                );
            }
        }
        state = appendTuiNotice(
            state,
            submitted.replaces !== undefined
                ? `renamed ${submitted.replaces} to ${submitted.id}`
                : submitted.restore === true
                ? `${submitted.id} answers where Vera ships it again`
                : submitted.shipped === true
                ? `${submitted.id} now answers at ${submitted.declaration.base_url}`
                : form.editing === undefined
                ? `declared ${submitted.id}`
                : `updated ${submitted.id}`,
        );
        // The key entered on the form goes to the credential store, which is a
        // separate file from the declaration that just landed in config.json.
        if (submitted.apiKey !== undefined) {
            try {
                authStorage.setCredential(submitted.id, {
                    type: "api_key",
                    key: submitted.apiKey,
                });
                state = appendTuiNotice(
                    state,
                    `stored ${submitted.id} API key`,
                );
            } catch (error) {
                state = appendTuiError(
                    state,
                    `could not store the ${submitted.id} API key: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        requestAgentSettings(focusedAgentClient());
        // Rebuilt rather than patched: the connect list is read from the config
        // file, and the file just changed. It opens on the row that was just
        // declared, which is the one the user came here to act on.
        openProviderPicker(form.parent?.parent, { selected: submitted.id });
    }

    function applySecretPromptTransition(
        prompt: TuiSecretPromptState,
        transition: { readonly state?: TuiSecretPromptState; readonly submitted?: string },
    ): void {
        secretPrompt = transition.state;
        if (secretPrompt !== undefined) {
            renderState();
            return;
        }
        if (transition.submitted !== undefined) {
            try {
                authStorage.setCredential(prompt.providerId, {
                    type: "api_key",
                    key: transition.submitted,
                });
                state = appendTuiNotice(state, `stored ${prompt.label} API key`);
                requestAgentSettings(focusedAgentClient());
            } catch (error) {
                state = appendTuiError(
                    state,
                    `could not store the ${prompt.label} API key: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        // Back to the pane the prompt was opened over, rebuilt so the row it
        // came from carries its new mark.
        if (prompt.parent?.kind === "provider") {
            openProviderPicker(prompt.parent.parent);
            return;
        }
        settingsPicker = prompt.parent;
        if (settingsPicker?.kind === "model") {
            requestAgentSettings(focusedAgentClient());
        }
        renderState();
        focusActiveSurface();
    }

    /**
     * The name a picker row was given.
     *
     * The current session is renamed through its own attachment, because that
     * is the client holding the name on screen and the host refuses to write
     * behind an attached client's back. Every other row goes over the host.
     */
    function applySessionRenamePromptTransition(
        prompt: TuiNamePromptState,
        transition: TuiNamePromptTransition,
    ): void {
        namePrompt = transition.state;
        if (namePrompt !== undefined) {
            renderState();
            return;
        }
        // A pool name leaves the pane it was opened over alone: the settings
        // snapshot that follows the write rebuilds it, and the captured parent
        // is the list as it read before the name existed.
        const parent = prompt.parent;
        settingsPicker = prompt.target.kind === "pool"
            ? settingsPicker ?? parent
            : parent;
        if (transition.submitted !== undefined && prompt.target.kind === "pool") {
            sendCommand({
                type: "pool_name",
                requestId: randomUUID(),
                provider: prompt.target.provider,
                model: prompt.target.model,
                name: transition.submitted,
            });
        } else if (
            transition.submitted !== undefined
            && prompt.target.kind === "session"
        ) {
            if (prompt.target.sessionId === client.agentId) {
                const requestId = randomUUID();
                pendingSessionRename = { requestId };
                sendCommand({
                    type: "update_session_name",
                    requestId,
                    name: transition.submitted,
                });
            } else {
                void performSessionRename(
                    prompt.target.sessionId,
                    transition.submitted,
                );
            }
        }
        renderState();
        focusActiveSurface();
    }

    async function performSessionRename(
        sessionId: string,
        name: string | null,
    ): Promise<void> {
        if (dependencies.renameSession === undefined) {
            state = appendTuiError(
                state,
                "Renaming another conversation is unavailable",
            );
            renderState();
            return;
        }
        const generation = clientGeneration;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
            dependencies.renameSession(sessionId, name)
                .catch((): RenameSessionResult => ({
                    status: "rejected",
                    reason: "failed",
                })),
            new Promise<RenameSessionResult>((resolve) => {
                timeout = setTimeout(() => {
                    resolve({ status: "rejected", reason: "failed" });
                }, dependencies.sessionSwitchTimeoutMs
                    ?? SESSION_SWITCH_TIMEOUT_MS);
            }),
        ]);
        clearTimeout(timeout);
        // The session on screen may have been swapped underneath while the
        // host was answering, and this result belongs to the one that left.
        if (shuttingDown || generation !== clientGeneration) return;
        state = result.status === "renamed"
            ? appendTuiNotice(
                state,
                result.name === null
                    ? "session name cleared"
                    : `session renamed: ${result.name}`,
            )
            : appendTuiError(
                state,
                result.reason === "busy"
                    ? "That conversation is open in another client"
                    : result.reason === "not_found"
                    ? "That conversation is no longer available"
                    : result.reason === "invalid"
                    ? "Session name must be 1 to 200 UTF-8 bytes"
                    : "Could not rename that conversation",
            );
        if (result.status === "renamed" && settingsPicker?.kind === "session") {
            await refreshSessionPicker();
        }
        renderState();
    }

    /**
     * The session pane, rebuilt from the host.
     *
     * A rename changes what a row says, and the row text comes from the host
     * listing, so the pane is re-read rather than patched with what was asked
     * for.
     */
    async function refreshSessionPicker(): Promise<void> {
        if (dependencies.listAgents === undefined) return;
        const generation = clientGeneration;
        try {
            const agents = await dependencies.listAgents();
            if (
                shuttingDown || generation !== clientGeneration
                || settingsPicker?.kind !== "session"
            ) {
                return;
            }
            settingsPicker = startTuiSessionPicker(
                agents,
                client.agentId,
                false,
                new Date(),
                false,
                hostedPanePersistence.groups,
            );
            renderState();
        } catch {
            // The pane keeps the rows it has: a failed refresh is not a
            // reason to close what the user is working in.
        }
    }

    function openSettingsMenu(): void {
        settingsPickerAgent = focusedAgentClient();
        settingsPicker = startTuiSettingsMenu(
            "settings",
            focusedAgentState()?.modelSettings?.developer,
        );
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function openSettingsMenuTarget(
        target: TuiSettingsMenuTarget,
        parent?: TuiSettingsPickerState,
    ): void {
        if (target === "model") return openModelPicker(parent);
        if (target === "reasoning") return openReasoningPicker(parent);
        if (target === "theme") return openThemePicker(parent);
        if (target === "context_limit") {
            settingsPicker = withTuiPickerParent(
                startTuiContextLimitPicker(state.modelSettings?.contextLimit),
                parent,
            );
            renderState();
            focusActiveSurface();
            return;
        }
        if (target === "developer") {
            settingsPicker = withTuiPickerParent(
                startTuiDeveloperMenu(state.modelSettings?.developer),
                parent,
            );
            renderState();
            focusActiveSurface();
            return;
        }
        if (target.startsWith("developer_")) {
            const pane = startTuiDeveloperValuePicker(
                target,
                state.modelSettings?.developer,
            );
            if (pane !== undefined) {
                settingsPicker = withTuiPickerParent(pane, parent);
                renderState();
                focusActiveSurface();
                return;
            }
        }
        if (target === "permission_mode") return openPermissionsPicker(parent);
        if (target === "granted_permissions") return openPreferencesList(parent);
        if (target === "reviewer") return openReviewerMenu(parent);
        if (target === "reviewer_primary") {
            return openReviewerPicker("primary", parent);
        }
        if (target === "reviewer_fallback") {
            return openReviewerPicker("fallback", parent);
        }
        settingsPicker = withTuiPickerParent(
            startTuiSettingsMenu("permission_settings"),
            parent,
        );
        renderState();
        focusActiveSurface();
    }

    /**
     * Palette rows run through the composer so a chosen row lands in history and
     * takes the same path a typed command does. Rows with no slash command of
     * their own (and the one row that only starts a command) are dispatched
     * directly instead.
     */
    function runPaletteAction(entry: TuiPaletteEntry): void {
        if (
            entry.action.type === "prefill_composer"
            || entry.slashName === undefined
        ) {
            composer.clearComposer();
            runStandalonePaletteAction(entry.action);
            return;
        }
        composer.setComposerText(`/${entry.slashName}`);
        renderState();
        submitPrompt();
    }

    function runStandalonePaletteAction(action: TuiCommandAction): void {
        if (action.type === "prefill_composer") {
            composer.setComposerText(action.text);
            renderCommandSuggestions();
            renderState();
            composer.focus();
            return;
        }
        if (action.type === "open_model_picker") return openModelPicker();
        if (action.type === "open_reasoning_picker") {
            return openReasoningPicker();
        }
        if (action.type === "open_permissions_picker") {
            return openPermissionsPicker();
        }
        if (action.type === "open_agent_picker") {
            void openAgentPicker();
            return;
        }
        if (action.type === "open_work_tab") return openWorkTab();
        if (action.type === "go_back") return runBack();
        if (action.type === "open_search") return openSearchOverlay();
        if (action.type === "open_theme_picker") return openThemePicker();
        if (action.type === "open_preferences_list") {
            return openPreferencesList();
        }
        if (action.type === "open_settings_menu") return openSettingsMenu();
        if (action.type === "open_help") return openHelp(action.tab);
        renderState();
        focusActiveSurface();
    }

    function runBack(): void {
        if (backOriginId === undefined) {
            state = appendTuiNotice(
                state,
                "Nothing to go back to. /work lists what needs you.",
            );
            renderState();
            return;
        }
        if (dependencies.listAgents === undefined) {
            state = appendTuiError(state, "Switching sessions is unavailable");
            renderState();
            return;
        }
        const target = backOriginId;
        void dependencies.listAgents().then((agents) => {
            if (shuttingDown) return;
            const origin = agents.find((agent) => agent.id === target);
            if (origin === undefined) {
                backOriginId = undefined;
                state = appendTuiNotice(
                    state,
                    "The conversation you came from is gone."
                        + " /resume lists what is still here.",
                );
                renderState();
                return;
            }
            beginSessionResume(origin.session_path, origin.id, true);
        }).catch((error) => {
            if (shuttingDown) return;
            state = appendTuiError(
                state,
                `Could not go back: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState();
        });
    }

    function jumpMenuContentWidth(): number {
        return Math.max(10, jumpMenuBox.width - 4);
    }

    function closeJumpMenu(): void {
        jumpMenu = undefined;
        jumpMenuBox.visible = false;
        composer.focus();
        renderer.requestRender();
    }

    function renderJumpMenu(): void {
        if (jumpMenu === undefined) {
            jumpMenuBox.visible = false;
            renderer.requestRender();
            return;
        }
        const widest = jumpMenu.rows.reduce(
            (columns, row) =>
                Math.max(
                    columns,
                    row.label.length + (row.detail?.length ?? 0) + 8,
                ),
            24,
        );
        const boxWidth = Math.min(widest, Math.max(24, renderer.width - 8));
        jumpMenuBox.width = boxWidth;
        const lines = jumpMenuLines(jumpMenu, Math.max(10, boxWidth - 4));
        jumpMenuBox.height = lines.length + 2;
        jumpMenuText.content = new StyledText(lines.flatMap((line, index) => [
            line.role === "header"
                ? fg(TUI_MUTED)(line.text)
                : fg(line.selected === true ? TUI_ACCENT : TUI_TEXT)(
                    line.text,
                ),
            ...(index === lines.length - 1 ? [] : [fg(TUI_TEXT)("\n")]),
        ]));
        positionCommandSuggestions();
        jumpMenuBox.visible = true;
        renderer.requestRender();
    }

    function runJumpTo(row: JumpRow): void {
        jumpMenu = undefined;
        jumpMenuBox.visible = false;
        beginSessionResume(
            row.sessionPath,
            row.sessionId,
            row.kind === "back",
        );
    }

    function openJumpMenuOverlay(): void {
        if (jumpMenu !== undefined || anyOverlayOpen()) return;
        if (dependencies.listAgents === undefined) {
            state = appendTuiNotice(
                state,
                "Jumping between conversations is unavailable on this host",
            );
            renderState();
            return;
        }
        void dependencies.listAgents().then((agents) => {
            if (shuttingDown || anyOverlayOpen()) return;
            const currentId = client.agentId;
            const originAgent = agents.find((agent) =>
                agent.id === backOriginId
            );
            const back: JumpOrigin | undefined = originAgent === undefined
                ? undefined
                : {
                    sessionId: originAgent.id,
                    sessionPath: originAgent.session_path,
                    title: originAgent.title ?? originAgent.name
                        ?? "previous conversation",
                };
            const needsYou = (workIndex?.rows ?? []).filter((row) =>
                row.section === "needs_you"
            );
            jumpMenu = openJumpMenuState(buildJumpRows({
                currentId,
                back,
                needsYou,
                agents,
            }));
            if (jumpMenu === undefined) {
                state = appendTuiNotice(
                    state,
                    "Nowhere to jump: nothing needs you and this conversation"
                        + " has no parent or children",
                );
                renderState();
                return;
            }
            renderJumpMenu();
        }).catch((error) => {
            if (shuttingDown) return;
            state = appendTuiError(
                state,
                `Could not build the jump menu: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState();
        });
    }

    function openWorkTab(): void {
        if (workIndex === undefined) {
            state = appendTuiError(
                state,
                "This host does not report work; reconnect to see the inbox",
            );
            renderState();
            composer.focus();
            return;
        }
        workTab = startWorkTab(workIndex);
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    /**
     * Open the side bar on the session already on screen.
     *
     * The roster is read once here. Status after that arrives on the work
     * index the host pushes on every roster transition, so nothing polls.
     */
    function openWorkspaceSidebar(
        options: { readonly focus?: boolean; readonly persist?: boolean } = {},
    ): void {
        if (dependencies.listAgents === undefined) {
            state = appendTuiError(
                state,
                "This host does not list sessions; reconnect to switch",
            );
            renderState();
            composer.focus();
            return;
        }
        const generation = clientGeneration;
        const focus = options.focus !== false;
        if (options.persist !== false) {
            workspaceSidebarDocked = true;
            try {
                saveTuiWorkspaceSidebarDocked(true);
            } catch {
                // A preference write cannot stop the rail opening now.
            }
        }
        void dependencies.listAgents().then((agents) => {
            if (shuttingDown || generation !== clientGeneration) return;
            const sessions = workspaceSidebarSessions(agents);
            const opened = startWorkspaceSidebar(
                sessions,
                workspacePinnedIds,
                client.agentId,
            );
            workspaceSidebar = workIndex === undefined
                ? opened
                : applyWorkspaceWorkIndex(opened, workIndex);
            workspaceSidebarFocused = focus;
            if (focus) composer.blur();
            renderState();
            focusActiveSurface();
        }).catch((error) => {
            if (shuttingDown) return;
            state = appendTuiError(
                state,
                `Could not list sessions: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState();
        });
    }

    /**
     * The roster read again, on the push that already says the roster moved.
     *
     * The pane keeps the rows it has until the new listing arrives, so a
     * refresh that is slow or fails leaves the reader looking at the last good
     * listing rather than at nothing.
     */
    function refreshWorkspaceSidebarRoster(): void {
        if (dependencies.listAgents === undefined) return;
        const generation = clientGeneration;
        void dependencies.listAgents().then((agents) => {
            if (shuttingDown || generation !== clientGeneration) return;
            const open = workspaceSidebar;
            if (open === undefined) return;
            const listed = refreshWorkspaceSidebarSessions(
                open,
                workspaceSidebarSessions(agents),
            );
            workspaceSidebar = workIndex === undefined
                ? listed
                : applyWorkspaceWorkIndex(listed, workIndex);
            renderState();
        }).catch(() => {
            // Nothing to say: the rows already listed are still the best
            // answer, and the next push asks again.
        });
    }

    /**
     * Where the listing is drawn: a full-height column down the left edge with
     * the whole chat surface beside it, or a card when the terminal is too
     * narrow to hold both.
     *
     * The transcript reflows into what the rail leaves it, so the rows it had
     * are not the rows it has. The reader's place is captured before the width
     * changes and restored after it, which is what a resize does for the same
     * reason.
     */
    function applyWorkspaceRail(): void {
        const columns = workspaceSidebar === undefined
            ? undefined
            : workspaceRailColumns(renderer.width, workspaceRailPreferred);
        if (columns !== workspaceRail) {
            workspaceRail = columns;
            if (transcriptFollowsBottom()) {
                pendingTranscriptScrollRestore = { scrollTop: 0, atBottom: true };
            } else {
                captureTranscriptScrollAnchor();
            }
            workspaceSidebarView.setRail(columns);
        }
        const occupied = workspaceSidebarView.railColumns() ?? 0;
        // The navigator owns a full-height column like an editor sidebar.
        // Reserving that width on the app moves the transcript, composer,
        // status rows and dialogs together; nothing from the chat can run
        // underneath the dock.
        app.paddingLeft = occupied;
        workspaceSidebarView.surface.left = 0;
        const pickerBesideRail = columns !== undefined
            && settingsPicker !== undefined
            && workspaceStaysBesideSettingsPicker(settingsPicker);
        overlayScrim.left = pickerBesideRail ? occupied : 0;
        overlayScrim.width = pickerBesideRail
            ? Math.max(0, renderer.width - occupied)
            : renderer.width;
        statusBand.left = occupied;
        statusBand.width = Math.max(0, renderer.width - occupied);
        commandSuggestionsBox.left = occupied;
        jumpMenuBox.left = occupied
            + tuiComposerOverlayInset(appearance).paddingLeft;
        sidebar.body.paddingLeft = 0;
        sidebar.refit();
    }

    function resizeWorkspaceRailAt(pointerColumn: number): void {
        if (workspaceRail === undefined) return;
        const occupied = workspaceSidebarView.railColumns();
        if (occupied === undefined) return;
        const inset = occupied - workspaceRail;
        const next = clampWorkspaceRailColumns(
            pointerColumn + 1 - inset,
            renderer.width,
        );
        if (next === undefined || next === workspaceRail) return;
        workspaceRailPreferred = next;
        renderState();
    }

    function workspaceStaysBesideSettingsPicker(
        picker: TuiAnySettingsPickerState,
    ): boolean {
        if (picker.kind === "extension") return false;
        return picker.kind === "model"
            || picker.parent?.kind === "model"
            || picker.pendingModel !== undefined;
    }

    function fitSettingsPickerBesideWorkspace(
        picker: TuiAnySettingsPickerState,
    ): void {
        if (
            workspaceRail === undefined
            || !workspaceStaysBesideSettingsPicker(picker)
        ) return;
        const occupied = workspaceSidebarView.railColumns() ?? 0;
        const chatColumns = Math.max(0, renderer.width - occupied);
        settingsPickerView.box.left = occupied + Math.floor(chatColumns * 0.1);
        settingsPickerView.box.width = Math.max(
            20,
            Math.floor(chatColumns * 0.8),
        );
    }

    function closeWorkspaceSidebar(): void {
        workspaceSidebar = undefined;
        workspaceSidebarFocused = false;
        workspaceSidebarDocked = false;
        workspaceRailDragging = false;
        workspaceSidebarView.box.borderColor = theme.element;
        try {
            saveTuiWorkspaceSidebarDocked(false);
        } catch {
            // The current layout still closes when persistence cannot update.
        }
        workspaceSidebarView.surface.visible = false;
        composer.focus();
        renderState();
        focusActiveSurface();
    }

    function runWorkspaceSidebarAction(action: WorkspaceSidebarAction): void {
        if (action.kind === "close") {
            workspaceSidebarFocused = false;
            composer.focus();
            renderState();
            focusActiveSurface();
            return;
        }
        if (action.kind === "pin") {
            workspacePinnedIds = action.pinnedIds;
            try {
                saveTuiPinnedSessionIds(action.pinnedIds);
            } catch {
                // A preference write cannot stop the list from reordering.
            }
            renderState();
            focusActiveSurface();
            return;
        }
        workspaceSidebarFocused = false;
        composer.focus();
        renderState();
        beginSessionResume(action.session_path, action.session_id);
    }

    function closeWorkSurfaces(): void {
        workTab = undefined;
        searchOverlay = undefined;
        // The scan already running finishes and finds no overlay to fill; the
        // one waiting behind it never starts.
        queuedSearch = undefined;
        workTabView.surface.visible = false;
        searchOverlayView.surface.visible = false;
        composer.focus();
        renderState();
        focusActiveSurface();
    }

    /**
     * Every row opens its session, and answering happens there.
     *
     * A needs-you row is no exception: switching to the session puts its own
     * approval or question card on screen, which is the surface that owns the
     * decision. Answering from the inbox would be a second way to decide, and
     * the one that never showed the request.
     */
    function runWorkTabAction(
        open: WorkTabState,
        action:
            | { readonly kind: "close" }
            | {
                readonly kind:
                    | "answer_request"
                    | "open_session"
                    | "open_result";
                readonly session_id: string;
            },
    ): void {
        if (action.kind === "close") {
            closeWorkSurfaces();
            return;
        }
        const row = open.index.rows.find(
            (candidate) => candidate.session_id === action.session_id,
        );
        closeWorkSurfaces();
        if (row !== undefined) {
            beginSessionResume(row.session_path, row.session_id);
        }
    }

    function runSearchOverlayAction(
        action:
            | { readonly kind: "close" }
            | {
                readonly kind: "search";
                readonly query: SessionSearchQuery;
            }
            | {
                readonly kind: "open";
                readonly session_id: string;
                readonly session_path: string;
                readonly entry_id: string | null;
            },
    ): void {
        if (action.kind === "close") {
            closeWorkSurfaces();
            return;
        }
        if (action.kind === "open") {
            closeWorkSurfaces();
            // Set before the switch, so the first paint of the session that
            // arrives is the one that scrolls.
            pendingSearchTarget = action.entry_id === null
                ? undefined
                : { sessionId: action.session_id, entryId: action.entry_id };
            beginSessionResume(action.session_path, action.session_id);
            return;
        }
        renderState();
        focusActiveSurface();
        if (dependencies.searchSessions === undefined) {
            searchOverlay = searchOverlay === undefined
                ? undefined
                : applySearchFailure(
                    searchOverlay,
                    action.query,
                    "Searching past work is unavailable on this host",
                );
            renderState();
            return;
        }
        beginSearch(action.query);
    }

    /**
     * Run one scan at a time, remembering only the newest query asked for.
     *
     * Every keystroke asks, and each ask reads every transcript on the machine.
     * Firing them all would put one scan per character on the host and finish
     * them out of order; queueing all of them would scan for prefixes nobody is
     * still looking at. Only the last query typed is worth answering.
     */
    function beginSearch(query: SessionSearchQuery): void {
        if (searchInFlight) {
            queuedSearch = query;
            return;
        }
        searchInFlight = true;
        const finish = (): void => {
            searchInFlight = false;
            const next = queuedSearch;
            queuedSearch = undefined;
            if (next !== undefined && !shuttingDown
                && searchOverlay !== undefined) {
                beginSearch(next);
            }
        };
        void dependencies.searchSessions!(query).then((results) => {
            if (!shuttingDown && searchOverlay !== undefined) {
                searchOverlay = applySearchResults(
                    searchOverlay,
                    query,
                    results,
                );
                renderState();
            }
        }, (error) => {
            if (!shuttingDown && searchOverlay !== undefined) {
                searchOverlay = applySearchFailure(
                    searchOverlay,
                    query,
                    error instanceof Error ? error.message : String(error),
                );
                renderState();
            }
        }).finally(finish);
    }

    function openSearchOverlay(): void {
        searchOverlay = startSearchOverlay(client.workspace ?? process.cwd());
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function openCommandPalette(): void {
        commandPalette = startTuiCommandPalette(registeredPaletteEntries());
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function openHelp(tab: "general" | "keys" = "general"): void {
        const nextHelp = startTuiHelp(coreHelpCommands(), hostExtensionCommands);
        help = tab === "general" ? nextHelp : { ...nextHelp, tab };
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function applySettingsPickerTransition(
        transition:
            | TuiSettingsPickerTransition
            | TuiExtensionPickerTransition,
    ): void {
        const extensionPickerWasOpen = settingsPicker?.kind === "extension";
        // Captured before the reassignment below so a model selection that
        // needs to chain into a level pane can hand the model pane back to
        // Escape: `handleTuiSettingsPickerKey` returns no `state` on Enter,
        // so this is the only place that still has it.
        const previousPicker = settingsPicker;
        const returningToModelPicker = settingsPicker?.kind !== "model"
            && transition.state?.kind === "model";
        settingsPicker = transition.state;
        if (
            extensionPickerWasOpen
            && transition.selection?.kind === "extension"
        ) {
            const pending = pendingExtensionPicker;
            pendingExtensionPicker = undefined;
            pending?.removeAbortListener();
            pending?.resolve({
                outcome: "selected",
                rowId: transition.selection.rowId,
                actionId: transition.selection.actionId,
            });
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        } else if (
            extensionPickerWasOpen
            && transition.state === undefined
            && transition.selection === undefined
        ) {
            const pending = pendingExtensionPicker;
            pendingExtensionPicker = undefined;
            pending?.removeAbortListener();
            pending?.resolve({ outcome: "cancelled" });
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        }
        if (
            "previewTheme" in transition
            && transition.previewTheme !== undefined
        ) {
            scheduleThemePreview(transition.previewTheme);
        }
        if (
            "trashCandidate" in transition
            && transition.trashCandidate !== undefined
        ) {
            sessionTrashCandidate = transition.trashCandidate;
        }
        if (
            "renameCandidate" in transition
            && transition.renameCandidate !== undefined
        ) {
            namePrompt = startTuiNamePrompt(
                {
                    kind: "session",
                    sessionId: transition.renameCandidate.sessionId,
                },
                transition.renameCandidate.label,
                previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker,
            );
            renderState();
            focusActiveSurface();
            return;
        }
        if ("openProviders" in transition && transition.openProviders === true) {
            // The model pane stays underneath: connecting a provider is a
            // detour on the way to picking a model, not a change of subject.
            // The pane it returns to is the one the transition left behind, not
            // the one the key arrived on: ⇥ onto Providers wraps the list back
            // to its first tab, and Escape has to land on that.
            openProviderPicker(
                settingsPicker?.kind === "model"
                    ? settingsPicker
                    : previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker,
            );
            return;
        }
        if (
            "forgetProvider" in transition
            && transition.forgetProvider !== undefined
        ) {
            forgetProvider(
                transition.forgetProvider,
                previousPicker?.kind === "provider"
                    ? previousPicker.parent
                    : undefined,
            );
            return;
        }
        if (
            "editProvider" in transition
            && transition.editProvider !== undefined
        ) {
            openProviderEditForm(
                transition.editProvider,
                previousPicker?.kind === "provider" ? previousPicker : undefined,
            );
            return;
        }
        if (
            "editEndpoint" in transition
            && transition.editEndpoint !== undefined
        ) {
            openProviderEndpointForm(
                transition.editEndpoint,
                previousPicker?.kind === "provider" ? previousPicker : undefined,
            );
            return;
        }
        if (
            "declareProvider" in transition
            && transition.declareProvider === true
        ) {
            providerForm = startTuiProviderForm(
                previousPicker?.kind === "provider" ? previousPicker : undefined,
            );
            settingsPicker = undefined;
            composer.blur();
            renderState();
            focusActiveSurface();
            return;
        }
        if (
            "refreshCatalog" in transition
            && transition.refreshCatalog !== undefined
        ) {
            requestCatalogRefresh(transition.refreshCatalog);
            return;
        }
        if (
            "refreshCatalogScope" in transition
            && transition.refreshCatalogScope === true
        ) {
            openCatalogRefreshScopePicker();
            return;
        }
        if ("poolVerifySweep" in transition && transition.poolVerifySweep === true) {
            openPoolVerifyScopePicker();
            return;
        }
        if ("poolVerify" in transition && transition.poolVerify !== undefined) {
            openVerifyDialog(
                transition.poolVerify.provider,
                transition.poolVerify.model,
            );
            return;
        }
        if ("poolName" in transition && transition.poolName !== undefined) {
            namePrompt = startTuiNamePrompt(
                {
                    kind: "pool",
                    provider: transition.poolName.provider,
                    model: transition.poolName.model,
                },
                transition.poolName.label,
                previousPicker?.kind === "extension" ? undefined : previousPicker,
            );
            renderState();
            focusActiveSurface();
            return;
        }
        if ("poolMove" in transition && transition.poolMove !== undefined) {
            // Same rule as the toggle: the pane is rebuilt from the snapshot
            // that comes back, not from a guess about where the row landed.
            const move = transition.poolMove;
            sendCommand({
                type: "pool_move",
                requestId: randomUUID(),
                provider: move.provider,
                model: move.model,
                delta: move.delta,
            });
            return;
        }
        if ("poolToggle" in transition && transition.poolToggle !== undefined) {
            // The pane stays open and stays on the same row. It is not updated
            // here: the settings snapshot that comes back rebuilds it, so what
            // the user sees is what the host stored rather than a guess.
            const toggle = transition.poolToggle;
            poolChangeUndo = undefined;
            if (settingsPicker?.kind === "model") {
                settingsPicker = {
                    ...settingsPicker,
                    canUndoPoolChange: false,
                };
            }
            if (toggle.action === "add") {
                // The name prompt follows the verdict, not the keypress: a
                // model that never made it into the pool cannot be named.
                const requestId = requestPoolAdmission(
                    toggle.provider,
                    toggle.model,
                );
                pendingPoolName = {
                    requestId,
                    provider: toggle.provider,
                    model: toggle.model,
                    label: `${toggle.provider}/${toggle.model}`,
                };
                pendingPoolChanges.set(requestId, {
                    action: "remove",
                    provider: toggle.provider,
                    model: toggle.model,
                });
                return;
            }
            const removed = state.modelSettings?.pooled?.find((entry) =>
                entry.provider === toggle.provider
                && entry.model === toggle.model
            );
            const requestId = randomUUID();
            pendingPoolChanges.set(requestId, {
                action: "add",
                provider: toggle.provider,
                model: toggle.model,
                ...(removed?.poolName === undefined
                    ? {}
                    : { poolName: removed.poolName }),
            });
            sendCommand({
                type: "pool_remove",
                requestId,
                provider: toggle.provider,
                model: toggle.model,
            });
        }
        if (
            "undoPoolChange" in transition
            && transition.undoPoolChange === true
            && poolChangeUndo !== undefined
        ) {
            const undo = poolChangeUndo;
            if (settingsPicker?.kind === "model") {
                settingsPicker = {
                    ...settingsPicker,
                    canUndoPoolChange: false,
                };
            }
            if (undo.action === "remove") {
                const requestId = randomUUID();
                pendingPoolUndos.set(requestId, {
                    undo,
                    completesOnSettings: true,
                });
                sendCommand({
                    type: "pool_remove",
                    requestId,
                    provider: undo.provider,
                    model: undo.model,
                });
            } else {
                const requestId = requestPoolAdmission(
                    undo.provider,
                    undo.model,
                );
                pendingPoolUndos.set(requestId, {
                    undo,
                    completesOnSettings: undo.poolName === undefined,
                });
            }
            return;
        }
        if (transition.selection !== undefined) {
            const selection = transition.selection;
            if (selection.kind === "extension") {
                return;
            }
            if (selection.kind === "model") {
                // Choosing a model runs it and nothing else. The pool is the
                // user's own shortlist, so it is only ever written by the key
                // that says so.
                const chosenLevels = selection.reasoningEffort === undefined
                    ? modelLevelFacts(selection.provider, selection.model)
                    : undefined;
                if (
                    chosenLevels !== undefined
                    && chosenLevels.levels.length > 0
                    && previousPicker?.kind === "model"
                ) {
                    // A model with levels opens the level pane instead of
                    // closing: Enter there folds both choices into one patch.
                    settingsPicker = startTuiReasoningPicker(
                        chosenLevels.levels,
                        chosenLevels.defaultLevel,
                        state.modelSettings?.reasoningEffort,
                        {
                            provider: selection.provider,
                            model: selection.model,
                            modelPaneState: previousPicker,
                        },
                    );
                    composer.blur();
                    settingsPickerView.update(settingsPicker);
                    settingsPickerView.box.focus();
                    renderState();
                    return;
                }
                const chosen = selection.reasoningEffort === undefined
                    ? `${selection.provider}/${selection.model}`
                    : `${selection.provider}/${selection.model} (${selection.reasoningEffort})`;
                requestModelSettingsChange(
                    {
                        provider: selection.provider,
                        model: selection.model,
                        ...(selection.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: selection.reasoningEffort }),
                    },
                    `model → ${chosen}`,
                    `the model to ${chosen}`,
                    settingsPickerAgent,
                );
            } else if (selection.kind === "provider") {
                connectProvider(
                    selection.providerId,
                    previousPicker?.kind === "extension"
                        ? undefined
                        : previousPicker,
                );
                return;
            } else if (selection.kind === "reasoning") {
                requestModelSettingsChange(
                    { reasoningEffort: selection.reasoningEffort },
                    `reasoning → ${selection.reasoningEffort}`,
                    `reasoning to ${selection.reasoningEffort}`,
                    settingsPickerAgent,
                );
            } else if (selection.kind === "permissions") {
                if (selection.mode === "full_access") {
                    confirmingFullAccess = true;
                    confirmingFullAccessAgent = settingsPickerAgent;
                } else {
                    requestPermissionsChange(
                        selection.mode,
                        settingsPickerAgent,
                    );
                }
            } else if (selection.kind === "theme") {
                themeName = selection.theme;
                saveTuiThemePreference(themeName);
                void applySelectedTheme(themeName, true);
            } else if (selection.kind === "context_limit") {
                const label = selection.limit === null
                    ? "Auto"
                    : formatContextLimit(selection.limit);
                requestModelSettingsChange(
                    { contextLimit: selection.limit },
                    `context limit → ${label}`,
                    `context limit to ${label}`,
                    settingsPickerAgent,
                );
            } else if (selection.kind === "developer") {
                requestModelSettingsChange(
                    { developer: selection.patch },
                    developerChangeLabel(selection.patch),
                    developerChangeLabel(selection.patch),
                    settingsPickerAgent,
                );
            } else if (selection.kind === "menu") {
                // A menu row opens the next surface over this one, which stays
                // remembered as its parent so leaving comes back here.
                settingsPicker = undefined;
                openSettingsMenuTarget(
                    selection.target,
                    previousPicker?.kind === "extension"
                        ? undefined
                        : previousPicker,
                );
                return;
            } else if (selection.kind === "reviewer") {
                const patch = reviewerPatchFor(selection);
                if (patch === undefined) {
                    showStatusNotice("Choose a primary reviewer first");
                } else {
                    requestModelSettingsChange(
                        { reviewer: patch },
                        `reviewer → ${reviewerToast(selection)}`,
                        `the ${selection.slot === "primary"
                            ? "reviewer"
                            : "failsafe reviewer"}`,
                        settingsPickerAgent,
                    );
                }
            } else if (selection.kind === "pool_verify_scope") {
                startPoolVerifySweep(selection.onlyUnverified);
                return;
            } else if (selection.kind === "catalog_refresh_scope") {
                startCatalogRefreshSweep(selection.providers);
                return;
            } else if (selection.kind === "model_assignment_browse") {
                // Keeping a model is what makes it available as a default, so
                // the row that says so lands on the collection it is kept in
                // rather than leaving the user to find it.
                openModelPicker();
                settingsPicker = switchedModelTab(
                    settingsPicker as TuiSettingsPickerState,
                    "pool",
                );
                renderState();
                focusActiveSurface();
                return;
            } else if (selection.kind === "model_assignment_open") {
                // The pane the row was chosen on, which Enter has already
                // cleared from `settingsPicker`: without it Escape closes the
                // card instead of stepping back to the list.
                openModelAssignmentPicker(
                    selection.assignment,
                    previousPicker?.kind === "extension"
                        ? undefined
                        : previousPicker,
                );
                return;
            } else if (selection.kind === "model_assignment") {
                // A model with levels asks for one before the write, the same
                // chain the session's own model goes through: an assignment
                // that named a model but no level would run the provider's
                // default rather than the one the user meant.
                const assignedLevels = selection.model === undefined
                    || selection.reasoningEffort !== undefined
                    ? undefined
                    : modelLevelFacts(selection.provider, selection.model);
                if (
                    assignedLevels !== undefined
                    && assignedLevels.levels.length > 0
                    && previousPicker?.kind === "model_assignment"
                ) {
                    settingsPicker = startTuiReasoningPicker(
                        assignedLevels.levels,
                        assignedLevels.defaultLevel,
                        undefined,
                        {
                            provider: selection.provider as string,
                            model: selection.model as string,
                            modelPaneState: previousPicker,
                            assignment: selection.assignment,
                        },
                    );
                    composer.blur();
                    settingsPickerView.update(settingsPicker);
                    settingsPickerView.box.focus();
                    renderState();
                    return;
                }
                bindModelAssignmentFromPicker(selection);
            } else {
                // Picking a session from the list is where the person meant
                // to go, not a hop taken to answer something: there is no trip
                // to offer them back from.
                beginSessionResume(
                    selection.sessionPath,
                    selection.sessionId,
                    false,
                    false,
                );
                return;
            }
            // Where the stack goes next is `tuiPickerAfterSelection`'s rule.
            // A confirmation overrides it: it is its own modal level, and the
            // menu would sit open behind it.
            settingsPicker = confirmingFullAccess
                    || previousPicker?.kind === "extension"
                ? undefined
                : tuiPickerAfterSelection(selection, previousPicker);
        }
        if (sessionTrashCandidate !== undefined) {
            composer.blur();
            sessionTrashConfirmView.update(sessionTrashCandidate.label);
            sessionTrashConfirmView.box.focus();
        } else if (providerForgetCandidate !== undefined) {
            composer.blur();
            providerForgetConfirmView.update(providerForgetCandidate.label);
            providerForgetConfirmView.box.focus();
        } else if (settingsPicker === undefined) {
            closeSettingsPickerSurface();
        } else {
            composer.blur();
            settingsPickerView.update(settingsPicker);
            settingsPickerView.box.focus();
        }
        if (returningToModelPicker) {
            requestAgentSettings(focusedAgentClient());
        }
        renderState();
    }

    /**
     * Take the picker card off the screen and give the composer the cursor back.
     *
     * Clearing `settingsPicker` is not enough on its own: the card is a
     * renderable that stays visible until it is hidden, so a path that closes
     * the pane and returns early has to come through here or it leaves a dead
     * card over the transcript it just started writing to.
     */
    function closeSettingsPickerSurface(): void {
        settingsPickerView.box.visible = false;
        settingsPickerAgent = undefined;
        if (pendingUiRequest === undefined) {
            composer.focus();
        }
    }

    /**
     * Put another session on screen without taking the screen away.
     *
     * The renderer, the extension registry, the theme, and the composer's own
     * widgets all outlive the switch: nothing about them belongs to a session.
     * What is reset is everything the old session put on screen or was waiting
     * on, and the host refills the transcript by replaying history to the new
     * attachment, which is the same path a fresh attach already takes.
     *
     * The draft carries over on purpose. A half-written prompt is the user's,
     * not the session's, and losing it to a keystroke that was meant to change
     * which conversation it lands in is the worst possible time to lose it.
     */
    function switchToClient(
        next: TuiAgentClient,
        draft?: TuiDraft,
        options: { readonly preserveSidebar?: boolean } = {},
    ): void {
        recordSessionSwitchOutcome("completed");
        const previous = client;
        clientGeneration += 1;
        // The old session owned these calls; nothing will answer them now.
        for (const pending of [...pendingConsults.values()]) {
            pending.reject(new Error("The conversation changed"));
        }
        rejectPendingExtensionSettingsFor(
            previous,
            new Error("The conversation changed"),
        );
        client = next;
        if (workspaceSidebar !== undefined && next.agentId !== undefined) {
            workspaceSidebar = {
                ...workspaceSidebar,
                currentId: next.agentId,
                selectedId: next.agentId,
            };
            refreshWorkspaceSidebarRoster();
        }
        if (next.agentId !== undefined) {
            flightRecorder?.sessionEntered(next.agentId);
        }
        setTuiWorkspaceRoot(next.workspace ?? process.cwd());
        void previous.detach().catch(() => previous.close());

        // The sidebar and any mentions belonged to the conversation being
        // left, so the client takes them down and each extension is told to
        // let go of whatever else it was holding.
        if (options.preserveSidebar !== true) {
            const previousSidebarAgent = hostedSidebar.release();
            if (previousSidebarAgent !== undefined) {
                rejectPendingExtensionSettingsFor(
                    previousSidebarAgent.client,
                    new Error("The conversation changed"),
                );
            }
            void previousSidebarAgent?.detach().catch(() =>
                previousSidebarAgent.close()
            );
            clearSidebarEntryNodes();
            sidebar.clear();
            sidebar.setHeader(undefined);
            sidebar.close();
            forgetPersistedAgentPane(previous.agentId);
            extensionMentions = [];
            extensionAddressee = undefined;
        }
        rememberOpenPaneGroup();
        experimentalTuiHost.conversationChanged();
        clientExtensionRegistry?.conversationChanged();

        state = createTuiState();
        // A hop the notice never landed in is over; it must not surface in
        // whichever conversation rebuilds next.
        pendingBackNotice = undefined;
        if (next.agentId !== undefined) {
            try {
                dependencies.onSessionEntered?.(next.agentId);
            } catch (error) {
                state = appendTuiNotice(state, recentSessionSaveFailure(error));
            }
        }
        connectionFailed = false;
        connectionFailure = undefined;
        abortRequested = false;
        workingSince = undefined;
        phaseSince = undefined;
        pendingUiRequest = undefined;
        queuedUiRequests.length = 0;
        pendingImages = [];
        submitAfterImageAttachment = false;
        promptSubmitting = false;
        pendingSessionRename = undefined;
        sessionSwitchPending = false;
        sessionTrashCandidate = undefined;
        sessionTrashPending = false;
        providerForgetCandidate = undefined;
        timelinePicker = undefined;
        settingsPicker = undefined;
        secretPrompt = undefined;
        namePrompt = undefined;
        providerForm = undefined;
        preferencesList = undefined;
        preferencesListParent = undefined;
        confirmingFullAccess = false;
        admissionDialog = undefined;
        admissionReturnPicker = undefined;
        extensionCommandsGeneration += 1;
        disposeHostExtensionCommands();
        disposeHostExtensionCommands = () => {};
        hostExtensionCommands = [];
        extensionCommandsLoading = next.listExtensionCommands !== undefined
            && next.failed !== true;
        watchBackgroundAgents(next);
        watchWorkIndex(next);
        sessionTitle = undefined;
        mainHeaderVisible = true;
        sidebarHeaderVisible = true;
        applyTerminalTitle();
        refreshTerminalTitle();
        clearTranscriptNodes();

        composer.clearComposer();
        if (draft !== undefined) {
            composer.setComposerText(draft.text);
            pendingImages = draft.attachmentIds.map((id) => ({
                requestId: randomUUID(),
                id,
            }));
        }
        settingsPickerView.box.visible = false;
        focusActiveSurface();
        renderCommandSuggestions();
        renderState();
        void receiveAgentUpdates();
        if (next.failed !== true) {
            void loadExtensionCommands();
            requestSessionSettings();
        }
    }

    /**
     * Move to the session a picker row named.
     *
     * The draft is read before the switch and handed back to it, so a prompt
     * typed against the wrong conversation can be sent to the right one.
     */
    function beginSessionResume(
        sessionPath: string,
        sessionId?: string,
        viaBack = false,
        armsBack = true,
    ): void {
        const openingInSidebar = sidebar.isFocused()
            && hostedSidebar.pane !== undefined;
        settingsPicker = undefined;
        if (sessionId !== undefined && sessionId === client.agentId) {
            // The row for the session already on screen. Tearing down that
            // session's own transcript to put it back is a worse answer to
            // "this one" than simply leaving.
            setSidebarFocused(false);
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        }
        if (
            openingInSidebar
            && sessionId !== undefined
            && sessionId === hostedSidebar.pane?.agentId
        ) {
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        }
        if (dependencies.resumeSession === undefined) {
            state = appendTuiError(state, "Switching sessions is unavailable");
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        }
        if (sessionSwitchPending) {
            return;
        }
        // Only the first hop is remembered: /back always returns to where
        // the switching started, not to the previous stop. Going back clears
        // the edge instead of arming it, or back would turn into a toggle.
        const previousId = client.agentId;
        let armedNow = false;
        if (
            !viaBack
            && armsBack
            && !openingInSidebar
            && backOriginId === undefined
            && previousId !== undefined
        ) {
            backOriginId = previousId;
            backOriginTitle = sessionTitle;
            armedNow = true;
        }
        const draft = currentDraft();
        sessionSwitchPending = true;
        sessionSwitchActivity = "switching conversation…";
        settingsPickerView.box.visible = false;
        renderState();
        void withSessionSwitchDeadline(
            dependencies.resumeSession(sessionPath),
            discardSwitchTarget,
        ).then(async (next) => {
            if (shuttingDown) {
                discardSwitchTarget(next);
                return;
            }
            if (openingInSidebar) {
                await openExtensionAgent(
                    "vera.tui.agent-attachments",
                    requireIdentifiedClient(next),
                    "sidebar",
                    true,
                    sessionId,
                );
                sessionSwitchPending = false;
                return;
            }
            switchToClient(next, draft);
            if (viaBack) {
                backOriginId = undefined;
            } else if (backOriginId !== undefined) {
                // The way back, said where the person landed: the switch is
                // easy to make by accident from the work tab, and nothing
                // else on screen names the return trip.
                const notice =
                    "Type /back to return to the conversation you came from";
                // The top copy names the origin so the hop reads as a place
                // left, not just a rule; the copy after the transcript stays
                // generic since the name is already on screen by then.
                let originTitle = backOriginTitle;
                if (
                    originTitle === undefined
                    && dependencies.listAgents !== undefined
                ) {
                    originTitle = await dependencies.listAgents().then(
                        (agents) =>
                            agents.find((agent) =>
                                agent.id === backOriginId
                            )?.title,
                    ).catch(() => undefined);
                }
                state = appendTuiNotice(
                    state,
                    originTitle === undefined
                        ? notice
                        : `Type /back to return to "${originTitle}"`,
                    "soft",
                );
                pendingBackNotice = notice;
                renderState();
            }
        }).catch((error) => {
            if (shuttingDown) return;
            // A switch that never happened is not a hop worth remembering.
            if (armedNow) backOriginId = undefined;
            sessionSwitchPending = false;
            state = appendTuiError(
                state,
                `Could not switch conversation: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            focusActiveSurface();
            renderState();
        });
    }

    /** What is in the composer right now, absent when it is empty. */
    function currentDraft(): TuiDraft | undefined {
        const text = composer.plainText;
        const attachmentIds = pendingImages
            .map((image) => image.id)
            .filter((id): id is string => id !== undefined);
        return text.length === 0 && attachmentIds.length === 0
            ? undefined
            : { text, attachmentIds };
    }

    function beginSessionTrash(candidate: {
        readonly sessionId: string;
        readonly label: string;
    }): void {
        if (dependencies.trashSession === undefined) {
            sessionTrashCandidate = undefined;
            state = appendTuiError(
                state,
                "Moving conversations to Trash is unavailable",
            );
            renderState();
            return;
        }
        sessionTrashPending = true;
        sessionSwitchPending = true;
        sessionSwitchActivity = "moving conversation to Trash…";
        renderState();
        void performSessionTrash(candidate);
    }

    async function performSessionTrash(candidate: {
        readonly sessionId: string;
        readonly label: string;
    }): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                dependencies.trashSession!(candidate.sessionId),
                new Promise<TrashSessionResult>((resolve) => {
                    timeout = setTimeout(() => {
                        resolve({ status: "rejected", reason: "failed" });
                    }, dependencies.sessionSwitchTimeoutMs
                        ?? SESSION_SWITCH_TIMEOUT_MS);
                }),
            ]);
            clearTimeout(timeout);
            if (shuttingDown) return;
            if (result.status === "trashed") {
                state = appendTuiNotice(
                    state,
                    `moved to Trash: ${candidate.label}`,
                );
                if (dependencies.listAgents !== undefined) {
                    try {
                        settingsPicker = startTuiSessionPicker(
                            await dependencies.listAgents(),
                            client.agentId,
                            false,
                            new Date(),
                            false,
                            hostedPanePersistence.groups,
                        );
                    } catch {
                        settingsPicker = removeSessionPickerOption(
                            settingsPicker?.kind === "extension"
                                ? undefined
                                : settingsPicker,
                            candidate.sessionId,
                        );
                    }
                }
            } else {
                state = appendTuiError(
                    state,
                    result.reason === "busy"
                        ? "That conversation is active in another client"
                        : result.reason === "not_found"
                        ? "That conversation is no longer available"
                        : "Could not move that conversation to Trash",
                );
            }
        } catch {
            clearTimeout(timeout);
            if (shuttingDown) return;
            sessionTrashPending = false;
            sessionSwitchPending = false;
            sessionTrashCandidate = undefined;
            state = appendTuiError(
                state,
                "Could not move that conversation to Trash",
            );
            }
            sessionTrashPending = false;
            sessionSwitchPending = false;
            sessionTrashCandidate = undefined;
        focusActiveSurface();
        renderState();
    }

    /**
     * Send a model settings edit and toast what was asked for.
     *
     * `toast` is what the status line shows while the change is in flight;
     * `subject` completes "Could not change …" if the engine rejects it.
     */
    function requestModelSettingsChange(
        patch: ModelSettingsPatch,
        toast: string,
        subject: string,
        target: TuiAgentClient = focusedAgentClient(),
    ): void {
        const requestId = randomUUID();
        requestedModelChanges.set(requestId, { subject, patch, target });
        void target.send({
            type: "update_model_settings",
            requestId,
            patch,
        }).catch(reportConnectionError);
        showStatusNotice(toast);
    }

    function formatContextLimit(tokens: number): string {
        return tokens % 1_048_576 === 0
            ? `${tokens / 1_048_576}m`
            : `${Math.round(tokens / 1_024)}k`;
    }

    /**
     * What each live `pool_add` asked for, so an unavailable verdict can be
     * sent again without the user re-picking the model.
     */
    const poolAdmissionAttempts = new Map<string, {
        readonly provider: string;
        readonly model: string;
        readonly verify: boolean;
        readonly retry: boolean;
    }>();

    /**
     * One silent second run when a provider was unreachable, because that
     * verdict is usually a blip and the first thing a user does is ask again.
     * Answers whether the verdict was swallowed: the caller then skips it, and
     * the failed checklist comes back off the transcript so the retry replaces
     * it rather than stacking under it. A retry that fails too is reported.
     */
    function retryPoolAdmission(
        requestId: string,
        verdict: string,
    ): boolean {
        const attempt = poolAdmissionAttempts.get(requestId);
        poolAdmissionAttempts.delete(requestId);
        if (
            attempt === undefined || attempt.retry || verdict !== "unavailable"
        ) {
            return false;
        }
        state = dropTuiAdmission(state, requestId);
        const retryId = requestPoolAdmission(
            attempt.provider,
            attempt.model,
            attempt.verify,
            true,
        );
        if (poolVerifySweep?.requestId === requestId) {
            // A retry is the same step of the sweep under a new id. Without
            // this the sweep waits on a verdict that will never carry the id
            // it is watching for, and stops on the first unreachable model.
            poolVerifySweep = { ...poolVerifySweep, requestId: retryId };
        }
        const poolChange = pendingPoolChanges.get(requestId);
        pendingPoolChanges.delete(requestId);
        if (poolChange !== undefined) {
            pendingPoolChanges.set(retryId, poolChange);
        }
        const pendingUndo = pendingPoolUndos.get(requestId);
        pendingPoolUndos.delete(requestId);
        if (pendingUndo !== undefined) {
            pendingPoolUndos.set(retryId, pendingUndo);
        }
        if (admissionDialog?.requestId === requestId) {
            admissionDialog = startTuiAdmissionDialog(
                attempt.provider,
                attempt.model,
                retryId,
            );
        }
        if (pendingPoolName?.requestId === requestId) {
            pendingPoolName = { ...pendingPoolName, requestId: retryId };
        }
        return true;
    }

    /**
     * Sends `pool_add` and opens the admission checklist in the transcript.
     * The reply is a stream rather than one update, so the checklist entry is
     * created here and rewritten by the progress updates as they land. The
     * transcript entry is written whether or not the dialog is showing: it is
     * the durable record, and the only surface a reattached client gets.
     */
    /**
     * Asks the provider for its list now. The pane stays open and is rebuilt
     * by the `model_settings` reply on the route every other edit to it takes,
     * so the only thing owed here is a word about what is happening: the wait
     * is bounded but it is not instant, and a list that comes back identical
     * would otherwise look like a key that did nothing.
     */
    function requestCatalogRefresh(provider: string): void {
        const requestId = randomUUID();
        catalogRefreshes.set(requestId, provider);
        showStatusNotice(`asking ${provider} for its model list…`);
        sendCommand({ type: "catalog_refresh", requestId, provider });
        renderState();
    }

    function requestPoolAdmission(
        provider: string,
        model: string,
        verify = false,
        retry = false,
    ): string {
        const requestId = randomUUID();
        poolAdmissionAttempts.set(requestId, { provider, model, verify, retry });
        state = beginTuiAdmission(state, requestId, `${provider}/${model}`);
        sendCommand({
            type: "pool_add",
            requestId,
            provider,
            model,
            ...(verify ? { verify: true } : {}),
        });
        renderState();
        return requestId;
    }

    /** The live admission record for the dialog's own request, if any. */
    function dialogAdmission() {
        return state.admission !== undefined
                && state.admission.requestId === admissionDialog?.requestId
            ? state.admission
            : undefined;
    }

    /**
     * Verification on demand: the probes go out immediately, and the dialog
     * is the checklist they report into. The model pane, when one is open, is
     * set aside rather than closed so leaving the dialog can put the user back
     * where they were.
     */
    /** Every model the user keeps, in the order the pane lists them. */
    function keptModels(): readonly {
        readonly provider: string;
        readonly model: string;
        readonly verified: boolean;
    }[] {
        return (focusedAgentState().modelSettings?.pooled ?? []).map((entry) => ({
            provider: entry.provider,
            model: entry.model,
            verified: entry.verified === true,
        }));
    }

    function openCatalogRefreshScopePicker(): void {
        const providers = refreshableProvidersOf(
            state.modelSettings?.availableModels,
        );
        if (providers.length === 0) {
            showStatusNotice("no provider here keeps a model list to refresh");
            return;
        }
        settingsPicker = withTuiPickerParent(
            startTuiCatalogRefreshScopePicker(
                providers.map((name) => ({
                    name,
                    models: catalogSizeOf(name),
                })),
            ),
            settingsPicker?.kind === "model" ? settingsPicker : undefined,
        );
        renderState();
        focusActiveSurface();
    }

    /** An empty scope names every provider that keeps a list. */
    function startCatalogRefreshSweep(providers: readonly string[]): void {
        const queue = providers.length > 0
            ? providers
            : refreshableProvidersOf(state.modelSettings?.availableModels);
        settingsPicker = undefined;
        composer.blur();
        if (catalogRefreshSweep !== undefined) {
            // Two sweeps at once cannot both be reported: the second would
            // claim the first one's answers as its own.
            showStatusNotice("a refresh is already running");
            renderState();
            focusActiveSurface();
            return;
        }
        if (queue.length === 0) {
            showStatusNotice("no provider here keeps a model list to refresh");
            renderState();
            focusActiveSurface();
            return;
        }
        catalogRefreshSweep = { queue, index: 0, results: [] };
        renderState();
        focusActiveSurface();
        advanceCatalogRefreshSweep();
    }

    function advanceCatalogRefreshSweep(): void {
        const sweep = catalogRefreshSweep;
        if (sweep === undefined) return;
        const next = sweep.queue[sweep.index];
        if (next === undefined) {
            catalogRefreshSweep = undefined;
            showStatusNotice(catalogRefreshSummary(sweep.results));
            renderState();
            return;
        }
        sweep.results.push({ provider: next, before: catalogSizeOf(next) });
        showStatusNotice(
            `asking ${next} (${sweep.index + 1}/${sweep.queue.length})\u2026`,
        );
        const requestId = randomUUID();
        sweep.requestId = requestId;
        sendCommand({ type: "catalog_refresh", requestId, provider: next });
        renderState();
    }

    /** True when the reply belonged to the sweep, which then steps on. */
    function catalogRefreshSweepResult(
        requestId: string,
        refreshed: boolean,
    ): boolean {
        const sweep = catalogRefreshSweep;
        if (sweep === undefined || sweep.requestId !== requestId) return false;
        const result = sweep.results.at(-1);
        if (result !== undefined && refreshed) {
            result.after = catalogSizeOf(result.provider);
        }
        sweep.index += 1;
        advanceCatalogRefreshSweep();
        return true;
    }

    /**
     * What the sweep changed, provider by provider. The delta leads because it
     * is the reason to have run it; a provider that could not be asked says so
     * rather than being left out.
     */
    function catalogRefreshSummary(
        results: readonly {
            readonly provider: string;
            readonly before: number;
            readonly after?: number;
        }[],
    ): string {
        return results
            .map((entry) => {
                if (entry.after === undefined) {
                    return `${entry.provider}: could not ask`;
                }
                const delta = entry.after - entry.before;
                return delta === 0
                    ? `${entry.provider}: ${entry.after}, nothing new`
                    : `${entry.provider}: ${entry.after}, ${
                        delta > 0 ? `+${delta} new` : `${-delta} gone`
                    }`;
            })
            .join(" \u00b7 ");
    }

    function openPoolVerifyScopePicker(): void {
        const kept = keptModels();
        if (kept.length === 0) {
            showStatusNotice("nothing kept to probe yet");
            return;
        }
        settingsPicker = withTuiPickerParent(
            startTuiPoolVerifyScopePicker(
                kept.filter((entry) => !entry.verified).length,
                kept.length,
            ),
            settingsPicker?.kind === "model" ? settingsPicker : undefined,
        );
        renderState();
        focusActiveSurface();
    }

    /**
     * Runs the sweep without a dialog per model. A dialog would ask to be
     * dismissed between every probe, which turns a batch back into the
     * one-at-a-time key it was meant to replace. Progress goes to the status
     * line instead, and the rows update as each verdict lands.
     */
    function startPoolVerifySweep(onlyUnverified: boolean): void {
        const queue = keptModels()
            .filter((entry) => !onlyUnverified || !entry.verified)
            .map((entry) => ({ provider: entry.provider, model: entry.model }));
        settingsPicker = undefined;
        composer.blur();
        if (queue.length === 0) {
            showStatusNotice("everything you keep has been probed");
            renderState();
            focusActiveSurface();
            return;
        }
        poolVerifySweep = { queue, total: queue.length, index: 0, answered: 0 };
        renderState();
        focusActiveSurface();
        advancePoolVerifySweep();
    }

    function advancePoolVerifySweep(): void {
        const sweep = poolVerifySweep;
        if (sweep === undefined) return;
        const next = sweep.queue[sweep.index];
        if (next === undefined) {
            poolVerifySweep = undefined;
            showStatusNotice(
                `probed ${sweep.total}, ${sweep.answered} answered`,
            );
            renderState();
            return;
        }
        showStatusNotice(
            `probing ${next.provider}/${next.model} (${sweep.index + 1}/${sweep.total})`,
        );
        sweep.requestId = requestPoolAdmission(next.provider, next.model, true);
    }

    /** True when the verdict belonged to the sweep, which then steps on. */
    function poolVerifySweepResult(requestId: string, verdict: string): boolean {
        const sweep = poolVerifySweep;
        if (sweep === undefined || sweep.requestId !== requestId) return false;
        if (verdict === "added") sweep.answered += 1;
        sweep.index += 1;
        advancePoolVerifySweep();
        return true;
    }

    function openVerifyDialog(provider: string, model: string): void {
        admissionReturnPicker = settingsPicker?.kind === "model"
            ? settingsPicker
            : undefined;
        settingsPicker = undefined;
        const requestId = requestPoolAdmission(provider, model, true);
        admissionDialog = startTuiAdmissionDialog(provider, model, requestId);
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function closeAdmissionDialog(reopenPoolPicker: boolean): void {
        const returnPicker = admissionReturnPicker;
        admissionDialog = undefined;
        admissionReturnPicker = undefined;
        if (reopenPoolPicker && returnPicker !== undefined) {
            // Rebuilt rather than restored: the pool changed under the saved
            // pane, and a fresh open lands on the Pool tab, where the newly
            // admitted row is.
            openModelPicker(returnPicker.parent);
            return;
        }
        settingsPicker = returnPicker;
        focusActiveSurface();
        renderState();
    }

    /** Change the persistent host default used by new sessions. */
    function requestPermissionsChange(
        mode: string,
        target: TuiAgentClient = focusedAgentClient(),
        scope: "session" | "global" = "global",
    ): void {
        const requestId = randomUUID();
        requestedPermissionChanges.set(requestId, `permissions to ${mode}`);
        const sessionScoped = scope === "session"
            && target.supportsHostCapability?.(
                    HOST_CAPABILITY_SESSION_SCOPED_STATE,
                ) !== false;
        void target.send({
            type: sessionScoped
                ? "update_session_permission_mode"
                : "update_permissions",
            requestId,
            mode,
        }).catch(reportConnectionError);
        showStatusNotice(
            `permissions → ${mode}${sessionScoped ? "" : " (default too)"}`,
        );
    }

    async function applySelectedTheme(
        selectedTheme: typeof themeName,
        announce: boolean,
    ): Promise<void> {
        if (announce && pendingThemePreview !== undefined) {
            clearTimeout(pendingThemePreview);
            pendingThemePreview = undefined;
        }
        const version = ++themeApplicationVersion;
        const resolvedTheme = await resolveTuiTheme(renderer, selectedTheme);
        if (version !== themeApplicationVersion || shuttingDown) {
            return;
        }
        theme = resolvedTheme;
        applyTuiTheme(theme);
        refreshDialogChrome();
        experimentalTuiHost.setTheme(theme);
        clearTranscriptNodes();
        markdownStyle.destroy();
        markdownStyle = createMarkdownStyle(theme);

        placeholder.fg = theme.muted;
        backgroundStatusText.fg = theme.muted;
        activityHintText.fg = theme.muted;
        hostedModeText.fg = theme.muted;
        app.backgroundColor = theme.background;
        quoteText.fg = theme.muted;
        heldAddressText.fg = theme.muted;
        queuedPromptText.fg = theme.muted;
        jumpToBottomText.fg = theme.background;
        jumpToBottomText.bg = theme.accent;
        jumpToBottom.backgroundColor = theme.accent;
        sidebarJumpText.fg = theme.background;
        sidebarJumpText.bg = theme.accent;
        sidebarJump.backgroundColor = theme.accent;
        modeToastText.fg = theme.text;
        modeToastText.bg = theme.panel;
        modeToast.backgroundColor = theme.panel;
        commandSuggestionsText.fg = theme.text;
        commandSuggestionsBox.backgroundColor = theme.background;
        composerBox.backgroundColor = theme.input ?? theme.background;
        composerBox.borderColor = appearance.composerBoundaryColor
            ?? theme.element;
        composerStatusText.fg = theme.muted;
        composerRule.borderColor = appearance.composerBoundaryColor
            ?? theme.element;
        workspaceSidebarView.box.borderColor = theme.element;
        workspaceSidebarView.box.focusedBorderColor = theme.element;
        composer.backgroundColor = theme.input ?? theme.background;
        composer.focusedBackgroundColor = theme.input ?? theme.background;
        composer.textColor = theme.text;
        composer.focusedTextColor = theme.text;
        composer.cursorColor = theme.accent;
        approvalView.box.backgroundColor = theme.panel;
        approvalView.repaint();
        questionView.box.backgroundColor = theme.panel;
        questionView.bar.borderColor = theme.accent;
        questionView.detailsText.fg = theme.text;
        questionView.choiceAction.fg = theme.muted;
        questionView.cancelAction.fg = theme.muted;
        timelinePickerView.box.backgroundColor = theme.panel;
        if (timelinePicker !== undefined) {
            timelinePickerView.update(timelinePicker);
        }
        settingsPickerView.box.backgroundColor = theme.panel;
        commandPaletteView.box.backgroundColor = theme.panel;
        helpView.box.backgroundColor = theme.panel;
        doctorDialogView.box.backgroundColor = theme.panel;
        doctorDialogView.repaint();
        diagnosticsDialogView.box.backgroundColor = theme.panel;
        diagnosticsDialogView.repaint();
        // The column is built once and outlives any number of themes, and the
        // blocks in it were painted when they arrived.
        sidebar.setTheme(sidebarTheme(), markdownStyle);

        if (announce) {
            state = appendTuiNotice(
                state,
                `theme changed: ${selectedTheme}`,
                "soft",
                "theme",
            );
        }
        renderState();
    }

    /**
     * Theme rows preview live, but rebuilding a long Markdown transcript for
     * every key repeat makes the picker itself lag behind the cursor. Coalesce
     * a run of arrows and paint the row the cursor actually settles on.
     */
    function scheduleThemePreview(selectedTheme: typeof themeName): void {
        if (pendingThemePreview !== undefined) {
            clearTimeout(pendingThemePreview);
        }
        pendingThemePreview = setTimeout(() => {
            pendingThemePreview = undefined;
            void applySelectedTheme(selectedTheme, false);
        }, 50);
    }

    /**
     * Every name the user could type for a pooled model, ids included.
     *
     * `self` leads, because whatever is asking for a model is asking from
     * inside a conversation that already has one, and the same model is the
     * answer often enough to be the one already under the cursor.
     */
    function pooledModelNames(): readonly string[] {
        const names: string[] = ["self"];
        for (const entry of state.modelSettings?.pooled ?? []) {
            if (entry.poolName !== undefined) {
                names.push(entry.poolName);
            }
            names.push(entry.model);
        }
        return names;
    }

    /**
     * The half-typed token the composer can finish, and what it completes
     * from. A command argument comes from the pool; an `@` comes from whoever
     * claimed mentions.
     */
    function activeCompletion(): {
        prefix: string;
        values: readonly string[];
    } | undefined {
        const argument = commandRegistry.argumentPrefix(composer.plainText);
        if (argument !== undefined) {
            return {
                prefix: argument.prefix,
                // Bare names: the argument is the name itself, not a mention.
                values: argument.kind === "mention"
                    ? visibleMentions()
                    : pooledModelNames(),
            };
        }
        const mentions = visibleMentions();
        if (mentions.length === 0) return undefined;
        const mention = /(?:^|\s)(@\S*)$/.exec(composer.plainText);
        if (mention === null) return undefined;
        return {
            prefix: mention[1] ?? "",
            values: mentions.map((name) => `@${name}`),
        };
    }

    function renderCommandSuggestions(): void {
        const extensionBottomRows = experimentalTuiHost.bottomInsetRows();
        // Measured off the composer's own margin, which the status card below
        // it grows and shrinks: a fixed offset here lands inside the composer
        // as soon as that card is taller than the single line it replaced.
        // These transient lines sit above the composer in normal flow, so the
        // overlay clears whichever of them are currently visible instead of
        // painting over quote/address context.
        positionCommandSuggestions();
        if (composer.plainText.length === 0) {
            commandSuggestionIndex = 0;
        }
        const completing = activeCompletion();
        if (completing !== undefined) {
            argumentSuggestions = tuiArgumentSuggestions(
                completing.values,
                completing.prefix,
            );
            commandSuggestionIndex = Math.min(
                commandSuggestionIndex,
                Math.max(0, argumentSuggestions.length - 1),
            );
            const window = tuiSuggestionWindow(
                argumentSuggestions.length,
                commandSuggestionIndex,
                Math.max(
                    3,
                    renderer.height - SUGGESTIONS_RESERVED_ROWS
                        - extensionBottomRows,
                ),
            );
            commandSuggestionsText.content = renderTuiArgumentSuggestions(
                argumentSuggestions.slice(
                    window.start,
                    window.start + window.rows,
                ),
                commandSuggestionIndex - window.start,
            );
            commandSuggestionsBox.height = Math.max(1, window.rows) + 1;
            commandSuggestionsBox.visible = argumentSuggestions.length > 0
                && overlaysClearOfSuggestions();
            return;
        }
        argumentSuggestions = [];
        const suggestions = commandRegistry.suggestions(composer.plainText);
        if (composer.plainText !== "/") {
            // A list that just opened has a first row, not a chosen one.
            commandSuggestionMoved = false;
        }
        commandSuggestionIndex = Math.min(
            commandSuggestionIndex,
            Math.max(0, suggestions.length - 1),
        );
        const selected = composer.plainText === "/"
            ? commandSuggestionIndex
            : -1;
        // The transcript, the composer and the status rows all want the same
        // screen. What is left over is what the list may take, and it never
        // takes so much that its own bottom row is off the pane.
        // The unfiltered list is grouped by where each command came from; a
        // half-typed name is one flat run, where the group column would be
        // dead width and the gaps would separate nothing.
        const grouped = composer.plainText === "/";
        const window = tuiSuggestionWindow(
            suggestions.length,
            selected,
            Math.max(
                3,
                renderer.height - SUGGESTIONS_RESERVED_ROWS
                    - extensionBottomRows
                    - tuiSuggestionGaps(suggestions, grouped),
            ),
        );
        const visible = suggestions.slice(
            window.start,
            window.start + window.rows,
        );
        commandSuggestionsText.content = renderTuiCommandSuggestions(
            visible,
            selected < 0 ? -1 : selected - window.start,
            // Less the box's own margin and padding, or the last word of a
            // just-too-long row wraps anyway. The renderer reports the whole
            // terminal even when the workspace rail has reserved its left
            // side, so the rail has to come out of the same budget.
            tuiCommandSuggestionWidth(
                renderer.width,
                composerHorizontalInset,
                workspaceSidebarView.railColumns() ?? 0,
            ),
            window.hidden,
            grouped,
        );
        commandSuggestionsBox.height = suggestions.length > 0
            ? window.rows + tuiSuggestionGaps(visible, grouped)
                + (window.hidden > 0 ? 1 : 0) + 1
            : 1;
        const suggester = suggestions.length > 0
            ? undefined
            : activeComposeSuggester();
        if (suggester !== undefined) {
            // One line, under the composer, from an extension the user chose
            // to install. Core never reads composer text; this does, and it
            // only exists because installing the extension said it could.
            commandSuggestionsText.content = new StyledText([
                fg(TUI_MUTED)(
                    `${suggester.hint} · enter switch to ${suggester.agent} · esc dismiss`,
                ),
            ]);
            commandSuggestionsBox.height = 2;
            commandSuggestionsBox.visible = overlaysClearOfSuggestions();
            return;
        }
        commandSuggestionsBox.visible = suggestions.length > 0
            && overlaysClearOfSuggestions();
    }

    /**
     * The one suggester that applies right now, if any.
     *
     * First registered wins, so a second extension cannot talk over the first,
     * and a suggester dismissed with escape stays dismissed for the session.
     */
    function activeComposeSuggester():
        | {
            readonly id: string;
            readonly source: string;
            readonly agent: string;
            readonly hint: string;
        }
        | undefined
    {
        return findActiveComposeSuggester(
            clientExtensionRegistry?.composeSuggesters() ?? [],
            composer.plainText,
            focusedAgentState().agent?.name ?? "default",
            dismissedComposeSuggesters,
        );
    }

    function overlaysClearOfSuggestions(): boolean {
        return focusedUiRequest() === undefined
            && timelinePicker === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && help === undefined;
    }

    function finishStreamingAssistant(): void {
        for (let index = entryNodes.length - 1; index >= 0; index -= 1) {
            const node = entryNodes[index];
            if (node instanceof MarkdownRenderable) {
                node.streaming = false;
                return;
            }
        }
    }

    return finished.promise;

    async function copyTranscriptSelection(selection: Selection): Promise<void> {
        const text = selection.getSelectedText();
        if (text.length === 0) {
            return;
        }

        try {
            await copyText(text);
            if (shuttingDown) {
                return;
            }
            const count = countTuiCharacters(text);
            announceCopy(`copied ${count} character${count === 1 ? "" : "s"}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            announceCopy(`copy failed · ${message}`);
        }
    }

    /**
     * An overlay covers the status line, so a copy made from inside one has to
     * say so somewhere still on screen.
     */
    function announceCopy(message: string): void {
        if (experimentalTuiHost.showNotice(message)) return;
        showStatusNotice(message);
    }

    function showStatusNotice(message: string): void {
        statusNotice = message;
        statusNoticeVersion += 1;
        const version = statusNoticeVersion;
        renderStatus();

        setTimeout(() => {
            if (statusNoticeVersion !== version) {
                return;
            }
            statusNotice = undefined;
            renderStatus();
        }, COPY_NOTICE_DURATION_MS);
    }

    function showModeToast(message: string): void {
        modeToastVersion += 1;
        const version = modeToastVersion;
        modeToastText.content = message;
        modeToast.width = message.length + 4;
        // Above the overlay when one is open, so the toast is not painted
        // behind the card that prompted it.
        modeToast.visible = true;
        setTimeout(() => {
            if (modeToastVersion !== version) return;
            modeToast.visible = false;
        }, MODE_TOAST_DURATION_MS);
    }

    /**
     * Shows the jump-to-bottom pill whenever the transcript is not pinned to
     * the bottom.
     *
     * Streaming grows the transcript rather than being held in a fixed live
     * area, so the cost of scrolling up mid-turn is losing the stream, not a
     * moving viewport. The pill is the way back. It is positioned absolutely
     * over the transcript's last row so showing and hiding it never reflows
     * anything, which is the whole point.
     */
    function renderJumpToBottom(resumeFollow = true): void {
        const following = tuiTranscriptAtBottom(
            transcript.scrollTop,
            transcript.scrollHeight,
            transcript.viewport.height,
        );
        // OpenTUI's wheel handler marks every wheel event as manual after it
        // updates scrollTop, including the event that reaches the bottom. If
        // streaming grows the transcript before the next layout pass, that
        // stale manual flag prevents sticky scroll from following the new
        // content. Crossing from the visible pill back to the bottom is an
        // explicit request to resume following, so reapply the bottom here.
        // A keyboard scroll moves by an exact number of rows and passes false,
        // because snapping back would undo the row it just moved.
        if (following && resumeFollow) {
            transcript.scrollTo(transcript.scrollHeight);
        }
        const visible = !following && !anyOverlayOpen();
        jumpToBottom.visible = visible;
        if (!visible) {
            return;
        }
        jumpToBottom.top = commandSuggestionsBox.visible
            ? Math.min(
                transcript.y + transcript.height - 1,
                commandSuggestionsBox.y - 1,
            )
            : transcript.y + transcript.height - 1;
        jumpToBottom.left = Math.max(
            0,
            transcript.x + transcript.width - JUMP_TO_BOTTOM_LABEL.length - 2,
        );
    }

    function renderSidebarJump(): void {
        const visible = sidebar.isShown() && !sidebar.isFollowing()
            && !anyOverlayOpen();
        sidebarJump.visible = visible;
        if (!visible) {
            return;
        }
        const region = sidebar.bounds();
        sidebarJump.top = region.y + region.height - 1;
        sidebarJump.left = Math.max(
            0,
            region.x + region.width - SIDEBAR_JUMP_LABEL.length - 1,
        );
    }

    /**
     * The quote line, redrawn on the status tick as well as on state, because
     * the mark blinks and nothing else is changing while it does.
     */
    function renderPendingQuote(): void {
        const quote = pendingQuote;
        quoteText.visible = quote !== undefined && !anyOverlayOpen();
        setComposerMargin(quoteText.visible ? 3 : 2);
        if (quote === undefined) {
            quoteText.content = "";
            return;
        }
        const { facts, keys } = renderTuiQuote(quote);
        // Indented by hand: the line is one row in a column that does not pad
        // its children, and it has to start where the composer's text starts.
        quoteText.content = new StyledText([
            fg(TUI_ACCENT)(`${tuiQuoteMarker(Date.now())} `),
            fg(TUI_MUTED)(`${facts} · `),
            fg(TUI_ACCENT)(keys),
        ]);
    }

    /** The pinned line naming who the composer is holding for. */
    function renderHeldAddress(): void {
        const { facts, keys } = renderTuiHeldAddress(extensionAddressee);
        heldAddressText.visible = facts.length > 0 && !anyOverlayOpen();
        if (facts.length === 0) {
            heldAddressText.content = "";
            return;
        }
        // Indented by hand: the row sits in a column that does not pad its
        // children, and it has to start where the composer's text starts.
        heldAddressText.content = new StyledText([
            fg(TUI_MUTED)(
                `${" ".repeat(appearance.composerMarginHorizontal)}${facts} · `,
            ),
            fg(TUI_ACCENT)(keys),
        ]);
    }

    function paneHeaderText(
        name: string,
        approvalMode: string | undefined,
        settings: TuiState["modelSettings"],
        width: number,
    ): string {
        const left = `${name} · ${approvalMode ?? "loading"}`;
        const model = settings?.model;
        const right = model === undefined
            ? "model loading"
            : settings?.provider === undefined
            ? model
            : `${settings.provider}/${model}`;
        const contentWidth = Math.max(1, width - composerHorizontalInset);
        const indent = " ".repeat(composerContentIndent);
        if (left.length + right.length + 3 <= contentWidth) {
            return `${indent}${left}${" ".repeat(contentWidth - left.length - right.length)}${right}`;
        }
        const rightRoom = Math.max(0, contentWidth - left.length - 3);
        return rightRoom < 4
            ? `${indent}${left.slice(0, contentWidth)}`
            : `${indent}${left} · ${right.slice(0, rightRoom)}`;
    }

    function renderStatus(): void {
        if (shuttingDown) {
            return;
        }
        const statusState = focusedAgentState();
        const uiRequest = focusedUiRequest();
        const focusedSide = sidebar.isFocused() ? hostedSidebar.pane : undefined;
        const focusedAbort = focusedAbortRequested();
        const focusedActivity = focusedSide?.state.activity ?? activity;
        const focusedElapsed = focusedSide?.state.elapsedWorkingTime()
            ?? elapsedWorkingTime();
        const layout = sidebar.layout();
        const sideState = hostedSidebar.pane?.state.state;
        const paneHeadersVisible = !anyOverlayOpen();
        const sideWidth = sidebar.width();
        const mainWidth = Math.max(1, renderer.width - sideWidth - 1);
        // Beside a second pane the row names each one, because the point of the
        // row is telling the two columns apart. Alone it carries the session
        // title, which is the only thing left worth putting there.
        sidebar.setMainHeader(!paneHeadersVisible || !mainHeaderVisible
            ? undefined
            : hostedSidebar.pane !== undefined
            ? paneHeaderText(
                "Vera",
                state.approvalMode,
                state.modelSettings,
                layout === "split" ? mainWidth : renderer.width,
            )
            : sessionTitle !== undefined
            ? `  Session: ${sessionTitle}`
            : undefined);
        sidebar.setHeader(
            paneHeadersVisible
                && sidebarHeaderVisible
                && hostedSidebar.pane !== undefined
                && sideState !== undefined
            ? paneHeaderText(
                sidebarSessionTitle
                    ?? hostedSidebar.mention
                    ?? hostedSidebar.pane!.agentId,
                sideState.approvalMode,
                sideState.modelSettings,
                layout === "split" ? sideWidth : renderer.width,
            )
            : undefined);
        const workingHint = focusedSide === undefined
            ? WORKING_HINT
            : `esc stop ${hostedSidebar.mention ?? focusedSide.agentId}`
                + ` · ${tuiKeyHint("interrupt")}`;
        renderPendingQuote();
        renderHeldAddress();
        renderJumpToBottom();
        renderSidebarJump();

        let lifecycleHint = renderTuiIdleHint(
            READY_HINT,
            runningBackgroundAgents,
        );
        if (connectionFailed) {
            lifecycleHint = `disconnected${
                connectionFailure === undefined
                    ? ""
                    : `: ${shortConnectionFailure(connectionFailure)}`
            } · /reconnect · ctrl+c quit`;
        } else if (focusedAbort) {
            lifecycleHint = `${STOPPING_HINT} · ${focusedElapsed}`;
        } else if (
            uiRequest !== undefined
            && isToolApprovalUiRequestUpdate(uiRequest)
        ) {
            lifecycleHint = tuiApprovalHint(uiRequest);
        } else if (uiRequest?.request.type === "user_question") {
            lifecycleHint = `${QUESTION_HINT} · ${focusedElapsed}`;
        } else if (statusState.compactingSince !== undefined) {
            lifecycleHint = renderTuiCompactionHint(
                Date.now() - statusState.compactingSince,
                {
                    strategy: statusState.compactionStrategy,
                    provider: statusState.compactionProvider,
                    model: statusState.compactionModel,
                },
            );
        } else if (statusState.working) {
            const modelActivity = statusState.modelActivity;
            const waitingToRetry = modelActivity !== undefined
                && Date.parse(modelActivity.retryAt) > Date.now();
            lifecycleHint = waitingToRetry
                ? `retrying · attempt ${modelActivity.nextAttempt}/${modelActivity.maxAttempts}`
                    + ` · ${focusedElapsed}`
                : `${modelActivity === undefined ? focusedActivity : "thinking"}`
                    + ` · ${focusedElapsed}`;
        } else if (pendingImages.some((image) => image.id === undefined)) {
            lifecycleHint = "attaching image…";
        } else if (promptSubmitting) {
            lifecycleHint = "sending prompt with image…";
        } else if (sessionSwitchPending) {
            lifecycleHint = sessionSwitchActivity;
        } else if (extensionCommandPending) {
            lifecycleHint =
                `${extensionCommandActivity ?? "running extension command"} · ctrl+c quit`;
        } else if (pendingImages.length > 0) {
            lifecycleHint = `${pendingImages.length} image${pendingImages.length === 1 ? "" : "s"} attached · enter send`;
        }

        statusText.fg = statusState.approvalMode === "full_access"
            ? "#ff3b30"
            : statusNotice !== undefined
            ? TUI_NOTICE
            : statusState.working
                    || statusState.compactingSince !== undefined
                    || uiRequest !== undefined
                    || extensionCommandPending
                ? TUI_ACCENT
                : TUI_MUTED;
        const hostedModeStatus = hostedSidebar.pane === undefined
            ? undefined
            : [
                READY_HINT,
                `${hostedSidebar.modeLabel ?? hostedSidebar.mention ?? "agent"} mode`,
                sidebar.layout() === "split"
                    ? "split"
                    : sidebar.layout() === "sidebar"
                    ? `${hostedSidebar.modeLabel ?? hostedSidebar.mention ?? "agent"} only`
                    : "vera only",
                "ctrl+\\ layout",
                ...(sidebar.layout() === "split"
                    ? [sidebar.isFocused()
                        ? "ctrl+g vera"
                        : `ctrl+g ${hostedSidebar.mention ?? hostedSidebar.pane.agentId}`]
                    : []),
            ].join(" · ");
        hostedModeText.content = hostedModeStatus ?? READY_HINT;
        hostedModeText.visible = true;
        const statusLine = statusNotice ?? lifecycleHint;
        statusText.visible = !(approvalView.box.visible
            || questionView.box.visible);
        const quietActivity = statusNotice === undefined
            && !statusState.working
            && uiRequest === undefined
            && lifecycleHint === READY_HINT;
        const activityHint = statusState.working
                && uiRequest === undefined
                && !focusedAbort
            ? workingHint
            : "";
        const stripLines = dialStrip === undefined
            ? undefined
            : renderDialStrip(
                dialStrip,
                [
                    "tab/shift+tab lane",
                    `${tuiKeyChord("dials.pair.prev")}/${
                        tuiKeyChord("dials.pair.next")
                    } change`,
                    "⏎ apply",
                    "/permissions for more",
                ].join(" · "),
                Math.max(1, renderer.width - composerHorizontalInset),
                Math.max(3, Math.min(9, renderer.height - 23)),
            );
        dialCard.visible = stripLines !== undefined;
        dialCard.backgroundColor = TUI_HUD?.background ?? TUI_PANEL;
        const hudRows = stripLines?.slice(0, -1) ?? [];
        dialCardTitle.height = Math.max(1, hudRows.length);
        dialCard.height = hudRows.length + 3;
        const hudBg = TUI_HUD?.background ?? TUI_PANEL;
        const hudText = TUI_HUD?.text ?? TUI_TEXT;
        const hudMuted = TUI_HUD?.muted ?? TUI_MUTED;
        const hudAccent = TUI_HUD?.accent ?? TUI_ACCENT;
        const hudNotice = TUI_HUD?.notice ?? TUI_NOTICE;
        const hudSuccess = TUI_HUD?.success ?? VERA_TUI_THEME.success;
        dialCardTitle.content = new StyledText(
            paintDialHud(hudRows, dialStrip?.lane, {
                text: hudText,
                muted: hudMuted,
                accent: hudAccent,
                notice: hudNotice,
                background: hudBg,
                success: TUI_HUD?.success ?? TUI_SUCCESS,
            }).flatMap((spans, index) => [
                ...spans.map((span) => fg(span.color)(span.text)),
                ...(index === hudRows.length - 1 ? [] : [fg(hudText)("\n")]),
            ]),
        );
        const dialHintParts = (stripLines?.at(-1) ?? "")
            .split(DIAL_EXIT_SEPARATOR);
        dialCardHint.content = stripLines === undefined
            ? ""
            : new StyledText([
                fg(hudMuted)(dialHintParts[0] ?? ""),
                fg(hudNotice)(dialHintParts[1] ?? ""),
            ]);
        activityHintText.content = activityHint;
        activityHintText.visible = statusText.visible
            && activityHint.length > 0;
        // Pull on repaint: the renderer is handed the snapshot and answers
        // synchronously, or it does not answer at all. Nothing here waits on
        // an extension, and a renderer that fails leaves the built-in line.
        const extensionSegments = clientExtensionRegistry?.renderStatusLine(
            tuiStatusSnapshot(
                statusState.modelSettings,
                statusState.approvalMode,
                statusState.context,
                process.cwd(),
                runningBackgroundAgents,
                state.working
                    ? "working"
                    : uiRequest === undefined
                        ? "idle"
                        : "waiting",
            ),
        );
        const statusDetailsRows: TuiStatusChunk[][] =
            extensionSegments === undefined
                ? renderTuiStatusDetailsRows(
                    statusState.modelSettings,
                    statusState.approvalMode,
                    statusState.context,
                    process.cwd(),
                    0,
                    statusState.effortSubstitution,
                    hostedSidebar.pane === undefined,
                    workspaceBranch.current(),
                    {
                        // `*` reads off the recorded origin, so dialling back
                        // to the default clears it on every path.
                        pairOverridden:
                            statusState.modelSettingsOrigin === "user",
                        ...(statusState.agent === undefined
                            ? {}
                            : { agent: statusState.agent.name }),
                        postureOverridden:
                            statusState.approvalModeOrigin === "user"
                            && statusState.approvalMode
                                !== statusState.agent?.posture,
                        ...(statusState.modelFallback === undefined
                            ? {}
                            : { fallbackTo: statusState.modelFallback.to }),
                    },
                    workIndex?.needs_you ?? 0,
                    Math.max(1, renderer.width - composerHorizontalInset),
                )
                : [[{
                    tone: "muted",
                    text: renderTuiStatusSegments(
                        hostedSidebar.pane === undefined
                            ? extensionSegments
                            : extensionSegments.filter((segment) =>
                                segment.kind !== "permissions"
                            ),
                    ),
                }]];
        // Hosted-pane controls live at the bottom right beside the workspace
        // row. The activity row above can then change without hiding them.
        const detailsRows = statusDetailsRows;
        const runningNames = runningBackgroundAgentNames.map((name) =>
            truncateFooterLine(
                `* ${name}`,
                Math.min(72, renderer.width - composerHorizontalInset),
            )
        );
        const agentSection = currentAgentHasParent
            ? ["/parent to return"]
            : runningNames.length === 0
                ? []
                : [
                    `${runningNames.length} subagent${
                        runningNames.length === 1 ? "" : "s"
                    } running · /subagents to attach`,
                    ...runningNames,
                ];
        const agentHeader = agentSection[0] ?? "";
        const animatedAgentHeader = runningNames.length === 0
            ? new StyledText([fg(TUI_MUTED)(agentHeader)])
            : activityAnimation === "shimmer"
            ? new StyledText([fg(TUI_MUTED)(agentHeader)])
            : renderTuiActivityAnimation(
                activityAnimation,
                activityFrame(),
                agentHeader,
                {
                    active: TUI_ACCENT,
                    trail: ACTIVE_GRID_TRAIL,
                    inactive: TUI_ELEMENT,
                    text: TUI_MUTED,
                },
                activityAnimationWidth,
            );
        // The card's own inner width, past the band's indent, its border and
        // its padding: the rules drawn inside it have to stop where it does.
        const cardWidth = Math.max(1, renderer.width - composerHorizontalInset);
        const rule = (glyph: string) =>
            fg(TUI_ELEMENT)(`${glyph.repeat(cardWidth)}\n`);
        // The first row says what the session is answering as, and it lives
        // inside the composer's frame: it is a property of the thing being
        // typed into. What is left describes where the session is, and reads
        // under the frame.
        const insideRow = detailsRows[0] ?? [];
        const outsideRows = detailsRows.slice(1);
        composerStatusText.content = new StyledText(
            insideRow.map((chunk) => fg(statusToneColor(chunk.tone))(chunk.text)),
        );
        needsYouChipWidth = needsYouChipColumns(
            insideRow,
            workIndex?.needs_you ?? 0,
        );
        const detailChunks = outsideRows.flatMap((row, index) => [
            ...row.map((chunk) => fg(statusToneColor(chunk.tone))(chunk.text)),
            ...(index === outsideRows.length - 1
                ? []
                : [fg(TUI_MUTED)("\n"), rule("─")]),
        ]);
        backgroundStatusText.content = new StyledText([
            ...detailChunks,
            ...(agentSection.length === 0 ? [] : [
                fg(TUI_MUTED)("\n"),
                rule("·"),
                ...animatedAgentHeader.chunks,
                fg(TUI_MUTED)(
                    agentSection.length === 1
                        ? ""
                        : `\n${agentSection.slice(1).join("\n")}`,
                ),
            ]),
        ]);
        // A rule between every pair of rows under the frame, and one more
        // above the agent section when there is one.
        const cardRows = Math.max(1, outsideRows.length * 2 - 1)
            + (agentSection.length === 0 ? 0 : 1 + agentSection.length);
        backgroundStatusText.height = cardRows;
        // The band's own rows, which the composer sits straight on top of with
        // no gutter of its own: the card, its border lines, and whichever
        // status lines are showing above it.
        setComposerMargin(
            cardRows + 1,
        );
        statusText.content = quietActivity
            ? new StyledText([
                fg(TUI_MUTED)(HUD_HINT.slice(0, -3)),
                fg(TUI_ACCENT)("HUD"),
                fg(TUI_MUTED)(` · ${MODEL_PICKER_HINT}`),
            ])
            : statusState.working
                && statusNotice === undefined
                && uiRequest === undefined
                && !focusedAbort
            ? renderTuiActivityAnimation(
                activityAnimation,
                activityFrame(),
                statusLine,
                {
                    active: TUI_ACCENT,
                    // The trail is part of Vera's ActiveGrid identity, not a
                    // success indicator inherited from the selected theme.
                    trail: activityAnimation === "shimmer"
                        ? TUI_ELEMENT
                        : ACTIVE_GRID_TRAIL,
                    inactive: TUI_MUTED,
                    text: state.approvalMode === "full_access"
                        ? "#ff3b30"
                        : TUI_ACCENT,
                },
                activityAnimationWidth,
            )
            : statusLine;
    }

    /**
     * Follow one session's background work, from the attach onwards.
     *
     * The host sends the current facts with the attach and again whenever they
     * change, so there is nothing to poll and nothing to wait for: the first
     * paint after a switch is already right.
     */
    function watchBackgroundAgents(next: TuiAgentClient): void {
        stopWatchingBackgroundAgents?.();
        stopWatchingBackgroundAgents = undefined;
        applyBackgroundAgents(next.backgroundAgents);
        stopWatchingBackgroundAgents = next.onBackgroundAgents?.((agents) => {
            if (client !== next || shuttingDown) {
                return;
            }
            applyBackgroundAgents(agents);
            renderStatus();
        });
    }

    /**
     * Follow the machine-wide work inbox, from the attach onwards.
     *
     * Watched whether or not the tab is open: the counts belong on the status
     * line and an approval landing in another session is worth a notification
     * whether or not this client happens to be looking at the inbox.
     */
    function watchWorkIndex(next: TuiAgentClient): void {
        stopWatchingWorkIndex?.();
        stopWatchingWorkIndex = undefined;
        applyWorkIndexSnapshot(next.workIndex, false);
        stopWatchingWorkIndex = next.onWorkIndex?.((index) => {
            if (client !== next || shuttingDown) return;
            applyWorkIndexSnapshot(index, true);
        });
    }

    /**
     * `announce` is false for the snapshot that arrives with an attach: it
     * describes work that was already there before this client existed, and
     * ringing for all of it on every reconnect would make the bell noise.
     */
    function applyWorkIndexSnapshot(
        index: WorkIndexSnapshot | undefined,
        announce: boolean,
    ): void {
        if (index === undefined) return;
        const previous = workIndex;
        workIndex = index;
        if (workTab !== undefined) {
            workTab = applyWorkIndex(workTab, index);
        }
        if (workspaceSidebar !== undefined) {
            workspaceSidebar = applyWorkspaceWorkIndex(workspaceSidebar, index);
            // The same push carries the sessions that have gone and the ones
            // that have arrived, so the listing is read again here rather than
            // only when the pane is opened.
            refreshWorkspaceSidebarRoster();
        }
        if (announce) {
            const notice = attentionNotice(
                newAttentionRows(previous, index),
                terminalFocused,
            );
            if (notice !== undefined) {
                writeTerminal(attentionNoticeSequence(notice));
            }
        }
        renderState();
    }

    /**
     * Escape sequences go straight to the terminal rather than through the
     * renderer, which owns the screen it draws and knows nothing about the
     * window around it. A write that fails is dropped: a notification is best
     * effort, and the inbox is the guaranteed way to find out either way.
     */
    function writeTerminal(sequence: string): void {
        try {
            process.stdout.write(sequence);
        } catch {
            // A closed or non-tty stdout is not a reason to fail a turn.
        }
    }

    function applyBackgroundAgents(
        agents: BackgroundAgentsSnapshot | undefined,
    ): void {
        runningBackgroundAgents = agents?.running ?? 0;
        // A reconnect/resubscribe can land the same child twice in one
        // snapshot; each name gets its own spinner row, so a duplicate here
        // shows up as a stacked/overlapping animation on screen.
        runningBackgroundAgentNames = [...new Set(agents?.children ?? [])];
        currentAgentHasParent = agents?.has_parent ?? false;
    }

    function observeActivity(update: AgentUpdate): void {
        emitExperimentalAgentEvent(update);
        if (update.type === "status" && update.state === "working") {
            workingSince ??= Date.now();
            phaseSince ??= workingSince;
            activity = "thinking";
        } else if (update.type === "status" && update.state === "waiting") {
            workingSince ??= Date.now();
            phaseSince = undefined;
            activity = "waiting";
        } else if (update.type === "model_activity") {
            workingSince ??= Date.now();
            activity = `retrying ${update.model}`;
        } else if (update.type === "user_prompt") {
            workingSince ??= Date.now();
            phaseSince = Date.now();
            activity = "thinking";
        } else if (update.type === "assistant_thinking") {
            // Reasoning can resume after visible text, so each burst re-arms the
            // phase and earns its own summary line.
            workingSince ??= Date.now();
            phaseSince ??= Date.now();
            activity = "thinking";
        } else if (update.type === "assistant_delta") {
            finishThoughtPhase();
            workingSince ??= Date.now();
            activity = "responding";
        } else if (update.type === "tool_started") {
            finishThoughtPhase();
            workingSince ??= Date.now();
            activity = `running ${update.tool}`;
        } else if (update.type === "tool_finished") {
            activity = "thinking";
            phaseSince = Date.now();
        } else if (
            update.type === "turn_finished"
            || update.type === "agent_failed"
        ) {
            finishThoughtPhase();
        }
    }

    function finishThoughtPhase(): void {
        if (activity !== "thinking" || phaseSince === undefined) {
            state = dropTuiThinking(state);
            return;
        }
        const seconds = Math.max(0, Date.now() - phaseSince) / 1_000;
        state = appendTuiThought(state, seconds);
        phaseSince = undefined;
    }

    function elapsedWorkingTime(): string {
        if (workingSince === undefined) {
            return "0s";
        }
        const elapsedSeconds = Math.max(
            0,
            Math.floor((Date.now() - workingSince) / 1_000),
        );
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        return minutes === 0
            ? `${seconds}s`
            : `${minutes}m${String(seconds).padStart(2, "0")}s`;
    }

    function activityFrame(): number {
        const interval = activityAnimationInterval
            ?? (activityAnimation === "shimmer"
                ? SHIMMER_FRAME_INTERVAL_MS
                : activityAnimation === "symmetric_wave"
                ? SYMMETRIC_WAVE_FRAME_INTERVAL_MS
                : DEFAULT_ACTIVITY_FRAME_INTERVAL_MS);
        return Math.floor(Date.now() / interval);
    }

    function emitExperimentalAgentEvent(update: AgentUpdate): void {
        switch (update.type) {
            case "user_prompt":
                experimentalTuiHost.agentEvent({
                    type: update.type,
                    text: update.content,
                });
                return;
            case "assistant_delta":
            case "assistant_thinking":
                experimentalTuiHost.agentEvent({
                    type: update.type,
                    text: update.text,
                });
                return;
            case "tool_started":
                experimentalTuiHost.agentEvent({
                    type: update.type,
                    tool: update.tool,
                });
                return;
            case "tool_finished":
                experimentalTuiHost.agentEvent({
                    type: update.type,
                    tool: update.tool,
                    ...(update.output === undefined
                        ? {}
                        : { output: update.output.slice(0, 4_000) }),
                    ...(update.isError === undefined
                        ? {}
                        : { isError: update.isError }),
                });
                return;
            case "tool_presentation":
                experimentalTuiHost.agentEvent({
                    type: update.type,
                    tool: update.tool,
                });
                return;
            case "turn_finished":
                experimentalTuiHost.agentEvent({
                    type: update.type,
                    ...(update.error === undefined
                        ? {}
                        : { text: update.error }),
                });
                return;
            case "status":
                experimentalTuiHost.agentEvent({
                    type: update.type,
                    state: update.state === "working"
                        ? "working"
                        : update.state === "waiting" ? "waiting" : "idle",
                });
                return;
            case "agent_failed":
                experimentalTuiHost.agentEvent({
                    type: update.type,
                    text: update.detail.slice(0, 4_000),
                });
                return;
            default:
                return;
        }
    }

}

function recentSessionSaveFailure(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not remember this session for vera -c: ${detail}`;
}

/** What a patch asks for, as `provider/model at effort`. */
function describeModelPatch(patch: ModelSettingsPatch): string {
    if (patch.contextLimit !== undefined) {
        return patch.contextLimit === null
            ? "Auto"
            : `${Math.round(patch.contextLimit / 1_024)}k`;
    }
    const model = patch.model === undefined
        ? undefined
        : patch.provider === undefined
        ? patch.model
        : `${patch.provider}/${patch.model}`;
    const effort = patch.reasoningEffort;
    const parts = [
        model,
        effort === undefined
            ? undefined
            : model === undefined ? effort : `at ${effort}`,
    ];
    return parts.filter((part) => part !== undefined).join(" ");
}

const DEVELOPER_FIELD_NAMES: Readonly<Record<string, string>> = {
    contextLimit: "developer context limit",
    compactionTriggerFraction: "developer compaction trigger",
    postCompactionTargetFraction: "developer post-compaction target",
    summaryWordCap: "developer summary word cap",
};

/** What one developer row changed, in the words the row used. */
function developerChangeLabel(patch: DeveloperSettingsPatch): string {
    if (patch.enabled !== undefined) {
        return patch.enabled
            ? "developer overrides on"
            : "developer overrides off";
    }
    const [field, value] = Object.entries(patch)[0] ?? [];
    const name = field === undefined
        ? "developer settings"
        : DEVELOPER_FIELD_NAMES[field] ?? "developer settings";
    return value === null || value === undefined
        ? `${name} off`
        : `${name} to ${value}`;
}

function modelPatchSubject(patch: ModelSettingsPatch): string {
    if (patch.contextLimit !== undefined) return "the context limit";
    return patch.model === undefined
        ? `the reasoning effort to ${describeModelPatch(patch)}`
        : `the model to ${describeModelPatch(patch)}`;
}

function rejectionNotice(
    subject: string,
    reason: "invalid" | "unavailable",
): string {
    return reason === "unavailable"
        ? `Changing ${subject} is unavailable on this host`
        : `Could not change ${subject}`;
}

function defaultModelChangeNotice(
    patch: ModelSettingsPatch,
    settings: ModelTurnSettings,
): string {
    if (patch.contextLimit !== undefined) {
        const label = settings.contextLimit === undefined
            ? "Auto"
            : `${Math.round(settings.contextLimit / 1_024)}k`;
        return `Changed the context limit to ${label}`;
    }
    if (patch.model === undefined) {
        const effort = settings.reasoningEffort ?? "the model default";
        return `Changed the reasoning effort to ${effort}; new conversations will use it by default`;
    }
    const effectivePatch: ModelSettingsPatch = {
        provider: settings.provider,
        model: settings.model,
        ...(patch.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: settings.reasoningEffort }),
    };
    return `Changed ${modelPatchSubject(effectivePatch)}; new conversations will use it by default`;
}
