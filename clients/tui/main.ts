import { BoxRenderable, CliRenderEvents, decodePasteBytes, MarkdownRenderable, ScrollBoxRenderable, stripAnsiSequences, TextRenderable, createCliRenderer, KeyEvent, RGBA, type CliRenderer, type Selection, type MouseEvent } from "@opentui/core";
import { randomUUID } from "node:crypto";

import { AsyncLocalStorage } from "node:async_hooks";
import { readStampedRelease } from "../../src/release/stamp.ts";
import { installLiveProcess } from "../../src/live-process.ts";
import { openFileInEditor, veraConfigPath } from "../editor.ts";
import { tuiComposerOverlayInset } from "./appearance.ts";
import { jumpMenuLines } from "./jump.ts";
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

import { isToolApprovalUiRequestUpdate, isUserQuestionUiRequestUpdate } from "../../src/engine/protocol.ts";
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
import { loadOptionalVeraConfig, tipsEnabled as configuredTipsEnabled, type VeraExtensionConfig } from "../../src/config.ts";
import {
    loadPoolFile,
    poolFileIssueNotices,
} from "../../src/model/pool-file-loader.ts";
import type {
    ModelAssignmentId,
    ModelAssignmentRow,
} from "../../src/config/model-assignments.ts";
import { bundledClientExtensions } from "../../src/extensions/bundled-client.ts";
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
import { HOST_CAPABILITY_HARNESS_MESSAGES } from "../../src/host/capabilities.ts";
import {
    findOrStartResidentHost,
    worktreeRuntimeNotice,
} from "../host/launch.ts";
import { createTuiApprovalView } from "./approval.ts";
import {
    createTuiQuestionView,
} from "./question.ts";
import { createTuiSidebar } from "./sidebar.ts";
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
import { copyTuiText } from "./clipboard.ts";
import { createTuiCommandPaletteView, handleTuiCommandPaletteScroll } from "./command-palette.ts";
import { createTuiHelpView, handleTuiHelpScroll } from "./help.ts";
import { createConfiguredBuiltinTuiCommandRegistry, registerExtensionTuiCommands, type TuiPaletteEntry } from "./commands.ts";
import { createTuiComposer, createTuiComposerPanel, TUI_COMPOSER_MIN_TEXT_ROWS } from "./composer.ts";
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
import { createTuiProviderForgetConfirmView } from "./provider-forget-confirm.ts";
import { createTuiAdmissionDialogView } from "./admission-dialog.ts";
import { searchSessionsThroughHost } from "../../src/host/session-search-client.ts";
import { parseRawInputEvent, tuiInterruptAction } from "./interrupt.ts";
import { createTuiLinesView } from "./lines-view.ts";
import { wheelCursor } from "./list-window.ts";
import { workTabAction } from "./work-tab.ts";
import { openWorkspaceSelection, workspaceHeaderAction, workspaceSidebarLayout } from "./workspace-sidebar.ts";
import { isWorkerFreeClient } from "./jsonl-view-client.ts";
import { createHomeClient, isHomeClient } from "./home-client.ts";
import {
    readModelSettingsThroughHost,
} from "../../src/host/model-settings-client.ts";
import {
    readAnnexUrlThroughHost,
    type AnnexUrlResult,
} from "../../src/annex/host-client.ts";
import { createHomeState, createTuiHomeView } from "./home-screen.ts";
import { createTuiResumeOverlayView } from "./resume-overlay.ts";
import { openSelected, searchSelectionOf, searchSelections, updateSearchOverlayText } from "./search-overlay.ts";
import { parseTerminalFocusEvent, FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON } from "./attention-notice.ts";
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
import { createTuiSettingsPickerView, handleTuiSettingsPickerScroll, switchedModelTab, moveTuiSettingsPickerPointer, sessionPickerLists, type TuiSettingsPickerState, createTuiProviderFormView, handleTuiProviderFormPaste } from "./settings-picker.ts";
import { createTuiRequestOptionsEditorView } from "./request-options-editor.ts";
import { createTuiSecretPromptView, handleTuiSecretPromptPaste } from "./secret-prompt.ts";
import { createTuiNamePromptView } from "./name-prompt.ts";
import { tuiKeyHint } from "./keymap.ts";

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
import { beginTuiTipLaunch } from "./tips-store.ts";
import { createRenderCoalescer } from "./render-coalescer.ts";
import {
    createAuthStorage,
    unreadableAuthStoragePath,
    type AuthStorage,
} from "../../src/providers/auth-storage.ts";
import { configuredProviders, findConfiguredProvider } from "../../src/providers/registry.ts";
import { createTuiPreferencesListView, handleTuiPreferencesListScroll } from "./preferences-list.ts";
import { createTuiStandingNudgesView, handleTuiStandingNudgesPaste, handleTuiStandingNudgesScroll } from "./standing-nudges.ts";
import { HostUnresponsiveError } from "../../src/host/lockfile.ts";
import { veraProfileDirectory } from "../../src/profile-paths.ts";
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
import { TUI_HUD, TUI_MUTED, TUI_PANEL, TUI_TEXT, applyTuiTheme, appendTuiExtensionBlock, appendTuiError, appendTuiNotice, createTuiState, setTuiWorkspaceRoot, type TuiState, type TuiTranscriptEntry } from "./state.ts";
import { resolveTuiTheme, tuiRecessColor } from "./theme.ts";
import { tuiThemeProperties } from "./theme-bindings.ts";
import { loadTuiActivityAnimationPreference, loadTuiActivityAnimationIntervalPreference, loadTuiActivityAnimationWidthPreference, loadTuiSidebarWidth, saveTuiSidebarWidth, loadTuiKeybindingOverlay, loadTuiPinnedSessionIds, loadTuiRecentSessionId, loadTuiThemePreference, loadTuiWorkspaceSidebarDocked, loadTuiWorkspaceSidebarWidth, saveTuiRecentSessionId, saveTuiWorkspaceSidebarWidth } from "./theme-preference.ts";
import { createTuiDiff, repaintTuiDiff } from "./diff.ts";
import { createTuiUserEntry, repaintTuiUserEntry } from "./user-entry.ts";
import { updateTuiToolHeader, updateTuiToolRow } from "./tool-row.ts";
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
import { activeOverlayFocus, focusActiveSurface, activeFlightSurface, applyTimelineTransition, withSessionSwitchDeadline, recordSessionSwitchOutcome, discardSwitchTarget, leaveSwitchSource, stopClientForShutdown, discardCreatedSwitchTarget, beginFork, beginHostReconnect, settleLostHost, reportConnectionError } from "./main/focus-switch.ts";
import { tipContext, tipPool, takeTip, transcriptEntryText, transcriptEstimatedRows, invalidateMeasuredEntryRows, measureTranscriptEntryNode, measureMaterializedTranscriptEntries, transcriptEntryRows, estimateTranscriptEntryRows, estimatedTranscriptRows, updateTranscriptEntryNode, createTranscriptEntryNode, destroyTranscriptEntryNode, transcriptWindowChildIndex, addTranscriptEntryNode, updateTranscriptSpacers, topmostVisibleTranscriptEntry, applyTranscriptScrollAnchor, captureTranscriptScrollAnchor, transcriptFollowsBottom, trimTranscriptWindow, renderTranscriptEntries, materializeEarlierTranscriptEntries, materializeLaterTranscriptEntries, nodeTranscriptRows, evictTranscriptEntries, maybeEvictTranscriptEntries, setTranscriptWindow, snapTranscriptWindowToTail, setTranscriptWindowAround, settleTranscriptScrollState, maybeMaterializeEarlierTranscriptEntries, maybeMaterializeLaterTranscriptEntries, maybeSnapTranscriptWindowToTail } from "./main/transcript-nodes.ts";
import { renderState, showSearchTarget, drawWorkspaceSidebar, refreshTimedSurfaces, anyOverlayOpen, shiftTranscriptEntrySlots, reseedTranscriptNodes, clearTranscriptNodes } from "./main/render-state.ts";
import { openReviewerMenu, openReviewerPicker, reviewerPatchFor, reviewerToast, openModelPicker, modelRequestOptionsFacts, modelPickerActionOptions, isModelShortlisted, refreshableProvidersOf, catalogSizeOf, currentModelAssignmentRows, openModelAssignmentPicker, bindModelAssignmentFromPicker, configureDisplayPath, configureFiles, openConfigurePicker, openConfigureEditor, modelLevelFacts, currentModelLevels, openReasoningPicker, openPermissionsPicker, openThemePicker, openPreferencesList, openStandingNudges, providerConnected, openProviderEditForm, openProviderPicker, connectProvider } from "./main/model-pickers.ts";
import { forgetProvider, forgetProviderCredential, defaultLoginProvider, openProviderEndpointForm, openRequestOptionsEditor, applyRequestOptionsEditorTransition, applyProviderFormTransition, applySecretPromptTransition, applySessionRenamePromptTransition, performSessionRename, refreshSessionPicker, openSettingsMenu, openSettingsDestination, openConfigurationRequiredRequest, activateConfigurationRequiredRequest, respondToConfigurationRequired, openNextConfigurationRequiredRequest, finishConfigurationPicker, syncConfigurationRequiredRequest } from "./main/provider-forms.ts";
import { openSettingsMenuTarget, runPaletteAction, runStandalonePaletteAction, runBack, jumpMenuContentWidth, closeJumpMenu, renderJumpMenu, runJumpTo } from "./main/palette-jump.ts";
import { openJumpMenuOverlay, openWorkTab, focusWorkspaceSidebar, openWorkspaceSidebar, cycleLiveSession, refreshWorkspaceSidebarRoster, applyWorkspaceRail, resizeWorkspaceRailAt, closeWorkspaceSidebar, runWorkspaceSidebarAction, openResumePicker, closeWorkSurfaces, runWorkTabAction, runSearchOverlayAction, beginSearch, openNamePrompt, openSearchOverlay, openCommandPalette, openHelp } from "./main/workspace-ops.ts";
import { applySettingsPickerTransition, closeSettingsPickerSurface } from "./main/settings-picker-transition.ts";
import { switchToClient, destinationIsLive, openSwitchDestination, requestCloseSession, beginParkToJsonl, runHomeAction, returnToHome, refreshHomeSessions, resumeJsonlView, beginCreateSession, beginSessionResume, currentDraft, beginSessionTrash, performSessionTrash, requestModelSettingsChange, formatContextLimit, retryPoolAdmission } from "./main/session-ops.ts";
import { requestCatalogRefresh, requestPoolAdmission, dialogAdmission, keptModels, openCatalogRefreshScopePicker, startCatalogRefreshSweep, advanceCatalogRefreshSweep, catalogRefreshSweepResult, catalogRefreshSummary, openPoolVerifyScopePicker, startPoolVerifySweep, advancePoolVerifySweep, poolVerifySweepResult, verifyModelInPicker, closeAdmissionDialog, requestPermissionsChange, applySelectedTheme, scheduleThemePreview } from "./main/pool-admission.ts";
import { pooledModelNames, activeCompletion, renderCommandSuggestions, activeComposeSuggester, overlaysClearOfSuggestions, finishStreamingAssistant, copyTranscriptSelection, announceCopy } from "./main/suggestions.ts";
import { showStatusNotice, showModeToast, showVerificationConsole, verificationConsoleRows, hideVerificationConsole, dropSettledVerificationConsole, liveVerificationConsole, renderJumpToBottom, renderSidebarJump, renderPendingQuote, renderHeldAddress, paneHeaderText } from "./main/notices.ts";
import { renderStatus } from "./main/render-status.ts";
import { watchBackgroundAgents, watchWorkIndex, applyWorkIndexSnapshot, writeTerminal, applyBackgroundAgents, observeActivity, finishThoughtPhase, elapsedWorkingTime, activityFrame, emitExperimentalAgentEvent } from "./main/watchers.ts";
export { watchBackgroundAgents, watchWorkIndex, applyWorkIndexSnapshot, writeTerminal, applyBackgroundAgents, observeActivity, finishThoughtPhase, elapsedWorkingTime, activityFrame, emitExperimentalAgentEvent };
export { renderStatus };
export { showStatusNotice, showModeToast, showVerificationConsole, verificationConsoleRows, hideVerificationConsole, dropSettledVerificationConsole, liveVerificationConsole, renderJumpToBottom, renderSidebarJump, renderPendingQuote, renderHeldAddress, paneHeaderText };
export { pooledModelNames, activeCompletion, renderCommandSuggestions, activeComposeSuggester, overlaysClearOfSuggestions, finishStreamingAssistant, copyTranscriptSelection, announceCopy };
export { requestCatalogRefresh, requestPoolAdmission, dialogAdmission, keptModels, openCatalogRefreshScopePicker, startCatalogRefreshSweep, advanceCatalogRefreshSweep, catalogRefreshSweepResult, catalogRefreshSummary, openPoolVerifyScopePicker, startPoolVerifySweep, advancePoolVerifySweep, poolVerifySweepResult, verifyModelInPicker, closeAdmissionDialog, requestPermissionsChange, applySelectedTheme, scheduleThemePreview };
export { switchToClient, destinationIsLive, openSwitchDestination, requestCloseSession, beginParkToJsonl, runHomeAction, returnToHome, refreshHomeSessions, resumeJsonlView, beginCreateSession, beginSessionResume, currentDraft, beginSessionTrash, performSessionTrash, requestModelSettingsChange, formatContextLimit, retryPoolAdmission };
export { applySettingsPickerTransition, closeSettingsPickerSurface };
export { openJumpMenuOverlay, openWorkTab, focusWorkspaceSidebar, openWorkspaceSidebar, cycleLiveSession, refreshWorkspaceSidebarRoster, applyWorkspaceRail, resizeWorkspaceRailAt, closeWorkspaceSidebar, runWorkspaceSidebarAction, openResumePicker, closeWorkSurfaces, runWorkTabAction, runSearchOverlayAction, beginSearch, openNamePrompt, openSearchOverlay, openCommandPalette, openHelp };
export { openSettingsMenuTarget, runPaletteAction, runStandalonePaletteAction, runBack, jumpMenuContentWidth, closeJumpMenu, renderJumpMenu, runJumpTo };
export { forgetProvider, forgetProviderCredential, defaultLoginProvider, openProviderEndpointForm, openRequestOptionsEditor, applyRequestOptionsEditorTransition, applyProviderFormTransition, applySecretPromptTransition, applySessionRenamePromptTransition, performSessionRename, refreshSessionPicker, openSettingsMenu, openSettingsDestination, openConfigurationRequiredRequest, activateConfigurationRequiredRequest, respondToConfigurationRequired, openNextConfigurationRequiredRequest, finishConfigurationPicker, syncConfigurationRequiredRequest };
export { openReviewerMenu, openReviewerPicker, reviewerPatchFor, reviewerToast, openModelPicker, modelRequestOptionsFacts, modelPickerActionOptions, isModelShortlisted, refreshableProvidersOf, catalogSizeOf, currentModelAssignmentRows, openModelAssignmentPicker, bindModelAssignmentFromPicker, configureDisplayPath, configureFiles, openConfigurePicker, openConfigureEditor, modelLevelFacts, currentModelLevels, openReasoningPicker, openPermissionsPicker, openThemePicker, openPreferencesList, openStandingNudges, providerConnected, openProviderEditForm, openProviderPicker, connectProvider };
export { renderState, showSearchTarget, drawWorkspaceSidebar, refreshTimedSurfaces, anyOverlayOpen, shiftTranscriptEntrySlots, reseedTranscriptNodes, clearTranscriptNodes };
export { tipContext, tipPool, takeTip, transcriptEntryText, transcriptEstimatedRows, invalidateMeasuredEntryRows, measureTranscriptEntryNode, measureMaterializedTranscriptEntries, transcriptEntryRows, estimateTranscriptEntryRows, estimatedTranscriptRows, updateTranscriptEntryNode, createTranscriptEntryNode, destroyTranscriptEntryNode, transcriptWindowChildIndex, addTranscriptEntryNode, updateTranscriptSpacers, topmostVisibleTranscriptEntry, applyTranscriptScrollAnchor, captureTranscriptScrollAnchor, transcriptFollowsBottom, trimTranscriptWindow, renderTranscriptEntries, materializeEarlierTranscriptEntries, materializeLaterTranscriptEntries, nodeTranscriptRows, evictTranscriptEntries, maybeEvictTranscriptEntries, setTranscriptWindow, snapTranscriptWindowToTail, setTranscriptWindowAround, settleTranscriptScrollState, maybeMaterializeEarlierTranscriptEntries, maybeMaterializeLaterTranscriptEntries, maybeSnapTranscriptWindowToTail };
export { activeOverlayFocus, focusActiveSurface, activeFlightSurface, applyTimelineTransition, withSessionSwitchDeadline, recordSessionSwitchOutcome, discardSwitchTarget, leaveSwitchSource, stopClientForShutdown, discardCreatedSwitchTarget, beginFork, beginHostReconnect, settleLostHost, reportConnectionError };
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

export const READY_HINT = `ready · ${tuiKeyHint("open_palette")}`;

export function tuiDevInstancePrefix(): string {
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

export const MODEL_PICKER_HINT = tuiKeyHint("open_model_picker");
export const HUD_HINT = tuiKeyHint("dials.open");
export const SIDEBAR_HINT = tuiKeyHint("toggle_workspace_sidebar");

/** Columns the quiet status row needs with the rail's chord in it. */
export function quietHintColumns(): number {
    return HUD_HINT.length + MODEL_PICKER_HINT.length + SIDEBAR_HINT.length + 6;
}
export const WORKING_HINT = `esc stop · ${tuiKeyHint("interrupt")}`;
export const STOPPING_HINT = "stopping…";
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

export function shortConnectionFailure(message: string): string {
    const line = message.split("\n")[0]?.trim() ?? "";
    return line.length > CONNECTION_FAILURE_HINT_LIMIT
        ? `${line.slice(0, CONNECTION_FAILURE_HINT_LIMIT - 1)}…`
        : line;
}
// The question overlay owns the choose/cancel hint now, so the status line only
// carries the waiting phase and the global interrupt.
export const QUESTION_HINT = `question waiting · ${tuiKeyHint("interrupt")}`;
export const COPY_NOTICE_DURATION_MS = 1_500;
export const MODE_TOAST_DURATION_MS = 2_500;
const STATUS_REFRESH_INTERVAL_MS = 100;
export const DIRECT_EXTENSION_COMMAND_TIMEOUT_MS = 2_000;
export const SYMMETRIC_WAVE_FRAME_INTERVAL_MS = 360;
export const SHIMMER_FRAME_INTERVAL_MS = 40;
export const DEFAULT_ACTIVITY_FRAME_INTERVAL_MS = 160;
export const SESSION_SWITCH_TIMEOUT_MS = 15_000;
export const POINTER_HOVER_DELAY_MS = 25;
/**
 * Two plain escapes in this window open the timeline picker, the same gesture
 * /rewind is. One press arms the window; any other key disarms it, so typing
 * between presses never counts as a double press.
 */
export const DOUBLE_ESCAPE_REWIND_WINDOW_MS = 500;
/** Rows the composer, the status band and a little transcript need. */
export const SUGGESTIONS_RESERVED_ROWS = 12;

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

export function truncateFooterLine(text: string, width: number): string {
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

export function removeSessionPickerOption(
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

export function recentSessionSaveFailure(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not remember this session for vera -c: ${detail}`;
}

export function closeSessionFailure(
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
export function developerChangeLabel(patch: DeveloperSettingsPatch): string {
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
