import { bg, BoxRenderable, CliRenderEvents, decodePasteBytes, fg, MarkdownRenderable, ScrollBoxRenderable, stripAnsiSequences, StyledText, TextRenderable, createCliRenderer, KeyEvent, RGBA, type CliRenderer, type Renderable, type Selection, type MouseEvent } from "@opentui/core";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AsyncLocalStorage } from "node:async_hooks";
import { readStampedRelease } from "../../src/release/stamp.ts";
import { installLiveProcess } from "../../src/live-process.ts";
import { openFileInEditor, veraConfigPath } from "../editor.ts";
import { tuiComposerOverlayInset } from "./appearance.ts";
import { buildJumpRows, jumpMenuLines, openJumpMenu as openJumpMenuState, type JumpOrigin, type JumpRow } from "./jump.ts";
import { registerTuiParsers } from "./parsers.ts";
import {
    createTuiFlightRecorder,
    type TuiFlightRecorder,
} from "./flight-recorder.ts";
import {
    installTerminalRestoreOnExit,
    watchTerminalLoss,
} from "./terminal-restore.ts";

import { APP_PADDING_BOTTOM, APP_PADDING_TOP, DIALOG_BACKGROUND_Z_INDEX, DIALOG_CARD_Z_INDEX, DIALOG_SCRIM_Z_INDEX, refreshDialogChrome, registerDialogCard } from "./dialog-chrome.ts";

import { isConfigurationRequiredUiRequestUpdate, isToolApprovalUiRequestUpdate, isUserQuestionUiRequestUpdate, type AgentUpdate, type UiRequestUpdate } from "../../src/engine/protocol.ts";
import {
    effectiveContextWindow,
    type DeveloperSettingsPatch,
    type ModelSettingsPatch,
    type ModelTurnSettings,
} from "../../src/engine/model-settings.ts";
import type { ModelReasoningEffort, UserMessage } from "../../src/model/types.ts";
import type {
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import { levelsForModel } from "../../src/model/catalog-view.ts";
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
import { findActiveComposeSuggester } from "./compose-suggester.ts";
import type {
    VeraClientOneshotRequest,
    VeraClientOneshotResult,
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
import {
    listExtensions,
    installExtension,
    removeExtension,
    setExtensionEnabled,
} from "../../src/extensions/manager.ts";
import { extensionTarget, renderExtensionInstallPreview, renderExtensionList, renderExtensionMutation } from "../../src/extensions/manager-command.ts";
import type {
    TuiTimelinePickerState,
    TuiTimelinePickerTransition,
} from "./timeline-picker.ts";
import { createAgentThroughHost, resumeAgentThroughHost } from
    "../../src/host/agent-start-client.ts";
import {
    closeAgentThroughHost,
    type CloseAgentResult,
} from "../../src/host/agent-close-client.ts";
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
import { HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE, HOST_CAPABILITY_HARNESS_MESSAGES, HOST_CAPABILITY_SESSION_SCOPED_STATE } from "../../src/host/capabilities.ts";
import {
    findOrStartResidentHost,
    worktreeRuntimeNotice,
} from "../host/launch.ts";
import {
    createTuiApprovalView,
    tuiApprovalHint,
} from "./approval.ts";
import {
    createTuiQuestionView,
} from "./question.ts";
import { createTuiSidebar } from "./sidebar.ts";
import { tuiTranscriptAtBottom } from "./transcript-scroll.ts";
import {
    TUI_TRANSCRIPT_INITIAL_WINDOW,
    TUI_TRANSCRIPT_MATERIALIZE_BATCH,
    TUI_TRANSCRIPT_MATERIALIZE_BUFFER,
    tuiTranscriptEntryIsVisible,
    tuiTranscriptEvictableRows,
    tuiTranscriptEntryStreams,
    tuiTranscriptNeedsEarlierEntries,
    tuiTranscriptPrependRange,
    tuiTranscriptReusableTail,
    tuiTranscriptTailRange,
} from "./transcript-window.ts";
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
import { captureTuiExtensionComposeTarget, type TuiExtensionComposeTarget } from "./client-extension-compose.ts";
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
import type {
    TuiSessionLeaveDisposition,
    TuiSessionLeaveResult,
} from "./session-lifecycle.ts";
export type { TuiAgentClient } from "./agent-client.ts";
import { renderTuiDiagnostics, type TuiDiagnosticsSnapshot } from "./diagnostics.ts";
import { idleProviderHealth, type HealthRung } from "./provider-health.ts";
import { createTuiDiagnosticsDialogView } from "./diagnostics-dialog.ts";
import { type VeraDoctorReport } from "../process-doctor.ts";
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
    failureReportOneshotInput,
    failureReportMarkdown,
    writeFailureReport,
} from "../../src/store/failure-report.ts";
import {
    diagnoseProviders,
    renderProviderDoctor,
} from "../provider-doctor.ts";
import { copyTuiText, countTuiCharacters } from "./clipboard.ts";
import { createTuiCommandPaletteView, handleTuiCommandPaletteScroll, startTuiCommandPalette } from "./command-palette.ts";
import { createTuiHelpView, handleTuiHelpScroll, startTuiHelp } from "./help.ts";
import { createConfiguredBuiltinTuiCommandRegistry, registerExtensionTuiCommands, renderTuiArgumentSuggestions, renderTuiCommandSuggestions, SLASH_COMPACT_WIDTH, tuiCommandSuggestionWidth, tuiSuggestionGaps, tuiSuggestionWindow, tuiArgumentSuggestions, tuiCommandArgumentHint, type TuiCommandAction, type TuiPaletteEntry } from "./commands.ts";
import { COMPOSER_PLACEHOLDER, createTuiComposer, createTuiComposerPanel, TUI_COMPOSER_MIN_TEXT_ROWS } from "./composer.ts";
import {
    fitTuiAppearance,
    resolveTuiAppearance,
    tuiComposerContentIndent,
    type TuiAppearance,
} from "./appearance.ts";
import {
    renderTuiActivityAnimation,
    renderTuiSpokes,
} from "./activity-pulse.ts";
import { TuiBodyFocusController } from "./body-focus.ts";
import { createTuiPermissionsConfirmView } from "./permissions-confirm.ts";
import { createTuiSessionTrashConfirmView } from "./session-trash-confirm.ts";
import { createTuiSessionCloseConfirmView } from "./session-close-confirm.ts";
import { createTuiProviderForgetConfirmView, tuiProviderForgetDecision } from "./provider-forget-confirm.ts";
import { createTuiAdmissionDialogView, startTuiAdmissionDialog } from "./admission-dialog.ts";
import { renderTuiHeldAddress } from "./addressing.ts";
import { searchSessionsThroughHost } from "../../src/host/session-search-client.ts";
import { parseRawInputEvent, tuiInterruptAction } from "./interrupt.ts";
import { createTuiLinesView } from "./lines-view.ts";
import { wheelCursor } from "./list-window.ts";
import { applyWorkIndex, startWorkTab, workTabAction, workTabViewState, type WorkTabState } from "./work-tab.ts";
import { applyWorkspaceWorkIndex, clampWorkspaceRailColumns, openWorkspaceSelection, refreshWorkspaceSidebarSessions, startWorkspaceSidebar, workspaceCycleTarget, workspaceHeaderAction, workspaceRailColumns, workspaceSidebarLayout, workspaceSidebarSessions, workspaceSidebarViewState, type WorkspaceSidebarAction, type WorkspaceSidebarState } from "./workspace-sidebar.ts";
import {
    createJsonlViewClient,
    isJsonlViewClient,
    isWorkerFreeClient,
} from "./jsonl-view-client.ts";
import { createHomeClient, isHomeClient } from "./home-client.ts";
import {
    readModelSettingsThroughHost,
} from "../../src/host/model-settings-client.ts";
import {
    readAnnexUrlThroughHost,
    type AnnexUrlResult,
} from "../../src/annex/host-client.ts";
import { createHomeState, createTuiHomeView, type HomeAction } from "./home-screen.ts";
import { createTuiResumeOverlayView } from "./resume-overlay.ts";
import { applySearchFailure, applySearchResults, openSelected, searchOverlayViewState, searchSelectionOf, searchSelections, startSearchOverlay, updateSearchOverlayText, type SearchScope } from "./search-overlay.ts";
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
import { renderTuiQuote, tuiQuoteMarker } from "./quote.ts";
import {
    needsYouChipColumns,
    renderTuiCompactionHint,
    renderTuiIdleHint,
    tuiPlaceRowModeLine,
    renderTuiFileViewStatusRows,
    renderTuiStatusDetailsRows,
    renderTuiStatusSegments,
    tuiStatusSnapshot,
    statusToneColor,
    type TuiStatusChunk,
} from "./status.ts";
import { watchWorkspaceBranch } from "./workspace-branch.ts";
import { createTuiSettingsPickerView, handleTuiSettingsPickerScroll, startTuiReviewerMenu, startTuiReviewerPicker, startTuiConfigurePicker, startTuiSettingsMenu, startTuiContextLimitPicker, startTuiDeveloperMenu, startTuiDeveloperValuePicker, startTuiSettingsPicker, verificationConsoleLines, switchedModelTab, syncTuiModelPicker, moveTuiSettingsPickerPointer, startTuiReasoningPicker, startTuiSessionPicker, sessionPickerLists, startTuiProviderPicker, tuiProviderGroup, tuiPickerAfterSelection, withTuiPickerParent, type TuiSettingsMenuTarget, type TuiReviewerSlot, startTuiModelAssignmentPicker, MODEL_ASSIGNMENT_SELF_VALUE, REVIEWER_CLEAR_VALUE, startTuiPoolVerifyScopePicker, tuiModelActionOptions, startTuiCatalogRefreshScopePicker, tuiModelAssignmentOptions, type TuiSettingsPickerState, type TuiSettingsPickerOption, type TuiConfigureFile, type TuiSettingsPickerTransition, type TuiExtensionPickerTransition, createTuiProviderFormView, handleTuiProviderFormPaste, startTuiProviderForm, type TuiProviderFormState, type TuiProviderFormTransition } from "./settings-picker.ts";
import { createTuiRequestOptionsEditorView, startTuiRequestOptionsEditor, type TuiRequestOptionsEditorTransition } from "./request-options-editor.ts";
import { createTuiSecretPromptView, handleTuiSecretPromptPaste, startTuiSecretPrompt, type TuiSecretPromptState } from "./secret-prompt.ts";
import {
    createTuiNamePromptView,
    startTuiNamePrompt,
    type TuiNamePromptTarget,
    type TuiNamePromptState,
    type TuiNamePromptTransition,
} from "./name-prompt.ts";
import { tuiKeyChord, tuiKeyHint } from "./keymap.ts";
import { resolveTuiSettingsDestination } from "./settings-destination.ts";

/** The agent list a /agent surface renders, as the host last reported it. */
import { DIAL_HUD_CAP, dialEffortPending, renderDialStrip, DIAL_EXIT_SEPARATOR } from "./dials.ts";
import {
    AUTO_MODE_ANIMATION_DURATION_MS,
    paintDialHud,
} from "./dial-paint.ts";
import {
    recordTuiTipShown,
    selectTuiTip,
    TUI_TIPS,
    type TuiTip,
    type TuiTipContext,
} from "./tips.ts";
import { beginTuiTipLaunch, saveTuiTipState } from "./tips-store.ts";
import { createRenderCoalescer } from "./render-coalescer.ts";
import {
    createAuthStorage,
    unreadableAuthStoragePath,
    type AuthStorage,
} from "../../src/providers/auth-storage.ts";
import { configuredProviders, findConfiguredProvider, isProviderConnected } from "../../src/providers/registry.ts";
import { loginOpenAICodex } from "../../src/providers/openai-codex-oauth.ts";
import { renderPermissionInspection } from "./permission-inspection.ts";
import { createTuiPreferencesListView, handleTuiPreferencesListScroll, startTuiPreferencesList } from "./preferences-list.ts";
import { createTuiStandingNudgesView, handleTuiStandingNudgesPaste, handleTuiStandingNudgesScroll, openTuiStandingNudges, standingNudgeIndicatorRow } from "./standing-nudges.ts";
import { HostReplacementBusyError } from "../../src/host/discovery.ts";
import { HostUnresponsiveError } from "../../src/host/lockfile.ts";
import {
    DEFAULT_PROFILE_NAME,
    veraProfileDirectory,
} from "../../src/profile-paths.ts";
import {
    loadStandingNudges,
    type StandingNudge,
} from "../../src/standing-nudges.ts";
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
import { createTuiTimelinePickerView } from "./timeline-picker.ts";
import { TUI_ACCENT, TUI_ELEMENT, TUI_HUD, TUI_MUTED, TUI_NOTICE, TUI_PANEL, TUI_SUCCESS, TUI_TEXT, applyTuiTheme, appendTuiExtensionBlock, appendTuiError, appendTuiNotice, appendTuiThought, dropTuiThinking, applyAgentUpdate, beginTuiAdmission, dropTuiAdmission, createTuiState, failTuiConnection, renderTuiEntry, renderTuiQueuedPrompt, setTuiWorkspaceRoot, tuiEntryMarginTop, transcriptMessageId, type TuiState, type TuiTranscriptEntry } from "./state.ts";
import { resolveTuiTheme, tuiRecessColor, VERA_TUI_THEME } from "./theme.ts";
import { applyTuiThemeBindings, tuiThemeProperties } from "./theme-bindings.ts";
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
    tuiThemePreferencePath,
} from "./theme-preference.ts";
import { createTuiDiff, repaintTuiDiff } from "./diff.ts";
import { createTuiUserEntry, repaintTuiUserEntry } from "./user-entry.ts";
import { updateTuiToolHeader, updateTuiToolRow } from "./tool-row.ts";
import { updateTuiThinkingWindow } from "./thinking-window.ts";
import { tuiMarkdownEntryContent } from "./markdown-entry.ts";
import { tuiGutterContent, tuiGutterWidth } from "./gutter.ts";
import { type PoolChangeUndo, type TuiAgentCatalog, type TuiRuntime } from "./main/runtime.ts";
import { applyTerminalTitle, fallbackSessionTitle, adoptFallbackSessionTitle, refreshTerminalTitle, toggleMainHeader, toggleSidebarHeader, readStandingNudgeRules, adoptStandingNudgesState, isSearchLanding, markSearchLanding, clearSearchLanding, appendPendingSidebarContextNotice, refreshKeymap, coreHelpCommands, registeredPaletteEntries, workerFreeAction, createMarkdownStyle, clearSidebarEntryNodes, closeSidebarPane, composerSlotHeight, setSurfaceBottomInsets, setComposerMargin, positionCommandSuggestions, resizeComposer } from "./main/chrome.ts";
import { openExtensionAgent, focusedAgentClient, isCurrentExtensionComposeTarget, focusedAgentState, modelSettingsForAgent, modelSettingsForOpenPicker, dialPool, dialCatalog, committedDialPair, openDials, openAgentPicker, describeAgentRow, wearAgent, requestAgentCatalog, stopAutoModeAnimation, startAutoModeAnimation, closeDials, closeTransientOverlaysForUiRequest, commitDials, setSidebarFocused, focusedUiRequest, focusedAbortRequested, focusedAgentCanAbort, composerIsAtLeftBoundary, abortFocusedAgent, releaseFocusedQueuedPrompts, hostOwnsPromptQueue, visibleMentions } from "./main/agents-dials.ts";
import { hostedAgentAddressing, sidebarTranscriptWidth, mainTranscriptWidth, rememberOpenPaneGroup, forgetPersistedAgentPane, createTuiEntryNode, renderSidebarAgent, repaintSidebarForTheme, handleSidebarAgentUpdate, sidebarTheme } from "./main/sidebar-pane.ts";
import { applyTranscriptScroll, handleKeypress } from "./main/keypress.ts";
import { pressKey, rowPointer, requestAgentSettings, retryMissingAgentSettings, isSettingsRetryTrigger, requestSessionSettings, restorePersistedAgentPane, diagnosticsSnapshot, renderDiagnostics, abortProviderHealthCheck, paintDiagnosticsDialog, startProviderHealthCheck, noticeRepeatedModelFailure, writeFailureReportFile } from "./main/diagnostics-ops.ts";
import { submitPrompt } from "./main/submit-prompt.ts";
import { leaveJsonlCommandMode, refuseJsonlCommand, availableCommandSuggestions, availableCommandCompletion, routeVisibleAgentPrompt, attachImagesToSidebar, offerMessageToExtensions, attachPastedImage, releaseDroppedImage } from "./main/prompt-routing.ts";
import { receiveAgentUpdates } from "./main/agent-updates.ts";
import { sendCommand, requestExtensionModelSettingsUpdate, settleExtensionModelSettings, rejectPendingExtensionSettingsFor, notifyExtensionSettings, requireSidebarOwner, resolvePooledModel, requestExtensionOneshot, requestExtensionPicker, loadExtensionCommands, supportsSkillCommands, requestSkillCommands, receiveSkillCatalog, receiveSkillInvocation, failPendingSkillInvocations } from "./main/extension-bridge.ts";
export { sendCommand, requestExtensionModelSettingsUpdate, settleExtensionModelSettings, rejectPendingExtensionSettingsFor, notifyExtensionSettings, requireSidebarOwner, resolvePooledModel, requestExtensionOneshot, requestExtensionPicker, loadExtensionCommands, supportsSkillCommands, requestSkillCommands, receiveSkillCatalog, receiveSkillInvocation, failPendingSkillInvocations };
export { receiveAgentUpdates };
export { leaveJsonlCommandMode, refuseJsonlCommand, availableCommandSuggestions, availableCommandCompletion, routeVisibleAgentPrompt, attachImagesToSidebar, offerMessageToExtensions, attachPastedImage, releaseDroppedImage };
export { submitPrompt };
export { pressKey, rowPointer, requestAgentSettings, retryMissingAgentSettings, isSettingsRetryTrigger, requestSessionSettings, restorePersistedAgentPane, diagnosticsSnapshot, renderDiagnostics, abortProviderHealthCheck, paintDiagnosticsDialog, startProviderHealthCheck, noticeRepeatedModelFailure, writeFailureReportFile };
export { applyTranscriptScroll, handleKeypress };
export { hostedAgentAddressing, sidebarTranscriptWidth, mainTranscriptWidth, rememberOpenPaneGroup, forgetPersistedAgentPane, createTuiEntryNode, renderSidebarAgent, repaintSidebarForTheme, handleSidebarAgentUpdate, sidebarTheme };
export { openExtensionAgent, focusedAgentClient, isCurrentExtensionComposeTarget, focusedAgentState, modelSettingsForAgent, modelSettingsForOpenPicker, dialPool, dialCatalog, committedDialPair, openDials, openAgentPicker, describeAgentRow, wearAgent, requestAgentCatalog, stopAutoModeAnimation, startAutoModeAnimation, closeDials, closeTransientOverlaysForUiRequest, commitDials, setSidebarFocused, focusedUiRequest, focusedAbortRequested, focusedAgentCanAbort, composerIsAtLeftBoundary, abortFocusedAgent, releaseFocusedQueuedPrompts, hostOwnsPromptQueue, visibleMentions };
export { applyTerminalTitle, fallbackSessionTitle, adoptFallbackSessionTitle, refreshTerminalTitle, toggleMainHeader, toggleSidebarHeader, readStandingNudgeRules, adoptStandingNudgesState, isSearchLanding, markSearchLanding, clearSearchLanding, appendPendingSidebarContextNotice, refreshKeymap, coreHelpCommands, registeredPaletteEntries, workerFreeAction, createMarkdownStyle, clearSidebarEntryNodes, closeSidebarPane, composerSlotHeight, setSurfaceBottomInsets, setComposerMargin, positionCommandSuggestions, resizeComposer };

registerTuiParsers();

// The palette has no other advertisement: it is a chord, not a slash command in
// the composer's list, so the idle status line is where you find out it exists.
/** The palette's first row while a closed session file is on screen. */
export const RESUME_VIEWED_PALETTE_ENTRY: TuiPaletteEntry = {
    name: "resume-this",
    label: "Resume this conversation",
    description: "start its worker and keep reading here",
    group: "Session",
    keyHint: "enter",
    action: { type: "resume_viewed_session" },
};

const READY_HINT = `ready · ${tuiKeyHint("open_palette")}`;

function tuiDevInstancePrefix(): string {
    const marker = process.env.VERA_DEV_INSTANCE?.trim();
    return marker === undefined || marker.length === 0
        ? ""
        : `[DEV ${marker}]`;
}

export function reconnectBusyMessage(): string {
    return "Could not restart the host: other work is still using it. "
        + "Run vera host stop --force then /reconnect.";
}

/** Typed `/reconnect` force-stops a wedge. It does not kill a busy answering host. */
export function confirmManualReconnectUpgrade(error: Error): boolean {
    return error instanceof HostUnresponsiveError;
}

const MODEL_PICKER_HINT = tuiKeyHint("open_model_picker");
const HUD_HINT = tuiKeyHint("dials.open");
const SIDEBAR_HINT = tuiKeyHint("toggle_workspace_sidebar");

/** Columns the quiet status row needs with the rail's chord in it. */
function quietHintColumns(): number {
    return HUD_HINT.length + MODEL_PICKER_HINT.length + SIDEBAR_HINT.length + 6;
}
const WORKING_HINT = `esc stop · ${tuiKeyHint("interrupt")}`;
const STOPPING_HINT = "stopping…";
/** How much of a connection failure the status line carries. */
const CONNECTION_FAILURE_HINT_LIMIT = 44;

/**
 * Failure signatures already named on screen. Per run rather than per session:
 * one mention is the point, and switching sessions is not new information.
 */
export const raisedModelFailureSignatures = new Set<string>();

export const FAILURE_REPORT_SUMMARY_TOKENS = 600;

export const FAILURE_REPORT_PROMPT =
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
export const DIRECT_EXTENSION_COMMAND_TIMEOUT_MS = 2_000;
const SYMMETRIC_WAVE_FRAME_INTERVAL_MS = 360;
const SHIMMER_FRAME_INTERVAL_MS = 40;
const DEFAULT_ACTIVITY_FRAME_INTERVAL_MS = 160;
const SESSION_SWITCH_TIMEOUT_MS = 15_000;
export const POINTER_HOVER_DELAY_MS = 25;
/**
 * Two plain escapes in this window open the timeline picker, the same gesture
 * /rewind is. One press arms the window; any other key disarms it, so typing
 * between presses never counts as a double press.
 */
export const DOUBLE_ESCAPE_REWIND_WINDOW_MS = 500;
/** Rows the composer, the status band and a little transcript need. */
const SUGGESTIONS_RESERVED_ROWS = 12;

/**
 * Whether an answer closes a stretch of tool work. Thoughts and notices do not
 * count: a rule that fires on every turn stops marking anything.
 */
export function assistantFollowsTools(
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

export function displayModeLabel(label: string): string {
    return `${label.slice(0, 1).toUpperCase()}${label.slice(1)}`;
}

function tuiContextSnapshot(
    measurement: TuiState["context"],
    settings: TuiState["modelSettings"],
): VeraClientContextSnapshot {
    if (measurement === undefined) {
        return { availability: "unavailable" };
    }
    const capacity = effectiveContextWindow(
        settings?.contextWindow,
        settings?.contextLimit,
    );
    const model = settings?.model === undefined
        ? undefined
        : {
            model: settings.model,
            ...(settings.provider === undefined
                ? {}
                : { provider: settings.provider }),
            ...(capacity === undefined ? {} : { capacity }),
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
                ...(component.parts === undefined
                    ? {}
                    : {
                        parts: component.parts.map((part) => ({
                            id: part.id,
                            displayName: part.displayName,
                            scope: part.scope,
                            bytes: part.bytes,
                            estimatedTokens: part.estimatedTokens,
                            ...(part.imported === true ? { imported: true } : {}),
                        })),
                    }),
            })),
        };
    return {
        availability: model !== undefined
                && capacity !== undefined
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
    readonly openConfigurationFile?: (path: string) => Promise<void>;
    /** Compatibility hook for callers that only open the profile config. */
    readonly openConfigure?: () => Promise<void>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    /** Host-held model state for a client with no session, used by home. */
    readonly readHostModelSettings?: (
        workspace: string,
    ) => Promise<ModelTurnSettings | undefined>;
    /** False when this machine has no conversations yet: home drops a row. */
    readonly homeHasSessions?: boolean;
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
    /** Hard-close one root and its owned tree, resolving at quiescence. */
    readonly closeSession?: (agentId: string) => Promise<CloseAgentResult>;
    /**
     * Scan the host's transcripts. Absent when this client reaches no host
     * that can search, which the overlay states rather than showing as an
     * empty past.
     */
    readonly searchSessions?: (
        query: SessionSearchQuery,
    ) => Promise<SessionSearchResults>;
    readonly reconnectSession?: (
        agentId: string,
        options?: { readonly replaceExisting?: boolean },
    ) => Promise<TuiAgentClient>;
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
        readonly hostBuildId?: string;
        readonly hostPid?: number;
        readonly hostStartedAt?: string;
    };
    /** Overrides the read-only process sampler for deterministic TUI tests. */
    readonly doctor?: () => Promise<VeraDoctorReport>;
    /** Annex base URL. The TUI opens /usage on it. Absent when this host has none. */
    readonly openUsagePage?: () => Promise<AnnexUrlResult>;
    /** Overrides `~/.vera/auth.json`, so a test never reads real credentials. */
    readonly authStorage?: AuthStorage;
    /** Overrides the live `admitModel` probe inspect uses for provider health. */
    readonly probeHealthRung?: (
        rung: HealthRung,
        signal: AbortSignal,
    ) => Promise<boolean>;
    /** Overrides process env for whether inspect health treats a provider as connected. */
    readonly healthEnv?: Readonly<Record<string, string | undefined>>;
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

export function requireIdentifiedClient(
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
        type: "home",
        workspace: process.cwd(),
    });
}

/** One row is enough to know the machine is not new. */
/**
 * Whether home offers its `All conversations` row.
 *
 * It asks what the session list would show, not how many session files exist:
 * a machine whose only conversations were opened and never spoken to has a
 * list with nothing in it, and a row that opens an empty list is a dead end.
 * Pages are walked because the untitled ones sort in among the rest, and
 * capped because startup waits on this.
 */
async function hostHasSessions(socketPath: string): Promise<boolean> {
    try {
        let cursor: string | undefined;
        for (let page = 0; page < HOME_SESSION_PROBE_PAGES; page += 1) {
            const listed = await listAgentPageThroughHost(socketPath, {
                limit: 50,
                order: "recent",
                ...(cursor === undefined ? {} : { cursor }),
            });
            if (listed.agents.some((agent) => sessionPickerLists(agent))) {
                return true;
            }
            cursor = listed.nextCursor;
            if (cursor === undefined) return false;
        }
        return false;
    } catch {
        // A listing this client could not read is not proof of a new machine.
        return true;
    }
}

const HOME_SESSION_PROBE_PAGES = 4;

export async function startConfiguredTui(
    target: TuiStartTarget,
    options: TuiStartOptions = {},
): Promise<void> {
    installLiveProcess("tui");
    installTerminalRestoreOnExit();
    // Optional on purpose: the host owns the config, and the only fields read
    // here are the client's own extension lists. Requiring the file made
    // `vera attach` against an already-running host fail on a fresh machine.
    const config = loadOptionalVeraConfig({ projectRoot: process.cwd() });
    let host = await findOrStartResidentHost({
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
    let agentId = resolvedTarget.type === "home"
        ? undefined
        : resolvedTarget.type === "create"
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
    // Home starts a worker for nothing: the card is on screen until the user
    // says which conversation this is.
    const homeHasSessions = resolvedTarget.type !== "home"
        ? undefined
        : await hostHasSessions(host.socket_path);
    const client = agentId === undefined
        ? createHomeClient(process.cwd(), {
            readModelSettings: (workspace) =>
                readModelSettingsThroughHost(host.socket_path, workspace),
        })
        : await agentClients.attach(agentId);
    const flightRecorder = createTuiFlightRecorder();
    if (agentId !== undefined) flightRecorder.sessionEntered(agentId);
    const rememberSession = (enteredAgentId: string): void => {
        saveTuiRecentSessionId(enteredAgentId);
    };
    try {
        if (agentId !== undefined) rememberSession(agentId);
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
        // A pool file the parser had to reduce still produced a pool, so this
        // says so instead of failing: the entries that were dropped are the
        // ones the user thinks are in force.
        const worktreeNotice = worktreeRuntimeNotice();
        const startupNotices = [
            ...(worktreeNotice === undefined ? [] : [worktreeNotice]),
            ...poolFileIssueNotices(
                loadPoolFile({ projectRoot: process.cwd() }).issues,
            ),
        ];
        const exit = await startTui({
            client,
            readHostModelSettings: (workspace) =>
                readModelSettingsThroughHost(host.socket_path, workspace),
            ...(homeHasSessions === undefined ? {} : { homeHasSessions }),
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
            closeSession: (targetAgentId) =>
                closeAgentThroughHost(host.socket_path, targetAgentId),
            // Read through the host rather than the session directory: the
            // host owns which profile's transcripts are the live ones, and a
            // client that resolved the path itself could search a different
            // profile from the one it is attached to.
            searchSessions: (query) =>
                searchSessionsThroughHost(host.socket_path, query),
            reconnectSession: async (currentAgentId, options) => {
                // No readline here: the renderer owns the screen. Typed
                // `/reconnect` is the confirm for a wedge; auto-restart after
                // a drop is not. A busy answering host must refuse rather
                // than be killed. Directory is not host identity.
                const replaceExisting = options?.replaceExisting === true;
                host = await findOrStartResidentHost({
                    confirmBusyUpgrade: replaceExisting
                        ? confirmManualReconnectUpgrade
                        : () => false,
                    ...(replaceExisting ? { replaceExisting: true } : {}),
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
                clientVersion: readStampedRelease().build_id,
                ...(host.build_id === undefined
                    ? {}
                    : { hostBuildId: host.build_id }),
                hostPid: host.pid,
                hostStartedAt: host.started_at,
            },
            openUsagePage: () => readAnnexUrlThroughHost(host.socket_path),
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
    const rt = { dependencies } as TuiRuntime;

    /**
     * The session currently on screen.
     *
     * Reassigned by switchToClient rather than fixed for the life of the TUI:
     * moving to another session is a detach and an attach, and everything that
     * talks to the host reads this binding at the moment it sends.
     */
    rt.client = rt.dependencies.client;
    rt.homeClientOptions = rt.dependencies.readHostModelSettings === undefined
        ? {}
        : { readModelSettings: rt.dependencies.readHostModelSettings };
    rt.flightRecorder = rt.dependencies.flightRecorder;
    rt.flightRecorder?.sessionEntered(rt.client.agentId ?? "unknown");
    rt.configuredAppearance = rt.dependencies.appearance
        ?? resolveTuiAppearance();
    setTuiWorkspaceRoot(rt.client.workspace ?? process.cwd());
    rt.renderer = await (rt.dependencies.createRenderer?.()
        ?? createCliRenderer({
            exitOnCtrlC: false,
            targetFps: 30,
        }));
    // ctrl+shift chords (model picker, jump, live session cycle) only arrive
    // when the terminal reports them. Ask for the kitty keyboard protocol so
    // a supporting terminal actually sends them.
    rt.renderer.enableKittyKeyboard();
    rt.appearance = fitTuiAppearance(rt.configuredAppearance, rt.renderer.width);
    rt.composerContentIndent = tuiComposerContentIndent(rt.appearance);
    rt.composerHorizontalInset = rt.composerContentIndent * 2;
    rt.entrySpacing = {
        message: rt.appearance.messageSpacing,
        toolGroup: rt.appearance.toolGroupSpacing,
    };
    rt.copyText = rt.dependencies.copyText
        ?? ((text: string) => copyTuiText(text, rt.renderer));
    rt.mainHeaderVisible = true;
    rt.sidebarHeaderVisible = true;
    applyTerminalTitle(rt);
    refreshTerminalTitle(rt);
    rt.themeName = loadTuiThemePreference();
    rt.activityAnimation = loadTuiActivityAnimationPreference();
    rt.activityAnimationInterval =
        loadTuiActivityAnimationIntervalPreference();
    rt.activityAnimationWidth = loadTuiActivityAnimationWidthPreference();
    rt.sidebarWidth = loadTuiSidebarWidth();
    rt.hostedPanePersistence = new TuiHostedPanePersistence();
    rt.theme = await resolveTuiTheme(rt.renderer, rt.themeName);
    applyTuiTheme(rt.theme);

    rt.state = createTuiState();
    rt.appendTranscriptRenderable = () => {
        throw new Error("Native transcript is not ready");
    };
    rt.openInspectDocument = () => {};
    for (const notice of rt.dependencies.startupNotices ?? []) {
        rt.state = appendTuiNotice(rt.state, notice);
    }
    rt.shuttingDown = false;
    rt.clientSurfaceReady = false;
    rt.transcriptSeeded = false;
    rt.pendingTranscriptReseed = false;
    rt.deferredKeymapNotices = [];
    // The arrival notice lands twice on purpose: once before the history
    // rebuild, which floats it above the transcript, and once after, so it is
    // also the last line the reader reaches.
    rt.experimentalTuiHost = createTuiExperimentalHost({
        renderer: rt.renderer,
        theme: rt.theme,
        workspace: () => rt.client.workspace ?? process.cwd(),
        transcript: () => rt.state.entries.flatMap((entry) =>
            (entry.kind === "user" || entry.kind === "assistant")
                && entry.text.length > 0
                ? [{ role: entry.kind, text: entry.text }]
                : []
        ),
        onFailure: (extensionId, message) => {
            if (rt.shuttingDown) return;
            rt.state = appendTuiNotice(
                rt.state,
                `${extensionId}: experimental TUI view failed: ${message}`,
            );
        },
        onRenderRequested: () => {
            if (rt.clientSurfaceReady) renderState(rt);
        },
        appendTranscriptRenderable: (node) => rt.appendTranscriptRenderable(node),
        openDocument: (document) => rt.openInspectDocument(document),
    });
    rt.connectionFailed = false;
    // One automatic host restart per drop. A failed attempt sits disconnected
    // so `/reconnect` stays the next move instead of looping. Cleared only
    // after a reconnected session is actually idle; clearing it at switch
    // time lets a dying worker restart the host forever and freeze the TUI.
    rt.hostReconnectAttempted = false;
    // This attachment already delivered agent_failed. The stream closing
    // after that is not a dropped host.
    rt.agentFailedThisAttachment = false;
    rt.statusNoticeVersion = 0;
    // What each in-flight change asked for, so a rejection can name it. The
    // status line reports the effective values once a change lands.
    rt.requestedModelChanges = new Map<string, {
        readonly subject: string;
        readonly patch: ModelSettingsPatch;
        readonly target: TuiAgentClient;
    }>();
    rt.requestedPermissionChanges = new Map<string, string>();
    rt.abortRequested = false;







    rt.queuedUiRequests = [];
    rt.queuedConfigurationRequests = [];
    rt.followTranscriptAfterUiRequest = false;
    rt.pendingExtensionSettings = new Map<
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
    rt.extensionSettingsListeners = new Set<
        (settings: NonNullable<typeof rt.state.modelSettings>) => void
    >();
    rt.extensionAgentTarget = new AsyncLocalStorage<TuiAgentClient>();
    rt.keybindingOverlay = loadTuiKeybindingOverlay();
    rt.announcedKeymapNotices = new Set<string>();
    /** The dial strip, open only while it is on screen. */
    /** A decorative flourish shown only inside the HUD when auto is entered. */
    /** The last catalog the host sent, which /agent opens against. */
    /** Suggesters escape put away, for the rest of this session. */
    rt.dismissedComposeSuggesters = new Set<string>();

    rt.pendingAgentCatalogs = new Map<
        string,
        (catalog: TuiAgentCatalog | undefined) => void
    >();
    rt.pendingSkillInvocations = new Map<string, string>();
    rt.messageInterceptPending = false;
    rt.standingNudgesProfileDirectory = veraProfileDirectory();
    rt.standingNudgeRules = readStandingNudgeRules(rt);


    /** The picker pane the preferences list was opened over, restored on close. */
    /**
     * The workspace side bar, mounted or not.
     *
     * A dock rather than an overlay: it remains beside the conversation while
     * the composer is active. Only its focused state claims bare keys; chords
     * pass through so ctrl+e can focus or remove the dock.
     */
    /** A dock can remain visible while typing; only focused docks claim keys. */
    rt.workspaceSidebarFocused = false;
    rt.workspaceSidebarDocked = loadTuiWorkspaceSidebarDocked();
    rt.workspaceRailPreferred = loadTuiWorkspaceSidebarWidth();
    /**
     * The row columns the side bar is currently drawn as a rail in, or nothing
     * while it is closed or drawn as a card. Held so the transcript beside it
     * is only reflowed when the layout actually changes.
     */
    rt.workspaceRailDragging = false;
    /** The rail width and terminal width the layout below was laid out for. */
    /** The last side bar state handed to the view, as drawn. */
    /** Client state. A pin orders one person's list and never reaches a host. */
    rt.workspacePinnedIds = loadTuiPinnedSessionIds();
    /**
     * The last index the host sent, held whether or not the tab is open: the
     * counts and the notifications are facts about the machine, and they do
     * not start existing when someone happens to look.
     */
    // Where the user was before switching anywhere: the single back target,
    // deliberately not a stack, so /back always means "where I started".
    // Only the id is held; the path and title are resolved when used, from
    // the same listing every other session surface reads.
    // The origin's name at hop time, for the arrival notice. The notice
    // fires once right after the switch, so a later rename is fine to miss.
    /**
     * Assumed focused until the terminal says otherwise. A terminal that does
     * not answer focus reporting would otherwise be treated as never watched,
     * and every approval would ring the bell under the person's nose.
     */
    rt.terminalFocused = true;
    rt.searchInFlight = false;
    /**
     * The transcript row a search asked to land on, and the session it lives
     * in, until it is on screen.
     *
     * The session is half the target, not decoration: closing the overlay
     * paints the conversation that was already open, and a target that only
     * named a row would be spent on that paint before the session it belongs
     * to had loaded.
     */
    /**
     * The block a search last landed on, marked in its gutter so the reader
     * can see which one answered the query.
     *
     * Held rather than painted once: the row is rebuilt whenever the window
     * moves, and a mark that survived only until the next scroll would be gone
     * by the time the reader looked for it.
     */

    /** Whether a rebuilt row is the one the last search landed on. */

    /**
     * Draws the landing marker on a built row, whatever kind it is.
     *
     * The user band owns its whole width and so has no gutter column; it
     * carries the marker in its own caret instead.
     */

    /** Drops the landing mark and restores the marked row's own marker. */
    rt.diagnosticsScope = "session";
    rt.diagnosticsProcessMemory = new Map();
    rt.diagnosticsSessionPathResolved = false;
    rt.diagnosticsGeneration = 0;
    rt.providerHealth = idleProviderHealth();
    rt.providerHealthGeneration = 0;
    rt.doctorInspectionGeneration = 0;
    rt.hostExtensionCommands = [];
    rt.disposeHostExtensionCommands = (): void => {};
    rt.extensionCommandsGeneration = 0;
    rt.disposeSkillCommands = (): void => {};
    rt.announcedSkillCommandNotices = new Set<string>();
    rt.confirmingFullAccess = false;
    /**
     * The pool add whose name prompt is still owed, if any. Naming is offered
     * once, at the moment the entry appears, and skipping it is a plain escape.
     */
    rt.pendingPoolChanges = new Map<string, PoolChangeUndo>();
    rt.pendingPoolUndos = new Map<string, {
        readonly undo: PoolChangeUndo;
        readonly completesOnSettings: boolean;
    }>();
    /**
     * A probe of every model the user keeps, one at a time. Sequential because
     * each entry is a live call to a provider, and a burst of them is the
     * shape rate limits are written against.
     */
    /** In-flight catalog refreshes, by request, so the reply can name one. */
    rt.catalogRefreshes = new Map<string, string>();
    /**
     * A refresh of several providers, one at a time. Sequential for the same
     * reason the probe sweep is: each entry is a live call, and what comes
     * back is counted against what was there before so the sweep can say what
     * actually changed.
     */
    /** The model pane the dialog covered, put back when the dialog leaves. */
    /**
     * The settings change each in-flight admission was meant to end in,
     * applied when its "added" verdict lands. Keyed by requestId rather than
     * held on the dialog: hiding the dialog must not lose the switch.
     */
    rt.sessionTrashPending = false;
    /**
     * In-flight close is waiting on `[1] close`. Idle `/close` and ctrl+w
     * skip this and park immediately.
     */
    rt.sessionCloseConfirm = false;
    /**
     * The credential `delete` asked to forget, waiting on the confirmation.
     *
     * It carries the pane to reopen because the connect list is read off disk:
     * forgetting changes the disk, so the pane is rebuilt rather than patched.
     */
    rt.commandSuggestionIndex = 0;
    /** Whether the highlighted row was chosen rather than merely first. */
    rt.commandSuggestionMoved = false;
    /** The argument values on offer, empty whenever the list is commands. */
    rt.argumentSuggestions = [];
    /** Names an extension offers after an `@`, replaced wholesale. */
    rt.extensionMentions = [];
    // Who an extension says the next message is going to. The client only
    // shows the name; it does not know what makes a message go there.
    rt.activity = "thinking";
    rt.themeApplicationVersion = 0;
    /**
     * Bumped by every switch, so the update pump reading the session being left
     * can tell that it is stale and stop instead of writing that session's
     * updates into the transcript of the one now on screen.
     */
    rt.clientGeneration = 0;
    /** Bumped whenever keyboard ownership moves between agent composers. */
    rt.composeSurfaceGeneration = 0;
    rt.resumeListVersion = 0;
    rt.promptSubmitting = false;
    rt.sessionSwitchPending = false;
    rt.sessionSwitchActivity = "starting new session…";
    rt.sessionSwitchBufferedUpdates = [];
    rt.sessionSwitchClearingMain = false;
    rt.extensionCommandPending = false;
    rt.clientExtensionReloadPending = false;
    rt.clientExtensionReload = {
        status: "never",
        loadedExtensionIds: [],
        failures: [],
    };
    rt.sidebarPromptSubmitting = false;
    rt.extensionCommandsLoading =
        rt.dependencies.client.listExtensionCommands !== undefined
        && rt.dependencies.client.failed !== true
        && rt.dependencies.client.viewOnly !== true;
    rt.skillCommandsLoading = supportsSkillCommands(rt, rt.dependencies.client);
    rt.runningBackgroundAgents = 0;
    rt.runningBackgroundAgentNames = [];
    rt.currentAgentHasParent = false;
    /**
     * Oneshots in flight, keyed by request. Several may run at once: an
     * extension with more than one seat asks them all in parallel.
     */
    rt.pendingOneshots = new Map<string, {
        readonly resolve: (result: VeraClientOneshotResult) => void;
        readonly reject: (reason: Error) => void;
    }>();
    rt.hostedSidebar = new TuiHostedSidebarAgent({
        onUpdate(update, current) {
            handleSidebarAgentUpdate(rt, update, current);
            if (update.type === "user_prompt") {
                appendPendingSidebarContextNotice(rt, current);
            }
            renderSidebarAgent(rt, current);
            if (
                update.type === "ui_request"
                || update.type === "ui_request_closed"
            ) {
                focusActiveSurface(rt);
            }
        },
        onFailure(error, current) {
            if (current !== rt.hostedSidebar.pane) return;
            rejectPendingExtensionSettingsFor(rt, current.client, error);
            rt.sidebar.append("agent", `Connection failed: ${error.message}`);
            renderState(rt);
        },
    });
    rt.submitAfterImageAttachment = false;
    rt.pendingImages = [];
    /** Scratch copies of dropped images, held until the host has the bytes. */
    rt.droppedImageReleases = new Map<string, () => Promise<void>>();
    if (rt.dependencies.initialDraft !== undefined) {
        rt.pendingImages = rt.dependencies.initialDraft.attachmentIds.map((id) => ({
            requestId: randomUUID(),
            id,
        }));
    }
    rt.finished = Promise.withResolvers<TuiExit>();
    rt.disabledBuiltinExtensions =
        rt.dependencies.disabledBuiltinExtensions ?? [];
    rt.commandRegistry = createConfiguredBuiltinTuiCommandRegistry(
        rt.disabledBuiltinExtensions,
    );
    rt.configuredClientExtensions = configuredTuiClientExtensions(
        rt.disabledBuiltinExtensions,
        rt.dependencies.clientExtensions,
    );
    rt.hostedAgentSurface = createTuiHostedAgentSurface({
        owner: () => rt.hostedSidebar.owner,
        hasAgent: () => rt.hostedSidebar.pane !== undefined,
        layout: () => rt.sidebar.layout(),
        isFocused: () => rt.sidebar.isFocused(),
        cycleSidebarLayout: () => rt.sidebar.cycleLayout(),
        setSidebarFocused: ((focused: boolean) => setSidebarFocused(rt, focused)),
        focusComposer: () => rt.composer.focus(),
        renderState: (() => renderState(rt)),
        renderStatus: (() => renderStatus(rt)),
        requestRender: () => rt.renderer.requestRender(),
    });
    rt.startConfiguredClientExtensionHost =
        createTuiClientExtensionHostStarter({
            extensions: () => rt.configuredClientExtensions,
            currentModelSettings: () => focusedAgentState(rt).modelSettings,
            currentContext: () => tuiContextSnapshot(
                focusedAgentState(rt).context,
                focusedAgentState(rt).modelSettings,
            ),
            compose: {
                capture(): TuiExtensionComposeTarget | undefined {
                    const target = rt.extensionAgentTarget.getStore();
                    return target === undefined ? undefined
                        : captureTuiExtensionComposeTarget({
                            client: target,
                            clientGeneration: rt.clientGeneration,
                            surfaceGeneration: rt.composeSurfaceGeneration,
                        });
                },
                insert(_extensionId, opaqueTarget, text) {
                    const target = opaqueTarget as TuiExtensionComposeTarget;
                    if (!isCurrentExtensionComposeTarget(rt, target)) {
                        return { status: "stale" };
                    }
                    rt.composer.insertComposerText(text);
                    renderCommandSuggestions(rt);
                    renderState(rt);
                    return { status: "accepted" };
                },
                focus(_extensionId, opaqueTarget) {
                    const target = opaqueTarget as TuiExtensionComposeTarget;
                    if (!isCurrentExtensionComposeTarget(rt, target)) {
                        return { status: "stale" };
                    }
                    if (
                        !rt.clientSurfaceReady
                        || !rt.composerBox.visible
                        || activeOverlayFocus(rt) !== undefined
                    ) {
                        return { status: "ineligible" };
                    }
                    rt.composer.focus();
                    rt.flightRecorder?.record({
                        type: "focus_changed",
                        surface: rt.sidebar.isFocused()
                            ? "sidebar_composer"
                            : "main_composer",
                    });
                    return { status: "accepted" };
                },
            },
            updateModelSettings: ((patch: VeraClientModelSettingsPatch, signal: AbortSignal) => requestExtensionModelSettingsUpdate(rt, patch, signal)),
            subscribeModelSettings(listener) {
                rt.extensionSettingsListeners.add(listener);
                return () => {
                    rt.extensionSettingsListeners.delete(listener);
                };
            },
            requestPicker: (request, signal) =>
                requestExtensionPicker(rt, request, signal),
            requestOneshot: (request, signal) =>
                requestExtensionOneshot(rt, request, signal),
            openSidebar(extensionId) {
                rt.hostedSidebar.claim(extensionId);
                rt.sidebar.setHeader(undefined);
                rt.sidebarHeaderVisible = true;
                rt.sidebar.open();
                renderState(rt);
            },
            appendSidebar(extensionId, block) {
                requireSidebarOwner(rt, extensionId);
                rt.sidebar.append(block.label, block.text, block.speaker);
                renderSidebarJump(rt);
            },
            clearSidebar(extensionId) {
                requireSidebarOwner(rt, extensionId);
                rt.sidebar.clear();
            },
            closeSidebar(extensionId) {
                requireSidebarOwner(rt, extensionId);
                closeSidebarPane(rt, extensionId);
            },
            setMentions(names) {
                rt.extensionMentions = names;
                if (rt.clientSurfaceReady) {
                    renderCommandSuggestions(rt);
                }
            },
            setAddressing(name) {
                rt.extensionAddressee = name;
                renderState(rt);
            },
            agents: createTuiClientExtensionAgentsAdapter({
                primary: () => rt.client,
                sidebar: () => rt.hostedSidebar.pane,
                sidebarMention: () => rt.hostedSidebar.mention,
                createAgent: rt.dependencies.createAgent,
                branchAgent: rt.dependencies.branchAgent,
            syncAgentContext: rt.dependencies.syncAgentContext,
            contextSynchronized(agentId, turns) {
                const side = rt.hostedSidebar.pane;
                if (side === undefined || side.agentId !== agentId) return;
                const text = `Caught up with ${turns} new ${
                    turns === 1 ? "turn" : "turns"
                } from the primary conversation.`;
                rt.pendingSidebarContextNotice = { agentId, text };
            },
                attachAgent: rt.dependencies.attachAgent,
                adoptAgent: (
                    extensionId,
                    next,
                    pane,
                    mention,
                    attachmentLifetime,
                    initialApprovalMode,
                    statusLabel,
                    signal,
                ) => openExtensionAgent(rt, 
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
                ...rt.experimentalTuiHost.adapter,
                agentSurface: rt.hostedAgentSurface,
            },
            ...(rt.dependencies.listSessionPage === undefined ? {} : {
                listSessions: (request: VeraClientSessionListRequest) =>
                    listSessionsForExtension(
                        rt.dependencies.listSessionPage!,
                        request,
                    ),
            }),
            readThread() {
                return rt.state.entries
                    .filter((entry) =>
                        (entry.kind === "user" || entry.kind === "assistant")
                        && entry.text.length > 0)
                    .map((entry) => ({
                        role: entry.kind as "user" | "assistant",
                        text: entry.text,
                    }));
            },
            appendTranscript(block) {
                rt.state = appendTuiExtensionBlock(rt.state, block.label, block.text);
                renderState(rt);
            },
            postNotice(text, noticeOptions) {
                rt.state = appendTuiNotice(rt.state, text, noticeOptions?.tone);
                renderState(rt);
                if (
                    noticeOptions?.replay === true
                    && rt.client.supportsHostCapability?.(
                        HOST_CAPABILITY_HARNESS_MESSAGES,
                    ) === true
                ) {
                    void rt.client.send({
                        type: "append_harness_message",
                        text,
                        tone: noticeOptions.tone ?? "primary",
                    });
                }
            },
            commandRegistry: rt.commandRegistry,
            onFailure(failure, failureSink) {
                const summary = `${failure.extensionId ?? failure.path}: ${failure.message}`;
                if (failureSink !== undefined) {
                    failureSink.push(summary);
                } else {
                    rt.state = appendTuiNotice(rt.state, summary);
                }
            },
        });
    rt.clientExtensionHost = createTuiClientExtensionHostController(
        rt.startConfiguredClientExtensionHost,
        (registry) => {
            rt.clientExtensionRegistry = registry;
            refreshKeymap(rt);
            if (registry === undefined) {
                rt.extensionMentions = [];
                rt.extensionAddressee = undefined;
                rt.commandPalette = undefined;
                rt.help = undefined;
                const attached = rt.hostedSidebar.release();
                if (attached !== undefined) {
                    rejectPendingExtensionSettingsFor(rt, 
                        attached.client,
                        new Error("The client extension host closed"),
                    );
                    // Reloading an extension generation removes the pane it
                    // owned. During TUI shutdown the pane was already released
                    // above, so its durable restore record must survive.
                    forgetPersistedAgentPane(rt);
                }
                void attached?.detach().catch(() => attached.close());
                clearSidebarEntryNodes(rt);
                rt.sidebar.clear();
                rt.sidebarSessionTitle = undefined;
                rt.sidebar.setHeader(undefined);
                rt.sidebarHeaderVisible = true;
                rt.sidebar.close();
            }
            if (rt.clientSurfaceReady) {
                renderCommandSuggestions(rt);
                renderState(rt);
            }
        },
    );
    await rt.clientExtensionHost.reload();
    refreshKeymap(rt);
    rt.directClientExtensions = bundledClientExtensions();
    for (const extension of rt.directClientExtensions) {
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
            rt.commandRegistry,
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



    /** Actions a closed session file can run without starting its worker. */

    rt.markdownStyle = createMarkdownStyle(rt, rt.theme);

    rt.transcript = new ScrollBoxRenderable(rt.renderer, {
        id: "transcript",
        flexGrow: 1,
        width: "100%",
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
        wrapperOptions: {
            paddingRight: rt.appearance.transcriptPaddingRight,
        },
        contentOptions: {
            flexDirection: "column",
            gap: 0,
            paddingTop: 0,
            paddingBottom: 1,
            paddingLeft: rt.appearance.transcriptPaddingLeft,
        },
    });
    rt.appendTranscriptRenderable = (node) => {
        const container = new BoxRenderable(rt.renderer, {
            id: `extension-transcript-${randomUUID()}`,
            width: "100%",
        });
        container.add(node);
        let active = true;
        rt.transcript.add(container);
        return async () => {
            if (!active) return;
            active = false;
            rt.transcript.remove(container.id);
            container.remove(node.id);
            container.destroy();
        };
    };

    rt.JUMP_TO_BOTTOM_LABEL =
        ` ↓ Jump to bottom · ${tuiKeyHint("jump_to_bottom")} `;
    rt.jumpToBottomText = new TextRenderable(rt.renderer, {
        id: "jump-to-bottom-text",
        content: rt.JUMP_TO_BOTTOM_LABEL,
        fg: rt.theme.background,
        bg: rt.theme.accent,
        width: "100%",
        height: 1,
    });
    rt.jumpToBottom = new BoxRenderable(rt.renderer, {
        id: "jump-to-bottom",
        position: "absolute",
        width: rt.JUMP_TO_BOTTOM_LABEL.length,
        height: 1,
        backgroundColor: rt.theme.accent,
        zIndex: 4,
        visible: false,
        onMouseDown: () => {
            rt.transcript.scrollTo(rt.transcript.scrollHeight);
            renderJumpToBottom(rt);
        },
    });
    rt.jumpToBottom.add(rt.jumpToBottomText);

    // The sidebar gets the same pill, shortened: the column is narrow, and the
    // key jumps the transcript, so there is nothing to name here but the way
    // back down.
    rt.SIDEBAR_JUMP_LABEL = " \u2193 Jump to bottom ";
    rt.sidebarJumpText = new TextRenderable(rt.renderer, {
        id: "sidebar-jump-text",
        content: rt.SIDEBAR_JUMP_LABEL,
        fg: rt.theme.background,
        bg: rt.theme.accent,
        width: "100%",
        height: 1,
    });
    rt.sidebarJump = new BoxRenderable(rt.renderer, {
        id: "sidebar-jump",
        position: "absolute",
        width: rt.SIDEBAR_JUMP_LABEL.length,
        height: 1,
        backgroundColor: rt.theme.accent,
        zIndex: 4,
        visible: false,
        onMouseDown: () => {
            rt.sidebar.scrollToBottom();
            renderJumpToBottom(rt);
        },
    });
    rt.sidebarJump.add(rt.sidebarJumpText);

    rt.placeholder = new TextRenderable(rt.renderer, {
        id: "placeholder",
        content: "Start a conversation with Vera.",
        fg: TUI_MUTED,
        width: "100%",
        marginLeft: rt.appearance.activityIndent,
    });
    rt.transcript.add(rt.placeholder);

    rt.transcriptEntryWindow = new BoxRenderable(rt.renderer, {
        id: "transcript-entry-window",
        width: "100%",
        flexDirection: "column",
        flexShrink: 0,
    });
    rt.transcriptWindowTopSpacer = new BoxRenderable(rt.renderer, {
        id: "transcript-window-top-spacer",
        width: "100%",
        height: 0,
        flexShrink: 0,
    });
    rt.transcriptWindowBottomSpacer = new BoxRenderable(rt.renderer, {
        id: "transcript-window-bottom-spacer",
        width: "100%",
        height: 0,
        visible: false,
        flexShrink: 0,
    });
    rt.transcriptEntryWindow.add(rt.transcriptWindowTopSpacer);
    rt.transcriptEntryWindow.add(rt.transcriptWindowBottomSpacer);
    rt.transcript.add(rt.transcriptEntryWindow);

    // Parallel sparse arrays: both use the reduced transcript index as their
    // contract. A missing slot means that entry has not been materialized,
    // while a present node and kind must be assigned or deleted together.
    rt.entryNodes = [];
    rt.entryNodeKinds = [];
    rt.entryNodeSources = new WeakMap<
        TextRenderable | MarkdownRenderable | BoxRenderable,
        TuiTranscriptEntry
    >();
    rt.materializedEntryStart = 0;
    rt.materializedEntryEnd = 0;
    /**
     * The rows an entry occupied while it was materialized.
     *
     * The spacer stands in for released entries, so a released entry's height
     * has to come back the same or the rows below it shift under the reader.
     * A measurement is exact where the estimate is not, which is what keeps
     * releasing and rebuilding a batch free of any scroll correction. Width
     * changes what an entry measures, so the whole cache is dropped on resize.
     */
    rt.measuredEntryRows = [];
    rt.measuredEntryRowsWidth = 0;
    /**
     * The entry the reader was reading and where it sat in the viewport, to be
     * put back once the layout it is waiting on has run.
     *
     * Anything that changes what stands above the viewport moves every row
     * below it: a width change, and materializing entries the spacer was
     * standing in for. A laid-out node says exactly how far, where the row
     * estimate the spacer was built from only guesses.
     */
    rt.sidebarEntryNodes = [];
    rt.sidebarEntryNodeKinds = [];
    rt.sidebarEntryGeneration = 0;


    /** Close the attached peer without ending its durable session. */

    rt.statusText = new TextRenderable(rt.renderer, {
        id: "status",
        content: READY_HINT,
        fg: TUI_MUTED,
        height: 1,
        flexGrow: 1,
        flexShrink: 1,
    });
    rt.activityHintText = new TextRenderable(rt.renderer, {
        id: "activity-hint",
        content: "",
        fg: TUI_MUTED,
        height: 1,
        flexShrink: 0,
        alignSelf: "flex-end",
    });
    rt.dialCardTitle = new TextRenderable(rt.renderer, {
        id: "dial-card-title",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: 3,
        flexShrink: 0,
    });
    rt.dialCardHint = new TextRenderable(rt.renderer, {
        id: "dial-card-hint",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        flexShrink: 0,
    });
    rt.dialCard = new BoxRenderable(rt.renderer, {
        id: "dial-card",
        // No border, and so no border styling option either: OpenTUI's
        // BoxRenderable reads any of them as "this box wants a border" and
        // overrides `border: false`. The HUD's own ground is what separates
        // it from the screen, the way the other overlays are drawn.
        border: false,
        backgroundColor: TUI_HUD?.background ?? TUI_PANEL,
        height: 6,
        marginLeft: rt.appearance.composerMarginHorizontal,
        marginRight: rt.appearance.composerMarginHorizontal,
        marginBottom: 1,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: rt.appearance.composerPaddingHorizontal + 1,
        paddingRight: rt.appearance.composerPaddingHorizontal + 1,
        flexDirection: "column",
        zIndex: DIALOG_CARD_Z_INDEX,
        focusable: true,
        visible: false,
    });
    rt.dialCard.add(rt.dialCardTitle);
    rt.dialCard.add(rt.dialCardHint);
    rt.backgroundStatusText = new TextRenderable(rt.renderer, {
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
    rt.statusCard = new BoxRenderable(rt.renderer, {
        id: "status-card",
        border: false,
        width: "100%",
        height: "auto",
        flexDirection: "column",
    });
    rt.statusCard.add(rt.backgroundStatusText);
    rt.workspaceBranch = watchWorkspaceBranch(
        process.cwd(),
        () => rt.renderer.requestRender(),
    );
    // A text node paints only the cells its glyphs fill, so the status rows
    // would show the transcript through every gap in the line, and through the
    // spaces inside it. The band that backs them is this box rather than a
    // sibling behind them: a sibling is sized from the rows' heights, which say
    // nothing about whether the rows are drawn, so every surface that hid a
    // status row left the paint behind. Held together, hiding the rows hides
    // the band, and one height serves the composer's margin as well.
    rt.statusBand = new BoxRenderable(rt.renderer, {
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
        paddingLeft: rt.composerContentIndent,
        paddingRight: rt.composerContentIndent,
        zIndex: DIALOG_BACKGROUND_Z_INDEX,
    });
    rt.hostedModeText = new TextRenderable(rt.renderer, {
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
    rt.placeRow = new BoxRenderable(rt.renderer, {
        id: "place-row",
        width: "100%",
        height: "auto",
        flexDirection: "row",
    });
    rt.statusCard.flexGrow = 1;
    rt.statusCard.flexShrink = 1;
    rt.placeRow.add(rt.statusCard);
    rt.placeRow.add(rt.hostedModeText);
    rt.activityRow = new BoxRenderable(rt.renderer, {
        id: "activity-row",
        width: "100%",
        height: 1,
        flexDirection: "row",
    });
    rt.activityRow.add(rt.statusText);
    rt.activityRow.add(rt.activityHintText);
    rt.statusBand.add(rt.activityRow);
    rt.statusBand.add(rt.placeRow);

    // Read here rather than passed in: tips are a client-side display choice,
    // and the host has no say in them.
    rt.tipsConfig = loadOptionalVeraConfig();
    rt.tipsEnabled = rt.tipsConfig === undefined
        || configuredTipsEnabled(rt.tipsConfig);
    // Tips read their own launch counter on the way in, so the count advances
    // once per start no matter how many tips the run goes on to show.
    rt.tipState = rt.tipsEnabled
        ? beginTuiTipLaunch()
        : { launches: 0, history: {} };
    // The line above the composer, cleared on the next submit. The overlay's
    // own line is chosen separately: an overlay is a place the user went
    // looking for keys, so it is allowed a tip even when the transcript one
    // has already been spent this turn.
    rt.workingLastRender = false;

    rt.composerTipText = new TextRenderable(rt.renderer, {
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

    rt.quoteText = new TextRenderable(rt.renderer, {
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
    rt.statusBand.add(rt.quoteText);

    rt.heldAddressText = new TextRenderable(rt.renderer, {
        id: "held-address",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });

    // The lines naming the sessions around this one: a parent to return to,
    // or the subagents running under it. They read above the composer rather
    // than under it. The rows under the composer are then fixed in height, so
    // the composer holds the same distance off the foot of the screen and
    // these lines take their room from the transcript instead.
    rt.agentNoticeText = new TextRenderable(rt.renderer, {
        id: "agent-notice",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });

    rt.queuedPromptText = new TextRenderable(rt.renderer, {
        id: "queued-prompt",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });

    rt.composer = createTuiComposer(
        rt.renderer,
        // Called with the editor's value, which is not what submitPrompt's
        // parameter means.
        () => submitPrompt(rt),
        ((path: string) => attachPastedImage(rt, path)),
    );
    rt.composer.onCommandDelete = () => {
        if (
            rt.composer.plainText.length === 0
            || anyOverlayOpen(rt)
        ) return false;
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        renderState(rt);
        return true;
    };
    rt.composer.onImageChipRemoved = (requestId) => {
        releaseDroppedImage(rt, requestId);
        rt.pendingImages = rt.pendingImages.filter(
            (image) => image.requestId !== requestId,
        );
        if (rt.pendingImages.length === 0) {
            rt.submitAfterImageAttachment = false;
        }
        renderState(rt);
    };
    if (rt.dependencies.initialDraft !== undefined) {
        rt.composer.setComposerText(rt.dependencies.initialDraft.text);
        for (const image of rt.pendingImages) {
            rt.composer.attachImageChip(image.requestId);
        }
    }
    rt.timelinePickerView = createTuiTimelinePickerView(rt.renderer);
    rt.settingsPickerView = createTuiSettingsPickerView(rt.renderer);
    rt.secretPromptView = createTuiSecretPromptView(rt.renderer);
    rt.namePromptView = createTuiNamePromptView(rt.renderer);
    rt.providerFormView = createTuiProviderFormView(rt.renderer);
    rt.requestOptionsEditorView = createTuiRequestOptionsEditorView(rt.renderer);
    rt.preferencesListView = createTuiPreferencesListView(rt.renderer);
    rt.standingNudgesView = createTuiStandingNudgesView(rt.renderer);
    rt.commandPaletteView = createTuiCommandPaletteView(rt.renderer);
    rt.workTabView = createTuiLinesView(rt.renderer, "work-tab");
    rt.workspaceSidebarView = createTuiLinesView(
        rt.renderer,
        "workspace-sidebar",
        { railDivider: true, railPadding: 2 },
    );
    // The search list changes with every keystroke, so its card keeps the
    // height it windows to rather than growing and shrinking under the typing.
    rt.searchOverlayView = createTuiLinesView(rt.renderer, "search-overlay", {
        fillHeight: true,
    });
    rt.helpView = createTuiHelpView(rt.renderer);
    rt.diagnosticsDialogView = createTuiDiagnosticsDialogView(rt.renderer, {
        showScopeTabs: true,
    });
    rt.extensionsDialogView = createTuiDiagnosticsDialogView(rt.renderer, {
        id: "extensions-dialog",
        title: "Extensions",
        footerText: "Managed installs stay outside the Vera release.",
        skipFirstLine: false,
    });
    rt.doctorDialogView = createTuiDiagnosticsDialogView(rt.renderer, {
        id: "doctor-dialog",
        title: "Doctor",
        footerText: "Read-only; no processes are stopped.",
        pendingText: "checking process health…",
        emphasis: "doctor",
    });
    rt.documentDialogView = createTuiDiagnosticsDialogView(rt.renderer, {
        id: "inspect-document-dialog",
        title: "Report",
        footerText: "",
        skipFirstLine: false,
    });
    rt.permissionsConfirmView = createTuiPermissionsConfirmView(
        rt.renderer,
        rt.theme,
    );
    rt.admissionDialogView = createTuiAdmissionDialogView(rt.renderer);
    rt.sessionTrashConfirmView =
        createTuiSessionTrashConfirmView(rt.renderer);
    rt.sessionCloseConfirmView =
        createTuiSessionCloseConfirmView(rt.renderer);
    rt.providerForgetConfirmView =
        createTuiProviderForgetConfirmView(rt.renderer);
    rt.approvalView = createTuiApprovalView(rt.renderer);
    rt.questionView = createTuiQuestionView(rt.renderer);
    [
        rt.timelinePickerView,
        rt.settingsPickerView,
        rt.secretPromptView,
        rt.namePromptView,
        rt.providerFormView,
        rt.requestOptionsEditorView,
        rt.preferencesListView,
        rt.standingNudgesView,
        rt.commandPaletteView,
        rt.helpView,
        rt.diagnosticsDialogView,
        rt.extensionsDialogView,
        rt.doctorDialogView,
        rt.documentDialogView,
        rt.permissionsConfirmView,
        rt.admissionDialogView,
        rt.sessionTrashConfirmView,
        rt.sessionCloseConfirmView,
        rt.providerForgetConfirmView,
        rt.approvalView,
        rt.questionView,
    ].forEach((view) => registerDialogCard(view.box));

    rt.openInspectDocument = (document) => {
        rt.diagnosticsGeneration += 1;
        abortProviderHealthCheck(rt);
        rt.providerHealthGeneration += 1;
        rt.diagnosticsDialog = undefined;
        rt.doctorDialog = undefined;
        rt.extensionsDialog = undefined;
        const renderMarkdown = typeof document.markdown === "function"
            ? document.markdown
            : undefined;
        const columns = rt.documentDialogView.contentWidth();
        rt.documentDialog = {
            title: document.title,
            text: renderMarkdown === undefined
                ? document.markdown as string
                : renderMarkdown(columns),
            footerText: document.footerText ?? "",
            copyReady: true,
            ...(renderMarkdown === undefined ? {} : { renderMarkdown }),
        };
        renderState(rt);
        focusActiveSurface(rt);
    };

    rt.commandSuggestionsText = new TextRenderable(rt.renderer, {
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
    rt.commandSuggestionsBox = new BoxRenderable(rt.renderer, {
        id: "command-suggestions",
        border: false,
        position: "absolute",
        ...tuiComposerOverlayInset(rt.appearance),
        bottom: 7,
        height: 1,
        paddingTop: 1,
        backgroundColor: rt.theme.background,
        zIndex: 5,
        visible: false,
    });
    rt.commandSuggestionsBox.add(rt.commandSuggestionsText);
    rt.composer.onContentChange = (() => renderCommandSuggestions(rt));

    rt.jumpMenuText = new TextRenderable(rt.renderer, {
        id: "jump-menu-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
    });
    // A quick detour, not a workspace: the menu hangs off the composer at the
    // status row that announces its targets, rather than taking the screen
    // the way the work tab does.
    rt.jumpMenuBox = new BoxRenderable(rt.renderer, {
        id: "jump-menu",
        border: true,
        borderStyle: "rounded",
        borderColor: rt.theme.element,
        focusedBorderColor: rt.theme.element,
        title: " Jump ",
        position: "absolute",
        left: tuiComposerOverlayInset(rt.appearance).paddingLeft,
        width: 40,
        height: 3,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: rt.theme.panel,
        zIndex: 5,
        visible: false,
        onMouseDown: (event) => {
            if (rt.jumpMenu === undefined) return;
            const lines = jumpMenuLines(rt.jumpMenu, jumpMenuContentWidth(rt));
            const line = lines[event.y - rt.jumpMenuBox.y - 1];
            if (line?.rowIndex === undefined) return;
            const row = rt.jumpMenu.rows[line.rowIndex];
            if (row !== undefined) runJumpTo(rt, row);
        },
    });
    rt.jumpMenuBox.add(rt.jumpMenuText);

    /**
     * How many rows the status band takes under the composer. The suggestion
     * strip floats outside the layout flow and has to clear that band, so the
     * margin is kept here rather than read back off the box.
     */
    rt.composerMarginRows = 2;
    /** Rows the agent notice above the composer is currently drawing. */
    rt.agentNoticeRows = 0;
    /**
     * A slash typed on a closed session file opens the composer for the few
     * commands that need no worker. Escape puts the notice back.
     */
    rt.jsonlCommandMode = false;


    /**
     * Hold every full-height surface off whatever the foot of the screen holds.
     *
     * Home has no composer, so a card that reserved one anyway would stop a
     * third of the way up a screen with nothing under it.
     */



    rt.modeToastText = new TextRenderable(rt.renderer, {
        id: "mode-toast-text",
        content: "",
        fg: rt.theme.text,
        bg: rt.theme.panel,
        width: "100%",
        height: 1,
    });
    rt.modeToast = new BoxRenderable(rt.renderer, {
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
        backgroundColor: rt.theme.panel,
        zIndex: 4,
        visible: false,
    });
    rt.modeToast.add(rt.modeToastText);
    rt.modeToastVersion = 0;

    const {
        panel: composerBox,
        status: composerStatusText,
        rule: composerRule,
        argumentHint: slashArgumentHint,
    } = createTuiComposerPanel(rt.renderer, rt.composer, {
        marginHorizontal: rt.appearance.composerMarginHorizontal,
        paddingHorizontal: rt.appearance.composerPaddingHorizontal,
        boundaryColor: rt.appearance.composerBoundaryColor ?? rt.theme.element,
    });
    rt.composerBox = composerBox;
    rt.composerStatusText = composerStatusText;
    rt.composerRule = composerRule;
    rt.slashArgumentHint = slashArgumentHint;
    rt.resumeOverlay = createTuiResumeOverlayView(rt.renderer, () => {
        resumeJsonlView(rt);
    });
    rt.homeState = createHomeState(
        rt.dependencies.homeHasSessions ?? true,
    );
    /**
     * What was typed on home, still growing while the conversation it started
     * is being created. The composer does not exist yet, so nothing else would
     * catch the rest of the sentence.
     */
    /**
     * Enter arrived on home before the conversation it started existed. The
     * message is sent as soon as there is a composer holding it.
     */
    rt.homeSubmitPending = false;
    rt.homeView = createTuiHomeView(rt.renderer, (action) => {
        runHomeAction(rt, action);
    });
    rt.homeView.applyAppearance({
        textColor: rt.theme.text,
        mutedColor: rt.theme.muted,
        accentColor: rt.theme.accent,
    });
    rt.homeView.update(rt.homeState);
    rt.resumeOverlay.applyAppearance({
        marginHorizontal: rt.appearance.composerMarginHorizontal,
        paddingHorizontal: rt.appearance.composerPaddingHorizontal,
        boundaryColor: rt.appearance.composerBoundaryColor ?? rt.theme.element,
        backgroundColor: rt.theme.input ?? rt.theme.background,
        noticeColor: rt.theme.panel,
        textColor: rt.theme.text,
        mutedColor: rt.theme.muted,
        accentColor: rt.theme.accent,
    });
    setSurfaceBottomInsets(rt, rt.composerBox.height + rt.composerMarginRows);
    // The attention chip at the head of the status row is a click target,
    // and it does what its label says: the hint reads /work, so the click
    // opens the work tab. Width zero means no chip is on screen.
    rt.needsYouChipWidth = 0;
    rt.composerStatusText.onMouseDown = (event) => {
        if (isWorkerFreeClient(rt.client)) return;
        if (rt.needsYouChipWidth === 0) return;
        if (event.x - rt.composerStatusText.x >= rt.needsYouChipWidth) return;
        openWorkTab(rt);
    };
    rt.composerTextRows = TUI_COMPOSER_MIN_TEXT_ROWS;
    rt.requestedComposerTextRows = TUI_COMPOSER_MIN_TEXT_ROWS;
    rt.composer.onTypedRowsChange = ((requestedRows: number) => resizeComposer(rt, requestedRows));

    rt.bodyFocus = new TuiBodyFocusController();
    // Everything the sidebar sits beside: the conversation and what hangs off
    // it, but not the composer, so the split ends where typing begins.
    rt.upper = new BoxRenderable(rt.renderer, {
        id: "upper",
        flexGrow: 1,
        flexDirection: "column",
        gap: 1,
    });
    rt.app = new BoxRenderable(rt.renderer, {
        id: "app",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        // The whole screen carries the theme's background. Painting it here
        // rather than under the surfaces that need it is what keeps a strip of
        // a different shade from showing wherever one of them is hidden.
        backgroundColor: rt.theme.background,
        paddingTop: APP_PADDING_TOP,
        paddingBottom: APP_PADDING_BOTTOM,
        onMouseDrag: (event: MouseEvent) => {
            rt.bodyFocus.noteDrag();
            if (!rt.workspaceRailDragging) return;
            event.preventDefault();
            event.stopPropagation();
            resizeWorkspaceRailAt(rt, event.x);
        },
        onMouseDragEnd: () => rt.bodyFocus.noteDrag(),
        onMouseUp: (event: MouseEvent) => {
            if (rt.workspaceRailDragging) {
                rt.workspaceRailDragging = false;
                rt.workspaceSidebarView.box.borderColor = rt.theme.element;
                event.stopPropagation();
                if (rt.workspaceRailPreferred !== undefined) {
                    try {
                        saveTuiWorkspaceSidebarWidth(rt.workspaceRailPreferred);
                    } catch {
                        // The rail keeps the width reached in this session.
                    }
                }
                return;
            }
            if (rt.bodyFocus.release(anyOverlayOpen(rt))) {
                // A click in the chat is the keyboard leaving the rail. Without
                // this the rail keeps its focus mark and its chord block while
                // the cursor sits in the composer.
                if (rt.workspaceSidebarFocused) {
                    rt.workspaceSidebarFocused = false;
                    renderState(rt);
                }
                rt.composer.focus();
            }
        },
    });
    rt.sidebar = createTuiSidebar({
        renderer: rt.renderer,
        transcript: rt.upper,
        theme: sidebarTheme(rt),
        syntaxStyle: rt.markdownStyle,
        ...(rt.sidebarWidth === undefined ? {} : { initialWidth: rt.sidebarWidth }),
        onWidthChanged: (columns) => {
            try {
                saveTuiSidebarWidth(columns);
            } catch {
                // A width that could not be saved is not worth interrupting a
                // drag over; the sidebar keeps it for this session.
            }
        },
        onHeaderClick: (() => toggleSidebarHeader(rt)),
        onMainHeaderClick: (() => toggleMainHeader(rt)),
        onPanelRelease: () => {
            if (rt.hostedSidebar.pane === undefined || anyOverlayOpen(rt)) return;
            // Pointer input never chooses the addressed agent; Ctrl+G owns
            // that. It does return typing focus after either transcript is
            // clicked or selected, matching the main pane.
            rt.composer.focus();
            renderState(rt);
        },
        // Clicking the column is how you talk to it: with one seat there is no
        // question who, and typing the name again is the part nobody wants.
        onPanelClick: () => {
            if (rt.hostedSidebar.pane !== undefined) {
                return;
            }
            const declared = rt.clientExtensionRegistry
                ?.experimentalHostedAgentAddressing(rt.hostedSidebar.owner);
            const first = declared?.secondary ?? visibleMentions(rt)[0];
            if (first === undefined) return;
            // Already addressing someone (even with a trailing space): a
            // second click must not stack another mention.
            if (/(?:^|\s)@\S*\s*$/.test(rt.composer.plainText)) return;
            rt.composer.setComposerText(
                rt.composer.plainText.length === 0
                    ? `@${first} `
                    : `${rt.composer.plainText} @${first} `,
            );
            setSidebarFocused(rt, true);
            rt.composer.focus();
            renderCommandSuggestions(rt);
            renderState(rt);
        },
        onLayoutChanged: () => {
            renderJumpToBottom(rt);
            renderSidebarJump(rt);
            renderCommandSuggestions(rt);
            const settings = focusedAgentState(rt).modelSettings;
            if (settings !== undefined) notifyExtensionSettings(rt, settings);
        },
    });





    /** The settings owned by the agent that opened an application picker. */

    /**
     * Keep a side agent's running pair while accepting the main host's fresh
     * global shortlist. A pool edit is sent on the main connection, but that
     * must not make a picker opened for another agent call Vera's pair
     * "current" when its reply arrives.
     */

    /** The pool as the strip needs it: identity, name, and published levels. */

    /**
     * Level facts for models the pool has no ready entry for, from the
     * catalog the host already sends. Facts only: these never become rows.
     */


    /**
     * Show the strip. Nothing is sent, nothing changes: the strip proposes.
     *
     * The recents come from the session's own model-setting history, which is
     * re-read here so the next open reflects whatever this session did since.
     */

    /**
     * The agent surface: what is live, and how to change it.
     *
     * A readout first. Switching is the loud action it also offers, and `[d]`
     * writes the session's pair into the highlighted agent's file — the only
     * write into an agent a wire command can do.
     */


    /** Enqueued, never applied here: the host decides where in the queue it lands. */





    /**
     * A ui_request from the agent (approval, question) owns the session pane.
     * Pickers and menus are not part of answering it, so they close rather
     * than painting over or stealing focus from the request. A docked agent
     * rail is navigation outside that pane: it yields focus but stays visible.
     */

    /** The pair as the next request will carry it. Nothing reaches the API now. */















    /**
     * One rendered transcript block: the entry's own renderable, wrapped in
     * the marker column unless it draws its own chrome edge to edge.
     */



    rt.upper.add(rt.transcript);
    rt.upper.add(rt.experimentalTuiHost.transcriptBottom);
    rt.app.add(rt.experimentalTuiHost.transcriptTop);
    rt.app.add(rt.sidebar.body);
    rt.app.add(rt.jumpToBottom);
    rt.app.add(rt.sidebarJump);
    rt.app.add(rt.modeToast);
    rt.overlayScrim = new BoxRenderable(rt.renderer, {
        id: "overlay-scrim",
        position: "absolute",
        // Stretched from above the app's top padding to below its bottom one.
        // An absolute child is laid out inside its parent's content box, so
        // the edges are pulled back out to the screen. Both edges and no
        // height: a height is measured against the content box and wins over
        // `bottom`, which leaves the last row undimmed.
        left: 0,
        top: -APP_PADDING_TOP,
        bottom: -APP_PADDING_BOTTOM,
        width: "100%",
        // Enough to push the transcript behind the card, not enough to erase
        // it. A heavier wash reads fine on paper and fails on the dark themes,
        // where the ground is already near black and the text lands on top of
        // it: what is behind a dialog still has to be legible as context.
        backgroundColor: RGBA.fromInts(0, 0, 0, 150),
        zIndex: DIALOG_SCRIM_Z_INDEX,
        visible: false,
    });
    rt.app.add(rt.overlayScrim);
    rt.app.add(rt.experimentalTuiHost.overlay);
    rt.upper.add(rt.queuedPromptText);
    rt.app.add(rt.commandSuggestionsBox);
    rt.app.add(rt.jumpMenuBox);
    rt.app.add(rt.approvalView.box);
    rt.app.add(rt.questionView.box);
    rt.app.add(rt.timelinePickerView.box);
    // Clicking a row is the pointer's version of ⏎ on it, and hovering is the
    // pointer's version of ↑↓. Each surface only says where its cursor lives;
    // `rowPointer` supplies the behaviour, so the two input paths cannot drift.
    //
    // The wheel is a third path and a separate one: it is bound per overlay
    // below, and it moves the cursor without activating anything. All three end
    // up at the same cursor, so a change to what a row means has to be made in
    // the surface's key handler, which is the only place all three meet.
    rt.timelinePickerView.pointer = rowPointer(rt, (index) => {
        if (rt.timelinePicker === undefined) return;
        // The rewind flow reuses one overlay for two lists. On the action
        // screen the rows are the actions themselves, so there is no cursor to
        // move first; the digit press below carries the choice.
        if (rt.timelinePicker.screen !== "select") return;
        rt.timelinePicker = { ...rt.timelinePicker, selectedIndex: index };
    });
    rt.settingsPickerView.pointer = rowPointer(rt, (index) => {
        if (rt.settingsPicker === undefined) return;
        rt.settingsPicker = moveTuiSettingsPickerPointer(rt.settingsPicker, index);
    });
    rt.settingsPickerView.onTab = (tab) => {
        // The strip is on screen on the connect pane too, and a chip on it
        // leaves that pane for the collection it names.
        const pane = rt.settingsPicker?.kind === "provider"
            ? rt.settingsPicker.parent
            : rt.settingsPicker;
        if (pane === undefined || pane.kind !== "model") {
            return;
        }
        rt.settingsPicker = switchedModelTab(pane, tab);
        renderState(rt);
    };
    rt.settingsPickerView.onConfigure = () => {
        if (rt.settingsPicker?.kind === "provider") return;
        if (rt.settingsPicker?.kind !== "model") return;
        openProviderPicker(rt, rt.settingsPicker);
    };
    rt.preferencesListView.pointer = rowPointer(rt, (index) => {
        if (rt.preferencesList === undefined) return;
        rt.preferencesList = { ...rt.preferencesList, selectedIndex: index };
    });
    rt.commandPaletteView.pointer = rowPointer(rt, (index) => {
        if (rt.commandPalette === undefined) return;
        rt.commandPalette = { ...rt.commandPalette, selectedIndex: index };
    });
    rt.helpView.pointer = rowPointer(rt, (index) => {
        if (rt.help === undefined) return;
        rt.help = { ...rt.help, selectedIndex: index };
    });
    // The approval and question dialogs are answered by number, not by a
    // moving highlight, so a click sends the row's own digit.
    rt.approvalView.pointer = rowPointer(rt, () => {}, "digit");
    rt.questionView.pointer = rowPointer(rt, () => {}, "digit");
    // The pane windows itself around the cursor, so the wheel moves the cursor
    // and lets the window follow, the same way ctrl+d and ctrl+u do.
    rt.settingsPickerView.box.onMouseScroll = (event) => {
        const scroll = event.scroll;
        if (rt.settingsPicker === undefined || scroll === undefined) return;
        const transition = handleTuiSettingsPickerScroll(rt.settingsPicker, scroll);
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        applySettingsPickerTransition(rt, transition);
    };
    rt.app.add(rt.settingsPickerView.box);
    rt.app.add(rt.secretPromptView.box);
    rt.app.add(rt.namePromptView.surface);
    rt.app.add(rt.providerFormView.surface);
    rt.app.add(rt.requestOptionsEditorView.surface);
    // Every windowed overlay takes the wheel, not just the one it was built for
    // first. The handlers are the same three lines because the movement itself
    // lives in list-window.ts.
    rt.preferencesListView.box.onMouseScroll = (event) => {
        if (rt.preferencesList === undefined || event.scroll === undefined) return;
        const transition = handleTuiPreferencesListScroll(
            rt.preferencesList,
            event.scroll,
        );
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        rt.preferencesList = transition.state;
        renderState(rt);
    };
    rt.standingNudgesView.box.onMouseScroll = (event) => {
        if (rt.standingNudges === undefined || event.scroll === undefined) return;
        if (rt.standingNudgesView.scroll(event.scroll)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const transition = handleTuiStandingNudgesScroll(
            rt.standingNudges,
            event.scroll,
        );
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        rt.standingNudges = transition.state;
        renderState(rt);
    };
    rt.commandPaletteView.box.onMouseScroll = (event) => {
        if (rt.commandPalette === undefined || event.scroll === undefined) return;
        const transition = handleTuiCommandPaletteScroll(
            rt.commandPalette,
            event.scroll,
        );
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        rt.commandPalette = transition.state;
        renderState(rt);
    };
    rt.helpView.box.onMouseScroll = (event) => {
        if (rt.help === undefined || event.scroll === undefined) return;
        const transition = handleTuiHelpScroll(rt.help, event.scroll);
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        rt.help = transition.state;
        renderState(rt);
    };
    rt.app.add(rt.preferencesListView.surface);
    rt.app.add(rt.standingNudgesView.surface);
    rt.app.add(rt.commandPaletteView.surface);
    // Hover moves the cursor and a click acts on it, the same as every other
    // overlay: a row the arrows can reach is a row the mouse can reach.
    rt.workTabView.pointer = {
        hover: (rowId) => {
            if (rt.workTab === undefined || rt.workTab.selectedId === rowId) return;
            rt.workTab = { ...rt.workTab, selectedId: rowId };
            renderState(rt);
        },
        activate: (rowId) => {
            if (rt.workTab === undefined) return;
            const open = { ...rt.workTab, selectedId: rowId };
            rt.workTab = open;
            const action = workTabAction(open.index, rowId);
            if (action !== undefined) runWorkTabAction(rt, open, action);
        },
    };
    // Hover moves the cursor and a click activates the row it landed on, the
    // same as every other list: a row the arrows can reach is a row the mouse
    // can reach.
    rt.workspaceSidebarView.pointer = {
        hover: (rowId) => {
            if (focusedUiRequest(rt) !== undefined) return;
            if (rt.workspaceSidebar === undefined) return;
            if (rt.workspaceSidebar.selectedId === rowId) return;
            rt.workspaceSidebar = { ...rt.workspaceSidebar, selectedId: rowId };
            renderState(rt);
        },
        activate: (rowId) => {
            // A question or approval owns this session pane. The rail stays
            // visible for context, but its dimmed controls must not queue a
            // hidden picker or start a session transition behind the request.
            if (focusedUiRequest(rt) !== undefined) return;
            if (rt.workspaceSidebar === undefined) return;
            const headerAction = workspaceHeaderAction(rowId);
            if (headerAction !== undefined) {
                runWorkspaceSidebarAction(rt, headerAction);
                return;
            }
            const open = { ...rt.workspaceSidebar, selectedId: rowId };
            rt.workspaceSidebar = open;
            const action = openWorkspaceSelection(open, rowId);
            if (action !== undefined) runWorkspaceSidebarAction(rt, action);
        },
    };
    rt.workspaceSidebarView.box.onMouseDown = (event: MouseEvent) => {
        const occupied = rt.workspaceSidebarView.railColumns();
        if (
            occupied === undefined
            || event.x !== occupied - 1
        ) return;
        event.preventDefault();
        event.stopPropagation();
        rt.workspaceRailDragging = true;
        rt.workspaceSidebarView.box.borderColor = rt.theme.accent;
    };
    rt.searchOverlayView.pointer = {
        hover: (rowId) => {
            const selected = searchSelectionOf(rowId);
            if (rt.searchOverlay === undefined || selected === undefined) return;
            rt.searchOverlay = { ...rt.searchOverlay, selected };
            renderState(rt);
        },
        activate: (rowId) => {
            const selected = searchSelectionOf(rowId);
            if (rt.searchOverlay === undefined || selected === undefined) return;
            rt.searchOverlay = { ...rt.searchOverlay, selected };
            const action = openSelected(rt.searchOverlay);
            if (action !== undefined) runSearchOverlayAction(rt, action);
        },
    };
    // The card windows itself around the cursor, so a wheel that moved the
    // window on its own would leave enter pointing at a row off screen.
    rt.workTabView.box.onMouseScroll = (event) => {
        if (rt.workTab === undefined || event.scroll === undefined) return;
        const rows = rt.workTab.index.rows;
        const at = rows.findIndex((row) => row.id === rt.workTab?.selectedId);
        const next = wheelCursor(Math.max(0, at), rows.length, event.scroll);
        const selectedId = next === undefined ? undefined : rows[next]?.id;
        if (selectedId === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        rt.workTab = { ...rt.workTab, selectedId };
        renderState(rt);
    };
    rt.workspaceSidebarView.box.onMouseScroll = (event) => {
        if (rt.workspaceSidebar === undefined || event.scroll === undefined) return;
        const open = rt.workspaceSidebar;
        const rows = workspaceSidebarLayout(open, {
            columns: rt.renderer.width,
            now: new Date(),
        }).selectable;
        const at = rows.indexOf(open.selectedId ?? "");
        const next = wheelCursor(Math.max(0, at), rows.length, event.scroll);
        const selectedId = next === undefined ? undefined : rows[next];
        if (selectedId === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        rt.workspaceSidebar = { ...open, selectedId };
        renderState(rt);
    };
    rt.searchOverlayView.box.onMouseScroll = (event) => {
        if (rt.searchOverlay === undefined || event.scroll === undefined) return;
        const selections = searchSelections(rt.searchOverlay);
        const at = selections.findIndex((candidate) =>
            candidate.sessionId === rt.searchOverlay?.selected?.sessionId
            && candidate.hitIndex === rt.searchOverlay.selected.hitIndex);
        const next = wheelCursor(
            Math.max(0, at),
            selections.length,
            event.scroll,
        );
        const selected = next === undefined ? undefined : selections[next];
        if (selected === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        rt.searchOverlay = { ...rt.searchOverlay, selected };
        renderState(rt);
    };
    rt.app.add(rt.workTabView.surface);
    rt.app.add(rt.workspaceSidebarView.surface);
    rt.app.add(rt.searchOverlayView.surface);
    rt.app.add(rt.helpView.box);
    rt.app.add(rt.diagnosticsDialogView.box);
    rt.app.add(rt.extensionsDialogView.box);
    rt.app.add(rt.doctorDialogView.box);
    rt.app.add(rt.documentDialogView.box);
    rt.app.add(rt.permissionsConfirmView.box);
    rt.app.add(rt.admissionDialogView.surface);
    rt.app.add(rt.sessionTrashConfirmView.surface);
    rt.app.add(rt.sessionCloseConfirmView.surface);
    rt.app.add(rt.providerForgetConfirmView.surface);
    rt.app.add(rt.composerTipText);
    rt.app.add(rt.experimentalTuiHost.footer);
    rt.app.add(rt.experimentalTuiHost.composerAdornment);
    // Pinned beside the composer, not written into the transcript: a mode the
    // transcript announces is a mode that scrolls out of sight.
    rt.app.add(rt.heldAddressText);
    rt.app.add(rt.dialCard);
    rt.app.add(rt.homeView.surface);
    rt.app.add(rt.agentNoticeText);
    rt.app.add(rt.composerBox);
    rt.app.add(rt.resumeOverlay.surface);
    rt.app.add(rt.statusBand);
    rt.renderer.root.add(rt.app);
    rt.clientSurfaceReady = true;
    rt.composer.focus();
    rt.flightRecorder?.record({
        type: "focus_changed",
        surface: "main_composer",
    });
    renderStatus(rt);

    // Beside the renderer's own reader rather than instead of it. Node hands
    // every `data` listener the same chunk, so this observes without
    // consuming, which is the only way to see these: the key parser drops the
    // focus sequences before any keypress handler runs.
    rt.watchTerminalFocus = (chunk: Buffer | string): void => {
        const focus = parseTerminalFocusEvent(
            typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
        if (focus !== undefined) rt.terminalFocused = focus === "focus_in";
    };
    process.stdin.on("data", rt.watchTerminalFocus);

    rt.stopWatchingTerminal = watchTerminalLoss(() => rt.renderer.destroy());

    rt.renderer.on(CliRenderEvents.DESTROY, () => {
        rt.stopWatchingTerminal();
        rt.flightRecorder?.record({ type: "renderer_destroyed" });
        rt.shuttingDown = true;
        stopAutoModeAnimation(rt);
        rt.renderCoalescer.stop();
        clearInterval(rt.statusTimer);
        rt.stopWatchingBackgroundAgents?.();
        rt.stopWatchingBackgroundAgents = undefined;
        rt.stopWatchingWorkIndex?.();
        rt.stopWatchingWorkIndex = undefined;
        rt.disposeSkillCommands();
        rt.disposeSkillCommands = () => {};
        rt.pendingSkillInvocations.clear();
        process.stdin.off("data", rt.watchTerminalFocus);
        writeTerminal(rt, FOCUS_REPORTING_OFF);
        const picker = rt.pendingExtensionPicker;
        rt.pendingExtensionPicker = undefined;
        picker?.removeAbortListener();
        picker?.resolve({ outcome: "cancelled" });
        for (const pending of rt.pendingExtensionSettings.values()) {
            pending.removeAbortListener();
            pending.reject(new Error("TUI is closing"));
        }
        rt.pendingExtensionSettings.clear();
        const attachedSidebar = rt.hostedSidebar.release();
        void rt.clientExtensionHost.close()
            .catch(() => undefined)
            .then(() => rt.experimentalTuiHost.close())
            .then(async () => {
                await stopClientForShutdown(rt, rt.client);
                if (
                    attachedSidebar !== undefined
                    && attachedSidebar.agentId !== rt.client.agentId
                ) {
                    await stopClientForShutdown(rt, attachedSidebar.client);
                }
            })
            .then(() => {
                rt.finished.resolve(
                    rt.client.agentId === undefined
                        ? {}
                        : { agentId: rt.client.agentId },
                );
            });
    });

    /** The column's share of whichever theme is current. */

    rt.renderCoalescer = createRenderCoalescer({ render: (() => renderState(rt)) });

    rt.renderer.on(CliRenderEvents.FRAME, () => {
        settleTranscriptScrollState(rt);
        measureMaterializedTranscriptEntries(rt);
        // Materializing and releasing both write the nodes and the spacers
        // they touch, so neither needs a repaint of the rest of the screen.
        // At most one runs per frame: releasing what was just built would
        // rebuild it on the next frame.
        // A pending search target owns the window until its row is on screen.
        // Moving it in the same frame would release the row the scroll is
        // about to reach.
        if (
            rt.pendingSearchTarget === undefined
            && !maybeSnapTranscriptWindowToTail(rt)
            && !maybeMaterializeEarlierTranscriptEntries(rt)
            && !maybeMaterializeLaterTranscriptEntries(rt)
        ) {
            maybeEvictTranscriptEntries(rt);
        }
        if (rt.pendingTranscriptScrollAnchor !== undefined) {
            // The rows that just arrived have no position until a layout runs,
            // and the frame about to be painted is the one that would show
            // them in the wrong place.
            rt.renderer.root.calculateLayout();
            applyTranscriptScrollAnchor(rt);
        }
        showSearchTarget(rt);
    });

    rt.statusTimer = setInterval(() => {
        renderStatus(rt);
        refreshTimedSurfaces(rt);
    }, rt.activityAnimation === "shimmer"
        ? rt.activityAnimationInterval ?? SHIMMER_FRAME_INTERVAL_MS
        : STATUS_REFRESH_INTERVAL_MS);
    watchBackgroundAgents(rt, rt.dependencies.client);
    watchWorkIndex(rt, rt.dependencies.client);
    // Asked for once, at startup: a terminal that answers reports every change
    // from here on, and one that does not leaves `terminalFocused` true, which
    // is the quiet default.
    writeTerminal(rt, FOCUS_REPORTING_ON);

    rt.renderer.on(CliRenderEvents.RESIZE, () => {
        rt.overlayScrim.width = rt.renderer.width;
        rt.appearance = fitTuiAppearance(rt.configuredAppearance, rt.renderer.width);
        rt.composerContentIndent = tuiComposerContentIndent(rt.appearance);
        rt.composerHorizontalInset = rt.composerContentIndent * 2;
        rt.composerBox.marginLeft = rt.appearance.composerMarginHorizontal;
        rt.composerBox.marginRight = rt.appearance.composerMarginHorizontal;
        rt.composerBox.paddingLeft = rt.appearance.composerPaddingHorizontal;
        rt.composerBox.paddingRight = rt.appearance.composerPaddingHorizontal;
        rt.resumeOverlay.applyAppearance({
            marginHorizontal: rt.appearance.composerMarginHorizontal,
            paddingHorizontal: rt.appearance.composerPaddingHorizontal,
            boundaryColor: rt.appearance.composerBoundaryColor ?? rt.theme.element,
            backgroundColor: rt.theme.input ?? rt.theme.background,
            noticeColor: rt.theme.panel,
            textColor: rt.theme.text,
            mutedColor: rt.theme.muted,
            accentColor: rt.theme.accent,
        });
        rt.dialCard.marginLeft = rt.appearance.composerMarginHorizontal;
        rt.dialCard.marginRight = rt.appearance.composerMarginHorizontal;
        rt.dialCard.paddingLeft = rt.appearance.composerPaddingHorizontal + 1;
        rt.dialCard.paddingRight = rt.appearance.composerPaddingHorizontal + 1;
        rt.statusBand.paddingLeft = rt.composerContentIndent;
        rt.statusBand.paddingRight = rt.composerContentIndent;
        const suggestionInset = tuiComposerOverlayInset(rt.appearance);
        rt.commandSuggestionsBox.left = suggestionInset.left;
        rt.commandSuggestionsBox.right = suggestionInset.right;
        rt.commandSuggestionsBox.paddingLeft = suggestionInset.paddingLeft;
        rt.commandSuggestionsBox.paddingRight = suggestionInset.paddingRight;
        rt.transcript.content.paddingLeft = rt.appearance.transcriptPaddingLeft;
        rt.transcript.wrapper.paddingRight = rt.appearance.transcriptPaddingRight;
        rt.sidebar.refit();
        if (transcriptFollowsBottom(rt)) {
            rt.pendingTranscriptScrollRestore = { scrollTop: 0, atBottom: true };
        } else {
            captureTranscriptScrollAnchor(rt);
        }
        resizeComposer(rt, rt.requestedComposerTextRows);
        renderState(rt);
    });
    rt.renderer.on(CliRenderEvents.SELECTION, (selection: Selection) => {
        const uiRequest = focusedUiRequest(rt);
        const copyableNodes = uiRequest !== undefined
                && isToolApprovalUiRequestUpdate(uiRequest)
            ? [rt.approvalView.detailsText]
            : uiRequest !== undefined
                    && isUserQuestionUiRequestUpdate(uiRequest)
                ? [rt.questionView.detailsText]
                : rt.entryNodes;
        const quotable = [
            ...rt.state.entries.flatMap((entry, index) => {
                const node = rt.entryNodes[index];
                return node === undefined ? [] : [{
                    node,
                    // Quoting the user's own words back is a different act
                    // from quoting the agent, and the attribution has to say
                    // which one happened.
                    speaker: entry.kind === "user" ? "you" : "agent",
                }];
            }),
            ...rt.sidebar.blocks(),
        ];
        if (
            isTranscriptSelection(selection, [
                // Drafts use the same drag-to-copy interaction as settled
                // transcript text. The textarea owns the highlight; this
                // gate only decides whether the selected text may reach the
                // clipboard.
                rt.composer,
                ...copyableNodes,
                ...rt.sidebar.blocks().map((block) => block.node),
                // An extension view is text on the same screen, so the same
                // drag has to copy it. The slot is the whole boundary: the
                // selection walks up to it from whatever line it landed on.
                rt.experimentalTuiHost.overlay,
                rt.experimentalTuiHost.transcriptTop,
                rt.experimentalTuiHost.transcriptBottom,
                rt.diagnosticsDialogView.box,
                rt.doctorDialogView.box,
                rt.extensionsDialogView.box,
                rt.documentDialogView.box,
            ])
        ) {
            void copyTranscriptSelection(rt, selection);
        }
        const speaker = selectionSpeaker(selection, quotable);
        const selected = speaker === undefined ? "" : selection.getSelectedText();
        // Only while an extension has somewhere to send it. With nobody else
        // in the conversation, quoting hands the agent its own words back,
        // and arming every plain copy with a quote changes what the next
        // message says without the sender asking for it.
        if (
            visibleMentions(rt).length > 0 && speaker !== undefined
            && selected.trim().length > 0
        ) {
            rt.pendingQuote = { source: speaker, text: selected };
            // A drag leaves the composer unfocused, which is right when the
            // selection was only a copy. It has just become the start of a
            // message, so the next keystroke has to land in the composer.
            if (!anyOverlayOpen(rt)) {
                rt.composer.focus();
            }
            renderState(rt);
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

    // The composer takes pastes through its own renderable handler. Dialog
    // fields are plain renderables, so their paste goes to the same editor as
    // their keystrokes before the composer can claim it as draft text.
    rt.renderer.keyInput.on("paste", (event) => {
        // A paste is input between the two presses, and a pasted image chip
        // is draft content even though it never lands in `plainText`, so a
        // paste always disarms the pair rather than leaving an armed first
        // escape to pair across it.
        rt.lastIdleEscapeAt = undefined;
        const uiRequest = focusedUiRequest(rt);
        const pasted = (): string =>
            stripAnsiSequences(decodePasteBytes(event.bytes));
        if (
            uiRequest !== undefined
            && isUserQuestionUiRequestUpdate(uiRequest)
            && rt.questionView.box.visible
            && rt.questionView.handlePaste(pasted())
        ) {
            event.preventDefault();
            event.stopPropagation();
            renderState(rt);
            return;
        }
        if (rt.timelinePicker !== undefined && rt.timelinePickerView.box.visible) {
            const transition = rt.timelinePickerView.handleEditorPaste(
                rt.timelinePicker,
                pasted(),
            );
            if (transition.handled) {
                event.preventDefault();
                event.stopPropagation();
                rt.timelinePicker = transition.state;
                renderState(rt);
                return;
            }
        }
        if (
            rt.settingsPicker !== undefined
            && rt.settingsPicker.kind !== "extension"
            && rt.settingsPickerView.box.visible
        ) {
            const transition = rt.settingsPickerView.handleEditorPaste(
                rt.settingsPicker,
                pasted(),
            );
            if (transition.handled) {
                event.preventDefault();
                event.stopPropagation();
                rt.settingsPicker = transition.state;
                renderState(rt);
                return;
            }
        }
        if (rt.searchOverlay !== undefined && rt.searchOverlayView.surface.visible) {
            rt.searchOverlayView.insertInputPaste(pasted());
            const transition = updateSearchOverlayText(
                rt.searchOverlay,
                rt.searchOverlayView.inputText(),
                rt.searchOverlayView.inputCursor(),
            );
            event.preventDefault();
            event.stopPropagation();
            rt.searchOverlay = transition.state;
            if (transition.action !== undefined) {
                runSearchOverlayAction(rt, transition.action);
            } else {
                renderState(rt);
            }
            return;
        }
        if (rt.commandPalette !== undefined && rt.commandPaletteView.surface.visible) {
            event.preventDefault();
            event.stopPropagation();
            rt.commandPalette = rt.commandPaletteView.handleEditorPaste(
                rt.commandPalette,
                pasted(),
            );
            renderState(rt);
            return;
        }
        if (rt.help !== undefined && rt.helpView.box.visible && rt.help.tab !== "general") {
            event.preventDefault();
            event.stopPropagation();
            rt.help = rt.helpView.handleEditorPaste(rt.help, pasted());
            renderState(rt);
            return;
        }
        if (
            rt.standingNudges !== undefined
            && rt.standingNudgesView.surface.visible
        ) {
            event.preventDefault();
            event.stopPropagation();
            const pasted = stripAnsiSequences(decodePasteBytes(event.bytes));
            const editorTransition = rt.standingNudgesView.handleEditorPaste(
                rt.standingNudges,
                pasted,
            );
            rt.standingNudges = editorTransition.handled
                ? editorTransition.state
                : handleTuiStandingNudgesPaste(rt.standingNudges, pasted);
            renderState(rt);
            return;
        }
        if (
            rt.requestOptionsEditor !== undefined
            && rt.requestOptionsEditorView.surface.visible
        ) {
            event.preventDefault();
            event.stopPropagation();
            const pasted = stripAnsiSequences(decodePasteBytes(event.bytes));
            const transition = rt.requestOptionsEditorView.handlePaste(
                rt.requestOptionsEditor,
                pasted,
            );
            rt.requestOptionsEditor = transition.state;
            renderState(rt);
            return;
        }
        if (
            rt.providerForm !== undefined
            && rt.providerFormView.surface.visible
        ) {
            event.preventDefault();
            event.stopPropagation();
            rt.providerForm = handleTuiProviderFormPaste(
                rt.providerForm,
                stripAnsiSequences(decodePasteBytes(event.bytes)),
            );
            renderState(rt);
            return;
        }
        if (
            rt.namePrompt !== undefined
            && rt.namePromptView.surface.visible
        ) {
            event.preventDefault();
            event.stopPropagation();
            rt.namePrompt = rt.namePromptView.handlePaste(
                rt.namePrompt,
                stripAnsiSequences(decodePasteBytes(event.bytes)),
            );
            renderState(rt);
            return;
        }
        if (rt.secretPrompt === undefined) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        rt.secretPrompt = handleTuiSecretPromptPaste(
            rt.secretPrompt,
            stripAnsiSequences(decodePasteBytes(event.bytes)),
        );
        renderState(rt);
    });

    rt.renderer.keyInput.on("keypress", ((key: KeyEvent) => handleKeypress(rt, key)));
    rt.lastInputRecordAt = 0;


    /**
     * Every key the TUI acts on arrives here, overlays included. Pointer input
     * is routed back through it (see `pressKey`) rather than growing a second
     * decision path per overlay: a click on a row has to mean exactly what ⏎ on
     * that row means, and the only way to guarantee that is for it to be the
     * same call.
     */

    /**
     * Press a key the user did not press. `KeyEvent` carries the whole shape
     * `handleKeypress` reads, so a synthetic press is indistinguishable from a
     * real one once it is in there.
     */

    /**
     * The pointer behaviour every overlay row gets, expressed once.
     *
     * `moveCursor` is the only thing a surface has to supply: how to put its
     * own highlight on row `index`. Hovering is that move; clicking is that
     * move followed by the key the row's highlight responds to, which is ⏎ for
     * a list and the row's own digit for the numbered dialogs.
     */

    /**
     * Ask the attached session for the state the status line reports.
     *
     * Replayed history carries the transcript and context only, so an
     * attachment that does not ask stays blank about the model and, worse,
     * silent about full access until some later update happens to arrive.
     */
    rt.settingsSnapshotRetries = new WeakMap<TuiAgentClient, number>();
    rt.MAX_SETTINGS_SNAPSHOT_RETRIES = 5;


    /**
     * History, context, and turn-end do not carry the model snapshot. The
     * first ask can miss if the host was not ready, so a later fact that the
     * session is live is what asks again.
     */



    void receiveAgentUpdates(rt);
    if (rt.client.failed !== true && rt.client.viewOnly !== true) {
        void loadExtensionCommands(rt);
        requestSkillCommands(rt);
        requestSessionSettings(rt);
    } else if (isHomeClient(rt.client)) {
        // The model pane is reachable from home, and what it shows is the
        // host's, so it is asked for at once rather than on first open.
        requestSessionSettings(rt);
    }
    void restorePersistedAgentPane(rt);
    if (rt.workspaceSidebarDocked) {
        openWorkspaceSidebar(rt, { focus: false, persist: false });
    }


    /**
     * `interceptedText` carries the text an extension asked to send instead of
     * what the user typed. Its presence is also what stops a second trip
     * through the interceptors.
     */





    /**
     * A model failing the same way again is worth one line saying so, because
     * the per-turn error alone reads as Vera breaking rather than as a pattern
     * with somewhere to look.
     */

    /**
     * Writes what the ledger holds to a file someone can read and send on.
     * A model summarises it when a working one is running, but the file is
     * written either way: the summary is a convenience, the record is the
     * point, and the model most likely to be asked is the one that failed.
     */




    /** Only the commands an idle conversation can run are offered here. */




    /**
     * A handled message still enters submit history and clears the composer:
     * the user submitted it, and an extension acting on it is not a reason to
     * lose the text or leave it sitting in the box.
     */

    /**
     * The host stores an attachment out of band, so a paste does not wait for
     * the turn to end. The image sits on the composer as a chip and rides
     * whichever prompt the user sends next.
     */









    /**
     * The user's own name for a pooled model, swapped for the id the provider
     * knows. An extension is handed whatever was typed, and a pool name is the
     * client's data to resolve.
     */









    /**
     * How to focus the overlay in front, or nothing when the composer is it.
     *
     * Held as a lookup rather than folded into `focusActiveSurface` so the same
     * answer serves the question "is the composer the surface this key belongs
     * to", which is what the unfocused-state keys ask.
     */





    /**
     * Give every session switch a deadline.
     *
     * A pending switch swallows the palette and refuses new prompts, so a host
     * request that never settles would strand the client with no way back. On
     * timeout the caller's rejection path runs, the old session stays attached,
     * and a late answer is discarded rather than swapped in behind the user.
     */


    /** Drop a session the client asked for but can no longer use. */

    /**
     * Apply the user's one-shot leave intent before the new conversation takes
     * over the screen. Close is a host acknowledgement, not an optimistic UI
     * state: when this resolves the source root and its owned tree are unable
     * to issue another provider call.
     */

    /** Best-effort terminal departure: stop only the last interactive viewer. */

    /** A newly-created target is ours to stop if the switch cannot commit. */


    /**
     * After attach-only retry has already failed, start a replacement host
     * the same way `/reconnect` does. `switchToClient` runs only after attach
     * succeeds. Typed `/reconnect` sets `replaceExisting`; auto-restart does
     * not.
     */



    /**
     * What the pool looks like right now, which is what every relevance
     * predicate is written against. Read fresh each time rather than cached:
     * pooling a model is exactly the kind of thing that should retire the tip
     * telling you to pool one.
     */

    /**
     * The built-in tips plus whatever extensions registered, read fresh so a
     * later-loading extension's tips join the pool without a restart.
     */

    /**
     * A tip to show, recorded as shown. Returns nothing when tips are off,
     * when nothing is eligible, or when the pool is exhausted for this launch.
     */





    /**
     * Records what every materialized entry currently occupies.
     *
     * A laid-out node is the only exact answer: the estimate is a character
     * count over the width and knows nothing of the borders and gutters the
     * boxed kinds draw. Measuring the window on every frame keeps the estimate
     * to entries that have never been on screen.
     */







    /** Children run [top spacer, materialized entries…, bottom spacer]. */



    /** The first materialized entry with any row inside the viewport. */

    /**
     * Puts the anchored entry back where it sat, once a layout has run.
     *
     * The correction is the difference between two laid-out positions, so it
     * carries no estimate of its own.
     */



    /**
     * Releases nodes for entries that no longer exist.
     *
     * The entry list shrinks whenever a turn ends and its thinking row is
     * dropped. A node past the end of the list is outside every index the
     * update pass walks, so nothing else would ever destroy it.
     */





    /**
     * Releases entries that have moved far enough outside the viewport.
     *
     * Without this the window only ever grows, so reaching the top of a long
     * session materializes all of it and holds it for the rest of the run.
     * Each released entry's measured height goes into the spacer that replaces
     * it, so releasing moves nothing the reader can see.
     */


    /**
     * Rebuilds the window as the tail, for a reader who jumped to the bottom.
     *
     * Walking the window down a batch a frame would take hundreds of frames
     * from the top of a long session, and every batch would move the bottom
     * the reader asked to land on.
     */








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

    /**
     * Draw the side bar, and only when what it draws has changed.
     *
     * The state carries a clock, so it is a fresh object on every timed
     * refresh even while the rail reads the same. Handing an unchanged state
     * to the view still repaints, and a repaint re-shows the terminal cursor,
     * which restarts its blink phase: ten a second and the caret in the
     * composer never gets to blink at all.
     */

    /**
     * Redraw the surfaces whose rows state how long ago something happened.
     *
     * Both read the clock rather than a value the host sent, so a tab left
     * open would go on saying "2m ago" about something from this morning. The
     * host only sends a new index when the work changes, which for a session
     * waiting on an answer is never.
     *
     * The idle slot's caret rides the same tick, for the same reason: it moves
     * on the clock and nothing else asks it to.
     *
     * Only these, and only while open: a full repaint on every tick would
     * rebuild the transcript to move one word.
     */

    /**
     * Whether some overlay owns the screen. Bare keybindings and body focus
     * both have to stand down while one is open, and they have to agree on
     * when, so they ask the same question here.
     */

    /**
     * Moves the materialized slots in [from, to) by delta, keeping the node
     * ids in step with their new indices.
     */

    /**
     * A delivered history repeats rows the transcript already shows, but not
     * always at the same index: the row echoing what the user typed gives way
     * to the stored prompt, and live-only rows drop out. The tail is matched
     * back from the newest row and the nodes that still stand are moved to
     * their new indices. Rebuilding one costs a markdown row a frame drawn
     * empty, which is the flash this avoids.
     */


    // The surface openers below are shared by three callers: a slash command, a
    // palette row, and a /settings menu entry. Keeping them here means the three
    // routes cannot drift into opening the same picker with different arguments.



    /**
     * The primary is required, so clearing it means the fallback has nothing to
     * sit behind: the whole reviewer is cleared instead. Clearing the failsafe
     * alone keeps the primary and sends `null` for the second slot.
     */






    /** The connected providers whose model list can be fetched again. */

    /** How many models the current snapshot holds for one provider. */

    /**
     * Read at the moment the pane opens rather than held from startup: config
     * and the pool are both files the user may have just edited, and this is
     * the surface that claims to show what they say.
     */


    /**
     * Writes the chosen model onto the assignment, or unbinds it. The write is
     * to the config file because an assignment is a setting. The host rereads
     * that file, so a compact in this session uses it without a restart.
     */





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







    /**
     * The store this client reads and writes credentials through, opened once.
     *
     * The TUI touches `~/.vera/auth.json` directly rather than asking the host
     * to write it. The host re-reads the file
     * on every credential check, so a key saved here is in effect on the next
     * turn with nothing to notify.
     */
    rt.authStorage = rt.dependencies.authStorage
        ?? createAuthStorage({
            onQuarantine(quarantinePath) {
                rt.state = appendTuiError(
                    rt.state,
                    `The old credential file could not be read and was moved to ${quarantinePath}`,
                );
                renderState(rt);
            },
        });
    if (rt.dependencies.authStorage === undefined) {
        // Said once, at the point where the pane would otherwise just look
        // empty for no stated reason. The store is left alone until something
        // is actually written to it.
        const unreadable = unreadableAuthStoragePath();
        if (unreadable !== undefined) {
            rt.state = appendTuiError(
                rt.state,
                `${unreadable} could not be read, so no provider shows as connected. Connecting one rewrites it.`,
            );
        }
    }
    /** Providers with a browser sign-in already running, so Enter cannot start a second. */
    rt.connectingProviders = new Set<string>();

    /**
     * Whether Vera already holds a credential, with an unreadable store read as
     * "no". The pane is a list of what to connect, so a broken `auth.json`
     * should show everything as unconnected rather than throw inside a keypress.
     */

    /**
     * The declaration form, opened on a provider that already exists. The key
     * is read back so saving without touching it keeps it, rather than the
     * blank field reading as "no key" and silently dropping one.
     */


    /**
     * Connect one provider, by whatever it is that provider wants.
     *
     * A row that needs no credential says so rather than pretending to connect,
     * since a check mark appearing for a step that never happened is the one
     * thing this pane cannot afford to get wrong.
     */

    /**
     * Ask before forgetting the credential Vera itself stored for a provider.
     *
     * Only a stored secret can be forgotten. `isProviderConnected` counts an
     * environment variable as connected too, and removing nothing while saying
     * "forgotten" would leave the row still marked and the key still in use, so
     * that case names the variable instead. Those cases never reach the
     * confirmation: there is nothing to confirm.
     */

    /**
     * Delete the credential the confirmation named.
     *
     * Nothing checks the store again: `forgetProvider` read it one keypress
     * ago, and a second read would only disagree with what the card promised.
     */


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





    /**
     * The name a picker row was given.
     *
     * A session visible in either pane is renamed through its own attachment,
     * because that client holds the name on screen and the host refuses to
     * write behind an attached client's back. Every other row goes over the
     * host.
     */


    /**
     * The session pane, rebuilt from the host.
     *
     * A rename changes what a row says, and the row text comes from the host
     * listing, so the pane is re-read rather than patched with what was asked
     * for.
     */


    /**
     * The one place this client turns a semantic setting into TUI state.
     * Callers may carry a picker parent for Escape, but no client position is
     * accepted from the destination itself.
     */








    /**
     * Palette rows run through the composer so a chosen row lands in history and
     * takes the same path a typed command does. Rows with no slash command of
     * their own (and the one row that only starts a command) are dispatched
     * directly instead.
     */


    /**
     * Return to the conversation this hop started from.
     *
     * `/back` is a view switch. It does not stop the conversation on screen.
     */







    /**
     * Open the side bar on the session already on screen.
     *
     * The roster is read once here. Status after that arrives on the work
     * index the host pushes on every roster transition, so nothing polls.
     */
    /** Hands the keyboard to a rail that is already on screen. */


    /**
     * Switch to the next or previous live session from anywhere.
     *
     * The rail does not have to be open. Leave is keep-running, the same as a
     * rail click. Parked jsonl rows are not in the ring. Cycle does not arm
     * `/back`: it is working-set chrome, and a child hop should offer
     * `/parent` instead.
     */

    /**
     * The roster read again, on the push that already says the roster moved.
     *
     * The pane keeps the rows it has until the new listing arrives, so a
     * refresh that is slow or fails leaves the reader looking at the last good
     * listing rather than at nothing.
     */

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






    /**
     * Every row opens its session, and answering happens there.
     *
     * A needs-you row is no exception: switching to the session puts its own
     * approval or question card on screen, which is the surface that owns the
     * decision. Answering from the inbox would be a second way to decide, and
     * the one that never showed the request.
     */


    /**
     * Run one scan at a time, remembering only the newest query asked for.
     *
     * Every keystroke asks, and each ask reads every transcript on the machine.
     * Firing them all would put one scan per character on the host and finish
     * them out of order; queueing all of them would scan for prefixes nobody is
     * still looking at. Only the last query typed is worth answering.
     */

    /**
     * The search pane, opened at a scope.
     *
     * The conversation on screen is what `conversation` scope means, so a pane
     * opened with no session behind it starts at the workspace instead of at a
     * scope that would search nothing.
     */





    /**
     * Take the picker card off the screen and give the composer the cursor back.
     *
     * Clearing `settingsPicker` is not enough on its own: the card is a
     * renderable that stays visible until it is hidden, so a path that closes
     * the pane and returns early has to come through here or it leaves a dead
     * card over the transcript it just started writing to.
     */

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

    /**
     * Whether the host already has this session running. Missing from the
     * listing, a listing error, or no listing at all means it is a file, not
     * a worker. Treating those as live is what started a worker on a click.
     */

    /**
     * Attach when the destination is already running; otherwise paint the
     * session file. The overlay is how a file view starts a worker.
     *
     * A rail click names the open from the row itself. `/resume` from the
     * picker always attaches. A failed file read is an error, not a resume.
     */

    /**
     * `/close` and ctrl+w. Idle parks immediately; in-flight work asks first.
     */

    /**
     * Stop this conversation's live agent and keep looking at its file.
     *
     * Forced jsonl so another client's still-running worker does not pull
     * this TUI back onto a live attach.
     */

    /**
     * Start a worker for the file currently on screen.
     */
    /**
     * What the home card's rows do.
     *
     * Typing is the fourth row in everything but name: the character that
     * started the conversation is already in the composer when it opens.
     */

    /**
     * Leave a session file for the home card.
     *
     * There is nothing running to stop, so this is a screen change and not a
     * session change: the file is on disk before and after. The row list is
     * re-asked because a conversation may have been started or closed since
     * the card was last up.
     */

    /** Whether home still has a session list worth offering a row for. */


    /**
     * Start a fresh conversation on this client.
     *
     * `/clear` stops the source. `/fresh`, `/clear --background`, and the
     * agent sidebar's ctrl+n keep it running. Pair-pane clears still go
     * through this too.
     */

    /**
     * Move to the session a picker row named.
     *
     * The draft is read before the switch and handed back to it, so a prompt
     * typed against the wrong conversation can be sent to the right one.
     */

    /** What is in the composer right now, absent when it is empty. */



    /**
     * Send a model settings edit and toast what was asked for.
     *
     * `toast` is what the status line shows while the change is in flight;
     * `subject` completes "Could not change …" if the engine rejects it.
     */


    /**
     * What each live `pool_add` asked for, so an unavailable verdict can be
     * sent again without the user re-picking the model.
     */
    rt.poolAdmissionAttempts = new Map<string, {
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


    /** The live admission record for the dialog's own request, if any. */

    /**
     * Verification on demand: the probes go out immediately, and the dialog
     * is the checklist they report into. The model pane, when one is open, is
     * set aside rather than closed so leaving the dialog can put the user back
     * where they were.
     */
    /** Every model the user keeps, in the order the pane lists them. */


    /** An empty scope names every provider that keeps a list. */


    /** True when the reply belonged to the sweep, which then steps on. */

    /**
     * What the sweep changed, provider by provider. The delta leads because it
     * is the reason to have run it; a provider that could not be asked says so
     * rather than being left out.
     */


    /**
     * Runs the sweep without a dialog per model. A dialog would ask to be
     * dismissed between every probe, which turns a batch back into the
     * one-at-a-time key it was meant to replace. Progress goes to the status
     * line instead, and the rows update as each verdict lands.
     */


    /** True when the verdict belonged to the sweep, which then steps on. */



    /** Change the persistent host default used by new sessions. */

    rt.themeBindings = [
        (activeTheme) => {
            applyTuiTheme(activeTheme);
            refreshDialogChrome();
            rt.experimentalTuiHost.setTheme(activeTheme);
            clearTranscriptNodes(rt);
            const retiredMarkdownStyle = rt.markdownStyle;
            rt.markdownStyle = createMarkdownStyle(rt, activeTheme);
            repaintSidebarForTheme(rt);
            retiredMarkdownStyle.destroy();
        },
        tuiThemeProperties(rt.placeholder, { fg: "muted" }),
        tuiThemeProperties(rt.backgroundStatusText, { fg: "muted" }),
        tuiThemeProperties(rt.activityHintText, { fg: "muted" }),
        tuiThemeProperties(rt.hostedModeText, { fg: "muted" }),
        tuiThemeProperties(rt.app, { backgroundColor: "background" }),
        tuiThemeProperties(rt.quoteText, { fg: "muted" }),
        tuiThemeProperties(rt.heldAddressText, { fg: "muted" }),
        tuiThemeProperties(rt.queuedPromptText, { fg: "muted" }),
        tuiThemeProperties(rt.jumpToBottomText, {
            fg: "background",
            bg: "accent",
        }),
        tuiThemeProperties(rt.jumpToBottom, { backgroundColor: "accent" }),
        tuiThemeProperties(rt.sidebarJumpText, {
            fg: "background",
            bg: "accent",
        }),
        tuiThemeProperties(rt.sidebarJump, { backgroundColor: "accent" }),
        tuiThemeProperties(rt.modeToastText, {
            fg: "text",
            bg: "panel",
        }),
        tuiThemeProperties(rt.modeToast, { backgroundColor: "panel" }),
        tuiThemeProperties(rt.commandSuggestionsText, { fg: "text" }),
        tuiThemeProperties(rt.commandSuggestionsBox, {
            backgroundColor: "background",
        }),
        tuiThemeProperties(rt.jumpMenuText, { fg: "text" }),
        tuiThemeProperties(rt.jumpMenuBox, {
            backgroundColor: "panel",
            borderColor: "element",
            focusedBorderColor: "element",
        }),
        () => {
            if (rt.jumpMenu !== undefined) {
                renderJumpMenu(rt);
            }
        },
        tuiThemeProperties(rt.composerBox, {
            backgroundColor: "input",
            borderColor: (activeTheme) =>
                rt.appearance.composerBoundaryColor ?? activeTheme.element,
        }),
        (activeTheme) => rt.homeView.applyAppearance({
            textColor: activeTheme.text,
            mutedColor: activeTheme.muted,
            accentColor: activeTheme.accent,
        }),
        (activeTheme) => rt.resumeOverlay.applyAppearance({
            marginHorizontal: rt.appearance.composerMarginHorizontal,
            paddingHorizontal: rt.appearance.composerPaddingHorizontal,
            boundaryColor: rt.appearance.composerBoundaryColor
                ?? activeTheme.element,
            backgroundColor: activeTheme.input,
            noticeColor: activeTheme.panel,
            textColor: activeTheme.text,
            mutedColor: activeTheme.muted,
            accentColor: activeTheme.accent,
        }),
        tuiThemeProperties(rt.composerStatusText, { fg: "muted" }),
        tuiThemeProperties(rt.slashArgumentHint, {
            fg: "muted",
            bg: "input",
        }),
        tuiThemeProperties(rt.composerRule, {
            borderColor: (activeTheme) =>
                rt.appearance.composerBoundaryColor ?? activeTheme.element,
        }),
        tuiThemeProperties(rt.workspaceSidebarView.box, {
            backgroundColor: tuiRecessColor,
            borderColor: (activeTheme) =>
                rt.workspaceRailDragging
                    ? activeTheme.accent
                    : activeTheme.element,
            focusedBorderColor: "element",
        }),
        tuiThemeProperties(rt.workTabView.box, { backgroundColor: "panel" }),
        tuiThemeProperties(rt.searchOverlayView.box, { backgroundColor: "panel" }),
        tuiThemeProperties(rt.composer, {
            backgroundColor: "input",
            focusedBackgroundColor: "input",
            textColor: "text",
            focusedTextColor: "text",
            cursorColor: "accent",
        }),
        tuiThemeProperties(rt.approvalView.box, { backgroundColor: "panel" }),
        () => rt.approvalView.repaint(),
        (activeTheme) => rt.permissionsConfirmView.setTheme(activeTheme),
        () => rt.questionView.repaint(),
        tuiThemeProperties(rt.timelinePickerView.box, {
            backgroundColor: "panel",
        }),
        () => {
            if (rt.timelinePicker !== undefined) {
                rt.timelinePickerView.update(rt.timelinePicker);
            }
        },
        tuiThemeProperties(rt.settingsPickerView.box, {
            backgroundColor: "panel",
        }),
        ...rt.secretPromptView.themeBindings,
        ...rt.namePromptView.themeBindings,
        ...rt.providerFormView.themeBindings,
        ...rt.requestOptionsEditorView.themeBindings,
        ...rt.preferencesListView.themeBindings,
        ...rt.standingNudgesView.themeBindings,
        tuiThemeProperties(rt.commandPaletteView.box, {
            backgroundColor: "panel",
        }),
        tuiThemeProperties(rt.helpView.box, { backgroundColor: "panel" }),
        tuiThemeProperties(rt.doctorDialogView.box, {
            backgroundColor: "panel",
        }),
        () => rt.doctorDialogView.repaint(),
        tuiThemeProperties(rt.diagnosticsDialogView.box, {
            backgroundColor: "panel",
        }),
        () => rt.diagnosticsDialogView.repaint(),
        tuiThemeProperties(rt.extensionsDialogView.box, {
            backgroundColor: "panel",
        }),
        () => rt.extensionsDialogView.repaint(),
        tuiThemeProperties(rt.documentDialogView.box, {
            backgroundColor: "panel",
        }),
        () => rt.documentDialogView.repaint(),
        ...rt.admissionDialogView.themeBindings,
        ...rt.sessionTrashConfirmView.themeBindings,
        ...rt.sessionCloseConfirmView.themeBindings,
        ...rt.providerForgetConfirmView.themeBindings,
    ];


    /**
     * Theme rows preview live, but rebuilding a long Markdown transcript for
     * every key repeat makes the picker itself lag behind the cursor. Coalesce
     * a run of arrows and paint the row the cursor actually settles on.
     */

    /**
     * Every name the user could type for a pooled model, ids included.
     *
     * `self` leads, because whatever is asking for a model is asking from
     * inside a conversation that already has one, and the same model is the
     * answer often enough to be the one already under the cursor.
     */

    /**
     * The half-typed token the composer can finish, and what it completes
     * from. A command argument comes from the pool; an `@` comes from whoever
     * claimed mentions.
     */


    /**
     * The one suggester that applies right now, if any.
     *
     * First registered wins, so a second extension cannot talk over the first,
     * and a suggester dismissed with escape stays dismissed for the session.
     */



    return rt.finished.promise;


    /**
     * An overlay covers the status line, so a copy made from inside one has to
     * say so somewhere still on screen.
     */




    /**
     * How many rows the console is taking from the list right now.
     *
     * Half-page movement is measured against what is on screen, so it has to
     * ask the console rather than assume a size it no longer has.
     */


    /**
     * A settled run has nothing left to report, so the console goes with it
     * rather than sitting on a spinner that will never turn again.
     */

    /** The checks reported so far for the run the console is showing. */

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


    /**
     * The quote line, redrawn on the status tick as well as on state, because
     * the mark blinks and nothing else is changing while it does.
     */

    /** The pinned line naming who the composer is holding for. */



    /**
     * Follow one session's background work, from the attach onwards.
     *
     * The host sends the current facts with the attach and again whenever they
     * change, so there is nothing to poll and nothing to wait for: the first
     * paint after a switch is already right.
     */

    /**
     * Follow the machine-wide work inbox, from the attach onwards.
     *
     * Watched whether or not the tab is open: the counts belong on the status
     * line and an approval landing in another session is worth a notification
     * whether or not this client happens to be looking at the inbox.
     */

    /**
     * `announce` is false for the snapshot that arrives with an attach: it
     * describes work that was already there before this client existed, and
     * ringing for all of it on every reconnect would make the bell noise.
     */

    /**
     * Escape sequences go straight to the terminal rather than through the
     * renderer, which owns the screen it draws and knows nothing about the
     * window around it. A write that fails is dropped: a notification is best
     * effort, and the inbox is the guaranteed way to find out either way.
     */







}

function recentSessionSaveFailure(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not remember this session for vera -c: ${detail}`;
}

function closeSessionFailure(
    reason: Extract<CloseAgentResult, { status: "rejected" }>["reason"],
): string {
    if (reason === "not_owned") {
        return "the current conversation belongs to another host";
    }
    if (reason === "not_found") {
        return "the current conversation is no longer running";
    }
    return "the host could not stop the current conversation";
}

/** What a patch asks for, as `provider/model at effort`. */
export function describeModelPatch(patch: ModelSettingsPatch): string {
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

export function modelPatchSubject(patch: ModelSettingsPatch): string {
    if (patch.contextLimit !== undefined) return "the context limit";
    return patch.model === undefined
        ? `the reasoning effort to ${describeModelPatch(patch)}`
        : `the model to ${describeModelPatch(patch)}`;
}

export function rejectionNotice(
    subject: string,
    reason: "invalid" | "unavailable",
): string {
    return reason === "unavailable"
        ? `Changing ${subject} is unavailable on this host`
        : `Could not change ${subject}`;
}

export function defaultModelChangeNotice(
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









































































































export function activeOverlayFocus(rt: TuiRuntime): (() => void) | undefined {
    if (rt.dialStrip !== undefined) {
        return () => rt.dialCard.focus();
    }
    const uiRequest = focusedUiRequest(rt);
    if (
        uiRequest !== undefined
        && isToolApprovalUiRequestUpdate(uiRequest)
    ) {
        return () => rt.approvalView.focus();
    }
    if (
        uiRequest !== undefined
        && isUserQuestionUiRequestUpdate(uiRequest)
    ) {
        return () => rt.questionView.focus();
    }
    if (rt.experimentalTuiHost.hasModal()) {
        return () => rt.experimentalTuiHost.focus();
    }
    if (rt.timelinePicker !== undefined) {
        return () => rt.timelinePickerView.focus();
    }
    // A rename prompt is a modal child of the sidebar or settings pane it
    // was opened from. Its editor must win while the parent remains open
    // underneath it, then the parent's existing focus state can resume
    // when the prompt closes.
    if (rt.namePrompt !== undefined) {
        return () => rt.namePromptView.focus();
    }
    if (rt.commandPalette !== undefined) {
        return () => rt.commandPaletteView.focus();
    }
    if (rt.workTab !== undefined) {
        return () => rt.workTabView.box.focus();
    }
    if (rt.workspaceSidebar !== undefined && rt.workspaceSidebarFocused) {
        return () => rt.workspaceSidebarView.box.focus();
    }
    if (rt.searchOverlay !== undefined) {
        return () => rt.searchOverlayView.focus();
    }
    if (rt.help !== undefined) {
        return () => rt.helpView.focus();
    }
    if (rt.doctorDialog !== undefined) {
        return () => rt.doctorDialogView.focus();
    }
    if (rt.extensionsDialog !== undefined) {
        return () => rt.extensionsDialogView.focus();
    }
    if (rt.documentDialog !== undefined) {
        return () => rt.documentDialogView.focus();
    }
    if (rt.diagnosticsDialog !== undefined) {
        return () => rt.diagnosticsDialogView.focus();
    }
    if (rt.confirmingFullAccess) {
        return () => rt.permissionsConfirmView.box.focus();
    }
    if (rt.admissionDialog !== undefined) {
        return () => rt.admissionDialogView.box.focus();
    }
    if (rt.sessionCloseConfirm) {
        return () => rt.sessionCloseConfirmView.box.focus();
    }
    if (rt.sessionTrashCandidate !== undefined) {
        return () => rt.sessionTrashConfirmView.box.focus();
    }
    if (rt.providerForgetCandidate !== undefined) {
        return () => rt.providerForgetConfirmView.box.focus();
    }
    if (rt.requestOptionsEditor !== undefined) {
        return () => rt.requestOptionsEditorView.focus();
    }
    if (rt.providerForm !== undefined) {
        return () => rt.providerFormView.box.focus();
    }
    if (rt.secretPrompt !== undefined) {
        return () => rt.secretPromptView.box.focus();
    }
    if (rt.settingsPicker !== undefined) {
        return () => rt.settingsPickerView.focus();
    }
    if (rt.preferencesList !== undefined) {
        return () => rt.preferencesListView.box.focus();
    }
    if (rt.standingNudges !== undefined) {
        return () => rt.standingNudgesView.focus();
    }
    return undefined;
}

export function focusActiveSurface(rt: TuiRuntime): void {
    const overlay = activeOverlayFocus(rt);
    const surface = overlay !== undefined
        ? "overlay"
        : rt.sidebar.isFocused()
        ? "sidebar_composer"
        : isHomeClient(rt.client)
        ? "home"
        : isJsonlViewClient(rt.client) && !rt.jsonlCommandMode
        ? "resume_overlay"
        : isJsonlViewClient(rt.client)
        ? "jsonl_command"
        : "main_composer";
    if (
        overlay === undefined
        && (!isWorkerFreeClient(rt.client) || rt.jsonlCommandMode)
        && rt.composer.focused
        && rt.recordedFocusSurface === surface
    ) {
        return;
    }
    rt.composer.blur();
    rt.recordedFocusSurface = surface;
    if (overlay !== undefined) {
        overlay();
        rt.flightRecorder?.record({ type: "focus_changed", surface });
        return;
    }
    if (isHomeClient(rt.client)) {
        rt.homeView.box.focus();
        rt.flightRecorder?.record({ type: "focus_changed", surface });
        return;
    }
    if (isJsonlViewClient(rt.client) && !rt.jsonlCommandMode) {
        rt.resumeOverlay.box.focus();
        rt.flightRecorder?.record({ type: "focus_changed", surface });
        return;
    }
    rt.composer.focus();
    rt.flightRecorder?.record({ type: "focus_changed", surface });
}

export function activeFlightSurface(rt: TuiRuntime): string {
    if (activeOverlayFocus(rt) !== undefined) return "overlay";
    if (isHomeClient(rt.client)) return "home";
    if (isJsonlViewClient(rt.client)) {
        return rt.jsonlCommandMode ? "jsonl_command" : "resume_overlay";
    }
    return rt.sidebar.isFocused() ? "sidebar_composer" : "main_composer";
}

export function applyTimelineTransition(rt: TuiRuntime, 
    transition: TuiTimelinePickerTransition,
): void {
    rt.timelinePicker = transition.state;
    if (transition.composerText !== undefined) {
        rt.composer.setComposerText(transition.composerText);
    }
    if (transition.command !== undefined) {
        sendCommand(rt, transition.command);
    }
    if (transition.forkBoundaryId !== undefined) {
        beginFork(rt, transition.forkBoundaryId);
        return;
    }
    if (rt.timelinePicker === undefined) {
        rt.timelinePickerView.box.visible = false;
        if (rt.pendingUiRequest === undefined) {
            rt.composer.focus();
        }
    } else {
        rt.composer.blur();
        rt.timelinePickerView.update(rt.timelinePicker);
        if (rt.pendingUiRequest === undefined) {
            rt.timelinePickerView.focus();
        }
    }
    renderState(rt);
}

export function withSessionSwitchDeadline<T>(rt: TuiRuntime, 
    request: Promise<T>,
    discardLate: (value: T) => void,
): Promise<T> {
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
            timedOut = true;
            reject(new Error("timed out"));
        }, rt.dependencies.sessionSwitchTimeoutMs ?? SESSION_SWITCH_TIMEOUT_MS);
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

export function recordSessionSwitchOutcome(rt: TuiRuntime, 
    outcome: "completed" | "failed",
    error?: unknown,
): void {
    if (rt.sessionSwitchStartedAt === undefined) return;
    rt.flightRecorder?.record({
        type: `session_switch_${outcome}`,
        operation: rt.sessionSwitchOperation ?? "unknown",
        durationMs: Math.round(performance.now() - rt.sessionSwitchStartedAt),
        ...(error === undefined
            ? {}
            : { error: error instanceof Error ? error.message : String(error) }),
    });
    rt.sessionSwitchStartedAt = undefined;
    rt.sessionSwitchOperation = undefined;
    rt.sessionSwitchBufferedUpdates = [];
    rt.sessionSwitchClearingMain = false;
}

export function discardSwitchTarget(rt: TuiRuntime, next: TuiAgentClient): void {
    void next.detach().catch(() => next.close());
}

export async function leaveSwitchSource(rt: TuiRuntime, 
    source: TuiAgentClient,
    disposition: TuiSessionLeaveDisposition,
    companions: readonly TuiAgentClient[] = [],
): Promise<TuiSessionLeaveResult> {
    const seen = new Set<TuiAgentClient>();
    let sourceResult: TuiSessionLeaveResult | undefined;
    for (const candidate of [...companions, source]) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        if (isWorkerFreeClient(candidate)) {
            const result = {
                sourceOutcome: "detached" as const,
                remainingInteractiveClients: 0,
            };
            if (candidate === source) sourceResult = result;
            continue;
        }
        const candidateId = candidate.agentId;
        if (candidateId === undefined) {
            throw new Error(
                "stopping the current conversation is unavailable",
            );
        }
        let result: TuiSessionLeaveResult;
        if (
            candidate.release !== undefined
            && candidate.supportsHostCapability?.(
                HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
            ) === true
        ) {
            const released = await candidate.release(
                disposition === "keep_running"
                    ? "keep_running"
                    : "stop_if_last",
            );
            result = {
                sourceOutcome: released.outcome,
                remainingInteractiveClients:
                    released.remainingInteractiveClients,
            };
        } else {
            if (disposition === "keep_running") {
                result = {
                    sourceOutcome: "detached",
                    remainingInteractiveClients: 0,
                };
                if (candidate === source) sourceResult = result;
                continue;
            }
            if (rt.dependencies.closeSession === undefined) {
                throw new Error(
                    "stopping the current conversation is unavailable",
                );
            }
            const closed = await rt.dependencies.closeSession(candidateId);
            if (closed.status !== "closed") {
                throw new Error(closeSessionFailure(closed.reason));
            }
            result = {
                sourceOutcome: "stopped",
                remainingInteractiveClients: 0,
            };
        }
        if (candidate === source) sourceResult = result;
    }
    return sourceResult ?? {
        sourceOutcome: "detached",
        remainingInteractiveClients: 0,
    };
}

export async function stopClientForShutdown(rt: TuiRuntime, source: TuiAgentClient): Promise<void> {
    if (isWorkerFreeClient(source)) {
        await source.detach().catch(() => source.close());
        return;
    }
    const sourceId = source.agentId;
    if (
        source.release !== undefined
        && source.supportsHostCapability?.(
            HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
        ) === true
    ) {
        await source.release("stop_if_last").catch(() => undefined);
    } else if (
        sourceId !== undefined
        && rt.dependencies.closeSession !== undefined
    ) {
        await rt.dependencies.closeSession(sourceId).catch(() => undefined);
    }
    await source.detach().catch(() => source.close());
}

export async function discardCreatedSwitchTarget(rt: TuiRuntime, 
    next: TuiAgentClient,
): Promise<void> {
    const targetId = next.agentId;
    if (targetId === undefined || rt.dependencies.closeSession === undefined) {
        discardSwitchTarget(rt, next);
        return;
    }
    await rt.dependencies.closeSession(targetId).catch(() => undefined);
    await next.detach().catch(() => next.close());
}

export function beginFork(rt: TuiRuntime, boundaryId: string): void {
    rt.timelinePicker = undefined;
    rt.timelinePickerView.box.visible = false;
    if (rt.dependencies.forkSession === undefined) {
        rt.state = appendTuiError(rt.state, "Forking this session is unavailable");
        rt.composer.focus();
        renderState(rt);
        return;
    }
    const sourceAgentId = rt.client.agentId;
    if (sourceAgentId === undefined) {
        rt.state = appendTuiError(rt.state, "Current session ID is unavailable");
        rt.composer.focus();
        renderState(rt);
        return;
    }
    rt.sessionSwitchPending = true;
    rt.sessionSwitchActivity = "forking session…";
    renderState(rt);
    void withSessionSwitchDeadline(rt, 
        rt.dependencies.forkSession(sourceAgentId, boundaryId),
        (result) => discardSwitchTarget(rt, result.client),
    ).then((result) => {
        if (rt.shuttingDown) {
            void result.client.detach().catch(() => result.client.close());
            return;
        }
        // The prompt the fork was taken before comes back to the composer,
        // which is the whole point of forking there rather than cloning.
        switchToClient(rt, result.client, {
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
        if (rt.shuttingDown) return;
        rt.sessionSwitchPending = false;
        const message = error instanceof Error ? error.message : String(error);
        rt.state = appendTuiError(
            rt.state,
            `Could not fork this session: ${message}`,
        );
        rt.composer.focus();
        renderState(rt);
    });
}

export function beginHostReconnect(rt: TuiRuntime, 
    options: {
        readonly clearComposer: boolean;
        readonly replaceExisting?: boolean;
    },
): void {
    const currentAgentId = rt.client.agentId;
    if (
        rt.sessionSwitchPending
        || rt.dependencies.reconnectSession === undefined
        || currentAgentId === undefined
    ) {
        return;
    }
    if (options.clearComposer) {
        rt.composer.clearComposer();
    }
    rt.sessionSwitchPending = true;
    rt.sessionSwitchActivity = "restarting host…";
    const stayAttached = options.replaceExisting === true
        && !rt.connectionFailed;
    if (!stayAttached) {
        settleLostHost(rt, "Host connection closed");
    }
    const draft = options.clearComposer ? undefined : currentDraft(rt);
    renderState(rt);
    void withSessionSwitchDeadline(rt, 
        rt.dependencies.reconnectSession(currentAgentId, {
            ...(options.replaceExisting === true
                ? { replaceExisting: true }
                : {}),
        }),
        ((next: TuiAgentClient) => discardSwitchTarget(rt, next)),
    ).then((next) => {
        if (rt.shuttingDown) {
            discardSwitchTarget(rt, next);
            return;
        }
        switchToClient(rt, next, draft);
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.sessionSwitchPending = false;
        if (error instanceof HostReplacementBusyError) {
            rt.state = appendTuiError(rt.state, reconnectBusyMessage());
            rt.composer.focus();
            renderState(rt);
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (rt.connectionFailed) {
            rt.state = appendTuiError(
                rt.state,
                `Could not reconnect: ${message}`,
            );
            renderState(rt);
            return;
        }
        if (options.replaceExisting === true) {
            rt.connectionFailed = true;
            rt.connectionFailure = message;
            rt.activity = "disconnected";
            settleLostHost(rt, message);
            rt.state = appendTuiError(
                rt.state,
                `Could not reconnect: ${message}`,
            );
            rt.composer.focus();
            renderState(rt);
            return;
        }
        reportConnectionError(rt, error);
    });
}

export function settleLostHost(rt: TuiRuntime, reason: string): void {
    for (const pending of rt.pendingOneshots.values()) {
        pending.reject(new Error(reason));
    }
    rt.pendingOneshots.clear();
    for (const image of rt.pendingImages) {
        rt.composer.removeImageChip(image.requestId);
    }
    rt.pendingImages = [];
    rt.submitAfterImageAttachment = false;
    const interruptedRename = rt.pendingSessionRename;
    rt.pendingSessionRename = undefined;
    const interruptedSidebarRename = rt.pendingSidebarSessionRename;
    rt.pendingSidebarSessionRename = undefined;
    if (
        interruptedRename?.commandText !== undefined
        && rt.composer.expandedText().length === 0
    ) {
        rt.composer.setComposerText(interruptedRename.commandText);
    }
    if (
        interruptedSidebarRename?.commandText !== undefined
        && rt.composer.expandedText().length === 0
    ) {
        rt.composer.setComposerText(interruptedSidebarRename.commandText);
    }
    rt.pendingUiRequest = undefined;
    rt.queuedUiRequests.length = 0;
    rt.activeConfigurationRequest = undefined;
    rt.queuedConfigurationRequests.length = 0;
    rt.timelinePicker = undefined;
    rt.settingsPicker = undefined;
    rt.standingNudges = undefined;
    rt.namePrompt = undefined;
    rt.providerForm = undefined;
    rt.requestOptionsEditor = undefined;
    rt.commandPalette = undefined;
    rt.help = undefined;
    rt.confirmingFullAccess = false;
    rt.admissionDialog = undefined;
    rt.admissionReturnPicker = undefined;
    rt.sessionTrashCandidate = undefined;
    rt.sessionTrashPending = false;
    rt.sessionCloseConfirm = false;
    rt.abortRequested = false;
    rt.workingSince = undefined;
    rt.phaseSince = undefined;
    rt.state = failTuiConnection(rt.state);
}

export function reportConnectionError(rt: TuiRuntime, error: unknown): void {
    if (rt.shuttingDown || rt.connectionFailed || rt.sessionSwitchPending) {
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Home answers reads and refuses everything else. A write it cannot
    // carry says something about this screen, not about a host that went
    // away, so it is reported and the connection is left alone.
    if (isHomeClient(rt.client)) {
        rt.state = appendTuiError(rt.state, message);
        renderState(rt);
        return;
    }
    // A jsonl view and a session that already died are not a dropped host.
    // Restarting the host here is what froze the TUI in a reconnect loop.
    if (
        rt.client.viewOnly === true
        || rt.client.failed === true
        || rt.agentFailedThisAttachment
    ) {
        rt.connectionFailed = true;
        rt.connectionFailure = message;
        rt.activity = "disconnected";
        settleLostHost(rt, message);
        renderState(rt);
        rt.composer.focus();
        return;
    }
    if (
        !rt.hostReconnectAttempted
        && rt.dependencies.reconnectSession !== undefined
        && rt.client.agentId !== undefined
    ) {
        rt.hostReconnectAttempted = true;
        beginHostReconnect(rt, { clearComposer: false });
        return;
    }
    rt.connectionFailed = true;
    rt.activity = "disconnected";
    rt.connectionFailure = message;
    settleLostHost(rt, message);
    renderState(rt);
    rt.composer.focus();
}

export function tipContext(rt: TuiRuntime, inModelPicker: boolean): TuiTipContext {
    const pooled = rt.state.modelSettings?.pooled ?? [];
    return {
        launches: rt.tipState.launches,
        pooledCount: pooled.length,
        namedPoolCount: pooled.filter((entry) =>
            entry.poolName !== undefined
        ).length,
        anyVerified: pooled.some((entry) => entry.verified),
        inModelPicker,
    };
}

export function tipPool(rt: TuiRuntime): readonly TuiTip[] {
    const registered = rt.clientExtensionRegistry?.tips() ?? [];
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

export function takeTip(rt: TuiRuntime, inModelPicker: boolean): string | undefined {
    if (!rt.tipsEnabled) return undefined;
    const tip = selectTuiTip(
        tipContext(rt, inModelPicker),
        rt.tipState.history,
        tipPool(rt),
    );
    if (tip === undefined) return undefined;
    rt.tipState = {
        launches: rt.tipState.launches,
        history: recordTuiTipShown(
            tip.id,
            rt.tipState.history,
            rt.tipState.launches,
        ),
    };
    saveTuiTipState(rt.tipState);
    return tip.text(tipContext(rt, inModelPicker));
}

export function transcriptEntryText(rt: TuiRuntime, entry: TuiTranscriptEntry): string {
    return entry.kind === "diff"
        ? `${entry.path}\n${entry.patch}`
        : entry.text;
}

export function transcriptEstimatedRows(rt: TuiRuntime, text: string, width: number): number {
    return text.split("\n").reduce((rows, line) => {
        const length = Math.max(1, Array.from(line).length);
        return rows + Math.max(1, Math.ceil(length / Math.max(1, width)));
    }, 0);
}

export function invalidateMeasuredEntryRows(rt: TuiRuntime): void {
    const width = mainTranscriptWidth(rt);
    if (width === rt.measuredEntryRowsWidth) return;
    rt.measuredEntryRowsWidth = width;
    rt.measuredEntryRows.length = 0;
}

export function measureTranscriptEntryNode(rt: TuiRuntime, index: number): void {
    const node = rt.entryNodes[index];
    if (node === undefined) return;
    const margin = node.marginTop;
    const rows = node.height + (typeof margin === "number" ? margin : 0);
    if (rows > 0) rt.measuredEntryRows[index] = rows;
}

export function measureMaterializedTranscriptEntries(rt: TuiRuntime): void {
    invalidateMeasuredEntryRows(rt);
    for (
        let index = rt.materializedEntryStart;
        index < rt.materializedEntryEnd;
        index += 1
    ) {
        measureTranscriptEntryNode(rt, index);
    }
}

export function transcriptEntryRows(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    index: number,
): number {
    if (!tuiTranscriptEntryIsVisible(entries[index])) return 0;
    return rt.measuredEntryRows[index] ?? estimateTranscriptEntryRows(rt, 
        entries,
        index,
    );
}

export function estimateTranscriptEntryRows(rt: TuiRuntime, 
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
        mainTranscriptWidth(rt)
            - tuiGutterWidth(entry, rt.appearance.activityIndent)
            - 1,
    );
    const margin = tuiEntryMarginTop(entries, index, rt.entrySpacing);
    if (entry.kind === "thinking") {
        // Reasoning still arriving is one clipped row however much has
        // arrived, so its height never depends on its text.
        return margin + 1;
    }
    return margin + Math.max(
        1,
        transcriptEstimatedRows(rt, transcriptEntryText(rt, entry), width),
    );
}

export function estimatedTranscriptRows(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    start: number,
    end: number,
): number {
    invalidateMeasuredEntryRows(rt);
    let rows = 0;
    for (let index = Math.max(0, start); index < end; index += 1) {
        rows += transcriptEntryRows(rt, entries, index);
    }
    return rows;
}

export function updateTranscriptEntryNode(rt: TuiRuntime, 
    wrapper: TextRenderable | MarkdownRenderable | BoxRenderable,
    entry: TuiTranscriptEntry,
): void {
    wrapper.visible = entry.kind !== "tool" || entry.hidden !== true;
    const existing = tuiGutterContent(wrapper);
    if (existing instanceof MarkdownRenderable) {
        // The trailing block stays unstable while this flag is on. A
        // finished turn has no live row, so a reused node has to settle.
        if (existing.streaming && !rt.state.working) {
            existing.streaming = false;
        }
        if (existing.content !== tuiMarkdownEntryContent(entry)) {
            existing.content = tuiMarkdownEntryContent(entry);
        }
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

export function createTranscriptEntryNode(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    index: number,
): TextRenderable | MarkdownRenderable | BoxRenderable {
    const entry = entries[index];
    if (entry === undefined) {
        throw new Error(`Transcript entry ${index} is unavailable`);
    }
    const streaming = tuiTranscriptEntryStreams(entries, index, rt.state.working);
    const node = createTuiEntryNode(rt, 
        `entry-${index}`,
        entry,
        tuiEntryMarginTop(entries, index, rt.entrySpacing),
        assistantFollowsTools(entries, index),
        streaming,
    );
    updateTranscriptEntryNode(rt, node, entry);
    rt.entryNodes[index] = node;
    rt.entryNodeKinds[index] = entry.kind;
    rt.entryNodeSources.set(node, entry);
    return node;
}

export function destroyTranscriptEntryNode(rt: TuiRuntime, index: number): void {
    rt.entryNodes[index]?.destroyRecursively();
    delete rt.entryNodes[index];
    delete rt.entryNodeKinds[index];
}

export function transcriptWindowChildIndex(rt: TuiRuntime, index: number): number {
    return 1 + index - rt.materializedEntryStart;
}

export function addTranscriptEntryNode(rt: TuiRuntime, 
    node: TextRenderable | MarkdownRenderable | BoxRenderable,
    index: number,
): void {
    rt.transcriptEntryWindow.add(node, transcriptWindowChildIndex(rt, index));
}

export function updateTranscriptSpacers(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): void {
    // A box holds a row even at height 0, which at the ends of the window
    // is a blank band above the first entry or below the last. Hiding an
    // empty spacer is what keeps those ends flush.
    const above = estimatedTranscriptRows(rt, entries, 0, rt.materializedEntryStart);
    const below = estimatedTranscriptRows(rt, 
        entries,
        rt.materializedEntryEnd,
        entries.length,
    );
    rt.transcriptWindowTopSpacer.height = above;
    rt.transcriptWindowTopSpacer.visible = above > 0;
    rt.transcriptWindowBottomSpacer.height = below;
    rt.transcriptWindowBottomSpacer.visible = below > 0;
}

export function topmostVisibleTranscriptEntry(rt: TuiRuntime): number | undefined {
    const top = rt.transcript.viewport.screenY;
    for (
        let index = rt.materializedEntryStart;
        index < rt.materializedEntryEnd;
        index += 1
    ) {
        const node = rt.entryNodes[index];
        if (node === undefined || !node.visible) continue;
        if (node.screenY + node.height > top) return index;
    }
    return undefined;
}

export function applyTranscriptScrollAnchor(rt: TuiRuntime): void {
    const anchor = rt.pendingTranscriptScrollAnchor;
    if (anchor === undefined) return;
    rt.pendingTranscriptScrollAnchor = undefined;
    const node = rt.entryNodes[anchor.index];
    if (node === undefined) return;
    const offset = node.screenY - rt.transcript.viewport.screenY;
    if (offset === anchor.offset) return;
    rt.transcript.scrollTo(rt.transcript.scrollTop + offset - anchor.offset);
}

export function captureTranscriptScrollAnchor(rt: TuiRuntime): void {
    rt.pendingTranscriptScrollAnchor = undefined;
    const index = topmostVisibleTranscriptEntry(rt);
    if (index === undefined) return;
    const node = rt.entryNodes[index];
    if (node === undefined) return;
    rt.pendingTranscriptScrollAnchor = {
        index,
        offset: node.screenY - rt.transcript.viewport.screenY,
    };
}

export function transcriptFollowsBottom(rt: TuiRuntime): boolean {
    return tuiTranscriptAtBottom(
        rt.transcript.scrollTop,
        rt.transcript.scrollHeight,
        rt.transcript.viewport.height,
    );
}

export function trimTranscriptWindow(rt: TuiRuntime, length: number): void {
    for (let index = length; index < rt.entryNodes.length; index += 1) {
        destroyTranscriptEntryNode(rt, index);
    }
    rt.entryNodes.length = Math.min(rt.entryNodes.length, length);
    rt.entryNodeKinds.length = rt.entryNodes.length;
    rt.measuredEntryRows.length = Math.min(rt.measuredEntryRows.length, length);
    rt.materializedEntryEnd = Math.min(rt.materializedEntryEnd, length);
    rt.materializedEntryStart = Math.min(
        rt.materializedEntryStart,
        rt.materializedEntryEnd,
    );
}

export function renderTranscriptEntries(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): void {
    if (rt.pendingTranscriptReseed) {
        rt.pendingTranscriptReseed = false;
        reseedTranscriptNodes(rt, entries);
    }
    trimTranscriptWindow(rt, entries.length);

    if (entries.length === 0) {
        rt.transcriptWindowTopSpacer.height = 0;
        rt.transcriptWindowTopSpacer.visible = false;
        rt.transcriptWindowBottomSpacer.height = 0;
        rt.transcriptWindowBottomSpacer.visible = false;
        return;
    }

    if (rt.materializedEntryEnd === 0 && rt.entryNodes.length === 0) {
        const initial = tuiTranscriptTailRange(entries.length);
        rt.materializedEntryStart = initial.start;
        rt.materializedEntryEnd = initial.start;
    }

    // Entries appended while the reader is scrolled away stay behind the
    // bottom spacer until they scroll into reach, so a long session does
    // not rebuild its whole tail on every arriving row.
    let materializeTo = transcriptFollowsBottom(rt)
        ? entries.length
        : Math.min(rt.materializedEntryEnd, entries.length);

    const changedKindAt = entries.findIndex((entry, index) =>
        rt.entryNodes[index] !== undefined
        && rt.entryNodeKinds[index] !== entry.kind
    );
    if (changedKindAt !== -1) {
        materializeTo = Math.max(materializeTo, rt.materializedEntryEnd);
        rt.pendingTranscriptScrollRestore = {
            scrollTop: rt.transcript.scrollTop,
            atBottom: tuiTranscriptAtBottom(
                rt.transcript.scrollTop,
                rt.transcript.scrollHeight,
                rt.transcript.viewport.height,
            ),
        };
        for (
            let index = changedKindAt;
            index < rt.materializedEntryEnd;
            index += 1
        ) {
            destroyTranscriptEntryNode(rt, index);
        }
        rt.materializedEntryEnd = changedKindAt;
    }

    for (
        let index = rt.materializedEntryStart;
        index < rt.materializedEntryEnd;
        index += 1
    ) {
        const node = rt.entryNodes[index];
        const entry = entries[index];
        if (node !== undefined && entry !== undefined) {
            updateTranscriptEntryNode(rt, node, entry);
            rt.entryNodeSources.set(node, entry);
        }
    }

    for (let index = rt.materializedEntryEnd; index < materializeTo; index += 1) {
        addTranscriptEntryNode(rt, 
            createTranscriptEntryNode(rt, entries, index),
            index,
        );
    }
    rt.materializedEntryEnd = Math.max(rt.materializedEntryEnd, materializeTo);
    updateTranscriptSpacers(rt, entries);
}

export function materializeEarlierTranscriptEntries(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): boolean {
    const range = tuiTranscriptPrependRange(rt.materializedEntryStart);
    if (range.start === range.end) return false;
    captureTranscriptScrollAnchor(rt);
    rt.materializedEntryStart = range.start;
    for (let index = range.start; index < range.end; index += 1) {
        addTranscriptEntryNode(rt, 
            createTranscriptEntryNode(rt, entries, index),
            index,
        );
    }
    updateTranscriptSpacers(rt, entries);
    return true;
}

export function materializeLaterTranscriptEntries(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): boolean {
    const end = Math.min(
        entries.length,
        rt.materializedEntryEnd + TUI_TRANSCRIPT_MATERIALIZE_BATCH,
    );
    if (end <= rt.materializedEntryEnd) return false;
    for (let index = rt.materializedEntryEnd; index < end; index += 1) {
        addTranscriptEntryNode(rt, 
            createTranscriptEntryNode(rt, entries, index),
            index,
        );
    }
    rt.materializedEntryEnd = end;
    // Nothing above the viewport changed, so the reader's position holds
    // on its own; only the spacer standing in for the rest shrinks.
    updateTranscriptSpacers(rt, entries);
    return true;
}

export function nodeTranscriptRows(rt: TuiRuntime, index: number): number | undefined {
    const node = rt.entryNodes[index];
    if (node === undefined) return undefined;
    const margin = node.marginTop;
    return node.height + (typeof margin === "number" ? margin : 0);
}

export function evictTranscriptEntries(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): boolean {
    const materializedAbove = Math.max(
        0,
        rt.transcript.scrollTop - rt.transcriptWindowTopSpacer.height,
    );
    const materializedBelow = Math.max(
        0,
        rt.transcript.scrollHeight
            - rt.transcriptWindowBottomSpacer.height
            - rt.transcript.scrollTop
            - rt.transcript.viewport.height,
    );
    const headroom = rt.materializedEntryEnd
        - rt.materializedEntryStart
        - TUI_TRANSCRIPT_INITIAL_WINDOW;
    if (headroom <= 0) return false;

    const aboveBudget = tuiTranscriptEvictableRows({
        scrollTop: rt.transcript.scrollTop,
        viewportHeight: rt.transcript.viewport.height,
        spacerHeight: rt.transcriptWindowTopSpacer.height,
    });
    if (aboveBudget > 0 && materializedAbove > 0) {
        const limit = Math.min(
            rt.materializedEntryStart + TUI_TRANSCRIPT_MATERIALIZE_BATCH,
            rt.materializedEntryStart + headroom,
        );
        let released = 0;
        let index = rt.materializedEntryStart;
        while (index < limit) {
            const rows = nodeTranscriptRows(rt, index);
            if (rows === undefined || released + rows > aboveBudget) break;
            measureTranscriptEntryNode(rt, index);
            released += rows;
            index += 1;
        }
        if (index > rt.materializedEntryStart) {
            for (let drop = rt.materializedEntryStart; drop < index; drop += 1) {
                destroyTranscriptEntryNode(rt, drop);
            }
            rt.materializedEntryStart = index;
            updateTranscriptSpacers(rt, entries);
            return true;
        }
    }

    const belowBudget = tuiTranscriptEvictableRows({
        scrollTop: materializedBelow,
        viewportHeight: rt.transcript.viewport.height,
        spacerHeight: 0,
    });
    if (belowBudget <= 0) return false;
    const floor = Math.max(
        rt.materializedEntryStart,
        rt.materializedEntryEnd - TUI_TRANSCRIPT_MATERIALIZE_BATCH,
        rt.materializedEntryEnd - headroom,
    );
    let released = 0;
    let index = rt.materializedEntryEnd;
    while (index > floor) {
        const rows = nodeTranscriptRows(rt, index - 1);
        if (rows === undefined || released + rows > belowBudget) break;
        measureTranscriptEntryNode(rt, index - 1);
        released += rows;
        index -= 1;
    }
    if (index === rt.materializedEntryEnd) return false;
    for (let drop = index; drop < rt.materializedEntryEnd; drop += 1) {
        destroyTranscriptEntryNode(rt, drop);
    }
    rt.materializedEntryEnd = index;
    updateTranscriptSpacers(rt, entries);
    return true;
}

export function maybeEvictTranscriptEntries(rt: TuiRuntime): boolean {
    if (rt.state.entries.length === 0) return false;
    return evictTranscriptEntries(rt, rt.state.entries);
}

export function setTranscriptWindow(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    start: number,
    end: number,
): void {
    for (let index = rt.materializedEntryStart; index < rt.materializedEntryEnd; index += 1) {
        measureTranscriptEntryNode(rt, index);
        destroyTranscriptEntryNode(rt, index);
    }
    rt.materializedEntryStart = start;
    rt.materializedEntryEnd = start;
    for (let index = start; index < end; index += 1) {
        addTranscriptEntryNode(rt, 
            createTranscriptEntryNode(rt, entries, index),
            index,
        );
    }
    rt.materializedEntryEnd = end;
    updateTranscriptSpacers(rt, entries);
    rt.pendingTranscriptScrollAnchor = undefined;
}

export function snapTranscriptWindowToTail(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): void {
    const tail = tuiTranscriptTailRange(entries.length);
    setTranscriptWindow(rt, entries, tail.start, tail.end);
    rt.transcript.scrollTo(rt.transcript.scrollHeight);
    // The rebuilt rows have no measured height until the next layout, so
    // the bottom is claimed again once they do.
    rt.pendingTranscriptScrollRestore = { scrollTop: 0, atBottom: true };
}

export function setTranscriptWindowAround(rt: TuiRuntime, 
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
    setTranscriptWindow(rt, 
        entries,
        start,
        Math.min(entries.length, start + TUI_TRANSCRIPT_INITIAL_WINDOW),
    );
}

export function settleTranscriptScrollState(rt: TuiRuntime): void {
    const restore = rt.pendingTranscriptScrollRestore;
    if (restore !== undefined) {
        rt.pendingTranscriptScrollRestore = undefined;
        rt.pendingTranscriptScrollAnchor = undefined;
        rt.transcript.scrollTo(
            restore.atBottom ? rt.transcript.scrollHeight : restore.scrollTop,
        );
    }
    applyTranscriptScrollAnchor(rt);
}

export function maybeMaterializeEarlierTranscriptEntries(rt: TuiRuntime): boolean {
    if (rt.state.entries.length === 0) return false;
    if (!tuiTranscriptNeedsEarlierEntries({
        materializedStart: rt.materializedEntryStart,
        scrollTop: rt.transcript.scrollTop,
        viewportHeight: rt.transcript.viewport.height,
        spacerTop: rt.transcriptWindowTopSpacer.screenY
            - rt.transcript.viewport.screenY
            + rt.transcript.scrollTop,
        spacerHeight: rt.transcriptWindowTopSpacer.height,
    })) {
        return false;
    }
    return materializeEarlierTranscriptEntries(rt, rt.state.entries);
}

export function maybeMaterializeLaterTranscriptEntries(rt: TuiRuntime): boolean {
    if (rt.materializedEntryEnd >= rt.state.entries.length) return false;
    const buffer = Math.max(1, rt.transcript.viewport.height)
        * TUI_TRANSCRIPT_MATERIALIZE_BUFFER;
    const materializedEdge = rt.transcript.scrollHeight
        - rt.transcriptWindowBottomSpacer.height;
    if (
        rt.transcript.scrollTop + rt.transcript.viewport.height + buffer
            < materializedEdge
    ) {
        return false;
    }
    return materializeLaterTranscriptEntries(rt, rt.state.entries);
}

export function maybeSnapTranscriptWindowToTail(rt: TuiRuntime): boolean {
    if (rt.state.entries.length === 0) return false;
    if (rt.materializedEntryEnd >= rt.state.entries.length) return false;
    if (!transcriptFollowsBottom(rt)) return false;
    snapTranscriptWindowToTail(rt, rt.state.entries);
    return true;
}

export function renderState(rt: TuiRuntime): void {
    if (rt.shuttingDown) {
        return;
    }
    const uiRequest = focusedUiRequest(rt);
    const configurationRequired = uiRequest !== undefined
        && isConfigurationRequiredUiRequestUpdate(uiRequest);
    rt.experimentalTuiHost.render();

    // Home says what to do in the middle of the screen; the transcript's
    // own invitation would be a second one, over an empty conversation
    // that does not exist yet.
    rt.placeholder.visible = rt.state.entries.length === 0
        && !isHomeClient(rt.client);
    // The transcript tip appears in the gap after a turn, which is the one
    // moment the user is reading rather than typing, and it is gone by the
    // time the next turn starts. Armed by the turn ending rather than by
    // the idle state itself, so the line does not come straight back in
    // the frames between a submit and the turn actually starting.
    if (rt.tipsEnabled && rt.workingLastRender && !rt.state.working) {
        rt.composerTip = takeTip(rt, false);
    }
    rt.workingLastRender = rt.state.working;
    rt.composerTipText.content = rt.composerTip === undefined
        ? new StyledText([])
        // Text nodes lay their content out from column zero, so the
        // optical indent beside the composer is written in rather than
        // set as padding.
        : new StyledText([
            fg(TUI_ACCENT)(
                `${" ".repeat(rt.appearance.composerTipIndent)}Tip `,
            ),
            fg(TUI_MUTED)(rt.composerTip),
        ]);
    rt.composerTipText.visible = rt.composerTip !== undefined
        && !anyOverlayOpen(rt);
    renderHeldAddress(rt);
    rt.composer.placeholder = rt.extensionAddressee === undefined
        ? rt.sidebar.isFocused() && rt.hostedSidebar.mention !== undefined
            ? `Message ${rt.hostedSidebar.mention}\u2026`
            : COMPOSER_PLACEHOLDER
        : `Message ${rt.extensionAddressee}\u2026`;
    renderPendingQuote(rt);
    const focusedState = focusedAgentState(rt);
    const queuedPrompt = renderTuiQueuedPrompt(focusedState);
    rt.queuedPromptText.content = queuedPrompt.length === 0
        ? ""
        : `${" ".repeat(rt.appearance.composerMarginHorizontal)}${queuedPrompt}`;
    rt.queuedPromptText.visible = focusedState.queuedPrompts.length > 0;
    rt.approvalView.box.visible = uiRequest?.request.type
        === "tool_approval";
    rt.questionView.box.visible = uiRequest?.request.type
        === "user_question";
    // A model, directory, and approval mode do not explain either pending
    // request. Both cards replace the composer and status band until the
    // user answers, so no status text can paint across their final row.
    rt.statusText.visible = !(rt.approvalView.box.visible
        || rt.questionView.box.visible);
    rt.statusBand.visible = !(rt.approvalView.box.visible
        || rt.questionView.box.visible);
    rt.timelinePickerView.box.visible = uiRequest === undefined
        && rt.timelinePicker !== undefined;
    rt.requestOptionsEditorView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.requestOptionsEditor !== undefined;
    // Over the connect pane it was opened from, so the pane is still there
    // to go back to when the key is saved or the prompt is abandoned.
    rt.providerFormView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.requestOptionsEditor === undefined
        && rt.providerForm !== undefined;
    rt.namePromptView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.requestOptionsEditor === undefined
        && rt.providerForm === undefined
        && rt.namePrompt !== undefined;
    rt.secretPromptView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.namePrompt === undefined
        && rt.requestOptionsEditor === undefined
        && rt.providerForm === undefined
        && rt.secretPrompt !== undefined;
    rt.settingsPickerView.box.visible = (uiRequest === undefined
            || configurationRequired)
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.secretPrompt === undefined
        && rt.namePrompt === undefined
        && rt.requestOptionsEditor === undefined
        && rt.providerForm === undefined
        && rt.settingsPicker !== undefined;
    rt.preferencesListView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.preferencesList !== undefined;
    rt.standingNudgesView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.preferencesList === undefined
        && rt.standingNudges !== undefined;
    rt.commandPaletteView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.secretPrompt === undefined
        && rt.preferencesList === undefined
        && rt.standingNudges === undefined
        && rt.commandPalette !== undefined;
    rt.workTabView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.settingsPicker === undefined
        && rt.standingNudges === undefined
        && rt.commandPalette === undefined
        && rt.workTab !== undefined;
    applyWorkspaceRail(rt);
    const sessionRequestVisible = rt.approvalView.box.visible
        || rt.questionView.box.visible;
    /*
     * A session-owned request replaces that session's composer, not the
     * navigator beside it. Narrow terminals still have a sidebar card
     * rather than a rail, so the request keeps the screen there.
     */
    const workspaceSidebarAllowed = uiRequest === undefined
        || (sessionRequestVisible && rt.workspaceRail !== undefined);
    rt.workspaceSidebarView.surface.visible = workspaceSidebarAllowed
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.settingsPicker === undefined
        && rt.standingNudges === undefined
        && rt.commandPalette === undefined
        && rt.workTab === undefined
        && rt.workspaceSidebar !== undefined
        && (rt.workspaceRail !== undefined || rt.workspaceSidebarFocused);
    rt.searchOverlayView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.settingsPicker === undefined
        && rt.standingNudges === undefined
        && rt.commandPalette === undefined
        && rt.workTab === undefined
        && rt.searchOverlay !== undefined;
    rt.helpView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.commandPalette === undefined
        && rt.workTab === undefined
        && rt.searchOverlay === undefined
        && rt.help !== undefined;
    rt.doctorDialogView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined
        && rt.diagnosticsDialog === undefined
        && rt.extensionsDialog === undefined
        && rt.documentDialog === undefined
        && rt.doctorDialog !== undefined;
    rt.diagnosticsDialogView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined
        && rt.doctorDialog === undefined
        && rt.extensionsDialog === undefined
        && rt.documentDialog === undefined
        && rt.diagnosticsDialog !== undefined;
    rt.extensionsDialogView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined
        && rt.doctorDialog === undefined
        && rt.diagnosticsDialog === undefined
        && rt.documentDialog === undefined
        && rt.extensionsDialog !== undefined;
    rt.documentDialogView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined
        && rt.doctorDialog === undefined
        && rt.diagnosticsDialog === undefined
        && rt.extensionsDialog === undefined
        && rt.documentDialog !== undefined;
    rt.permissionsConfirmView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.confirmingFullAccess;
    rt.admissionDialogView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && !rt.confirmingFullAccess
        && rt.admissionDialog !== undefined;
    rt.sessionTrashConfirmView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && rt.sessionTrashCandidate !== undefined
        && !rt.sessionCloseConfirm;
    rt.sessionCloseConfirmView.surface.visible = rt.timelinePicker === undefined
        && rt.sessionCloseConfirm;
    rt.providerForgetConfirmView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate !== undefined;
    const overlayVisible = rt.dialStrip !== undefined
        || rt.jumpMenuBox.visible
        || rt.approvalView.box.visible
        || rt.questionView.box.visible
        || rt.timelinePickerView.box.visible
        || rt.settingsPickerView.box.visible
        || rt.preferencesListView.surface.visible
        || rt.standingNudgesView.surface.visible
        || rt.commandPaletteView.surface.visible
        || rt.workTabView.surface.visible
        // A rail stands beside the transcript rather than over it, so the
        // scrim that dims the screen behind a card would be dimming the
        // half of it the reader is still reading.
        || (rt.workspaceSidebarView.surface.visible && rt.workspaceRail === undefined)
        || rt.searchOverlayView.surface.visible
        || rt.helpView.box.visible
        || rt.doctorDialogView.box.visible
        || rt.diagnosticsDialogView.box.visible
        || rt.extensionsDialogView.box.visible
        || rt.documentDialogView.box.visible
        || rt.permissionsConfirmView.box.visible
        || rt.admissionDialogView.surface.visible
        || rt.sessionTrashConfirmView.surface.visible
        || rt.sessionCloseConfirmView.surface.visible
        || rt.providerForgetConfirmView.surface.visible
        || rt.namePromptView.surface.visible
        || rt.providerFormView.surface.visible
        || rt.requestOptionsEditorView.surface.visible
        || rt.secretPromptView.box.visible
        || rt.experimentalTuiHost.hasModal();
    // The scrim carries the whole fade: its translucent fill composites
    // the glyphs behind it as well as the cell backgrounds, so the chrome
    // needs no attenuation of its own. Fading it a second time left the
    // composer and status band darker than the transcript beside them.
    rt.overlayScrim.visible = overlayVisible;
    const requestUsesRail = sessionRequestVisible
        && rt.workspaceSidebarView.surface.visible;
    const requestRailColumns = requestUsesRail
        ? rt.workspaceSidebarView.railColumns() ?? 0
        : 0;
    rt.overlayScrim.left = requestRailColumns;
    rt.overlayScrim.width = Math.max(1, rt.renderer.width - requestRailColumns);
    // Ordinary modals leave the conversation and composer in place as
    // dimmed context. The scrim sits above them and below the active card.
    // Approval and question cards are different: they replace the composer
    // until the pending engine request is answered.
    rt.composerBox.visible = uiRequest === undefined
        && (!isWorkerFreeClient(rt.client) || rt.jsonlCommandMode);
    rt.resumeOverlay.surface.visible = uiRequest === undefined
        && isJsonlViewClient(rt.client)
        && !rt.jsonlCommandMode;
    rt.homeView.surface.visible = isHomeClient(rt.client);
    renderCommandSuggestions(rt);
    if (
        uiRequest !== undefined
        && isToolApprovalUiRequestUpdate(uiRequest)
    ) {
        rt.approvalView.update(uiRequest);
    }
    if (
        uiRequest !== undefined
        && isUserQuestionUiRequestUpdate(uiRequest)
    ) {
        rt.questionView.update(uiRequest);
    }
    // Approval and question boxes are absolute children, so app padding
    // does not move them with the transcript. Seat session-owned cards in
    // the transcript column explicitly when the docked rail stays up.
    rt.approvalView.box.left = requestRailColumns;
    rt.questionView.box.left = requestRailColumns;
    if (rt.timelinePicker !== undefined) {
        rt.timelinePickerView.update(rt.timelinePicker);
    }
    if (rt.settingsPicker === undefined) {
        rt.pickerTipKind = undefined;
        rt.settingsPickerView.tip = undefined;
        rt.settingsPickerView.verification = undefined;
        // The run reports itself in the transcript. Closing the pane is
        // the end of the console, so reopening it does not bring back a
        // check that finished a while ago.
        rt.verificationConsole = undefined;
    } else if (rt.tipsEnabled && rt.pickerTipKind !== rt.settingsPicker.kind) {
        // One tip per pane, chosen when the pane opens. Rechoosing on
        // every keystroke would make the line flicker under the search
        // query, and the pane is one place, not one place per row.
        rt.pickerTipKind = rt.settingsPicker.kind;
        rt.settingsPickerView.tip = takeTip(rt, rt.settingsPicker.kind === "model");
    }
    if (rt.settingsPicker !== undefined) {
        rt.settingsPickerView.verification = rt.settingsPicker.kind === "model"
            ? liveVerificationConsole(rt)
            : undefined;
        rt.settingsPickerView.update(rt.settingsPicker);
    }
    if (rt.secretPrompt !== undefined) {
        rt.secretPromptView.update(rt.secretPrompt);
    }
    if (rt.namePrompt !== undefined) {
        rt.namePromptView.update(rt.namePrompt);
    }
    if (rt.providerForm !== undefined) {
        rt.providerFormView.update(rt.providerForm);
    }
    if (rt.requestOptionsEditor !== undefined) {
        rt.requestOptionsEditorView.update(rt.requestOptionsEditor);
    }
    if (rt.preferencesList !== undefined) {
        rt.preferencesListView.update(rt.preferencesList);
    }
    if (rt.standingNudges !== undefined) {
        rt.standingNudgesView.update(rt.standingNudges);
    }
    if (rt.commandPalette !== undefined) {
        rt.commandPaletteView.update(rt.commandPalette);
    }
    if (rt.workTab !== undefined) {
        rt.workTabView.update(
            workTabViewState(rt.workTab, rt.workTabView.contentWidth()),
        );
    }
    drawWorkspaceSidebar(rt);
    if (rt.searchOverlay !== undefined) {
        rt.searchOverlayView.update(searchOverlayViewState(
            rt.searchOverlay,
            rt.searchOverlayView.contentWidth(),
        ));
    }
    if (rt.help !== undefined) {
        rt.helpView.update(rt.help);
    }
    if (rt.doctorDialog !== undefined) {
        rt.doctorDialogView.update(rt.doctorDialog);
    }
    if (rt.diagnosticsDialog !== undefined) {
        if (rt.diagnosticsDialogView.contentWidth() !== rt.diagnosticsReportWidth) {
            rt.diagnosticsDialog = {
                ...rt.diagnosticsDialog,
                text: renderDiagnostics(rt),
            };
        }
        rt.diagnosticsDialogView.update(rt.diagnosticsDialog);
    }
    if (rt.extensionsDialog !== undefined) {
        rt.extensionsDialogView.update(rt.extensionsDialog);
    }
    if (rt.documentDialog !== undefined) {
        const text = rt.documentDialog.renderMarkdown?.(
            rt.documentDialogView.contentWidth(),
        ) ?? rt.documentDialog.text;
        if (text !== rt.documentDialog.text) {
            rt.documentDialog = { ...rt.documentDialog, text };
        }
        rt.documentDialogView.update(rt.documentDialog);
    }
    if (rt.sessionTrashCandidate !== undefined) {
        rt.sessionTrashConfirmView.update(rt.sessionTrashCandidate.label);
    }
    if (rt.sessionCloseConfirm) {
        rt.sessionCloseConfirmView.update(rt.sessionTitle ?? "untitled");
    }
    if (rt.providerForgetCandidate !== undefined) {
        rt.providerForgetConfirmView.update(rt.providerForgetCandidate.label);
    }
    if (rt.admissionDialog !== undefined) {
        rt.admissionDialogView.update(rt.admissionDialog, dialogAdmission(rt));
    }

    renderTranscriptEntries(rt, rt.state.entries);

    showSearchTarget(rt);
    renderStatus(rt);
}

export function showSearchTarget(rt: TuiRuntime): void {
    const target = rt.pendingSearchTarget;
    if (target === undefined || rt.client.agentId !== target.sessionId) {
        return;
    }
    const index = rt.state.entries.findIndex((entry) =>
        entry.kind !== "diff"
        && transcriptMessageId(entry.entryId) === target.entryId
    );
    // Nothing on screen yet means the session is still loading, so the
    // target waits. A drawn transcript without the row means the row is
    // gone, and chasing it through later paints of the same session would
    // scroll the reader away from wherever they had moved to.
    if (index === -1) {
        if (rt.state.entries.length > 0) rt.pendingSearchTarget = undefined;
        return;
    }
    const node = rt.entryNodes[index];
    if (node === undefined) {
        // Built in one step rather than a batch a frame: the target stays
        // outside the window until the scroll reaches it, and the window
        // would release each batch again before the next one arrived.
        setTranscriptWindowAround(rt, rt.state.entries, index);
        // The rows have no measured height until the next layout, so the
        // scroll waits a frame for one.
        return;
    }
    // A row built this frame has no position yet, and the frame that gives
    // it one also claims the bottom for a session that just opened. So the
    // scroll waits for the measurement, which is the frame after both.
    if (rt.measuredEntryRows[index] === undefined) return;
    rt.pendingSearchTarget = undefined;
    rt.searchLanding = {
        sessionId: target.sessionId,
        entryId: target.entryId,
    };
    // The node exists already and is about to be scrolled to, so the
    // glyph goes on in place; later rebuilds of this row read the id.
    const landed = rt.state.entries[index];
    if (landed !== undefined) markSearchLanding(rt, landed, node);
    // The row goes to the top of the pane rather than merely on screen: a
    // message taller than the pane would otherwise be shown by its end,
    // which is not where the match is, and one already on screen would not
    // move at all even though the reader came here to look at it.
    rt.transcript.scrollTo(
        rt.transcript.scrollTop + node.screenY - rt.transcript.viewport.screenY,
    );
}

export function drawWorkspaceSidebar(rt: TuiRuntime): void {
    if (rt.workspaceSidebar === undefined) {
        rt.workspaceSidebarDrawn = undefined;
        return;
    }
    const next = workspaceSidebarViewState(
        rt.workspaceSidebar,
        rt.renderer.width,
        new Date(),
        rt.workspaceRail,
        rt.workspaceSidebarFocused,
        activityFrame(rt),
    );
    const drawn = JSON.stringify(next);
    if (drawn === rt.workspaceSidebarDrawn) return;
    rt.workspaceSidebarDrawn = drawn;
    rt.workspaceSidebarView.update(next);
}

export function refreshTimedSurfaces(rt: TuiRuntime): void {
    if (rt.resumeOverlay.surface.visible) {
        rt.resumeOverlay.blink(Date.now());
    }
    if (rt.workTab !== undefined) {
        rt.workTabView.update(
            workTabViewState(rt.workTab, rt.workTabView.contentWidth()),
        );
    }
    applyWorkspaceRail(rt);
    drawWorkspaceSidebar(rt);
    if (rt.searchOverlay !== undefined) {
        rt.searchOverlayView.update(searchOverlayViewState(
            rt.searchOverlay,
            rt.searchOverlayView.contentWidth(),
        ));
    }
}

export function anyOverlayOpen(rt: TuiRuntime): boolean {
    return rt.dialStrip !== undefined
        || rt.experimentalTuiHost.hasModal()
        || focusedUiRequest(rt) !== undefined
        || rt.timelinePicker !== undefined
        || rt.secretPrompt !== undefined
        || rt.namePrompt !== undefined
        || rt.providerForm !== undefined
        || rt.requestOptionsEditor !== undefined
        || rt.settingsPicker !== undefined
        || rt.preferencesList !== undefined
        || rt.standingNudges !== undefined
        || rt.commandPalette !== undefined
        || rt.workTab !== undefined
        || rt.searchOverlay !== undefined
        || rt.help !== undefined
        || rt.doctorDialog !== undefined
        || rt.diagnosticsDialog !== undefined
        || rt.extensionsDialog !== undefined
        || rt.documentDialog !== undefined
        || rt.confirmingFullAccess
        || rt.admissionDialog !== undefined
        || rt.sessionTrashCandidate !== undefined
        || rt.sessionCloseConfirm
        || rt.providerForgetCandidate !== undefined
        || rt.jumpMenu !== undefined;
}

export function shiftTranscriptEntrySlots(rt: TuiRuntime, 
    from: number,
    to: number,
    delta: number,
): void {
    if (delta === 0) return;
    const moved: {
        node: TextRenderable | MarkdownRenderable | BoxRenderable;
        kind: TuiTranscriptEntry["kind"];
        rows: number | undefined;
    }[] = [];
    for (let index = from; index < to; index += 1) {
        const node = rt.entryNodes[index];
        const kind = rt.entryNodeKinds[index];
        if (node === undefined || kind === undefined) continue;
        moved.push({
            node,
            kind,
            rows: rt.measuredEntryRows[index],
        });
        delete rt.entryNodes[index];
        delete rt.entryNodeKinds[index];
        delete rt.measuredEntryRows[index];
    }
    moved.forEach((slot, offset) => {
        const target = from + delta + offset;
        slot.node.id = `entry-${target}`;
        rt.entryNodes[target] = slot.node;
        rt.entryNodeKinds[target] = slot.kind;
        if (slot.rows === undefined) delete rt.measuredEntryRows[target];
        else rt.measuredEntryRows[target] = slot.rows;
    });
}

export function reseedTranscriptNodes(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): void {
    const previous: (TuiTranscriptEntry | undefined)[] = [];
    for (
        let index = rt.materializedEntryStart;
        index < rt.materializedEntryEnd;
        index += 1
    ) {
        const node = rt.entryNodes[index];
        previous[index] = node === undefined
            ? undefined
            : rt.entryNodeSources.get(node);
    }
    const kept = tuiTranscriptReusableTail({
        previous,
        next: entries,
        previousStart: rt.materializedEntryStart,
        previousEnd: rt.materializedEntryEnd,
    });
    if (kept === 0) {
        clearTranscriptNodes(rt);
        return;
    }
    const oldEnd = rt.materializedEntryEnd;
    const newEnd = entries.length;
    const dropTo = oldEnd - kept;
    for (let index = rt.materializedEntryStart; index < dropTo; index += 1) {
        destroyTranscriptEntryNode(rt, index);
    }
    shiftTranscriptEntrySlots(rt, dropTo, oldEnd, newEnd - oldEnd);
    rt.materializedEntryStart = newEnd - kept;
    rt.materializedEntryEnd = newEnd;
    rt.pendingTranscriptScrollAnchor = undefined;
    rt.pendingTranscriptScrollRestore = {
        scrollTop: rt.transcript.scrollTop,
        atBottom: tuiTranscriptAtBottom(
            rt.transcript.scrollTop,
            rt.transcript.scrollHeight,
            rt.transcript.viewport.height,
        ),
    };
}

export function clearTranscriptNodes(rt: TuiRuntime): void {
    if (rt.state.entries.length > 0) {
        rt.pendingTranscriptScrollRestore = {
            scrollTop: rt.transcript.scrollTop,
            atBottom: tuiTranscriptAtBottom(
                rt.transcript.scrollTop,
                rt.transcript.scrollHeight,
                rt.transcript.viewport.height,
            ),
        };
    } else {
        rt.pendingTranscriptScrollRestore = undefined;
    }
    rt.experimentalTuiHost.clearTranscriptRenderables();
    for (const node of rt.entryNodes) {
        node?.destroyRecursively();
    }
    rt.entryNodes.length = 0;
    rt.entryNodeKinds.length = 0;
    rt.measuredEntryRows.length = 0;
    rt.materializedEntryStart = 0;
    rt.materializedEntryEnd = 0;
    rt.pendingTranscriptScrollAnchor = undefined;
    rt.transcriptWindowTopSpacer.height = 0;
    rt.transcriptWindowTopSpacer.visible = false;
    rt.transcriptWindowBottomSpacer.height = 0;
    rt.transcriptWindowBottomSpacer.visible = false;
}

export function openReviewerMenu(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    rt.settingsPicker = withTuiPickerParent(
        startTuiReviewerMenu(rt.state.modelSettings?.reviewerDefault),
        parent,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function openReviewerPicker(rt: TuiRuntime, 
    slot: TuiReviewerSlot,
    parent?: TuiSettingsPickerState,
): void {
    const reviewer = rt.state.modelSettings?.reviewerDefault;
    rt.settingsPicker = withTuiPickerParent(
        startTuiReviewerPicker(
            slot,
            rt.state.modelSettings?.pooled,
            slot === "primary" ? reviewer?.primary : reviewer?.fallback,
            rt.state.modelSettings?.availableModels,
        ),
        parent,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function reviewerPatchFor(rt: TuiRuntime, 
    selection: { slot: TuiReviewerSlot; provider?: string; model?: string },
): ModelSettingsPatch["reviewer"] {
    const chosen = selection.model === undefined ? undefined : {
        model: selection.model,
        ...(selection.provider === undefined
            ? {}
            : { provider: selection.provider }),
    };
    const current = rt.state.modelSettings?.reviewerDefault;
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

export function reviewerToast(rt: TuiRuntime, 
    selection: { slot: TuiReviewerSlot; provider?: string; model?: string },
): string {
    const name = selection.model === undefined
        ? "configured default"
        : selection.model;
    return selection.slot === "primary" ? name : `failsafe ${name}`;
}

export function openModelPicker(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    if (parent === undefined) rt.settingsPickerAgent = focusedAgentClient(rt);
    const targetState = focusedAgentState(rt);
    const currentProvider = targetState.modelSettings?.provider;
    const currentModel = targetState.modelSettings?.model;
    const pooled = targetState.modelSettings?.pooled ?? [];
    const currentShortlisted = currentProvider !== undefined
        && currentModel !== undefined
        && pooled.some((entry) =>
            entry.provider === currentProvider
            && entry.model === currentModel
        );
    rt.settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
        "model",
        targetState.modelSettings?.model,
        targetState.modelSettings?.reasoningEffort,
        targetState.approvalMode,
        targetState.modelSettings?.availableModels,
        undefined,
        targetState.modelSettings?.provider,
        undefined,
        pooled,
    ), parent);
    rt.settingsPicker = {
        ...rt.settingsPicker,
        ...modelRequestOptionsFacts(rt),
        assignmentOptions: tuiModelAssignmentOptions(
            currentModelAssignmentRows(rt),
            targetState.modelSettings?.model,
            targetState.modelSettings?.reasoningEffort,
            targetState.modelSettings?.contextLimit,
        ),
        actionOptions: modelPickerActionOptions(rt, targetState.modelSettings),
        ...(targetState.modelSettings?.webdevArenaSnapshot === undefined
            ? {}
            : {
                webdevArenaSnapshot:
                    targetState.modelSettings.webdevArenaSnapshot,
            }),
        // Home reads the catalog from the host, so it usually has one.
        // When the read failed there is no chord that would fill the list,
        // and saying so beats an empty list that looks like a provider
        // problem the user could go and fix.
        modelCatalogUnavailable: targetState.modelSettings === undefined
            && isHomeClient(focusedAgentClient(rt)),
    };
    if (rt.settingsPicker.tab === "pool" && currentShortlisted === false) {
        rt.settingsPicker = {
            ...switchedModelTab(rt.settingsPicker, "pool"),
            selectedIndex: 0,
        };
    }
    // Auth changes happen outside the host's original model snapshot.
    // Refresh here so reopening the picker also repairs a stale model pane
    // that was kept underneath the provider picker.
    requestAgentSettings(rt, focusedAgentClient(rt));
    renderState(rt);
    focusActiveSurface(rt);
}

export function modelRequestOptionsFacts(rt: TuiRuntime): Pick<
    TuiSettingsPickerState,
    "requestOptionsProviders" | "configuredRequestOptions"
> {
    const config = loadOptionalVeraConfig();
    const requestOptionsProviders = Object.fromEntries(
        configuredProviders(config).flatMap((provider) =>
            provider.requestOptions === undefined
                ? []
                : [[provider.id, {
                    providerLabel: provider.label,
                    label: provider.requestOptions.label,
                    explanation: provider.requestOptions.explanation,
                    documentationUrl: provider.requestOptions.documentationUrl,
                }]]
        ),
    );
    return {
        requestOptionsProviders,
        configuredRequestOptions: Object.keys(
            config?.model_request_options ?? {},
        ),
    };
}

export function modelPickerActionOptions(rt: TuiRuntime, 
    settings: TuiState["modelSettings"],
): readonly TuiSettingsPickerOption[] {
    const provider = settings?.provider;
    const model = settings?.model;
    const pooled = settings?.pooled ?? [];
    return tuiModelActionOptions(
        refreshableProvidersOf(rt, 
            settings?.availableModels,
            settings?.refreshableProviders,
        ),
        {
            hasPool: pooled.length > 0,
            ...(provider === undefined || model === undefined
                ? {}
                : {
                    currentModel: {
                        provider,
                        model,
                        shortlisted: isModelShortlisted(rt, 
                            settings,
                            provider,
                            model,
                        ),
                    },
                }),
        },
    );
}

export function isModelShortlisted(rt: TuiRuntime, 
    settings: TuiState["modelSettings"],
    provider: string,
    model: string,
): boolean {
    return settings?.pooled?.some((entry) =>
        entry.provider === provider && entry.model === model
    ) === true;
}

export function refreshableProvidersOf(rt: TuiRuntime, 
    models: readonly {
        readonly provider: string;
        readonly refreshable?: boolean;
    }[] | undefined,
    providers: readonly string[] | undefined,
): readonly string[] {
    if (providers !== undefined) return [...new Set(providers)];
    const named = new Set<string>();
    for (const model of models ?? []) {
        if (model.refreshable === true) {
            named.add(model.provider);
        }
    }
    return [...named].toSorted();
}

export function catalogSizeOf(rt: TuiRuntime, provider: string): number {
    return (rt.state.modelSettings?.availableModels ?? [])
        .filter((entry) => entry.provider === provider)
        .length;
}

export function currentModelAssignmentRows(rt: TuiRuntime): readonly ModelAssignmentRow[] {
    const configured = loadOptionalVeraConfig();
    if (configured === undefined) {
        return [];
    }
    return configuredModelAssignments(
        configured,
        poolReachability(loadPoolFile({ projectRoot: process.cwd() }).merged),
    );
}

export function openModelAssignmentPicker(rt: TuiRuntime, 
    assignment: ModelAssignmentId,
    parent?: TuiSettingsPickerState,
    selectedValue?: string,
): void {
    const targetState = focusedAgentState(rt);
    const row = currentModelAssignmentRows(rt).find((entry) => entry.assignment === assignment);
    const parentModel = targetState.modelSettings === undefined
        ? undefined
        : {
            ...(targetState.modelSettings.provider === undefined
                ? {}
                : { provider: targetState.modelSettings.provider }),
            model: targetState.modelSettings.model,
        };
    rt.settingsPicker = withTuiPickerParent(
        startTuiModelAssignmentPicker(
            assignment,
            row?.label ?? assignment,
            row?.intent ?? "",
            targetState.modelSettings?.pooled,
            row?.declared.map((entry) =>
                `${entry.provider}/${entry.model}`) ?? [],
            row?.allowSelf === true,
            parentModel,
            selectedValue,
        ),
        parent,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function bindModelAssignmentFromPicker(rt: TuiRuntime, 
    selection: {
        readonly assignment: ModelAssignmentId;
        readonly provider?: string;
        readonly model?: string;
        readonly reasoningEffort?: ModelReasoningEffort;
        readonly acceptDefaultReasoning?: true;
        readonly remove?: boolean;
        readonly clear?: boolean;
        readonly allowSelf?: boolean;
    },
): string | undefined {
    const subagents = selection.assignment === "subagents";
    const row = subagents
        ? currentModelAssignmentRows(rt).find((entry) =>
            entry.assignment === "subagents")
        : undefined;
    const currentModels = row?.declared ?? [];
    const selectedRef = selection.model === undefined
        ? undefined
        : `${selection.provider ?? ""}/${selection.model}`;
    const models = !subagents
        ? []
        : selection.clear === true
        ? []
        : selection.allowSelf !== undefined
        ? [...currentModels]
        : selection.remove === true
        ? currentModels.filter((entry) =>
            `${entry.provider}/${entry.model}` !== selectedRef)
        : [
            ...currentModels.filter((entry) =>
                `${entry.provider}/${entry.model}` !== selectedRef),
            {
                name: derivedModelName(
                    selection.provider as VeraProviderId,
                    selection.model as string,
                ),
                provider: selection.provider as VeraProviderId,
                model: selection.model as string,
                ...(selection.reasoningEffort === undefined
                    ? {}
                    : { reasoning_effort: selection.reasoningEffort }),
            },
        ];
    const allowSelf = selection.allowSelf
        ?? (selection.clear === true ? false : row?.allowSelf === true);
    const unbinding = subagents
        ? models.length === 0 && !allowSelf
        : selection.model === undefined;
    try {
        updateVeraConfigDefaults({
            model_assignment: {
                assignment: selection.assignment,
                binding: unbinding ? null : subagents ? {
                    models,
                    ...(allowSelf ? { allow_self: true } : {}),
                } : {
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
        // Refreshing settings also pushes the host's newly read policy to
        // an already-running worker before another spawn can use it.
        requestAgentSettings(rt, focusedAgentClient(rt));
    } catch (error) {
        const message = `Could not write the assignment: ${
            error instanceof Error ? error.message : String(error)
        }`;
        rt.state = appendTuiError(rt.state, message);
        return message;
    }
    rt.state = appendTuiNotice(
        rt.state,
        unbinding
            ? `${selection.assignment} unset. This session uses the fallback.`
            : subagents
            ? `Subagent policy updated: ${models.length} assigned, parent fallback ${
                allowSelf ? "on" : "off"
            }.`
            : `${selection.assignment} → ${
                selection.reasoningEffort === undefined
                    ? selection.model
                    : `${selection.model} (${selection.reasoningEffort})`
            }. This session uses it.`,
        "soft",
    );
    return undefined;
}

export function configureDisplayPath(rt: TuiRuntime, path: string): string {
    const home = homedir();
    const prefix = home.endsWith("/") ? home : `${home}/`;
    return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

export function configureFiles(rt: TuiRuntime): readonly TuiConfigureFile[] {
    const profileConfig = veraConfigPath();
    const files: TuiConfigureFile[] = [{
        label: "Profile config",
        path: profileConfig,
        displayPath: configureDisplayPath(rt, profileConfig),
        scope: "Profile",
        createIfMissing: true,
    }];
    const tuiPreferences = tuiThemePreferencePath();
    if (existsSync(tuiPreferences)) {
        files.push({
            label: "TUI preferences",
            path: tuiPreferences,
            displayPath: configureDisplayPath(rt, tuiPreferences),
            scope: "Profile",
            createIfMissing: false,
        });
    }
    const workspace = focusedAgentClient(rt).workspace;
    if (workspace !== undefined) {
        const projectConfig = join(workspace, ".vera", "config.json");
        if (existsSync(projectConfig)) {
            files.push({
                label: "Project config",
                path: projectConfig,
                displayPath: ".vera/config.json",
                scope: "Project",
                createIfMissing: false,
            });
        }
    }
    return files;
}

export function openConfigurePicker(rt: TuiRuntime): void {
    rt.settingsPickerAgent = focusedAgentClient(rt);
    rt.settingsPicker = startTuiConfigurePicker(configureFiles(rt));
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export async function openConfigureEditor(rt: TuiRuntime, file: TuiConfigureFile): Promise<void> {
    if (!file.createIfMissing && !existsSync(file.path)) {
        rt.state = appendTuiError(
            rt.state,
            `${file.label} is no longer available: ${file.displayPath}`,
        );
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    rt.renderer.suspend();
    try {
        if (rt.dependencies.openConfigurationFile !== undefined) {
            await rt.dependencies.openConfigurationFile(file.path);
        } else if (
            file.path === veraConfigPath()
            && rt.dependencies.openConfigure !== undefined
        ) {
            await rt.dependencies.openConfigure();
        } else {
            await openFileInEditor(file.path);
        }
        rt.state = appendTuiNotice(
            rt.state,
            `${file.label} editor closed: ${file.displayPath}`,
        );
    } catch (error) {
        rt.state = appendTuiError(
            rt.state,
            `Could not open ${file.label.toLowerCase()}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    } finally {
        rt.renderer.resume();
        renderState(rt);
        focusActiveSurface(rt);
    }
}

export function modelLevelFacts(rt: TuiRuntime, 
    provider: string | undefined,
    model: string | undefined,
    source: TuiState = focusedAgentState(rt),
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

export function currentModelLevels(rt: TuiRuntime): readonly ReasoningLevel[] {
    const targetState = focusedAgentState(rt);
    return modelLevelFacts(rt, 
        targetState.modelSettings?.provider,
        targetState.modelSettings?.model,
        targetState,
    )?.levels ?? [];
}

export function openReasoningPicker(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    if (parent === undefined) rt.settingsPickerAgent = focusedAgentClient(rt);
    const targetState = focusedAgentState(rt);
    // An empty (or unresolved) level list means this model has no
    // reasoning control at all. A card with no rows is indistinguishable
    // from the TUI ignoring the key, so say why there is nothing to pick.
    // This is presentation only: the engine still decides what it will
    // accept.
    const levels = currentModelLevels(rt);
    if (levels.length === 0) {
        rt.state = appendTuiNotice(
            rt.state,
            `${
                targetState.modelSettings === undefined
                    ? "this model"
                    : `${targetState.modelSettings.provider}/${targetState.modelSettings.model}`
            } has no reasoning effort setting`,
        );
        renderState(rt);
        return;
    }
    const current = modelLevelFacts(rt, 
        targetState.modelSettings?.provider,
        targetState.modelSettings?.model,
        targetState,
    );
    rt.settingsPicker = withTuiPickerParent(startTuiReasoningPicker(
        levels,
        current?.defaultLevel,
        targetState.modelSettings?.reasoningEffort,
    ), parent);
    renderState(rt);
    focusActiveSurface(rt);
}

export function openPermissionsPicker(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    if (parent === undefined) rt.settingsPickerAgent = focusedAgentClient(rt);
    const targetState = focusedAgentState(rt);
    if (targetState.permissionInspection !== undefined) {
        const notice = renderPermissionInspection(
            targetState.permissionInspection,
        );
        if (rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined) {
            rt.hostedSidebar.pane.state.state = appendTuiNotice(
                rt.hostedSidebar.pane.state.state,
                notice,
            );
            renderSidebarAgent(rt, rt.hostedSidebar.pane);
        } else {
            rt.state = appendTuiNotice(rt.state, notice);
        }
    }
    rt.settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
        "permissions",
        targetState.modelSettings?.model,
        targetState.modelSettings?.reasoningEffort,
        targetState.approvalMode,
        targetState.modelSettings?.availableModels,
        undefined,
        undefined,
        targetState.permissionInspection?.availableModes,
    ), parent);
    renderState(rt);
    focusActiveSurface(rt);
}

export function openThemePicker(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    rt.settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
        "theme",
        rt.state.modelSettings?.model,
        rt.state.modelSettings?.reasoningEffort,
        rt.state.approvalMode,
        rt.state.modelSettings?.availableModels,
        rt.themeName,
    ), parent);
    renderState(rt);
    focusActiveSurface(rt);
}

export function openPreferencesList(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    // Opened from the cached inspection, then refreshed by the reply to
    // this fetch. Without the fetch the list could be stale, since a
    // client is only sent an inspection at startup and when something
    // changes it.
    rt.preferencesList = startTuiPreferencesList(rt.state.permissionInspection);
    // Its own overlay rather than a picker pane, so the pane it came from
    // is held here instead of on the state, and closing puts it back.
    rt.preferencesListParent = parent;
    sendCommand(rt, { type: "get_permissions", requestId: randomUUID() });
    rt.composer.blur();
    focusActiveSurface(rt);
    renderState(rt);
}

export function openStandingNudges(rt: TuiRuntime): void {
    adoptStandingNudgesState(rt, 
        openTuiStandingNudges(
            rt.standingNudgesProfileDirectory,
            focusedAgentClient(rt).workspace ?? "",
        ),
    );
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function providerConnected(rt: TuiRuntime, provider: Parameters<typeof isProviderConnected>[0]): boolean {
    try {
        return isProviderConnected(provider, { authStorage: rt.authStorage });
    } catch {
        return false;
    }
}

export function openProviderEditForm(rt: TuiRuntime, 
    provider: string,
    parent?: TuiSettingsPickerState,
): void {
    const declaration = loadOptionalVeraConfig()?.providers?.[provider];
    if (declaration === undefined) {
        return;
    }
    let apiKey: string | undefined;
    try {
        const stored = rt.authStorage.getCredential(provider);
        apiKey = stored?.type === "api_key" ? stored.key : undefined;
    } catch {
        apiKey = undefined;
    }
    rt.providerForm = startTuiProviderForm(parent, {
        id: provider,
        baseUrl: declaration.base_url,
        protocol: declaration.protocol,
        credential: declaration.credential,
        ...(apiKey === undefined ? {} : { apiKey }),
    });
    rt.settingsPicker = undefined;
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openProviderPicker(rt: TuiRuntime, 
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
    const targetState = rt.state;
    const refreshable = new Set(refreshableProvidersOf(rt, 
        targetState.modelSettings?.availableModels,
        targetState.modelSettings?.refreshableProviders,
    ));
    rt.settingsPicker = withTuiPickerParent(
        startTuiProviderPicker(
            providers.map((provider) => ({
                id: provider.id,
                label: provider.label,
                group: tuiProviderGroup(
                    provider.access,
                    declared.has(provider.id),
                ),
                // A provider pointed somewhere other than where it ships
                // says so on its own row: it is the more surprising fact
                // about it than which credential it takes.
                ...(moved.has(provider.id)
                    ? { hint: provider.baseUrl ?? "" }
                    : provider.hint === undefined
                    ? {}
                    : { hint: provider.hint }),
                connected: providerConnected(rt, provider),
                ...(refreshable.has(provider.id) ? { refreshable: true } : {}),
                ...(declared.has(provider.id) ? { declared: true } : {}),
                ...(provider.fixedEndpoint === true
                    ? {}
                    : { endpointEditable: true }),
            })),
            options,
        ),
        parent,
    );
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function connectProvider(rt: TuiRuntime, 
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
        rt.secretPrompt = startTuiSecretPrompt(provider, pane);
        rt.settingsPicker = undefined;
        rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    // Everything below this point answers in the transcript, so the pane
    // goes away first. A notice written behind an open card is a notice the
    // user has to dismiss a modal to discover, and the sign-in URL is the
    // one line they cannot afford to miss.
    rt.settingsPicker = undefined;
    closeSettingsPickerSurface(rt);
    if (provider.credential === "none") {
        rt.state = appendTuiNotice(
            rt.state,
            `${provider.label} needs no credentials${
                provider.envVar === undefined
                    ? ""
                    : `, point it elsewhere with ${provider.envVar}`
            }`,
            // A standing fact about the provider, not something to do.
            "soft",
        );
        renderState(rt);
        return;
    }
    // Enter can still land twice, from two trips into the pane, and the
    // callback listener binds a fixed port: a second run would fail on the
    // first one's own server.
    if (rt.connectingProviders.has(provider.id)) {
        return;
    }
    rt.connectingProviders.add(provider.id);
    rt.state = appendTuiNotice(
        rt.state,
        `opening a browser to sign in to ${provider.label}…`,
        // Vera saying what it is doing. The line worth the eye is the URL
        // that follows, which is the one the user has to act on.
        "soft",
    );
    renderState(rt);
    void (rt.dependencies.loginProvider ?? ((providerId: string, onAuthorizationUrl: (url: string) => void) => defaultLoginProvider(rt, providerId, onAuthorizationUrl)))(
        provider.id,
        (url) => {
            rt.state = appendTuiNotice(rt.state, `sign in at ${url}`);
            renderState(rt);
        },
    ).then(() => {
        rt.connectingProviders.delete(provider.id);
        rt.state = appendTuiNotice(rt.state, `connected to ${provider.label}`, "soft");
        renderState(rt);
    }, (error: unknown) => {
        rt.connectingProviders.delete(provider.id);
        rt.state = appendTuiError(
            rt.state,
            `could not connect to ${provider.label}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function forgetProvider(rt: TuiRuntime, 
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
        stored = rt.authStorage.getCredential(provider.id);
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
        openProviderPicker(rt, pane, {
            selected: provider.id,
            subtitle: decision.message,
        });
        return;
    }
    rt.providerForgetCandidate = {
        providerId: provider.id,
        label: provider.label,
        pane,
    };
    rt.composer.blur();
    rt.providerForgetConfirmView.update(provider.label);
    renderState(rt);
    focusActiveSurface(rt);
}

export function forgetProviderCredential(rt: TuiRuntime, candidate: {
    readonly providerId: string;
    readonly label: string;
    readonly pane: TuiSettingsPickerState | undefined;
}): void {
    rt.providerForgetCandidate = undefined;
    rt.settingsPicker = undefined;
    closeSettingsPickerSurface(rt);
    try {
        rt.authStorage.deleteCredential(candidate.providerId);
    } catch (error) {
        rt.state = appendTuiError(
            rt.state,
            `could not forget the ${candidate.label} credential: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
        return;
    }
    rt.state = appendTuiNotice(
        rt.state,
        `forgot the stored ${candidate.label} credential`,
    );
    requestAgentSettings(rt, focusedAgentClient(rt));
    // Reopened rather than patched: the mark on every row is read from the
    // store, and the store just changed.
    openProviderPicker(rt, candidate.pane, { selected: candidate.providerId });
}

export async function defaultLoginProvider(rt: TuiRuntime, 
    providerId: string,
    onAuthorizationUrl: (url: string) => void,
): Promise<void> {
    if (providerId !== "openai-codex") {
        throw new Error(`No sign-in flow for provider ${providerId}`);
    }
    await loginOpenAICodex({ authStorage: rt.authStorage, onAuthorizationUrl });
}

export function openProviderEndpointForm(rt: TuiRuntime, 
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
        const stored = rt.authStorage.getCredential(providerId);
        apiKey = stored?.type === "api_key" ? stored.key : undefined;
    } catch {
        apiKey = undefined;
    }
    rt.providerForm = startTuiProviderForm(parent, {
        id: providerId,
        baseUrl: provider.baseUrl ?? "",
        protocol: "openai-chat",
        credential: provider.credential === "none" ? "none" : "api_key",
        shipped: true,
        ...(apiKey === undefined ? {} : { apiKey }),
    });
    rt.settingsPicker = undefined;
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openRequestOptionsEditor(rt: TuiRuntime, 
    candidate: NonNullable<TuiSettingsPickerTransition["requestOptions"]>,
    parent: TuiSettingsPickerState,
): void {
    try {
        const config = loadOptionalVeraConfig();
        const reference = `${candidate.provider}/${candidate.model}`;
        rt.requestOptionsEditor = startTuiRequestOptionsEditor(
            candidate,
            DEFAULT_PROFILE_NAME,
            config?.model_request_options?.[reference]?.body,
            parent,
        );
        rt.settingsPicker = undefined;
        rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
    } catch (error) {
        rt.state = appendTuiError(
            rt.state,
            error instanceof Error ? error.message : String(error),
        );
        rt.settingsPicker = parent;
        renderState(rt);
    }
}

export function applyRequestOptionsEditorTransition(rt: TuiRuntime, 
    transition: TuiRequestOptionsEditorTransition,
): void {
    const previous = rt.requestOptionsEditor;
    rt.requestOptionsEditor = transition.state;
    if (rt.requestOptionsEditor !== undefined) {
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (previous === undefined) return;
    if (transition.save === undefined) {
        rt.settingsPicker = previous.parent;
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    const save = transition.save;
    const reference = `${save.provider}/${save.model}`;
    try {
        updateVeraConfigDefaults({
            model_request_options: {
                model: reference,
                body: save.body,
            },
        });
    } catch (error) {
        rt.requestOptionsEditor = {
            ...previous,
            error: error instanceof Error ? error.message : String(error),
        };
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    rt.settingsPicker = {
        ...save.parent,
        ...modelRequestOptionsFacts(rt),
    };
    rt.state = appendTuiNotice(
        rt.state,
        `saved request options for ${reference}`,
        "soft",
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function applyProviderFormTransition(rt: TuiRuntime, 
    form: TuiProviderFormState,
    transition: TuiProviderFormTransition,
): void {
    rt.providerForm = transition.state;
    if (rt.providerForm !== undefined) {
        renderState(rt);
        return;
    }
    const submitted = transition.submitted;
    if (submitted === undefined) {
        rt.settingsPicker = form.parent;
        renderState(rt);
        focusActiveSurface(rt);
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
        rt.providerForm = {
            ...form,
            field: "base_url",
            error: error instanceof Error ? error.message : String(error),
        };
        renderState(rt);
        focusActiveSurface(rt);
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
            rt.authStorage.deleteCredential(submitted.replaces);
        } catch (error) {
            rt.state = appendTuiError(
                rt.state,
                `renamed to ${submitted.id}, but ${submitted.replaces} `
                    + `could not be removed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
        }
    }
    rt.state = appendTuiNotice(
        rt.state,
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
            rt.authStorage.setCredential(submitted.id, {
                type: "api_key",
                key: submitted.apiKey,
            });
            rt.state = appendTuiNotice(
                rt.state,
                `stored ${submitted.id} API key`,
            );
        } catch (error) {
            rt.state = appendTuiError(
                rt.state,
                `could not store the ${submitted.id} API key: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
    requestAgentSettings(rt, focusedAgentClient(rt));
    // Rebuilt rather than patched: the connect list is read from the config
    // file, and the file just changed. It opens on the row that was just
    // declared, which is the one the user came here to act on.
    openProviderPicker(rt, form.parent?.parent, { selected: submitted.id });
}

export function applySecretPromptTransition(rt: TuiRuntime, 
    prompt: TuiSecretPromptState,
    transition: { readonly state?: TuiSecretPromptState; readonly submitted?: string },
): void {
    rt.secretPrompt = transition.state;
    if (rt.secretPrompt !== undefined) {
        renderState(rt);
        return;
    }
    if (transition.submitted !== undefined) {
        try {
            rt.authStorage.setCredential(prompt.providerId, {
                type: "api_key",
                key: transition.submitted,
            });
            rt.state = appendTuiNotice(rt.state, `stored ${prompt.label} API key`);
            requestAgentSettings(rt, focusedAgentClient(rt));
        } catch (error) {
            rt.state = appendTuiError(
                rt.state,
                `could not store the ${prompt.label} API key: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
    // Back to the pane the prompt was opened over, rebuilt so the row it
    // came from carries its new mark.
    if (prompt.parent?.kind === "provider") {
        openProviderPicker(rt, prompt.parent.parent);
        return;
    }
    rt.settingsPicker = prompt.parent;
    if (rt.settingsPicker?.kind === "model") {
        requestAgentSettings(rt, focusedAgentClient(rt));
    }
    renderState(rt);
    focusActiveSurface(rt);
}

export function applySessionRenamePromptTransition(rt: TuiRuntime, 
    prompt: TuiNamePromptState,
    transition: TuiNamePromptTransition,
): void {
    rt.namePrompt = transition.state;
    if (rt.namePrompt !== undefined) {
        renderState(rt);
        return;
    }
    // A pool name leaves the pane it was opened over alone: the settings
    // snapshot that follows the write rebuilds it, and the captured parent
    // is the list as it read before the name existed.
    const parent = prompt.parent;
    rt.settingsPicker = prompt.target.kind === "pool"
        ? rt.settingsPicker ?? parent
        : parent;
    if (transition.submitted !== undefined && prompt.target.kind === "pool") {
        sendCommand(rt, {
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
        if (prompt.target.sessionId === rt.client.agentId) {
            const requestId = randomUUID();
            rt.pendingSessionRename = { requestId };
            sendCommand(rt, {
                type: "update_session_name",
                requestId,
                name: transition.submitted,
            });
        } else if (
            prompt.target.sessionId === rt.hostedSidebar.pane?.agentId
        ) {
            const requestId = randomUUID();
            const target = rt.hostedSidebar.pane;
            rt.pendingSidebarSessionRename = { requestId };
            void target.client.send({
                type: "update_session_name",
                requestId,
                name: transition.submitted,
            }).catch((error) => {
                if (rt.pendingSidebarSessionRename?.requestId !== requestId) {
                    return;
                }
                rt.pendingSidebarSessionRename = undefined;
                reportConnectionError(rt, error);
            });
        } else {
            void performSessionRename(rt, 
                prompt.target.sessionId,
                transition.submitted,
            );
        }
    }
    renderState(rt);
    focusActiveSurface(rt);
}

export async function performSessionRename(rt: TuiRuntime, 
    sessionId: string,
    name: string | null,
): Promise<void> {
    if (rt.dependencies.renameSession === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "Renaming another conversation is unavailable",
        );
        renderState(rt);
        return;
    }
    const generation = rt.clientGeneration;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
        rt.dependencies.renameSession(sessionId, name)
            .catch((): RenameSessionResult => ({
                status: "rejected",
                reason: "failed",
            })),
        new Promise<RenameSessionResult>((resolve) => {
            timeout = setTimeout(() => {
                resolve({ status: "rejected", reason: "failed" });
            }, rt.dependencies.sessionSwitchTimeoutMs
                ?? SESSION_SWITCH_TIMEOUT_MS);
        }),
    ]);
    clearTimeout(timeout);
    // The session on screen may have been swapped underneath while the
    // host was answering, and this result belongs to the one that left.
    if (rt.shuttingDown || generation !== rt.clientGeneration) return;
    rt.state = result.status === "renamed"
        ? appendTuiNotice(
            rt.state,
            result.name === null
                ? "session name cleared"
                : `session renamed: ${result.name}`,
        )
        : appendTuiError(
            rt.state,
            result.reason === "busy"
                ? "That conversation is open in another client"
                : result.reason === "not_found"
                ? "That conversation is no longer available"
                : result.reason === "invalid"
                ? "Session name must be 1 to 200 UTF-8 bytes"
                : "Could not rename that conversation",
        );
    if (result.status === "renamed" && rt.settingsPicker?.kind === "session") {
        await refreshSessionPicker(rt);
    }
    if (result.status === "renamed" && rt.workspaceSidebar !== undefined) {
        refreshWorkspaceSidebarRoster(rt);
    }
    renderState(rt);
}

export async function refreshSessionPicker(rt: TuiRuntime): Promise<void> {
    if (rt.dependencies.listAgents === undefined) return;
    const generation = rt.clientGeneration;
    try {
        const agents = await rt.dependencies.listAgents();
        if (
            rt.shuttingDown || generation !== rt.clientGeneration
            || rt.settingsPicker?.kind !== "session"
        ) {
            return;
        }
        rt.settingsPicker = startTuiSessionPicker(
            agents,
            rt.client.agentId,
            false,
            new Date(),
            false,
            rt.hostedPanePersistence.groups,
            rt.settingsPicker.enterDisposition ?? "stop",
        );
        renderState(rt);
    } catch {
        // The pane keeps the rows it has: a failed refresh is not a
        // reason to close what the user is working in.
    }
}

export function openSettingsMenu(rt: TuiRuntime): void {
    rt.settingsPickerAgent = focusedAgentClient(rt);
    rt.settingsPicker = startTuiSettingsMenu(
        "settings",
        focusedAgentState(rt)?.modelSettings?.developer,
    );
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openSettingsDestination(rt: TuiRuntime, 
    destination: unknown,
    options: {
        readonly parent?: TuiSettingsPickerState;
    } = {},
): "opened" | "unavailable" {
    const resolution = resolveTuiSettingsDestination(destination, {
        permissionModes:
            focusedAgentState(rt).permissionInspection?.availableModes,
    });
    if (resolution.status === "unsupported") {
        rt.state = appendTuiNotice(
            rt.state,
            "That settings destination is unavailable in this client.",
        );
        renderState(rt);
        return "unavailable";
    }
    const route = resolution.route;
    if (route.type === "settings_menu") {
        openSettingsMenu(rt);
    } else if (route.type === "model_picker") {
        openModelPicker(rt, options.parent);
    } else if (route.type === "reasoning_picker") {
        openReasoningPicker(rt, options.parent);
    } else if (route.type === "permission_mode_picker") {
        openPermissionsPicker(rt, options.parent);
    } else if (route.type === "agent_picker") {
        void openAgentPicker(rt, route.name);
    } else if (route.type === "provider_picker") {
        if (
            route.provider !== undefined
            && !configuredProviders(loadOptionalVeraConfig()).some(
                (provider) => provider.id === route.provider,
            )
        ) {
            rt.state = appendTuiNotice(
                rt.state,
                `No provider named ${route.provider}; that settings destination is unavailable.`,
            );
            renderState(rt);
            return "unavailable";
        }
        openProviderPicker(rt, options.parent, {
            ...(route.provider === undefined
                ? {}
                : { selected: route.provider }),
        });
    } else if (route.type === "model_shortlist") {
        openModelPicker(rt);
        rt.settingsPicker = switchedModelTab(
            rt.settingsPicker as TuiSettingsPickerState,
            "pool",
        );
        renderState(rt);
    } else if (route.type === "model_assignments") {
        openModelPicker(rt);
        rt.settingsPicker = switchedModelTab(
            rt.settingsPicker as TuiSettingsPickerState,
            "defaults",
        );
        renderState(rt);
    } else {
        openModelAssignmentPicker(rt, route.assignment, options.parent);
    }
    return "opened";
}

export function openConfigurationRequiredRequest(rt: TuiRuntime, 
    request: UiRequestUpdate,
    target: TuiAgentClient,
): void {
    if (!isConfigurationRequiredUiRequestUpdate(request)) return;
    if (rt.activeConfigurationRequest?.requestId === request.requestId) return;
    if (rt.activeConfigurationRequest !== undefined) {
        if (!rt.queuedConfigurationRequests.some((queued) =>
            queued.request.requestId === request.requestId
            && queued.target === target)) {
            rt.queuedConfigurationRequests.push({ request, target });
        }
        return;
    }
    activateConfigurationRequiredRequest(rt, request, target);
}

export function activateConfigurationRequiredRequest(rt: TuiRuntime, 
    request: UiRequestUpdate,
    target: TuiAgentClient,
): void {
    if (!isConfigurationRequiredUiRequestUpdate(request)) return;
    rt.activeConfigurationRequest = { requestId: request.requestId, target };
    if (rt.hostedSidebar.pane?.client === target) {
        setSidebarFocused(rt, true);
    } else if (rt.client === target) {
        setSidebarFocused(rt, false);
    }
    rt.settingsPickerAgent = target;
    rt.state = appendTuiNotice(
        rt.state,
        `${request.request.reason} (${request.request.pendingAction.count} waiting)`,
        "soft",
    );

    let parent: TuiSettingsPickerState | undefined;
    if (
        request.request.destination.kind === "model_assignment"
        && request.request.destination.assignment === "subagents"
    ) {
        openModelPicker(rt);
        parent = switchedModelTab(
            rt.settingsPicker as TuiSettingsPickerState,
            "defaults",
        );
        rt.settingsPicker = undefined;
    }
    const opened = openSettingsDestination(rt, 
        request.request.destination,
        { ...(parent === undefined ? {} : { parent }) },
    );
    if (opened === "unavailable") {
        respondToConfigurationRequired(rt, "unavailable");
    }
}

export function respondToConfigurationRequired(rt: TuiRuntime, 
    outcome: "configured" | "cancelled" | "unavailable",
): void {
    const pending = rt.activeConfigurationRequest;
    if (pending === undefined) return;
    rt.activeConfigurationRequest = undefined;
    rt.settingsPicker = undefined;
    closeSettingsPickerSurface(rt);
    void pending.target.send({
        type: "ui_response",
        requestId: pending.requestId,
        response: { type: "configuration_required", outcome },
    }).catch(((error: unknown) => reportConnectionError(rt, error)));
    renderState(rt);
    focusActiveSurface(rt);
    openNextConfigurationRequiredRequest(rt);
}

export function openNextConfigurationRequiredRequest(rt: TuiRuntime): void {
    if (rt.activeConfigurationRequest !== undefined) return;
    const next = rt.queuedConfigurationRequests.shift();
    if (next === undefined) return;
    activateConfigurationRequiredRequest(rt, next.request, next.target);
}

export function finishConfigurationPicker(rt: TuiRuntime): void {
    const subagents = currentModelAssignmentRows(rt).find((row) =>
        row.assignment === "subagents");
    respondToConfigurationRequired(rt, 
        (subagents?.declared.length ?? 0) > 0 || subagents?.allowSelf === true
            ? "configured"
            : "cancelled",
    );
}

export function syncConfigurationRequiredRequest(rt: TuiRuntime, 
    request: UiRequestUpdate | undefined,
    target: TuiAgentClient,
): void {
    if (
        request !== undefined
        && isConfigurationRequiredUiRequestUpdate(request)
    ) {
        openConfigurationRequiredRequest(rt, request, target);
        return;
    }
    if (
        rt.activeConfigurationRequest !== undefined
        && rt.activeConfigurationRequest.target === target
    ) {
        rt.activeConfigurationRequest = undefined;
        rt.settingsPicker = undefined;
        closeSettingsPickerSurface(rt);
        openNextConfigurationRequiredRequest(rt);
        return;
    }
    for (let index = rt.queuedConfigurationRequests.length - 1;
        index >= 0; index -= 1) {
        if (rt.queuedConfigurationRequests[index]?.target === target) {
            rt.queuedConfigurationRequests.splice(index, 1);
        }
    }
}

export function openSettingsMenuTarget(rt: TuiRuntime, 
    target: TuiSettingsMenuTarget,
    parent?: TuiSettingsPickerState,
): void {
    if (target === "model") {
        openSettingsDestination(rt, { kind: "model" }, { parent });
        return;
    }
    if (target === "reasoning") {
        openSettingsDestination(rt, { kind: "reasoning" }, { parent });
        return;
    }
    if (target === "theme") return openThemePicker(rt, parent);
    if (target === "context_limit") {
        rt.settingsPicker = withTuiPickerParent(
            startTuiContextLimitPicker(rt.state.modelSettings?.contextLimit),
            parent,
        );
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (target === "developer") {
        rt.settingsPicker = withTuiPickerParent(
            startTuiDeveloperMenu(rt.state.modelSettings?.developer),
            parent,
        );
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (target.startsWith("developer_")) {
        const pane = startTuiDeveloperValuePicker(
            target,
            rt.state.modelSettings?.developer,
        );
        if (pane !== undefined) {
            rt.settingsPicker = withTuiPickerParent(pane, parent);
            renderState(rt);
            focusActiveSurface(rt);
            return;
        }
    }
    if (target === "permission_mode") {
        openSettingsDestination(rt, { kind: "permission_mode" }, { parent });
        return;
    }
    if (target === "granted_permissions") return openPreferencesList(rt, parent);
    if (target === "reviewer") return openReviewerMenu(rt, parent);
    if (target === "reviewer_primary") {
        return openReviewerPicker(rt, "primary", parent);
    }
    if (target === "reviewer_fallback") {
        return openReviewerPicker(rt, "fallback", parent);
    }
    rt.settingsPicker = withTuiPickerParent(
        startTuiSettingsMenu("permission_settings"),
        parent,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function runPaletteAction(rt: TuiRuntime, entry: TuiPaletteEntry): void {
    if (
        entry.action.type === "prefill_composer"
        || entry.slashName === undefined
    ) {
        rt.composer.clearComposer();
        runStandalonePaletteAction(rt, entry.action);
        return;
    }
    rt.composer.setComposerText(`/${entry.slashName}`);
    renderState(rt);
    submitPrompt(rt);
}

export function runStandalonePaletteAction(rt: TuiRuntime, action: TuiCommandAction): void {
    if (action.type === "resume_viewed_session") return resumeJsonlView(rt);
    if (action.type === "prefill_composer") {
        rt.composer.setComposerText(action.text);
        renderCommandSuggestions(rt);
        renderState(rt);
        rt.composer.focus();
        return;
    }
    if (action.type === "open_settings_destination") {
        openSettingsDestination(rt, action.destination);
        return;
    }
    if (action.type === "open_work_tab") return openWorkTab(rt);
    if (action.type === "go_back") return runBack(rt);
    if (action.type === "open_search") return openSearchOverlay(rt, "workspace");
    if (action.type === "open_theme_picker") return openThemePicker(rt);
    if (action.type === "open_preferences_list") {
        return openPreferencesList(rt);
    }
    if (action.type === "open_help") return openHelp(rt, action.tab);
    renderState(rt);
    focusActiveSurface(rt);
}

export function runBack(rt: TuiRuntime): void {
    if (rt.backOriginId === undefined) {
        rt.state = appendTuiNotice(
            rt.state,
            "Nothing to go back to. /work lists what needs you.",
        );
        renderState(rt);
        return;
    }
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiError(rt.state, "Switching sessions is unavailable");
        renderState(rt);
        return;
    }
    const target = rt.backOriginId;
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown) return;
        const origin = agents.find((agent) => agent.id === target);
        if (origin === undefined) {
            rt.backOriginId = undefined;
            rt.state = appendTuiNotice(
                rt.state,
                "The conversation you came from is gone."
                    + " /resume lists what is still here.",
            );
            renderState(rt);
            return;
        }
        beginSessionResume(rt, 
            origin.session_path,
            origin.id,
            true,
            true,
            "keep_running",
        );
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.state = appendTuiError(
            rt.state,
            `Could not go back: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function jumpMenuContentWidth(rt: TuiRuntime): number {
    return Math.max(10, rt.jumpMenuBox.width - 4);
}

export function closeJumpMenu(rt: TuiRuntime): void {
    rt.jumpMenu = undefined;
    rt.jumpMenuBox.visible = false;
    rt.composer.focus();
    rt.renderer.requestRender();
}

export function renderJumpMenu(rt: TuiRuntime): void {
    if (rt.jumpMenu === undefined) {
        rt.jumpMenuBox.visible = false;
        rt.renderer.requestRender();
        return;
    }
    const widest = rt.jumpMenu.rows.reduce(
        (columns, row) =>
            Math.max(
                columns,
                row.label.length + (row.detail?.length ?? 0) + 8,
            ),
        24,
    );
    const boxWidth = Math.min(widest, Math.max(24, rt.renderer.width - 8));
    rt.jumpMenuBox.width = boxWidth;
    const lines = jumpMenuLines(rt.jumpMenu, Math.max(10, boxWidth - 4));
    rt.jumpMenuBox.height = lines.length + 2;
    rt.jumpMenuText.content = new StyledText(lines.flatMap((line, index) => [
        line.role === "header"
            ? fg(TUI_MUTED)(line.text)
            : fg(line.selected === true ? TUI_ACCENT : TUI_TEXT)(
                line.text,
            ),
        ...(index === lines.length - 1 ? [] : [fg(TUI_TEXT)("\n")]),
    ]));
    positionCommandSuggestions(rt);
    rt.jumpMenuBox.visible = true;
    rt.renderer.requestRender();
}

export function runJumpTo(rt: TuiRuntime, row: JumpRow): void {
    rt.jumpMenu = undefined;
    rt.jumpMenuBox.visible = false;
    beginSessionResume(rt, 
        row.sessionPath,
        row.sessionId,
        row.kind === "back",
        true,
        "keep_running",
    );
}

export function openJumpMenuOverlay(rt: TuiRuntime): void {
    if (rt.jumpMenu !== undefined || anyOverlayOpen(rt)) return;
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiNotice(
            rt.state,
            "Jumping between conversations is unavailable on this host",
        );
        renderState(rt);
        return;
    }
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown || anyOverlayOpen(rt)) return;
        const currentId = rt.client.agentId;
        const originAgent = agents.find((agent) =>
            agent.id === rt.backOriginId
        );
        const back: JumpOrigin | undefined = originAgent === undefined
            ? undefined
            : {
                sessionId: originAgent.id,
                sessionPath: originAgent.session_path,
                title: originAgent.title ?? originAgent.name
                    ?? "previous conversation",
            };
        const needsYou = (rt.workIndex?.rows ?? []).filter((row) =>
            row.section === "needs_you"
        );
        rt.jumpMenu = openJumpMenuState(buildJumpRows({
            currentId,
            back,
            needsYou,
            agents,
        }));
        if (rt.jumpMenu === undefined) {
            rt.state = appendTuiNotice(
                rt.state,
                "Nowhere to jump: nothing needs you and this conversation"
                    + " has no parent or children",
            );
            renderState(rt);
            return;
        }
        renderJumpMenu(rt);
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.state = appendTuiError(
            rt.state,
            `Could not build the jump menu: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function openWorkTab(rt: TuiRuntime): void {
    if (rt.workIndex === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "This host does not report work; reconnect to see the inbox",
        );
        renderState(rt);
        rt.composer.focus();
        return;
    }
    rt.workTab = startWorkTab(rt.workIndex);
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function focusWorkspaceSidebar(rt: TuiRuntime): void {
    if (rt.workspaceSidebar === undefined || rt.workspaceSidebarFocused) return;
    rt.workspaceSidebarFocused = true;
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openWorkspaceSidebar(rt: TuiRuntime, 
    options: { readonly focus?: boolean; readonly persist?: boolean } = {},
): void {
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "This host does not list sessions; reconnect to switch",
        );
        renderState(rt);
        rt.composer.focus();
        return;
    }
    const generation = rt.clientGeneration;
    const focus = options.focus !== false;
    if (options.persist !== false) {
        rt.workspaceSidebarDocked = true;
        try {
            saveTuiWorkspaceSidebarDocked(true);
        } catch {
            // A preference write cannot stop the rail opening now.
        }
    }
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown || generation !== rt.clientGeneration) return;
        const sessions = workspaceSidebarSessions(agents);
        const opened = startWorkspaceSidebar(
            sessions,
            rt.workspacePinnedIds,
            rt.client.agentId,
        );
        rt.workspaceSidebar = rt.workIndex === undefined
            ? opened
            : applyWorkspaceWorkIndex(opened, rt.workIndex);
        rt.workspaceSidebarFocused = focus;
        if (focus) rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.state = appendTuiError(
            rt.state,
            `Could not list sessions: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function cycleLiveSession(rt: TuiRuntime, direction: 1 | -1): void {
    const openFrom = (listed: WorkspaceSidebarState): void => {
        const target = workspaceCycleTarget(
            listed,
            direction,
            new Date(),
            rt.renderer.width,
        );
        if (target === undefined) return;
        const action = openWorkspaceSelection(listed, target.id);
        if (action !== undefined) {
            runWorkspaceSidebarAction(rt, action, false);
        }
    };
    if (rt.workspaceSidebar !== undefined) {
        openFrom(rt.workspaceSidebar);
        return;
    }
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "This host does not list sessions; reconnect to switch",
        );
        renderState(rt);
        return;
    }
    const generation = rt.clientGeneration;
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown || generation !== rt.clientGeneration) return;
        const sessions = workspaceSidebarSessions(agents);
        const opened = startWorkspaceSidebar(
            sessions,
            rt.workspacePinnedIds,
            rt.client.agentId,
        );
        openFrom(
            rt.workIndex === undefined
                ? opened
                : applyWorkspaceWorkIndex(opened, rt.workIndex),
        );
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.state = appendTuiError(
            rt.state,
            `Could not list sessions: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function refreshWorkspaceSidebarRoster(rt: TuiRuntime): void {
    if (rt.dependencies.listAgents === undefined) return;
    const generation = rt.clientGeneration;
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown || generation !== rt.clientGeneration) return;
        const open = rt.workspaceSidebar;
        if (open === undefined) return;
        const listed = refreshWorkspaceSidebarSessions(
            open,
            workspaceSidebarSessions(agents),
        );
        rt.workspaceSidebar = rt.workIndex === undefined
            ? listed
            : applyWorkspaceWorkIndex(listed, rt.workIndex);
        renderState(rt);
    }).catch(() => {
        // Nothing to say: the rows already listed are still the best
        // answer, and the next push asks again.
    });
}

export function applyWorkspaceRail(rt: TuiRuntime): void {
    const columns = rt.workspaceSidebar === undefined
        ? undefined
        : workspaceRailColumns(rt.renderer.width, rt.workspaceRailPreferred);
    if (columns !== rt.workspaceRail) {
        rt.workspaceRail = columns;
        if (transcriptFollowsBottom(rt)) {
            rt.pendingTranscriptScrollRestore = { scrollTop: 0, atBottom: true };
        } else {
            captureTranscriptScrollAnchor(rt);
        }
        rt.workspaceSidebarView.setRail(columns);
    }
    const occupied = rt.workspaceSidebarView.railColumns() ?? 0;
    // Everything below is a function of the width the rail occupies and
    // the width of the terminal, and re-applying it repaints. Timed
    // refreshes call this on every tick, so the layout is only laid out
    // again when one of the two has moved.
    if (
        occupied === rt.workspaceRailLaidOut
        && rt.renderer.width === rt.workspaceRailLaidOutColumns
    ) return;
    rt.workspaceRailLaidOut = occupied;
    rt.workspaceRailLaidOutColumns = rt.renderer.width;
    // The navigator owns a full-height column like an editor sidebar.
    // Reserving that width on the app moves the transcript, composer,
    // status rows and dialogs together; nothing from the chat can run
    // underneath the dock.
    rt.app.paddingLeft = occupied;
    rt.workspaceSidebarView.surface.left = 0;
    // Global dialogs still hide the rail. Session-owned approval and
    // question cards stay in the chat column; renderState narrows their
    // scrim to that column after it knows which kind of overlay is open.
    rt.overlayScrim.left = 0;
    rt.overlayScrim.width = rt.renderer.width;
    rt.statusBand.left = occupied;
    rt.statusBand.width = Math.max(0, rt.renderer.width - occupied);
    // The card centres itself inside its surface, so the surface has to be
    // the space the rail leaves rather than the whole terminal.
    rt.homeView.surface.left = occupied;
    rt.homeView.surface.width = Math.max(1, rt.renderer.width - occupied);
    // The idle block breaks its prose to the chat's width, and its
    // height is part of what the composer slot occupies, so a change in
    // one has to reach the rows measured off the other.
    if (
        rt.resumeOverlay.setColumns(Math.max(1, rt.renderer.width - occupied))
    ) {
        setComposerMargin(rt, rt.composerMarginRows);
    }
    rt.commandSuggestionsBox.left = occupied;
    rt.jumpMenuBox.left = occupied
        + tuiComposerOverlayInset(rt.appearance).paddingLeft;
    rt.sidebar.body.paddingLeft = 0;
    rt.sidebar.refit();
}

export function resizeWorkspaceRailAt(rt: TuiRuntime, pointerColumn: number): void {
    if (rt.workspaceRail === undefined) return;
    const occupied = rt.workspaceSidebarView.railColumns();
    if (occupied === undefined) return;
    const inset = occupied - rt.workspaceRail;
    const next = clampWorkspaceRailColumns(
        pointerColumn + 1 - inset,
        rt.renderer.width,
    );
    if (next === undefined || next === rt.workspaceRail) return;
    rt.workspaceRailPreferred = next;
    renderState(rt);
}

export function closeWorkspaceSidebar(rt: TuiRuntime): void {
    rt.workspaceSidebar = undefined;
    rt.workspaceSidebarFocused = false;
    rt.workspaceSidebarDocked = false;
    rt.workspaceRailDragging = false;
    rt.workspaceSidebarView.box.borderColor = rt.theme.element;
    try {
        saveTuiWorkspaceSidebarDocked(false);
    } catch {
        // The current layout still closes when persistence cannot update.
    }
    rt.workspaceSidebarView.surface.visible = false;
    rt.composer.focus();
    renderState(rt);
    focusActiveSurface(rt);
}

export function runWorkspaceSidebarAction(rt: TuiRuntime, 
    action: WorkspaceSidebarAction,
    armsBack = true,
): void {
    if (action.kind === "close") {
        rt.workspaceSidebarFocused = false;
        rt.composer.focus();
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (action.kind === "hide") {
        closeWorkspaceSidebar(rt);
        return;
    }
    if (action.kind === "pin") {
        rt.workspacePinnedIds = action.pinnedIds;
        try {
            saveTuiPinnedSessionIds(action.pinnedIds);
        } catch {
            // A preference write cannot stop the list from reordering.
        }
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (action.kind === "new_session") {
        rt.workspaceSidebarFocused = false;
        rt.composer.focus();
        renderState(rt);
        beginCreateSession(rt, "keep_running");
        return;
    }
    if (action.kind === "resume_picker") {
        rt.workspaceSidebarFocused = false;
        openResumePicker(rt);
        return;
    }
    if (action.kind === "rename_session") {
        openNamePrompt(rt, 
            { kind: "session", sessionId: action.session_id },
            action.label,
            undefined,
            action.value,
        );
        return;
    }
    rt.workspaceSidebarFocused = false;
    rt.composer.focus();
    renderState(rt);
    // The rail is working-set chrome. Opening another row must not stop
    // live work on the session you left; `/resume` Enter still does.
    // Idle rows paint the file. A row that already has a worker attaches.
    beginSessionResume(rt, 
        action.session_path,
        action.session_id,
        false,
        armsBack,
        "keep_running",
        action.active ? "attach" : "jsonl",
    );
}

export function openResumePicker(rt: TuiRuntime): void {
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiError(rt.state, "Session listing is unavailable");
        renderState(rt);
        return;
    }
    const version = ++rt.resumeListVersion;
    const targetAgentId = focusedAgentClient(rt).agentId;
    // Neither home nor a session file has a worker to stop, so Enter is
    // not a switch away from anything: it opens the row and that is all.
    const nothingToLeave = isWorkerFreeClient(rt.client);
    rt.settingsPicker = startTuiSessionPicker(
        [],
        targetAgentId,
        true,
        new Date(),
        false,
        [],
        "stop",
        nothingToLeave,
    );
    focusActiveSurface(rt);
    renderState(rt);
    void rt.dependencies.listAgents().then((agents) => {
        if (
            rt.shuttingDown
            || version !== rt.resumeListVersion
            || rt.settingsPicker?.kind !== "session"
        ) {
            return;
        }
        rt.settingsPicker = startTuiSessionPicker(
            agents,
            targetAgentId,
            false,
            new Date(),
            false,
            rt.hostedPanePersistence.groups,
            "stop",
            nothingToLeave,
        );
        focusActiveSurface(rt);
        renderState(rt);
    }).catch((error) => {
        if (
            !rt.shuttingDown
            && version === rt.resumeListVersion
            && rt.settingsPicker?.kind === "session"
        ) {
            const message = error instanceof Error
                ? error.message
                : String(error);
            rt.state = appendTuiError(
                rt.state,
                `Could not list sessions: ${message}`,
            );
            rt.settingsPicker = undefined;
            focusActiveSurface(rt);
            renderState(rt);
        }
    });
}

export function closeWorkSurfaces(rt: TuiRuntime): void {
    rt.workTab = undefined;
    rt.searchOverlay = undefined;
    // The scan already running finishes and finds no overlay to fill; the
    // one waiting behind it never starts.
    rt.queuedSearch = undefined;
    rt.workTabView.surface.visible = false;
    rt.searchOverlayView.surface.visible = false;
    rt.composer.focus();
    renderState(rt);
    focusActiveSurface(rt);
}

export function runWorkTabAction(rt: TuiRuntime, 
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
        closeWorkSurfaces(rt);
        return;
    }
    const row = open.index.rows.find(
        (candidate) => candidate.session_id === action.session_id,
    );
    closeWorkSurfaces(rt);
    if (row !== undefined) {
        beginSessionResume(rt, row.session_path, row.session_id);
    }
}

export function runSearchOverlayAction(rt: TuiRuntime, 
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
        closeWorkSurfaces(rt);
        return;
    }
    if (action.kind === "open") {
        closeWorkSurfaces(rt);
        // Set before the switch, so the first paint of the session that
        // arrives is the one that scrolls.
        rt.pendingSearchTarget = action.entry_id === null
            ? undefined
            : { sessionId: action.session_id, entryId: action.entry_id };
        beginSessionResume(rt, action.session_path, action.session_id);
        return;
    }
    renderState(rt);
    focusActiveSurface(rt);
    if (rt.dependencies.searchSessions === undefined) {
        rt.searchOverlay = rt.searchOverlay === undefined
            ? undefined
            : applySearchFailure(
                rt.searchOverlay,
                action.query,
                "Searching past work is unavailable on this host",
            );
        renderState(rt);
        return;
    }
    beginSearch(rt, action.query);
}

export function beginSearch(rt: TuiRuntime, query: SessionSearchQuery): void {
    if (rt.searchInFlight) {
        rt.queuedSearch = query;
        return;
    }
    rt.searchInFlight = true;
    const finish = (): void => {
        rt.searchInFlight = false;
        const next = rt.queuedSearch;
        rt.queuedSearch = undefined;
        if (next !== undefined && !rt.shuttingDown
            && rt.searchOverlay !== undefined) {
            beginSearch(rt, next);
        }
    };
    void rt.dependencies.searchSessions!(query).then((results) => {
        if (!rt.shuttingDown && rt.searchOverlay !== undefined) {
            rt.searchOverlay = applySearchResults(
                rt.searchOverlay,
                query,
                results,
            );
            renderState(rt);
        }
    }, (error) => {
        if (!rt.shuttingDown && rt.searchOverlay !== undefined) {
            rt.searchOverlay = applySearchFailure(
                rt.searchOverlay,
                query,
                error instanceof Error ? error.message : String(error),
            );
            renderState(rt);
        }
    }).finally(finish);
}

export function openNamePrompt(rt: TuiRuntime, 
    target: TuiNamePromptTarget,
    label: string,
    parent: TuiSettingsPickerState | undefined,
    value?: string,
): void {
    rt.namePrompt = startTuiNamePrompt(target, label, parent, value);
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openSearchOverlay(rt: TuiRuntime, scope?: SearchScope): void {
    // The previous landing answered the previous question. Clearing it on
    // open, not on close, keeps the mark visible for as long as the reader
    // is still looking at what the last search found.
    clearSearchLanding(rt);
    const target = focusedAgentClient(rt);
    rt.searchOverlay = startSearchOverlay(target.workspace ?? process.cwd(), {
        ...(target.agentId === undefined
            ? {}
            : { sessionId: target.agentId }),
        ...(scope === undefined ? {} : { scope }),
    });
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openCommandPalette(rt: TuiRuntime): void {
    rt.commandPalette = startTuiCommandPalette(registeredPaletteEntries(rt));
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openHelp(rt: TuiRuntime, tab: "general" | "keys" = "general"): void {
    const nextHelp = startTuiHelp(coreHelpCommands(rt), rt.hostExtensionCommands);
    rt.help = tab === "general" ? nextHelp : { ...nextHelp, tab };
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function applySettingsPickerTransition(rt: TuiRuntime, 
    transition:
        | TuiSettingsPickerTransition
        | TuiExtensionPickerTransition,
): void {
    const extensionPickerWasOpen = rt.settingsPicker?.kind === "extension";
    // Captured before the reassignment below so a model selection that
    // needs to chain into a level pane can hand the model pane back to
    // Escape: `handleTuiSettingsPickerKey` returns no `state` on Enter,
    // so this is the only place that still has it.
    const previousPicker = rt.settingsPicker;
    const returningToModelPicker = rt.settingsPicker?.kind !== "model"
        && transition.state?.kind === "model";
    rt.settingsPicker = transition.state;
    if (
        extensionPickerWasOpen
        && transition.selection?.kind === "extension"
    ) {
        const pending = rt.pendingExtensionPicker;
        rt.pendingExtensionPicker = undefined;
        pending?.removeAbortListener();
        pending?.resolve({
            outcome: "selected",
            rowId: transition.selection.rowId,
            actionId: transition.selection.actionId,
        });
        rt.settingsPickerView.box.visible = false;
        focusActiveSurface(rt);
        renderState(rt);
        return;
    } else if (
        extensionPickerWasOpen
        && transition.state === undefined
        && transition.selection === undefined
    ) {
        const pending = rt.pendingExtensionPicker;
        rt.pendingExtensionPicker = undefined;
        pending?.removeAbortListener();
        pending?.resolve({ outcome: "cancelled" });
        rt.settingsPickerView.box.visible = false;
        focusActiveSurface(rt);
        renderState(rt);
        return;
    }
    if (
        rt.activeConfigurationRequest !== undefined
        && previousPicker?.kind === "model_assignment"
        && previousPicker.modelAssignment === "subagents"
        && transition.selection === undefined
        && (
            transition.state === undefined
            || transition.state === previousPicker.parent
        )
    ) {
        finishConfigurationPicker(rt);
        return;
    }
    if (
        "previewTheme" in transition
        && transition.previewTheme !== undefined
    ) {
        scheduleThemePreview(rt, transition.previewTheme);
    }
    if (
        "trashCandidate" in transition
        && transition.trashCandidate !== undefined
    ) {
        rt.sessionTrashCandidate = transition.trashCandidate;
    }
    if (
        "renameCandidate" in transition
        && transition.renameCandidate !== undefined
    ) {
        openNamePrompt(rt, 
            {
                kind: "session",
                sessionId: transition.renameCandidate.sessionId,
            },
            transition.renameCandidate.label,
            previousPicker?.kind === "extension"
                ? undefined
                : previousPicker,
            transition.renameCandidate.value,
        );
        return;
    }
    if (
        "requestOptions" in transition
        && transition.requestOptions !== undefined
        && previousPicker?.kind === "model"
    ) {
        openRequestOptionsEditor(rt, 
            transition.requestOptions,
            previousPicker,
        );
        return;
    }
    if ("openProviders" in transition && transition.openProviders === true) {
        // The model pane stays underneath: connecting a provider is a
        // detour on the way to picking a model, not a change of subject.
        // The pane it returns to is the one the transition left behind, not
        // the one the key arrived on: ⇥ onto Providers wraps the list back
        // to its first tab, and Escape has to land on that.
        openProviderPicker(rt, 
            rt.settingsPicker?.kind === "model"
                ? rt.settingsPicker
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
        forgetProvider(rt, 
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
        openProviderEditForm(rt, 
            transition.editProvider,
            previousPicker?.kind === "provider" ? previousPicker : undefined,
        );
        return;
    }
    if (
        "editEndpoint" in transition
        && transition.editEndpoint !== undefined
    ) {
        openProviderEndpointForm(rt, 
            transition.editEndpoint,
            previousPicker?.kind === "provider" ? previousPicker : undefined,
        );
        return;
    }
    if (
        "declareProvider" in transition
        && transition.declareProvider === true
    ) {
        rt.providerForm = startTuiProviderForm(
            previousPicker?.kind === "provider" ? previousPicker : undefined,
        );
        rt.settingsPicker = undefined;
        rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (
        "refreshCatalog" in transition
        && transition.refreshCatalog !== undefined
    ) {
        // The chord names a row, and a row names one provider, so it asks
        // that one. Choosing which providers to ask is what the More page
        // action is for.
        requestCatalogRefresh(rt, transition.refreshCatalog);
        return;
    }
    if (
        "refreshCatalogScope" in transition
        && transition.refreshCatalogScope === true
    ) {
        openCatalogRefreshScopePicker(rt);
        return;
    }
    if ("poolVerifySweep" in transition && transition.poolVerifySweep === true) {
        openPoolVerifyScopePicker(rt);
        return;
    }
    if ("poolVerify" in transition && transition.poolVerify !== undefined) {
        verifyModelInPicker(rt, 
            transition.poolVerify.provider,
            transition.poolVerify.model,
        );
        return;
    }
    if ("poolName" in transition && transition.poolName !== undefined) {
        openNamePrompt(rt, 
            {
                kind: "pool",
                provider: transition.poolName.provider,
                model: transition.poolName.model,
            },
            transition.poolName.label,
            previousPicker?.kind === "extension" ? undefined : previousPicker,
        );
        return;
    }
    if ("poolMove" in transition && transition.poolMove !== undefined) {
        // Same rule as the toggle: the pane is rebuilt from the snapshot
        // that comes back, not from a guess about where the row landed.
        const move = transition.poolMove;
        sendCommand(rt, {
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
        rt.poolChangeUndo = undefined;
        if (rt.settingsPicker?.kind === "model") {
            rt.settingsPicker = {
                ...rt.settingsPicker,
                canUndoPoolChange: false,
            };
        }
        if (toggle.action === "add") {
            const pickerSettings = modelSettingsForOpenPicker(rt, 
                rt.state.modelSettings,
            );
            if (
                isModelShortlisted(rt, 
                    pickerSettings,
                    toggle.provider,
                    toggle.model,
                )
            ) {
                if (rt.settingsPicker?.kind === "model") {
                    rt.settingsPicker = syncTuiModelPicker(
                        rt.settingsPicker,
                        {
                            ...(pickerSettings ?? {}),
                            actionOptions: modelPickerActionOptions(rt, 
                                pickerSettings,
                            ),
                        },
                    );
                }
                showStatusNotice(rt, 
                    `${toggle.provider}/${toggle.model} is already shortlisted`,
                );
                renderState(rt);
                return;
            }
            // The name prompt follows the verdict, not the keypress: a
            // model that never made it into the pool cannot be named.
            const requestId = requestPoolAdmission(rt, 
                toggle.provider,
                toggle.model,
            );
            rt.pendingPoolName = {
                requestId,
                provider: toggle.provider,
                model: toggle.model,
                label: `${toggle.provider}/${toggle.model}`,
            };
            rt.pendingPoolChanges.set(requestId, {
                action: "remove",
                provider: toggle.provider,
                model: toggle.model,
            });
            return;
        }
        const removed = rt.state.modelSettings?.pooled?.find((entry) =>
            entry.provider === toggle.provider
            && entry.model === toggle.model
        );
        const requestId = randomUUID();
        rt.pendingPoolChanges.set(requestId, {
            action: "add",
            provider: toggle.provider,
            model: toggle.model,
            ...(removed?.poolName === undefined
                ? {}
                : { poolName: removed.poolName }),
        });
        sendCommand(rt, {
            type: "pool_remove",
            requestId,
            provider: toggle.provider,
            model: toggle.model,
        });
    }
    if (
        "undoPoolChange" in transition
        && transition.undoPoolChange === true
        && rt.poolChangeUndo !== undefined
    ) {
        const undo = rt.poolChangeUndo;
        if (rt.settingsPicker?.kind === "model") {
            rt.settingsPicker = {
                ...rt.settingsPicker,
                canUndoPoolChange: false,
            };
        }
        if (undo.action === "remove") {
            const requestId = randomUUID();
            rt.pendingPoolUndos.set(requestId, {
                undo,
                completesOnSettings: true,
            });
            sendCommand(rt, {
                type: "pool_remove",
                requestId,
                provider: undo.provider,
                model: undo.model,
            });
        } else {
            const requestId = requestPoolAdmission(rt, 
                undo.provider,
                undo.model,
            );
            rt.pendingPoolUndos.set(requestId, {
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
        if (selection.kind === "configure") {
            closeSettingsPickerSurface(rt);
            renderState(rt);
            void openConfigureEditor(rt, selection.file);
            return;
        }
        if (selection.kind === "model") {
            // Choosing a model runs it and nothing else. The pool is the
            // user's own shortlist, so it is only ever written by the key
            // that says so.
            const chosenLevels = selection.reasoningEffort === undefined
                ? modelLevelFacts(rt, selection.provider, selection.model)
                : undefined;
            if (
                chosenLevels !== undefined
                && chosenLevels.levels.length > 0
                && previousPicker?.kind === "model"
            ) {
                // A model with levels opens the level pane instead of
                // closing: Enter there folds both choices into one patch.
                rt.settingsPicker = startTuiReasoningPicker(
                    chosenLevels.levels,
                    chosenLevels.defaultLevel,
                    rt.state.modelSettings?.reasoningEffort,
                    {
                        provider: selection.provider,
                        model: selection.model,
                        modelPaneState: previousPicker,
                    },
                );
                rt.composer.blur();
                rt.settingsPickerView.update(rt.settingsPicker);
                rt.settingsPickerView.focus();
                renderState(rt);
                return;
            }
            const chosen = selection.reasoningEffort === undefined
                ? `${selection.provider}/${selection.model}`
                : `${selection.provider}/${selection.model} (${selection.reasoningEffort})`;
            requestModelSettingsChange(rt, 
                {
                    provider: selection.provider,
                    model: selection.model,
                    ...(selection.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: selection.reasoningEffort }),
                },
                `model → ${chosen}`,
                `the model to ${chosen}`,
                rt.settingsPickerAgent,
            );
        } else if (selection.kind === "provider") {
            connectProvider(rt, 
                selection.providerId,
                previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker,
            );
            return;
        } else if (selection.kind === "reasoning") {
            requestModelSettingsChange(rt, 
                { reasoningEffort: selection.reasoningEffort },
                `reasoning → ${selection.reasoningEffort}`,
                `reasoning to ${selection.reasoningEffort}`,
                rt.settingsPickerAgent,
            );
        } else if (selection.kind === "permissions") {
            if (selection.mode === "full_access") {
                rt.confirmingFullAccess = true;
                rt.confirmingFullAccessAgent = rt.settingsPickerAgent;
            } else {
                requestPermissionsChange(rt, 
                    selection.mode,
                    rt.settingsPickerAgent,
                );
            }
        } else if (selection.kind === "theme") {
            rt.themeName = selection.theme;
            saveTuiThemePreference(rt.themeName);
            void applySelectedTheme(rt, rt.themeName, true);
        } else if (selection.kind === "context_limit") {
            const label = selection.limit === null
                ? "Auto"
                : formatContextLimit(rt, selection.limit);
            requestModelSettingsChange(rt, 
                { contextLimit: selection.limit },
                `context limit → ${label}`,
                `context limit to ${label}`,
                rt.settingsPickerAgent,
            );
        } else if (selection.kind === "developer") {
            requestModelSettingsChange(rt, 
                { developer: selection.patch },
                developerChangeLabel(selection.patch),
                developerChangeLabel(selection.patch),
                rt.settingsPickerAgent,
            );
        } else if (selection.kind === "menu") {
            // A menu row opens the next surface over this one, which stays
            // remembered as its parent so leaving comes back here.
            rt.settingsPicker = undefined;
            openSettingsMenuTarget(rt, 
                selection.target,
                previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker,
            );
            return;
        } else if (selection.kind === "reviewer") {
            const patch = reviewerPatchFor(rt, selection);
            if (patch === undefined) {
                showStatusNotice(rt, "Choose a primary classifier first");
            } else {
                requestModelSettingsChange(rt, 
                    { reviewer: patch },
                    `classifier → ${reviewerToast(rt, selection)}`,
                    `the ${selection.slot === "primary"
                        ? "classifier"
                        : "failsafe classifier"}`,
                    rt.settingsPickerAgent,
                );
            }
        } else if (selection.kind === "pool_verify_scope") {
            startPoolVerifySweep(rt, selection.onlyUnverified);
            return;
        } else if (selection.kind === "catalog_refresh_scope") {
            startCatalogRefreshSweep(rt, selection.providers);
            return;
        } else if (selection.kind === "model_assignment_browse") {
            // Keeping a model is what makes it available as a default, so
            // the row that says so lands on the collection it is kept in
            // rather than leaving the user to find it.
            openSettingsDestination(rt, { kind: "model_shortlist" });
            return;
        } else if (selection.kind === "model_assignment_open") {
            // The pane the row was chosen on, which Enter has already
            // cleared from `settingsPicker`: without it Escape closes the
            // card instead of stepping back to the list.
            openSettingsDestination(rt, 
                {
                    kind: "model_assignment",
                    assignment: selection.assignment,
                },
                {
                    parent: previousPicker?.kind === "extension"
                        ? undefined
                        : previousPicker,
                },
            );
            return;
        } else if (selection.kind === "model_assignment") {
            // A model with levels asks for one before the write, the same
            // chain the session's own model goes through: an assignment
            // that named a model but no level would run the provider's
            // default rather than the one the user meant.
            const assignedLevels = selection.model === undefined
                || selection.remove === true
                || selection.reasoningEffort !== undefined
                || selection.acceptDefaultReasoning === true
                ? undefined
                : modelLevelFacts(rt, selection.provider, selection.model);
            if (
                assignedLevels !== undefined
                && assignedLevels.levels.length > 0
                && previousPicker?.kind === "model_assignment"
            ) {
                rt.settingsPicker = startTuiReasoningPicker(
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
                rt.composer.blur();
                rt.settingsPickerView.update(rt.settingsPicker);
                rt.settingsPickerView.focus();
                renderState(rt);
                return;
            }
            const bindingError = bindModelAssignmentFromPicker(rt, selection);
            if (bindingError !== undefined) {
                // The request is still waiting and the setting did not
                // change, so keep the picker retryable and make the
                // terminal failure visible outside its card.
                rt.settingsPicker = previousPicker?.kind === "model_assignment"
                    ? { ...previousPicker, subtitle: bindingError }
                    : previousPicker;
                showStatusNotice(rt, bindingError);
                renderState(rt);
                focusActiveSurface(rt);
                return;
            }
            if (selection.assignment === "subagents") {
                const assignmentPane = previousPicker?.kind
                        === "model_assignment"
                    ? previousPicker
                    : previousPicker !== undefined
                            && "pendingModel" in previousPicker
                            && previousPicker.pendingModel?.modelPaneState.kind
                            === "model_assignment"
                    ? previousPicker.pendingModel.modelPaneState
                    : undefined;
                const selectedValue = selection.allowSelf !== undefined
                    ? MODEL_ASSIGNMENT_SELF_VALUE
                    : selection.clear === true
                    ? REVIEWER_CLEAR_VALUE
                    : selection.model === undefined
                    ? undefined
                    : `${selection.provider ?? ""}/${selection.model}`;
                openModelAssignmentPicker(rt, 
                    "subagents",
                    assignmentPane?.parent,
                    selectedValue,
                );
                return;
            }
        } else {
            // Picking a session from the list is where the person meant
            // to go, not a hop taken to answer something: there is no trip
            // to offer them back from.
            beginSessionResume(rt, 
                selection.sessionPath,
                selection.sessionId,
                false,
                false,
                selection.sourceDisposition,
                "attach",
            );
            return;
        }
        // Where the stack goes next is `tuiPickerAfterSelection`'s rule.
        // A confirmation overrides it: it is its own modal level, and the
        // menu would sit open behind it.
        rt.settingsPicker = rt.confirmingFullAccess
                || previousPicker?.kind === "extension"
            ? undefined
            : tuiPickerAfterSelection(selection, previousPicker);
    }
    if (rt.sessionTrashCandidate !== undefined) {
        rt.composer.blur();
        rt.sessionTrashConfirmView.update(rt.sessionTrashCandidate.label);
        rt.sessionTrashConfirmView.box.focus();
    } else if (rt.providerForgetCandidate !== undefined) {
        rt.composer.blur();
        rt.providerForgetConfirmView.update(rt.providerForgetCandidate.label);
        rt.providerForgetConfirmView.box.focus();
    } else if (rt.settingsPicker === undefined) {
        closeSettingsPickerSurface(rt);
    } else {
        rt.composer.blur();
        rt.settingsPickerView.update(rt.settingsPicker);
        rt.settingsPickerView.focus();
    }
    if (returningToModelPicker) {
        requestAgentSettings(rt, focusedAgentClient(rt));
    }
    renderState(rt);
}

export function closeSettingsPickerSurface(rt: TuiRuntime): void {
    rt.settingsPickerView.box.visible = false;
    rt.settingsPickerAgent = undefined;
    if (rt.pendingUiRequest === undefined) {
        rt.composer.focus();
    }
}

export function switchToClient(rt: TuiRuntime, 
    next: TuiAgentClient,
    draft?: TuiDraft,
    options: { readonly preserveSidebar?: boolean } = {},
): void {
    recordSessionSwitchOutcome(rt, "completed");
    const previous = rt.client;
    rt.clientGeneration += 1;
    rt.agentFailedThisAttachment = false;
    // The old session owned these calls; nothing will answer them now.
    for (const pending of [...rt.pendingOneshots.values()]) {
        pending.reject(new Error("The conversation changed"));
    }
    rejectPendingExtensionSettingsFor(rt, 
        previous,
        new Error("The conversation changed"),
    );
    rt.client = next;
    if (rt.workspaceSidebar !== undefined && next.agentId !== undefined) {
        rt.workspaceSidebar = {
            ...rt.workspaceSidebar,
            currentId: next.agentId,
            selectedId: next.agentId,
        };
        refreshWorkspaceSidebarRoster(rt);
    }
    if (next.agentId !== undefined) {
        rt.flightRecorder?.sessionEntered(next.agentId);
    }
    setTuiWorkspaceRoot(next.workspace ?? process.cwd());
    void previous.detach().catch(() => previous.close());

    // The sidebar and any mentions belonged to the conversation being
    // left, so the client takes them down and each extension is told to
    // let go of whatever else it was holding.
    if (options.preserveSidebar !== true) {
        const previousSidebarAgent = rt.hostedSidebar.release();
        if (previousSidebarAgent !== undefined) {
            rejectPendingExtensionSettingsFor(rt, 
                previousSidebarAgent.client,
                new Error("The conversation changed"),
            );
        }
        void previousSidebarAgent?.detach().catch(() =>
            previousSidebarAgent.close()
        );
        clearSidebarEntryNodes(rt);
        rt.sidebar.clear();
        rt.sidebar.setHeader(undefined);
        rt.sidebar.close();
        forgetPersistedAgentPane(rt, previous.agentId);
        rt.extensionMentions = [];
        rt.extensionAddressee = undefined;
    }
    rememberOpenPaneGroup(rt);
    rt.experimentalTuiHost.conversationChanged();
    rt.clientExtensionRegistry?.conversationChanged();

    rt.state = createTuiState();
    // A hop the notice never landed in is over; it must not surface in
    // whichever conversation rebuilds next.
    rt.pendingBackNotice = undefined;
    rt.pendingSessionSwitchNotice = undefined;
    if (next.agentId !== undefined) {
        try {
            rt.dependencies.onSessionEntered?.(next.agentId);
        } catch (error) {
            rt.state = appendTuiNotice(rt.state, recentSessionSaveFailure(error));
        }
    }
    rt.connectionFailed = false;
    rt.connectionFailure = undefined;
    rt.jsonlCommandMode = false;
    rt.abortRequested = false;
    rt.workingSince = undefined;
    rt.phaseSince = undefined;
    rt.pendingUiRequest = undefined;
    rt.queuedUiRequests.length = 0;
    rt.activeConfigurationRequest = undefined;
    rt.queuedConfigurationRequests.length = 0;
    rt.pendingImages = [];
    rt.submitAfterImageAttachment = false;
    rt.promptSubmitting = false;
    rt.pendingSessionRename = undefined;
    rt.sessionSwitchPending = false;
    rt.sessionTrashCandidate = undefined;
    rt.sessionTrashPending = false;
    rt.sessionCloseConfirm = false;
    rt.providerForgetCandidate = undefined;
    rt.timelinePicker = undefined;
    rt.settingsPicker = undefined;
    rt.secretPrompt = undefined;
    rt.namePrompt = undefined;
    rt.providerForm = undefined;
    rt.requestOptionsEditor = undefined;
    rt.preferencesList = undefined;
    rt.preferencesListParent = undefined;
    rt.standingNudges = undefined;
    rt.confirmingFullAccess = false;
    rt.admissionDialog = undefined;
    rt.admissionReturnPicker = undefined;
    rt.extensionCommandsGeneration += 1;
    rt.disposeHostExtensionCommands();
    rt.disposeHostExtensionCommands = () => {};
    rt.hostExtensionCommands = [];
    rt.skillCatalogRequestId = undefined;
    rt.disposeSkillCommands();
    rt.disposeSkillCommands = () => {};
    rt.pendingSkillInvocations.clear();
    rt.extensionCommandsLoading = next.listExtensionCommands !== undefined
        && next.failed !== true
        && next.viewOnly !== true;
    rt.skillCommandsLoading = supportsSkillCommands(rt, next);
    watchBackgroundAgents(rt, next);
    watchWorkIndex(rt, next);
    rt.sessionTitle = undefined;
    rt.mainHeaderVisible = true;
    rt.sidebarHeaderVisible = true;
    applyTerminalTitle(rt);
    refreshTerminalTitle(rt);
    clearTranscriptNodes(rt);

    rt.composer.clearComposer();
    if (draft !== undefined) {
        rt.composer.setComposerText(draft.text);
        rt.pendingImages = draft.attachmentIds.map((id) => ({
            requestId: randomUUID(),
            id,
        }));
    }
    rt.settingsPickerView.box.visible = false;
    focusActiveSurface(rt);
    renderCommandSuggestions(rt);
    renderState(rt);
    void receiveAgentUpdates(rt);
    if (next.failed !== true && next.viewOnly !== true) {
        void loadExtensionCommands(rt);
        requestSkillCommands(rt);
        requestSessionSettings(rt);
    }
}

export async function destinationIsLive(rt: TuiRuntime, 
    sessionPath: string,
    sessionId?: string,
): Promise<boolean> {
    if (rt.dependencies.listAgents === undefined) return false;
    try {
        const agents = await rt.dependencies.listAgents();
        const row = agents.find((agent) =>
            (sessionId !== undefined && agent.id === sessionId)
            || agent.session_path === sessionPath
        );
        return row?.live === true || row?.worker_pid !== undefined;
    } catch {
        return false;
    }
}

export async function openSwitchDestination(rt: TuiRuntime, 
    sessionPath: string,
    sessionId?: string,
    destinationOpen?: "jsonl" | "attach",
): Promise<TuiAgentClient> {
    const attach = destinationOpen === "attach"
        || (
            destinationOpen !== "jsonl"
            && await destinationIsLive(rt, sessionPath, sessionId)
        );
    if (attach) {
        return rt.dependencies.resumeSession!(sessionPath);
    }
    return await createJsonlViewClient(sessionPath);
}

export function requestCloseSession(rt: TuiRuntime): void {
    if (isWorkerFreeClient(rt.client) || rt.sessionSwitchPending) {
        return;
    }
    if (
        rt.state.working
        || rt.state.compactingSince !== undefined
        || rt.pendingUiRequest !== undefined
    ) {
        rt.sessionCloseConfirm = true;
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    beginParkToJsonl(rt);
}

export function beginParkToJsonl(rt: TuiRuntime): void {
    rt.sessionCloseConfirm = false;
    if (isWorkerFreeClient(rt.client) || rt.sessionSwitchPending) {
        return;
    }
    const sourceClient = rt.client;
    const sourceCompanions = rt.hostedSidebar.pane === undefined
        ? []
        : [rt.hostedSidebar.pane.client];
    const agentId = rt.client.agentId;
    if (agentId === undefined) {
        rt.state = appendTuiError(rt.state, "Current session ID is unavailable");
        renderState(rt);
        return;
    }
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "Stopping this conversation is unavailable",
        );
        renderState(rt);
        return;
    }
    const draft = currentDraft(rt);
    rt.sessionSwitchPending = true;
    rt.sessionSwitchActivity = "closing conversation…";
    renderState(rt);
    void withSessionSwitchDeadline(rt, 
        (async () => {
            const agents = await rt.dependencies.listAgents!();
            const listed = agents.find((agent) => agent.id === agentId);
            const sessionPath = listed?.session_path;
            if (sessionPath === undefined) {
                throw new Error("Current session file is unavailable");
            }
            const leaveResult = await leaveSwitchSource(rt, 
                sourceClient,
                "stop",
                sourceCompanions,
            );
            return {
                next: await createJsonlViewClient(sessionPath),
                leaveResult,
            };
        })(),
        (value) => discardSwitchTarget(rt, value.next),
    ).then(({ next, leaveResult }) => {
        if (rt.shuttingDown) {
            discardSwitchTarget(rt, next);
            return;
        }
        switchToClient(rt, next, draft);
        if (
            leaveResult.sourceOutcome === "detached"
            && leaveResult.remainingInteractiveClients > 0
        ) {
            rt.pendingSessionSwitchNotice =
                "This conversation is still running in another client";
        }
    }).catch((error) => {
        if (rt.shuttingDown) {
            return;
        }
        rt.sessionSwitchPending = false;
        const message = error instanceof Error
            ? error.message
            : String(error);
        rt.state = appendTuiError(
            rt.state,
            `Could not close this conversation: ${message}`,
        );
        focusActiveSurface(rt);
        renderState(rt);
    });
}

export function runHomeAction(rt: TuiRuntime, action: HomeAction): void {
    if (action.kind === "resume_picker") {
        openResumePicker(rt);
        return;
    }
    if (action.kind === "search") {
        openSearchOverlay(rt);
        return;
    }
    if (action.kind === "palette") {
        openCommandPalette(rt);
        return;
    }
    if (action.kind !== "type") {
        beginCreateSession(rt, "stop");
        return;
    }
    rt.homeTypedText = action.text;
    // Read when the new client lands, not now: whatever else was typed
    // in between has been appended to it by then.
    beginCreateSession(rt, "stop", () => ({
        text: rt.homeTypedText ?? "",
        attachmentIds: [],
    }));
}

export function returnToHome(rt: TuiRuntime): void {
    if (isHomeClient(rt.client) || rt.sessionSwitchPending) return;
    rt.homeTypedText = undefined;
    rt.homeSubmitPending = false;
    switchToClient(rt, createHomeClient(
        rt.client.workspace ?? process.cwd(),
        rt.homeClientOptions,
    ));
    void refreshHomeSessions(rt);
}

export async function refreshHomeSessions(rt: TuiRuntime): Promise<void> {
    if (rt.dependencies.listAgents === undefined) return;
    let agents: readonly RegisteredAgentSummary[];
    try {
        agents = await rt.dependencies.listAgents();
    } catch {
        // A listing this client could not read says nothing either way,
        // so the card keeps the answer it already had.
        return;
    }
    if (!isHomeClient(rt.client)) return;
    rt.homeState = createHomeState(
        agents.some((agent) => sessionPickerLists(agent)),
    );
    rt.homeView.update(rt.homeState);
    rt.renderer.requestRender();
}

export function resumeJsonlView(rt: TuiRuntime): void {
    if (!isJsonlViewClient(rt.client)) {
        return;
    }
    if (rt.dependencies.resumeSession === undefined) {
        rt.state = appendTuiError(rt.state, "Switching sessions is unavailable");
        renderState(rt);
        return;
    }
    if (rt.sessionSwitchPending) {
        return;
    }
    const sessionPath = rt.client.sessionPath;
    rt.sessionSwitchPending = true;
    rt.sessionSwitchActivity = "opening conversation…";
    renderState(rt);
    void withSessionSwitchDeadline(rt, 
        rt.dependencies.resumeSession(sessionPath),
        ((next: TuiAgentClient) => discardSwitchTarget(rt, next)),
    ).then((live) => {
        if (rt.shuttingDown) {
            discardSwitchTarget(rt, live);
            return;
        }
        switchToClient(rt, live, currentDraft(rt));
    }).catch((error) => {
        if (rt.shuttingDown) {
            return;
        }
        rt.sessionSwitchPending = false;
        const message = error instanceof Error
            ? error.message
            : String(error);
        rt.state = appendTuiError(
            rt.state,
            `Could not resume: ${message}`,
        );
        renderState(rt);
    });
}

export function beginCreateSession(rt: TuiRuntime, 
    sourceDisposition: TuiSessionLeaveDisposition = "stop",
    draft?: () => TuiDraft | undefined,
): void {
    rt.composer.clearComposer();
    const clearingSidebar = rt.sidebar.isFocused()
        && rt.hostedSidebar.pane !== undefined;
    const sourceClient = focusedAgentClient(rt);
    const sourceCompanions = clearingSidebar
        || rt.hostedSidebar.pane === undefined
        ? []
        : [rt.hostedSidebar.pane.client];
    // A blank peer has nothing useful to reset. Treating a second
    // clear as close makes it possible to get rid of an empty pane
    // without requiring a separate close command.
    const clearingBlankSidebar = clearingSidebar
        && !rt.sidebarEntryNodes.some((node) => node.visible);
    if (clearingBlankSidebar) {
        closeSidebarPane(rt);
        return;
    }
    if (
        clearingSidebar
            ? rt.dependencies.createAgent === undefined
            : rt.dependencies.createSession === undefined
    ) {
        rt.state = appendTuiError(
            rt.state,
            "Starting a new session is unavailable",
        );
        renderState(rt);
        return;
    }
    if (rt.sessionSwitchPending) {
        return;
    }
    const workspace = focusedAgentClient(rt).workspace;
    if (workspace === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "Current session workspace is unavailable",
        );
        renderState(rt);
        return;
    }
    rt.sessionSwitchPending = true;
    rt.sessionSwitchActivity = "starting new session…";
    rt.sessionSwitchStartedAt = performance.now();
    rt.sessionSwitchOperation = "clear";
    rt.sessionSwitchBufferedUpdates = [];
    rt.sessionSwitchClearingMain = !clearingSidebar;
    rt.flightRecorder?.record({
        type: "session_switch_started",
        operation: "clear",
        target: clearingSidebar ? "sidebar" : "main",
    });
    const previousState = clearingSidebar ? undefined : rt.state;
    if (!clearingSidebar) {
        rt.state = createTuiState();
        clearTranscriptNodes(rt);
        renderState(rt);
    } else {
        renderStatus(rt);
    }
    const nextSession = clearingSidebar
        ? rt.dependencies.createAgent!(
            workspace,
            rt.hostedSidebar.initialApprovalMode
                ?? focusedAgentState(rt).approvalMode,
            rt.hostedSidebar.attachmentLifetime,
        )
        : rt.dependencies.createSession!(workspace);
    void withSessionSwitchDeadline(rt, 
        nextSession,
        (next) => void discardCreatedSwitchTarget(rt, next),
    ).then(async (next) => {
        if (rt.shuttingDown) {
            void discardCreatedSwitchTarget(rt, next);
            return;
        }
        let leaveResult: TuiSessionLeaveResult;
        try {
            leaveResult = await leaveSwitchSource(rt, 
                sourceClient,
                sourceDisposition,
                sourceCompanions,
            );
        } catch (error) {
            await discardCreatedSwitchTarget(rt, next);
            throw error;
        }
        if (clearingSidebar) {
            await openExtensionAgent(rt, 
                rt.hostedSidebar.owner ?? "vera.tui.agent-attachments",
                requireIdentifiedClient(next),
                "sidebar",
                true,
                rt.hostedSidebar.mention,
                rt.hostedSidebar.attachmentLifetime,
                rt.hostedSidebar.initialApprovalMode,
            );
            recordSessionSwitchOutcome(rt, "completed");
            rt.sessionSwitchPending = false;
            return;
        }
        switchToClient(rt, next, draft?.());
        if (rt.homeSubmitPending) {
            rt.homeSubmitPending = false;
            submitPrompt(rt);
        }
        if (
            sourceDisposition === "stop"
            && leaveResult.sourceOutcome === "detached"
            && leaveResult.remainingInteractiveClients > 0
        ) {
            const notice =
                "The previous conversation is still running in another client";
            rt.pendingSessionSwitchNotice = notice;
        }
    }).catch((error) => {
        if (rt.shuttingDown) {
            return;
        }
        rt.sessionSwitchPending = false;
        rt.homeSubmitPending = false;
        rt.homeTypedText = undefined;
        if (previousState !== undefined) {
            rt.state = previousState;
            for (const update of rt.sessionSwitchBufferedUpdates) {
                rt.state = applyAgentUpdate(rt.state, update);
            }
            clearTranscriptNodes(rt);
        }
        rt.sessionSwitchBufferedUpdates = [];
        recordSessionSwitchOutcome(rt, "failed", error);
        const message = error instanceof Error
            ? error.message
            : String(error);
        rt.state = appendTuiError(
            rt.state,
            `Could not start a new session: ${message}`,
        );
        renderState(rt);
    });
}

export function beginSessionResume(rt: TuiRuntime, 
    sessionPath: string,
    sessionId?: string,
    viaBack = false,
    armsBack = true,
    sourceDisposition: TuiSessionLeaveDisposition = "stop",
    destinationOpen?: "jsonl" | "attach",
): void {
    const openingInSidebar = rt.sidebar.isFocused()
        && rt.hostedSidebar.pane !== undefined;
    const sourceClient = openingInSidebar
        ? rt.hostedSidebar.pane!.client
        : rt.client;
    const sourceCompanions = openingInSidebar
        || rt.hostedSidebar.pane === undefined
        ? []
        : [rt.hostedSidebar.pane.client];
    rt.settingsPicker = undefined;
    if (sessionId !== undefined && sessionId === rt.client.agentId) {
        // The row for the session already on screen. Tearing down that
        // session's own transcript to put it back is a worse answer to
        // "this one" than simply leaving.
        setSidebarFocused(rt, false);
        rt.settingsPickerView.box.visible = false;
        focusActiveSurface(rt);
        renderState(rt);
        return;
    }
    if (
        openingInSidebar
        && sessionId !== undefined
        && sessionId === rt.hostedSidebar.pane?.agentId
    ) {
        rt.settingsPickerView.box.visible = false;
        focusActiveSurface(rt);
        renderState(rt);
        return;
    }
    if (rt.dependencies.resumeSession === undefined) {
        rt.state = appendTuiError(rt.state, "Switching sessions is unavailable");
        rt.settingsPickerView.box.visible = false;
        focusActiveSurface(rt);
        renderState(rt);
        return;
    }
    if (rt.sessionSwitchPending) {
        return;
    }
    if (!openingInSidebar && rt.promptSubmitting) {
        rt.state = appendTuiNotice(
            rt.state,
            "Wait for the skill command to be accepted or rejected before switching conversations.",
        );
        rt.settingsPickerView.box.visible = false;
        focusActiveSurface(rt);
        renderState(rt);
        return;
    }
    // Only the first hop is remembered: /back always returns to where
    // the switching started, not to the previous stop. Going back clears
    // the edge instead of arming it, or back would turn into a toggle.
    const previousId = rt.client.agentId;
    let armedNow = false;
    if (
        !viaBack
        && armsBack
        && !openingInSidebar
        && rt.backOriginId === undefined
        && previousId !== undefined
    ) {
        rt.backOriginId = previousId;
        rt.backOriginTitle = rt.sessionTitle;
        armedNow = true;
    }
    const draft = currentDraft(rt);
    rt.sessionSwitchPending = true;
    rt.sessionSwitchActivity = "switching conversation…";
    rt.settingsPickerView.box.visible = false;
    renderState(rt);
    void withSessionSwitchDeadline(rt, 
        openSwitchDestination(rt, sessionPath, sessionId, destinationOpen),
        ((next: TuiAgentClient) => discardSwitchTarget(rt, next)),
    ).then(async (next) => {
        if (rt.shuttingDown) {
            discardSwitchTarget(rt, next);
            return;
        }
        let destination = next;
        let leaveResult: TuiSessionLeaveResult | undefined;
        try {
            leaveResult = await leaveSwitchSource(rt, 
                sourceClient,
                sourceDisposition,
                sourceCompanions,
            );
        } catch (error) {
            discardSwitchTarget(rt, next);
            throw error;
        }
        if (
            sourceDisposition === "stop"
            && !isJsonlViewClient(next)
        ) {
            // The selected row can be a child of the source. Hard close
            // correctly takes that whole tree down, including the target
            // attachment we opened first to validate the destination.
            // Resume once more after quiescence so a durable child becomes
            // the new root instead of putting a dead attachment on screen.
            if (leaveResult.sourceOutcome === "stopped") {
                discardSwitchTarget(rt, next);
                destination = await withSessionSwitchDeadline(rt, 
                    rt.dependencies.resumeSession!(sessionPath),
                    ((next: TuiAgentClient) => discardSwitchTarget(rt, next)),
                );
            }
        }
        if (openingInSidebar) {
            await openExtensionAgent(rt, 
                "vera.tui.agent-attachments",
                requireIdentifiedClient(destination),
                "sidebar",
                true,
                sessionId,
            );
            rt.sessionSwitchPending = false;
            return;
        }
        switchToClient(rt, destination, draft);
        if (
            sourceDisposition === "stop"
            && leaveResult?.sourceOutcome === "detached"
            && leaveResult.remainingInteractiveClients > 0
        ) {
            const notice =
                "The previous conversation is still running in another client";
            rt.pendingSessionSwitchNotice = notice;
        }
        const destId = rt.client.agentId;
        let destParentId: string | undefined;
        let destParentTitle: string | undefined;
        if (rt.dependencies.listAgents !== undefined && destId !== undefined) {
            try {
                const agents = await rt.dependencies.listAgents();
                const dest = agents.find((agent) => agent.id === destId);
                destParentId = dest?.parent_id;
                if (destParentId !== undefined) {
                    destParentTitle = agents.find(
                        (agent) => agent.id === destParentId,
                    )?.title;
                }
            } catch {
                // The switch already landed; a listing failure cannot
                // take it back.
            }
        }
        if (viaBack) {
            rt.backOriginId = undefined;
        }
        let noticeKind: "parent" | "back" | "none" = "none";
        if (destParentId !== undefined) {
            noticeKind = "parent";
            const notice =
                "Type /parent to return to the parent conversation";
            rt.state = appendTuiNotice(
                rt.state,
                destParentTitle === undefined
                    ? notice
                    : `Type /parent to return to "${destParentTitle}"`,
                "soft",
            );
            rt.pendingBackNotice = notice;
            renderState(rt);
        } else if (
            rt.backOriginId !== undefined
            && destId !== rt.backOriginId
        ) {
            noticeKind = "back";
            // The way back, said where the person landed: the switch is
            // easy to make by accident from the work tab, and nothing
            // else on screen names the return trip.
            const notice =
                "Type /back to return to the conversation you came from";
            let originTitle = rt.backOriginTitle;
            if (
                originTitle === undefined
                && rt.dependencies.listAgents !== undefined
            ) {
                originTitle = await rt.dependencies.listAgents().then(
                    (agents) =>
                        agents.find((agent) =>
                            agent.id === rt.backOriginId
                        )?.title,
                ).catch(() => undefined);
            }
            rt.state = appendTuiNotice(
                rt.state,
                originTitle === undefined
                    ? notice
                    : `Type /back to return to "${originTitle}"`,
                "soft",
            );
            rt.pendingBackNotice = notice;
            renderState(rt);
        } else if (destId === rt.backOriginId) {
            rt.backOriginId = undefined;
        }
    }).catch((error) => {
        if (rt.shuttingDown) return;
        // A switch that never happened is not a hop worth remembering.
        if (armedNow) rt.backOriginId = undefined;
        rt.sessionSwitchPending = false;
        rt.state = appendTuiError(
            rt.state,
            `Could not switch conversation: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        focusActiveSurface(rt);
        renderState(rt);
    });
}

export function currentDraft(rt: TuiRuntime): TuiDraft | undefined {
    const text = rt.composer.plainText;
    const attachmentIds = rt.pendingImages
        .map((image) => image.id)
        .filter((id): id is string => id !== undefined);
    return text.length === 0 && attachmentIds.length === 0
        ? undefined
        : { text, attachmentIds };
}

export function beginSessionTrash(rt: TuiRuntime, candidate: {
    readonly sessionId: string;
    readonly label: string;
}): void {
    if (rt.dependencies.trashSession === undefined) {
        rt.sessionTrashCandidate = undefined;
        rt.state = appendTuiError(
            rt.state,
            "Moving conversations to Trash is unavailable",
        );
        renderState(rt);
        return;
    }
    rt.sessionTrashPending = true;
    rt.sessionSwitchPending = true;
    rt.sessionSwitchActivity = "moving conversation to Trash…";
    renderState(rt);
    void performSessionTrash(rt, candidate);
}

export async function performSessionTrash(rt: TuiRuntime, candidate: {
    readonly sessionId: string;
    readonly label: string;
}): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            rt.dependencies.trashSession!(candidate.sessionId),
            new Promise<TrashSessionResult>((resolve) => {
                timeout = setTimeout(() => {
                    resolve({ status: "rejected", reason: "failed" });
                }, rt.dependencies.sessionSwitchTimeoutMs
                    ?? SESSION_SWITCH_TIMEOUT_MS);
            }),
        ]);
        clearTimeout(timeout);
        if (rt.shuttingDown) return;
        if (result.status === "trashed") {
            rt.state = appendTuiNotice(
                rt.state,
                `moved to Trash: ${candidate.label}`,
            );
            if (rt.dependencies.listAgents !== undefined) {
                try {
                    rt.settingsPicker = startTuiSessionPicker(
                        await rt.dependencies.listAgents(),
                        rt.client.agentId,
                        false,
                        new Date(),
                        false,
                        rt.hostedPanePersistence.groups,
                    );
                } catch {
                    rt.settingsPicker = removeSessionPickerOption(
                        rt.settingsPicker?.kind === "extension"
                            ? undefined
                            : rt.settingsPicker,
                        candidate.sessionId,
                    );
                }
            }
        } else {
            rt.state = appendTuiError(
                rt.state,
                result.reason === "busy"
                    ? "That conversation is active in another client"
                    : result.reason === "not_found"
                    ? "That conversation is no longer available"
                    : "Could not move that conversation to Trash",
            );
        }
    } catch {
        clearTimeout(timeout);
        if (rt.shuttingDown) return;
        rt.sessionTrashPending = false;
        rt.sessionSwitchPending = false;
        rt.sessionTrashCandidate = undefined;
        rt.state = appendTuiError(
            rt.state,
            "Could not move that conversation to Trash",
        );
        }
        rt.sessionTrashPending = false;
        rt.sessionSwitchPending = false;
        rt.sessionTrashCandidate = undefined;
    focusActiveSurface(rt);
    renderState(rt);
}

export function requestModelSettingsChange(rt: TuiRuntime, 
    patch: ModelSettingsPatch,
    toast: string,
    subject: string,
    target: TuiAgentClient = focusedAgentClient(rt),
): void {
    const requestId = randomUUID();
    rt.requestedModelChanges.set(requestId, { subject, patch, target });
    void target.send({
        type: "update_model_settings",
        requestId,
        patch,
    }).catch(((error: unknown) => reportConnectionError(rt, error)));
    showStatusNotice(rt, toast);
}

export function formatContextLimit(rt: TuiRuntime, tokens: number): string {
    return tokens % 1_048_576 === 0
        ? `${tokens / 1_048_576}m`
        : `${Math.round(tokens / 1_024)}k`;
}

export function retryPoolAdmission(rt: TuiRuntime, 
    requestId: string,
    verdict: string,
): boolean {
    const attempt = rt.poolAdmissionAttempts.get(requestId);
    rt.poolAdmissionAttempts.delete(requestId);
    if (
        attempt === undefined || attempt.retry || verdict !== "unavailable"
    ) {
        return false;
    }
    rt.state = dropTuiAdmission(rt.state, requestId);
    const retryId = requestPoolAdmission(rt, 
        attempt.provider,
        attempt.model,
        attempt.verify,
        true,
    );
    if (rt.poolVerifySweep?.requestId === requestId) {
        // A retry is the same step of the sweep under a new id. Without
        // this the sweep waits on a verdict that will never carry the id
        // it is watching for, and stops on the first unreachable model.
        rt.poolVerifySweep = { ...rt.poolVerifySweep, requestId: retryId };
    }
    const poolChange = rt.pendingPoolChanges.get(requestId);
    rt.pendingPoolChanges.delete(requestId);
    if (poolChange !== undefined) {
        rt.pendingPoolChanges.set(retryId, poolChange);
    }
    const pendingUndo = rt.pendingPoolUndos.get(requestId);
    rt.pendingPoolUndos.delete(requestId);
    if (pendingUndo !== undefined) {
        rt.pendingPoolUndos.set(retryId, pendingUndo);
    }
    if (rt.admissionDialog?.requestId === requestId) {
        rt.admissionDialog = startTuiAdmissionDialog(
            attempt.provider,
            attempt.model,
            retryId,
        );
    }
    if (rt.pendingPoolName?.requestId === requestId) {
        rt.pendingPoolName = { ...rt.pendingPoolName, requestId: retryId };
    }
    return true;
}

export function requestCatalogRefresh(rt: TuiRuntime, provider: string): void {
    const requestId = randomUUID();
    rt.catalogRefreshes.set(requestId, provider);
    showStatusNotice(rt, `asking ${provider} for its model list…`);
    sendCommand(rt, { type: "catalog_refresh", requestId, provider });
    renderState(rt);
}

export function requestPoolAdmission(rt: TuiRuntime, 
    provider: string,
    model: string,
    verify = false,
    retry = false,
): string {
    const requestId = randomUUID();
    rt.poolAdmissionAttempts.set(requestId, { provider, model, verify, retry });
    rt.state = beginTuiAdmission(rt.state, requestId, `${provider}/${model}`);
    showVerificationConsole(rt, requestId, `${provider}/${model}`);
    sendCommand(rt, {
        type: "pool_add",
        requestId,
        provider,
        model,
        ...(verify ? { verify: true } : {}),
    });
    renderState(rt);
    return requestId;
}

export function dialogAdmission(rt: TuiRuntime) {
    return rt.state.admission !== undefined
            && rt.state.admission.requestId === rt.admissionDialog?.requestId
        ? rt.state.admission
        : undefined;
}

export function keptModels(rt: TuiRuntime): readonly {
    readonly provider: string;
    readonly model: string;
    readonly verified: boolean;
}[] {
    return (focusedAgentState(rt).modelSettings?.pooled ?? []).map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        verified: entry.verified === true,
    }));
}

export function openCatalogRefreshScopePicker(rt: TuiRuntime): void {
    const targetState = rt.state;
    const providers = refreshableProvidersOf(rt, 
        targetState.modelSettings?.availableModels,
        targetState.modelSettings?.refreshableProviders,
    );
    if (providers.length === 0) {
        showStatusNotice(rt, "no provider here keeps a model list to refresh");
        return;
    }
    rt.settingsPicker = withTuiPickerParent(
        startTuiCatalogRefreshScopePicker(
            providers.map((name) => ({
                name,
                models: catalogSizeOf(rt, name),
            })),
        ),
        rt.settingsPicker?.kind === "model" ? rt.settingsPicker : undefined,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function startCatalogRefreshSweep(rt: TuiRuntime, providers: readonly string[]): void {
    const queue = providers.length > 0
        ? providers
        : refreshableProvidersOf(rt, 
            rt.state.modelSettings?.availableModels,
            rt.state.modelSettings?.refreshableProviders,
        );
    rt.settingsPicker = undefined;
    rt.composer.blur();
    if (rt.catalogRefreshSweep !== undefined) {
        // Two sweeps at once cannot both be reported: the second would
        // claim the first one's answers as its own.
        showStatusNotice(rt, "a refresh is already running");
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (queue.length === 0) {
        showStatusNotice(rt, "no provider here keeps a model list to refresh");
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    rt.catalogRefreshSweep = { queue, index: 0, results: [] };
    renderState(rt);
    focusActiveSurface(rt);
    advanceCatalogRefreshSweep(rt);
}

export function advanceCatalogRefreshSweep(rt: TuiRuntime): void {
    const sweep = rt.catalogRefreshSweep;
    if (sweep === undefined) return;
    const next = sweep.queue[sweep.index];
    if (next === undefined) {
        rt.catalogRefreshSweep = undefined;
        showStatusNotice(rt, catalogRefreshSummary(rt, sweep.results));
        renderState(rt);
        return;
    }
    sweep.results.push({ provider: next, before: catalogSizeOf(rt, next) });
    showStatusNotice(rt, 
        `asking ${next} (${sweep.index + 1}/${sweep.queue.length})\u2026`,
    );
    const requestId = randomUUID();
    sweep.requestId = requestId;
    sendCommand(rt, { type: "catalog_refresh", requestId, provider: next });
    renderState(rt);
}

export function catalogRefreshSweepResult(rt: TuiRuntime, 
    requestId: string,
    refreshed: boolean,
): boolean {
    const sweep = rt.catalogRefreshSweep;
    if (sweep === undefined || sweep.requestId !== requestId) return false;
    const result = sweep.results.at(-1);
    if (result !== undefined && refreshed) {
        result.after = catalogSizeOf(rt, result.provider);
    }
    sweep.index += 1;
    advanceCatalogRefreshSweep(rt);
    return true;
}

export function catalogRefreshSummary(rt: TuiRuntime, 
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

export function openPoolVerifyScopePicker(rt: TuiRuntime): void {
    const kept = keptModels(rt);
    if (kept.length === 0) {
        showStatusNotice(rt, "nothing kept to probe yet");
        return;
    }
    rt.settingsPicker = withTuiPickerParent(
        startTuiPoolVerifyScopePicker(
            kept.filter((entry) => !entry.verified).length,
            kept.length,
        ),
        rt.settingsPicker?.kind === "model" ? rt.settingsPicker : undefined,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function startPoolVerifySweep(rt: TuiRuntime, onlyUnverified: boolean): void {
    const queue = keptModels(rt)
        .filter((entry) => !onlyUnverified || !entry.verified)
        .map((entry) => ({ provider: entry.provider, model: entry.model }));
    rt.settingsPicker = undefined;
    rt.composer.blur();
    if (queue.length === 0) {
        showStatusNotice(rt, "everything you keep has been probed");
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    rt.poolVerifySweep = { queue, total: queue.length, index: 0, answered: 0 };
    renderState(rt);
    focusActiveSurface(rt);
    advancePoolVerifySweep(rt);
}

export function advancePoolVerifySweep(rt: TuiRuntime): void {
    const sweep = rt.poolVerifySweep;
    if (sweep === undefined) return;
    const next = sweep.queue[sweep.index];
    if (next === undefined) {
        rt.poolVerifySweep = undefined;
        showStatusNotice(rt, 
            `probed ${sweep.total}, ${sweep.answered} answered`,
        );
        renderState(rt);
        return;
    }
    showStatusNotice(rt, 
        `probing ${next.provider}/${next.model} (${sweep.index + 1}/${sweep.total})`,
    );
    sweep.requestId = requestPoolAdmission(rt, next.provider, next.model, true);
}

export function poolVerifySweepResult(rt: TuiRuntime, requestId: string, verdict: string): boolean {
    const sweep = rt.poolVerifySweep;
    if (sweep === undefined || sweep.requestId !== requestId) return false;
    if (verdict === "added") sweep.answered += 1;
    sweep.index += 1;
    advancePoolVerifySweep(rt);
    return true;
}

export function verifyModelInPicker(rt: TuiRuntime, provider: string, model: string): void {
    // Keep the model pane in place: its full-width console is the live
    // verification surface, including for a model being checked again.
    requestPoolAdmission(rt, provider, model, true);
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function closeAdmissionDialog(rt: TuiRuntime, reopenPoolPicker: boolean): void {
    const returnPicker = rt.admissionReturnPicker;
    rt.admissionDialog = undefined;
    rt.admissionReturnPicker = undefined;
    if (reopenPoolPicker && returnPicker !== undefined) {
        // Rebuilt rather than restored: the pool changed under the saved
        // pane, and a fresh open lands on the Pool tab, where the newly
        // admitted row is.
        openModelPicker(rt, returnPicker.parent);
        return;
    }
    rt.settingsPicker = returnPicker;
    focusActiveSurface(rt);
    renderState(rt);
}

export function requestPermissionsChange(rt: TuiRuntime, 
    mode: string,
    target: TuiAgentClient = focusedAgentClient(rt),
    scope: "session" | "global" = "global",
): void {
    const requestId = randomUUID();
    rt.requestedPermissionChanges.set(requestId, `permissions to ${mode}`);
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
    }).catch(((error: unknown) => reportConnectionError(rt, error)));
    showStatusNotice(rt, 
        `permissions → ${mode}${sessionScoped ? "" : " (default too)"}`,
    );
}

export async function applySelectedTheme(rt: TuiRuntime, 
    selectedTheme: typeof rt.themeName,
    announce: boolean,
): Promise<void> {
    if (announce && rt.pendingThemePreview !== undefined) {
        clearTimeout(rt.pendingThemePreview);
        rt.pendingThemePreview = undefined;
    }
    const version = ++rt.themeApplicationVersion;
    const resolvedTheme = await resolveTuiTheme(rt.renderer, selectedTheme);
    if (version !== rt.themeApplicationVersion || rt.shuttingDown) {
        return;
    }
    rt.theme = resolvedTheme;
    applyTuiThemeBindings(rt.theme, rt.themeBindings);

    if (announce) {
        rt.state = appendTuiNotice(
            rt.state,
            `theme changed: ${selectedTheme}`,
            "soft",
            "theme",
        );
    }
    renderState(rt);
}

export function scheduleThemePreview(rt: TuiRuntime, selectedTheme: typeof rt.themeName): void {
    if (rt.pendingThemePreview !== undefined) {
        clearTimeout(rt.pendingThemePreview);
    }
    rt.pendingThemePreview = setTimeout(() => {
        rt.pendingThemePreview = undefined;
        void applySelectedTheme(rt, selectedTheme, false);
    }, 50);
}

export function pooledModelNames(rt: TuiRuntime): readonly string[] {
    const names: string[] = ["self"];
    for (const entry of rt.state.modelSettings?.pooled ?? []) {
        if (entry.poolName !== undefined) {
            names.push(entry.poolName);
        }
        names.push(entry.model);
    }
    return names;
}

export function activeCompletion(rt: TuiRuntime): {
    prefix: string;
    values: readonly string[];
} | undefined {
    const argument = rt.commandRegistry.argumentPrefix(rt.composer.plainText);
    if (argument !== undefined) {
        return {
            prefix: argument.prefix,
            // Bare names: the argument is the name itself, not a mention.
            values: argument.kind === "mention"
                ? visibleMentions(rt)
                : pooledModelNames(rt),
        };
    }
    const mentions = visibleMentions(rt);
    if (mentions.length === 0) return undefined;
    const mention = /(?:^|\s)(@\S*)$/.exec(rt.composer.plainText);
    if (mention === null) return undefined;
    return {
        prefix: mention[1] ?? "",
        values: mentions.map((name) => `@${name}`),
    };
}

export function renderCommandSuggestions(rt: TuiRuntime): void {
    const hint = tuiCommandArgumentHint(
        rt.commandRegistry.registeredCommands(),
        rt.composer.plainText,
    );
    rt.slashArgumentHint.content = hint ?? "";
    rt.slashArgumentHint.visible = hint !== undefined;
    rt.slashArgumentHint.left = hint === undefined
        ? 0
        : Bun.stringWidth(rt.composer.plainText);
    const extensionBottomRows = rt.experimentalTuiHost.bottomInsetRows();
    // Measured off the composer's own margin, which the status card below
    // it grows and shrinks: a fixed offset here lands inside the composer
    // as soon as that card is taller than the single line it replaced.
    // These transient lines sit above the composer in normal flow, so the
    // overlay clears whichever of them are currently visible instead of
    // painting over quote/address context.
    positionCommandSuggestions(rt);
    if (rt.composer.plainText.length === 0) {
        rt.commandSuggestionIndex = 0;
    }
    const completing = activeCompletion(rt);
    if (completing !== undefined) {
        rt.argumentSuggestions = tuiArgumentSuggestions(
            completing.values,
            completing.prefix,
        );
        rt.commandSuggestionIndex = Math.min(
            rt.commandSuggestionIndex,
            Math.max(0, rt.argumentSuggestions.length - 1),
        );
        const window = tuiSuggestionWindow(
            rt.argumentSuggestions.length,
            rt.commandSuggestionIndex,
            Math.max(
                3,
                rt.renderer.height - SUGGESTIONS_RESERVED_ROWS
                    - extensionBottomRows,
            ),
        );
        rt.commandSuggestionsText.content = renderTuiArgumentSuggestions(
            rt.argumentSuggestions.slice(
                window.start,
                window.start + window.rows,
            ),
            rt.commandSuggestionIndex - window.start,
        );
        rt.commandSuggestionsBox.height = Math.max(1, window.rows) + 1;
        rt.commandSuggestionsBox.visible = rt.argumentSuggestions.length > 0
            && overlaysClearOfSuggestions(rt);
        return;
    }
    rt.argumentSuggestions = [];
    const suggestions = availableCommandSuggestions(rt, rt.composer.plainText);
    if (rt.composer.plainText !== "/") {
        // A list that just opened has a first row, not a chosen one.
        rt.commandSuggestionMoved = false;
    }
    rt.commandSuggestionIndex = Math.min(
        rt.commandSuggestionIndex,
        Math.max(0, suggestions.length - 1),
    );
    const selected = rt.composer.plainText === "/"
        ? rt.commandSuggestionIndex
        : -1;
    // The transcript, the composer and the status rows all want the same
    // screen. What is left over is what the list may take, and it never
    // takes so much that its own bottom row is off the pane.
    // The unfiltered list is grouped by where each command came from; a
    // half-typed name is one flat run, where the group column would be
    // dead width and the gaps would separate nothing.
    const grouped = rt.composer.plainText === "/";
    // Less the box's own margin and padding, or the last word of a
    // just-too-long row wraps anyway. The renderer reports the whole
    // terminal even when the workspace rail has reserved its left side,
    // so the rail has to come out of the same budget.
    const suggestionWidth = tuiCommandSuggestionWidth(
        rt.renderer.width,
        rt.composerHorizontalInset,
        rt.workspaceSidebarView.railColumns() ?? 0,
    );
    // Below a rail-narrowed strip the group column and a description
    // cannot both fit beside the command names, so the list drops to a
    // bare "group heading, then one /command per line" style instead of
    // letting every row run past the strip.
    const compact = suggestionWidth < SLASH_COMPACT_WIDTH;
    const window = tuiSuggestionWindow(
        suggestions.length,
        selected,
        Math.max(
            3,
            rt.renderer.height - SUGGESTIONS_RESERVED_ROWS
                - extensionBottomRows
                - tuiSuggestionGaps(suggestions, grouped, compact),
        ),
    );
    const visible = suggestions.slice(
        window.start,
        window.start + window.rows,
    );
    rt.commandSuggestionsText.content = renderTuiCommandSuggestions(
        visible,
        selected < 0 ? -1 : selected - window.start,
        suggestionWidth,
        window.hidden,
        grouped,
        compact,
    );
    rt.commandSuggestionsBox.height = suggestions.length > 0
        ? window.rows + tuiSuggestionGaps(visible, grouped, compact)
            + (window.hidden > 0 ? 1 : 0) + 1
        : 1;
    const suggester = suggestions.length > 0
        ? undefined
        : activeComposeSuggester(rt);
    if (suggester !== undefined) {
        // One line, under the composer, from an extension the user chose
        // to install. Core never reads composer text; this does, and it
        // only exists because installing the extension said it could.
        rt.commandSuggestionsText.content = new StyledText([
            fg(TUI_MUTED)(
                `${suggester.hint} · enter switch to ${suggester.agent} · esc dismiss`,
            ),
        ]);
        rt.commandSuggestionsBox.height = 2;
        rt.commandSuggestionsBox.visible = overlaysClearOfSuggestions(rt);
        return;
    }
    rt.commandSuggestionsBox.visible = suggestions.length > 0
        && overlaysClearOfSuggestions(rt);
}

export function activeComposeSuggester(rt: TuiRuntime):
    | {
        readonly id: string;
        readonly source: string;
        readonly agent: string;
        readonly hint: string;
    }
    | undefined
{
    return findActiveComposeSuggester(
        rt.clientExtensionRegistry?.composeSuggesters() ?? [],
        rt.composer.plainText,
        focusedAgentState(rt).agent?.name ?? "default",
        rt.dismissedComposeSuggesters,
    );
}

export function overlaysClearOfSuggestions(rt: TuiRuntime): boolean {
    return focusedUiRequest(rt) === undefined
        && rt.timelinePicker === undefined
        && rt.settingsPicker === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined;
}

export function finishStreamingAssistant(rt: TuiRuntime): void {
    // Entries other than user prompts are wrapped in a gutter box, so the
    // markdown sits below the node held in entryNodes. Assigning the flag
    // rebuilds every block; a settled entry is left alone.
    const settle = (node: Renderable): void => {
        if (node instanceof MarkdownRenderable) {
            if (node.streaming) node.streaming = false;
            return;
        }
        const content = tuiGutterContent(node);
        if (content !== node) {
            settle(content);
            return;
        }
        for (const child of node.getChildren()) settle(child);
    };
    for (const node of rt.entryNodes) {
        if (node !== undefined) settle(node);
    }
}

export async function copyTranscriptSelection(rt: TuiRuntime, selection: Selection): Promise<void> {
    const text = selection.getSelectedText();
    if (text.length === 0) {
        return;
    }

    try {
        await rt.copyText(text);
        if (rt.shuttingDown) {
            return;
        }
        const count = countTuiCharacters(text);
        announceCopy(rt, `copied ${count} character${count === 1 ? "" : "s"}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        announceCopy(rt, `copy failed · ${message}`);
    }
}

export function announceCopy(rt: TuiRuntime, message: string): void {
    if (rt.experimentalTuiHost.showNotice(message)) return;
    showStatusNotice(rt, message);
}

export function showStatusNotice(rt: TuiRuntime, message: string): void {
    rt.statusNotice = message;
    rt.statusNoticeVersion += 1;
    const version = rt.statusNoticeVersion;
    renderStatus(rt);

    setTimeout(() => {
        if (rt.statusNoticeVersion !== version) {
            return;
        }
        rt.statusNotice = undefined;
        renderStatus(rt);
    }, COPY_NOTICE_DURATION_MS);
}

export function showModeToast(rt: TuiRuntime, message: string): void {
    rt.modeToastVersion += 1;
    const version = rt.modeToastVersion;
    rt.modeToastText.content = message;
    rt.modeToast.width = message.length + 4;
    // Above the overlay when one is open, so the toast is not painted
    // behind the card that prompted it.
    rt.modeToast.visible = true;
    setTimeout(() => {
        if (rt.modeToastVersion !== version) return;
        rt.modeToast.visible = false;
    }, MODE_TOAST_DURATION_MS);
}

export function showVerificationConsole(rt: TuiRuntime, 
    requestId: string,
    subject: string,
): void {
    rt.verificationConsole = { requestId, subject };
}

export function verificationConsoleRows(rt: TuiRuntime): number {
    if (rt.settingsPicker?.kind !== "model") return 0;
    const shown = liveVerificationConsole(rt);
    return shown === undefined ? 0 : verificationConsoleLines(shown);
}

export function hideVerificationConsole(rt: TuiRuntime, requestId: string): void {
    if (rt.verificationConsole?.requestId !== requestId) return;
    rt.verificationConsole = undefined;
}

export function dropSettledVerificationConsole(rt: TuiRuntime): void {
    if (rt.verificationConsole === undefined) return;
    const admission = rt.state.admission;
    if (
        admission?.requestId === rt.verificationConsole.requestId
        && admission.settled === true
    ) {
        rt.verificationConsole = undefined;
    }
}

export function liveVerificationConsole(rt: TuiRuntime) {
    const shown = rt.verificationConsole;
    if (shown === undefined) return undefined;
    const admission = rt.state.admission?.requestId === shown.requestId
        ? rt.state.admission
        : undefined;
    if (admission?.settled === true) return undefined;
    return {
        subject: shown.subject,
        steps: (admission?.steps ?? []).map((step) => ({
            label: step.label,
            status: step.status,
        })),
    };
}

export function renderJumpToBottom(rt: TuiRuntime, resumeFollow = true): void {
    const following = tuiTranscriptAtBottom(
        rt.transcript.scrollTop,
        rt.transcript.scrollHeight,
        rt.transcript.viewport.height,
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
        rt.transcript.scrollTo(rt.transcript.scrollHeight);
    }
    const visible = !following && !anyOverlayOpen(rt);
    rt.jumpToBottom.visible = visible;
    if (!visible) {
        return;
    }
    rt.jumpToBottom.top = rt.commandSuggestionsBox.visible
        ? Math.min(
            rt.transcript.y + rt.transcript.height - 1,
            rt.commandSuggestionsBox.y - 1,
        )
        : rt.transcript.y + rt.transcript.height - 1;
    rt.jumpToBottom.left = Math.max(
        0,
        rt.transcript.x + rt.transcript.width - rt.JUMP_TO_BOTTOM_LABEL.length - 2,
    );
}

export function renderSidebarJump(rt: TuiRuntime): void {
    const visible = rt.sidebar.isShown() && !rt.sidebar.isFollowing()
        && !anyOverlayOpen(rt);
    rt.sidebarJump.visible = visible;
    if (!visible) {
        return;
    }
    const region = rt.sidebar.bounds();
    rt.sidebarJump.top = region.y + region.height - 1;
    rt.sidebarJump.left = Math.max(
        0,
        region.x + region.width - rt.SIDEBAR_JUMP_LABEL.length - 1,
    );
}

export function renderPendingQuote(rt: TuiRuntime): void {
    const quote = rt.pendingQuote;
    rt.quoteText.visible = quote !== undefined && !anyOverlayOpen(rt);
    setComposerMargin(rt, rt.quoteText.visible ? 3 : 2);
    if (quote === undefined) {
        rt.quoteText.content = "";
        return;
    }
    const { facts, keys } = renderTuiQuote(quote);
    // Indented by hand: the line is one row in a column that does not pad
    // its children, and it has to start where the composer's text starts.
    rt.quoteText.content = new StyledText([
        fg(TUI_ACCENT)(`${tuiQuoteMarker(Date.now())} `),
        fg(TUI_MUTED)(`${facts} · `),
        fg(TUI_ACCENT)(keys),
    ]);
}

export function renderHeldAddress(rt: TuiRuntime): void {
    const { facts, keys } = renderTuiHeldAddress(rt.extensionAddressee);
    rt.heldAddressText.visible = facts.length > 0 && !anyOverlayOpen(rt);
    if (facts.length === 0) {
        rt.heldAddressText.content = "";
        return;
    }
    // Indented by hand: the row sits in a column that does not pad its
    // children, and it has to start where the composer's text starts.
    rt.heldAddressText.content = new StyledText([
        fg(TUI_MUTED)(
            `${" ".repeat(rt.appearance.composerMarginHorizontal)}${facts} · `,
        ),
        fg(TUI_ACCENT)(keys),
    ]);
}

export function paneHeaderText(rt: TuiRuntime, 
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
    const contentWidth = Math.max(1, width - rt.composerHorizontalInset);
    const indent = " ".repeat(rt.composerContentIndent);
    if (left.length + right.length + 3 <= contentWidth) {
        return `${indent}${left}${" ".repeat(contentWidth - left.length - right.length)}${right}`;
    }
    const rightRoom = Math.max(0, contentWidth - left.length - 3);
    return rightRoom < 4
        ? `${indent}${left.slice(0, contentWidth)}`
        : `${indent}${left} · ${right.slice(0, rightRoom)}`;
}

export function renderStatus(rt: TuiRuntime): void {
    if (rt.shuttingDown) {
        return;
    }
    const statusState = focusedAgentState(rt);
    const uiRequest = focusedUiRequest(rt);
    const focusedSide = rt.sidebar.isFocused() ? rt.hostedSidebar.pane : undefined;
    const focusedAbort = focusedAbortRequested(rt);
    const focusedActivity = focusedSide?.state.activity ?? rt.activity;
    const focusedElapsed = focusedSide?.state.elapsedWorkingTime()
        ?? elapsedWorkingTime(rt);
    const layout = rt.sidebar.layout();
    const sideState = rt.hostedSidebar.pane?.state.state;
    const paneHeadersVisible = !anyOverlayOpen(rt);
    const sideWidth = rt.sidebar.width();
    // The renderer still reports the whole terminal once the workspace
    // rail has reserved its left side (see `tuiCommandSuggestionWidth`'s
    // note above), so the HUD and status rows below the composer have to
    // come out of the same budget or their content overruns the box the
    // rail already narrowed them to.
    const railInset = rt.workspaceSidebarView.railColumns() ?? 0;
    const mainWidth = Math.max(1, rt.renderer.width - sideWidth - 1);
    // Beside a second pane the row names each one, because the point of the
    // row is telling the two columns apart. Alone it carries the session
    // title, which is the only thing left worth putting there.
    rt.sidebar.setMainHeader(!paneHeadersVisible || !rt.mainHeaderVisible
        ? undefined
        : rt.hostedSidebar.pane !== undefined
        ? paneHeaderText(rt, 
            "Vera",
            rt.state.approvalMode,
            rt.state.modelSettings,
            layout === "split" ? mainWidth : rt.renderer.width,
        )
        : rt.sessionTitle !== undefined
        ? `  Session: ${rt.sessionTitle}`
        : undefined);
    rt.sidebar.setHeader(
        paneHeadersVisible
            && rt.sidebarHeaderVisible
            && rt.hostedSidebar.pane !== undefined
            && sideState !== undefined
        ? paneHeaderText(rt, 
            rt.sidebarSessionTitle
                ?? rt.hostedSidebar.mention
                ?? rt.hostedSidebar.pane!.agentId,
            sideState.approvalMode,
            sideState.modelSettings,
            layout === "split" ? sideWidth : rt.renderer.width,
        )
        : undefined);
    const workingHint = focusedSide === undefined
        ? WORKING_HINT
        : `esc stop ${rt.hostedSidebar.mention ?? focusedSide.agentId}`
            + ` · ${tuiKeyHint("interrupt")}`;
    renderPendingQuote(rt);
    renderHeldAddress(rt);
    renderJumpToBottom(rt);
    renderSidebarJump(rt);

    let lifecycleHint = renderTuiIdleHint(
        READY_HINT,
        rt.runningBackgroundAgents,
    );
    if (rt.sessionSwitchPending) {
        lifecycleHint = rt.sessionSwitchActivity;
    } else if (rt.connectionFailed) {
        lifecycleHint = `disconnected${
            rt.connectionFailure === undefined
                ? ""
                : `: ${shortConnectionFailure(rt.connectionFailure)}`
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
    } else if (rt.pendingImages.some((image) => image.id === undefined)) {
        lifecycleHint = "attaching image…";
    } else if (rt.promptSubmitting) {
        lifecycleHint = rt.pendingSkillInvocations.size > 0
            ? "invoking skill…"
            : "sending prompt with image…";
    } else if (rt.extensionCommandPending) {
        lifecycleHint =
            `${rt.extensionCommandActivity ?? "running extension command"} · ctrl+c quit`;
    } else if (rt.pendingImages.length > 0) {
        lifecycleHint = `${rt.pendingImages.length} image${rt.pendingImages.length === 1 ? "" : "s"} attached · enter send`;
    }

    if (
        isWorkerFreeClient(rt.client)
        && !rt.sessionSwitchPending
        && !rt.connectionFailed
    ) {
        lifecycleHint = "";
    }

    rt.statusText.fg = statusState.approvalMode === "full_access"
        ? rt.theme.critical
        : rt.statusNotice !== undefined
        ? TUI_NOTICE
        : statusState.working
                || statusState.compactingSince !== undefined
                || uiRequest !== undefined
                || rt.extensionCommandPending
            ? TUI_ACCENT
            : TUI_MUTED;
    const hostedControls = rt.hostedSidebar.pane === undefined
        ? []
        : [
            `${rt.hostedSidebar.modeLabel ?? rt.hostedSidebar.mention ?? "agent"} mode`,
            rt.sidebar.layout() === "split"
                ? "split"
                : rt.sidebar.layout() === "sidebar"
                ? `${rt.hostedSidebar.modeLabel ?? rt.hostedSidebar.mention ?? "agent"} only`
                : "vera only",
            "ctrl+\\ layout",
            ...(rt.sidebar.layout() === "split"
                ? [rt.sidebar.isFocused()
                    ? "ctrl+g vera"
                    : `ctrl+g ${rt.hostedSidebar.mention ?? rt.hostedSidebar.pane.agentId}`]
                : []),
        ];
    const placeIdle = !focusedAbort
        && !statusState.working
        && statusState.compactingSince === undefined
        && uiRequest === undefined
        && !rt.sessionSwitchPending
        && !rt.connectionFailed
        && !rt.promptSubmitting
        && !rt.extensionCommandPending
        && rt.pendingImages.length === 0
        && !isWorkerFreeClient(rt.client);
    const hostedModeStatus = tuiPlaceRowModeLine(
        READY_HINT,
        placeIdle,
        hostedControls,
    );
    rt.hostedModeText.content = hostedModeStatus;
    rt.hostedModeText.visible = hostedModeStatus.length > 0;
    const statusLine = [
        tuiDevInstancePrefix(),
        rt.statusNotice ?? lifecycleHint,
    ].filter((part) => part.length > 0).join(" ");
    rt.statusText.visible = !(rt.approvalView.box.visible
        || rt.questionView.box.visible);
    const quietActivity = rt.statusNotice === undefined
        && !statusState.working
        && uiRequest === undefined
        && lifecycleHint === READY_HINT;
    const activityHint = statusState.working
            && uiRequest === undefined
            && !focusedAbort
        ? workingHint
        : "";
    const dialWidth = Math.max(
        1,
        rt.renderer.width - rt.composerHorizontalInset - railInset,
    );
    const stripLines = rt.dialStrip === undefined
        ? undefined
        : renderDialStrip(
            rt.dialStrip,
            [
                "↑/↓ lane",
                `${tuiKeyChord("dials.pair.prev")}/${
                    tuiKeyChord("dials.pair.next")
                } change`,
                "⏎ apply",
                "/permissions for more",
            ].join(" · "),
            dialWidth,
            // A hidden-model ellipsis already spends the next row. Let an
            // actual model use that row when the full composition fits.
            Math.max(3, Math.min(DIAL_HUD_CAP, rt.renderer.height - 22)),
        );
    rt.dialCard.visible = stripLines !== undefined;
    rt.dialCard.backgroundColor = TUI_HUD?.background ?? TUI_PANEL;
    const hudRows = stripLines?.slice(0, -1) ?? [];
    rt.dialCardTitle.height = Math.max(1, hudRows.length);
    rt.dialCard.height = hudRows.length + 3;
    const hudBg = TUI_HUD?.background ?? TUI_PANEL;
    const hudText = TUI_HUD?.text ?? TUI_TEXT;
    const hudMuted = TUI_HUD?.muted ?? TUI_MUTED;
    const hudAccent = TUI_HUD?.accent ?? TUI_ACCENT;
    const hudNotice = TUI_HUD?.notice ?? TUI_NOTICE;
    const hudSuccess = TUI_HUD?.success ?? VERA_TUI_THEME.success;
    rt.dialCardTitle.content = new StyledText(
        paintDialHud(hudRows, rt.dialStrip?.lane, {
            text: hudText,
            muted: hudMuted,
            accent: hudAccent,
            notice: hudNotice,
            background: hudBg,
            success: TUI_HUD?.success ?? TUI_SUCCESS,
            secondary: rt.theme.secondary,
            accessAsk: VERA_TUI_THEME.accent,
            accessAuto: VERA_TUI_THEME.hud?.auto
                ?? VERA_TUI_THEME.success,
        }, {
            effortPending: rt.dialStrip === undefined
                ? false
                : dialEffortPending(rt.dialStrip),
            autoAnimation: rt.autoModeAnimationStartedAt === undefined
                ? undefined
                : {
                    progress: Math.min(
                        1,
                        (Date.now() - rt.autoModeAnimationStartedAt)
                        / AUTO_MODE_ANIMATION_DURATION_MS,
                    ),
                    width: dialWidth,
                },
        }).flatMap((spans, index) => [
            ...spans.map((span) =>
                fg(span.color)(
                    span.background === undefined
                        ? span.text
                        : bg(span.background)(span.text)
                )
            ),
            ...(index === hudRows.length - 1 ? [] : [fg(hudText)("\n")]),
        ]),
    );
    const dialHintParts = (stripLines?.at(-1) ?? "")
        .split(DIAL_EXIT_SEPARATOR);
    rt.dialCardHint.content = stripLines === undefined
        ? ""
        : new StyledText([
            fg(hudMuted)(dialHintParts[0] ?? ""),
            fg(hudNotice)(dialHintParts[1] ?? ""),
        ]);
    rt.activityHintText.content = activityHint;
    rt.activityHintText.visible = rt.statusText.visible
        && activityHint.length > 0;
    // Pull on repaint: the renderer is handed the snapshot and answers
    // synchronously, or it does not answer at all. Nothing here waits on
    // an extension, and a renderer that fails leaves the built-in line.
    const extensionSegments = rt.clientExtensionRegistry?.renderStatusLine(
        tuiStatusSnapshot(
            statusState.modelSettings,
            statusState.approvalMode,
            statusState.context,
            process.cwd(),
            rt.runningBackgroundAgents,
            rt.state.working
                ? "working"
                : uiRequest === undefined
                    ? "idle"
                    : "waiting",
        ),
    );
    const statusDetailsRows: TuiStatusChunk[][] = isWorkerFreeClient(rt.client)
        ? renderTuiFileViewStatusRows(
            rt.client.workspace ?? process.cwd(),
            rt.workspaceBranch.current(),
        )
        : extensionSegments === undefined
        ? renderTuiStatusDetailsRows(
                statusState.modelSettings,
                statusState.approvalMode,
                statusState.context,
                process.cwd(),
                0,
                statusState.effortSubstitution,
                rt.hostedSidebar.pane === undefined,
                rt.workspaceBranch.current(),
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
                rt.workIndex?.needs_you ?? 0,
                Math.max(1, rt.renderer.width - rt.composerHorizontalInset - railInset),
            )
        : [[{
                tone: "muted",
                text: renderTuiStatusSegments(
                    rt.hostedSidebar.pane === undefined
                        ? extensionSegments
                        : extensionSegments.filter((segment) =>
                            segment.kind !== "permissions"
                        ),
                ),
            }]];
    // Hosted-pane controls live at the bottom right beside the workspace
    // row. The activity row above can then change without hiding them.
    const detailsRows = statusDetailsRows;
    const runningNames = rt.runningBackgroundAgentNames.map((name) =>
        truncateFooterLine(
            `* ${name}`,
            Math.min(72, rt.renderer.width - rt.composerHorizontalInset - railInset),
        )
    );
    // The card's own inner width, past the band's indent, its border and
    // its padding: notices and rules stop at the same right edge.
    const cardWidth = Math.max(
        1,
        rt.renderer.width - rt.composerHorizontalInset - railInset,
    );
    const nudgeIndicator = isHomeClient(rt.client) || isWorkerFreeClient(rt.client)
        ? undefined
        : standingNudgeIndicatorRow(rt.standingNudgeRules, {
            agent: statusState.agent?.name ?? "default",
            workspace: focusedAgentClient(rt).workspace ?? "",
        }, cardWidth);
    const agentSection = rt.currentAgentHasParent
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
        : rt.activityAnimation === "off"
        ? new StyledText([fg(TUI_MUTED)(agentHeader)])
        : renderTuiSpokes(
            activityFrame(rt),
            agentHeader,
            {
                active: TUI_ACCENT,
                trail: rt.theme.activityTrail,
                inactive: TUI_ELEMENT,
                text: TUI_MUTED,
            },
        );
    const rule = (glyph: string) =>
        fg(TUI_ELEMENT)(`${glyph.repeat(cardWidth)}\n`);
    // The first row says what the session is answering as, and it lives
    // inside the composer's frame: it is a property of the thing being
    // typed into. What is left describes where the session is, and reads
    // under the frame.
    const insideRow = detailsRows[0] ?? [];
    const outsideRows = detailsRows.slice(1);
    rt.composerStatusText.content = new StyledText(
        insideRow.map((chunk) => fg(statusToneColor(chunk.tone))(chunk.text)),
    );
    rt.needsYouChipWidth = needsYouChipColumns(
        insideRow,
        rt.workIndex?.needs_you ?? 0,
    );
    const detailChunks = outsideRows.flatMap((row, index) => [
        ...row.map((chunk) => fg(statusToneColor(chunk.tone))(chunk.text)),
        ...(index === outsideRows.length - 1
            ? []
            : [fg(TUI_MUTED)("\n"), rule("─")]),
    ]);
    rt.backgroundStatusText.content = new StyledText(detailChunks);
    // Text nodes lay their content out from column zero, so the notice
    // carries the indent the band gets as padding.
    const noticeIndent = " ".repeat(rt.composerContentIndent);
    rt.agentNoticeText.content = nudgeIndicator === undefined &&
            agentSection.length === 0
        ? new StyledText([])
        : new StyledText([
            ...(nudgeIndicator === undefined
                ? []
                : [
                    fg(TUI_MUTED)(noticeIndent),
                    fg(TUI_ACCENT)("● "),
                    fg(TUI_MUTED)(
                        `${nudgeIndicator.status}${nudgeIndicator.gap}${nudgeIndicator.detail}`,
                    ),
                ]),
            ...(agentSection.length === 0
                ? []
                : [
                    fg(TUI_MUTED)(
                        `${nudgeIndicator === undefined ? "" : "\n"}${noticeIndent}`,
                    ),
                    ...animatedAgentHeader.chunks,
                    fg(TUI_MUTED)(
                        agentSection.length === 1
                            ? ""
                            : `\n${
                                agentSection.slice(1)
                                    .map((row) => `${noticeIndent}${row}`)
                                    .join("\n")
                            }`,
                    ),
                ]),
        ]);
    rt.agentNoticeRows = agentSection.length +
        (nudgeIndicator === undefined ? 0 : 1);
    rt.agentNoticeText.height = Math.max(1, rt.agentNoticeRows);
    rt.agentNoticeText.visible = rt.agentNoticeRows > 0;
    // A rule separates each pair of status rows under the frame.
    const cardRows = Math.max(1, outsideRows.length * 2 - 1);
    rt.backgroundStatusText.height = cardRows;
    // The band's own rows, which the composer sits straight on top of with
    // no gutter of its own: the card, its border lines, and whichever
    // status lines are showing above it. Nothing here varies, so the
    // composer keeps one height off the foot of the screen.
    setComposerMargin(rt, 
        cardRows + 1,
    );
    // The HUD and the model picker are named here because nothing else on
    // screen names them. The rail is named too while it is closed, for the
    // same reason: once it is open it advertises its own chords.
    const quietHint = [
        fg(TUI_MUTED)(HUD_HINT.slice(0, -3)),
        fg(TUI_ACCENT)("HUD"),
        fg(TUI_MUTED)(` · ${MODEL_PICKER_HINT}`),
    ];
    if (
        rt.workspaceSidebar === undefined
        && quietHintColumns() <= rt.renderer.width - rt.composerHorizontalInset
    ) {
        quietHint.push(fg(TUI_MUTED)(` · ${SIDEBAR_HINT}`));
    }
    rt.statusText.content = quietActivity
        ? new StyledText(quietHint)
        : statusState.working
            && rt.statusNotice === undefined
            && uiRequest === undefined
            && !focusedAbort
        ? renderTuiActivityAnimation(
            rt.activityAnimation,
            activityFrame(rt),
            statusLine,
            {
                active: TUI_ACCENT,
                // ActiveGrid has its own theme role instead of borrowing
                // the success color.
                trail: rt.activityAnimation === "shimmer"
                    ? TUI_ELEMENT
                    : rt.theme.activityTrail,
                inactive: TUI_MUTED,
                text: rt.state.approvalMode === "full_access"
                    ? rt.theme.critical
                    : TUI_ACCENT,
            },
            rt.activityAnimationWidth,
        )
        : statusLine;
}

export function watchBackgroundAgents(rt: TuiRuntime, next: TuiAgentClient): void {
    rt.stopWatchingBackgroundAgents?.();
    rt.stopWatchingBackgroundAgents = undefined;
    applyBackgroundAgents(rt, next.backgroundAgents);
    rt.stopWatchingBackgroundAgents = next.onBackgroundAgents?.((agents) => {
        if (rt.client !== next || rt.shuttingDown) {
            return;
        }
        applyBackgroundAgents(rt, agents);
        renderStatus(rt);
    });
}

export function watchWorkIndex(rt: TuiRuntime, next: TuiAgentClient): void {
    rt.stopWatchingWorkIndex?.();
    rt.stopWatchingWorkIndex = undefined;
    applyWorkIndexSnapshot(rt, next.workIndex, false);
    rt.stopWatchingWorkIndex = next.onWorkIndex?.((index) => {
        if (rt.client !== next || rt.shuttingDown) return;
        applyWorkIndexSnapshot(rt, index, true);
    });
}

export function applyWorkIndexSnapshot(rt: TuiRuntime, 
    index: WorkIndexSnapshot | undefined,
    announce: boolean,
): void {
    if (index === undefined) return;
    const previous = rt.workIndex;
    rt.workIndex = index;
    if (rt.workTab !== undefined) {
        rt.workTab = applyWorkIndex(rt.workTab, index);
    }
    if (rt.workspaceSidebar !== undefined) {
        rt.workspaceSidebar = applyWorkspaceWorkIndex(rt.workspaceSidebar, index);
        // The same push carries the sessions that have gone and the ones
        // that have arrived, so the listing is read again here rather than
        // only when the pane is opened.
        refreshWorkspaceSidebarRoster(rt);
    }
    if (announce) {
        const notice = attentionNotice(
            newAttentionRows(previous, index),
            rt.terminalFocused,
        );
        if (notice !== undefined) {
            writeTerminal(rt, attentionNoticeSequence(notice));
        }
    }
    renderState(rt);
}

export function writeTerminal(rt: TuiRuntime, sequence: string): void {
    try {
        process.stdout.write(sequence);
    } catch {
        // A closed or non-tty stdout is not a reason to fail a turn.
    }
}

export function applyBackgroundAgents(rt: TuiRuntime, 
    agents: BackgroundAgentsSnapshot | undefined,
): void {
    rt.runningBackgroundAgents = agents?.running ?? 0;
    // A reconnect/resubscribe can land the same child twice in one
    // snapshot; each name gets its own spinner row, so a duplicate here
    // shows up as a stacked/overlapping animation on screen.
    rt.runningBackgroundAgentNames = [...new Set(agents?.children ?? [])];
    rt.currentAgentHasParent = agents?.has_parent ?? false;
}

export function observeActivity(rt: TuiRuntime, update: AgentUpdate): void {
    emitExperimentalAgentEvent(rt, update);
    if (update.type === "status" && update.state === "working") {
        rt.workingSince ??= Date.now();
        rt.phaseSince ??= rt.workingSince;
        rt.activity = "thinking";
    } else if (update.type === "status" && update.state === "waiting") {
        rt.workingSince ??= Date.now();
        rt.phaseSince = undefined;
        rt.activity = "waiting";
    } else if (update.type === "status" && update.state === "idle") {
        rt.workingSince = undefined;
        rt.phaseSince = undefined;
        rt.activity = "ready";
    } else if (update.type === "model_activity") {
        rt.workingSince ??= Date.now();
        if (update.replacesPartialAttempt === true) {
            rt.phaseSince = undefined;
        }
        rt.activity = `retrying ${update.model}`;
    } else if (update.type === "user_prompt") {
        rt.workingSince ??= Date.now();
        rt.phaseSince = Date.now();
        rt.activity = "thinking";
    } else if (update.type === "assistant_thinking") {
        // Reasoning can resume after visible text, so each burst re-arms the
        // phase and earns its own summary line.
        rt.workingSince ??= Date.now();
        rt.phaseSince ??= Date.now();
        rt.activity = "thinking";
    } else if (update.type === "assistant_delta") {
        finishThoughtPhase(rt);
        rt.workingSince ??= Date.now();
        rt.activity = "responding";
    } else if (update.type === "tool_started") {
        finishThoughtPhase(rt);
        rt.workingSince ??= Date.now();
        rt.activity = `running ${update.tool}`;
    } else if (update.type === "tool_finished") {
        rt.activity = "thinking";
        rt.phaseSince = Date.now();
    } else if (
        update.type === "turn_finished"
        || update.type === "agent_failed"
    ) {
        finishThoughtPhase(rt);
    }
}

export function finishThoughtPhase(rt: TuiRuntime): void {
    if (rt.activity !== "thinking" || rt.phaseSince === undefined) {
        rt.state = dropTuiThinking(rt.state);
        return;
    }
    const seconds = Math.max(0, Date.now() - rt.phaseSince) / 1_000;
    rt.state = appendTuiThought(rt.state, seconds);
    rt.phaseSince = undefined;
}

export function elapsedWorkingTime(rt: TuiRuntime): string {
    if (rt.workingSince === undefined) {
        return "0s";
    }
    const elapsedSeconds = Math.max(
        0,
        Math.floor((Date.now() - rt.workingSince) / 1_000),
    );
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return minutes === 0
        ? `${seconds}s`
        : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function activityFrame(rt: TuiRuntime): number {
    const interval = rt.activityAnimationInterval
        ?? (rt.activityAnimation === "shimmer"
            ? SHIMMER_FRAME_INTERVAL_MS
            : rt.activityAnimation === "symmetric_wave"
            ? SYMMETRIC_WAVE_FRAME_INTERVAL_MS
            : DEFAULT_ACTIVITY_FRAME_INTERVAL_MS);
    return Math.floor(Date.now() / interval);
}

export function emitExperimentalAgentEvent(rt: TuiRuntime, update: AgentUpdate): void {
    switch (update.type) {
        case "user_prompt":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                text: update.content,
            });
            return;
        case "assistant_delta":
        case "assistant_thinking":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                text: update.text,
            });
            return;
        case "tool_started":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                tool: update.tool,
            });
            return;
        case "tool_finished":
            rt.experimentalTuiHost.agentEvent({
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
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                tool: update.tool,
            });
            return;
        case "turn_finished":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                ...(update.error === undefined
                    ? {}
                    : { text: update.error }),
            });
            return;
        case "status":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                state: update.state === "working"
                    ? "working"
                    : update.state === "waiting" ? "waiting" : "idle",
            });
            return;
        case "agent_failed":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                text: update.detail.slice(0, 4_000),
            });
            return;
        default:
            return;
    }
}
