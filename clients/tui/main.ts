import { forgetProviderThroughHost } from "../../src/host/provider-forget-client.ts";
import { operateModelsThroughHost } from "../../src/host/model-operation-client.ts";
import type { ModelOperation, ModelOperationResult } from "../../src/model/model-operations.ts";
import { BoxRenderable, CliRenderEvents, decodePasteBytes, MarkdownRenderable, ScrollBoxRenderable, stripAnsiSequences, TextRenderable, createCliRenderer, KeyEvent, RGBA, type CliRenderer, type Selection, type MouseEvent } from "@opentui/core";
import { randomUUID } from "node:crypto";

import { AsyncLocalStorage } from "node:async_hooks";
import { readStampedRelease } from "../../src/release/stamp.ts";
import { installLiveProcess } from "../../src/live-process.ts";
import { openFileInEditor, veraConfigPath } from "../editor.ts";
import { tuiComposerOverlayInset } from "./appearance.ts";
import { jumpMenuLines } from "./jump.ts";
import type { OutriderDriver } from "./main/outrider-ops.ts";
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
    type OverrideSettingsPatch,
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
import { createTuiOverridesResetConfirmView } from "./overrides-reset-confirm.ts";
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
    refreshCatalogThroughHost,
} from "../../src/host/model-settings-client.ts";
import {
    readAnnexUrlThroughHost,
    type AnnexUrlResult,
} from "../../src/annex/host-client.ts";
import { createHomeState, createTuiHomeView } from "./home-screen.ts";
import { createTuiOnboardingView } from "./onboarding-screen.ts";
import { wizardFieldIsOpen } from "./onboarding-wizard.ts";
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
import { createTuiSettingsPickerView, handleTuiSettingsPickerScroll, switchedModelTab, moveTuiSettingsPickerPointer, sessionPickerLists, type TuiSettingsPickerState, createTuiProviderFormView } from "./settings-picker.ts";
import { createTuiRequestOptionsEditorView } from "./request-options-editor.ts";
import { createTuiSecretPromptView } from "./secret-prompt.ts";
import { createTuiNamePromptView } from "./name-prompt.ts";
import { tuiKeyHint } from "./keymap.ts";

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
import { createTuiExtensionsListView } from "./extensions-list.ts";
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
import { openExtensionAgent, focusedAgentClient, isCurrentExtensionComposeTarget, focusedAgentState, modelSettingsForAgent, modelSettingsForOpenPicker, dialPool, dialCatalog, committedDialPair, openDials, openAgentPicker, describeAgentRow, selectAgent, requestAgentCatalog, stopAutoModeAnimation, startAutoModeAnimation, closeDials, closeTransientOverlaysForUiRequest, commitDials, setSidebarFocused, focusedUiRequest, focusedAbortRequested, focusedAgentCanAbort, composerIsAtLeftBoundary, abortFocusedAgent, releaseFocusedQueuedPrompts, hostOwnsPromptQueue, visibleMentions } from "./main/agents-dials.ts";
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
import { openReviewerMenu, openReviewerPicker, reviewerPatchFor, reviewerToast, openModelPicker, modelRequestOptionsFacts, modelPickerActionOptions, isModelShortlisted, refreshableProvidersOf, catalogSizeOf, currentModelAssignmentRows, openModelAssignmentPicker, bindModelAssignmentFromPicker, configureDisplayPath, configureFiles, openConfigurePicker, openConfigureEditor, modelLevelFacts, currentModelLevels, openReasoningPicker, openPermissionsPicker, openThemePicker, openPreferencesList, openStandingNudges, providerHasCredential, openProviderEditForm, openProviderPicker, connectProvider, homeNeedsProvider, onboardingInput } from "./main/model-pickers.ts";
import { forgetProvider, forgetProviderCredential, defaultLoginProvider, openProviderEndpointForm, openRequestOptionsEditor, applyRequestOptionsEditorTransition, applyProviderFormTransition, applySecretPromptTransition, applySessionRenamePromptTransition, performSessionRename, refreshSessionPicker, openSettingsMenu, openSettingsDestination, openConfigurationRequiredRequest, activateConfigurationRequiredRequest, respondToConfigurationRequired, openNextConfigurationRequiredRequest, finishConfigurationPicker, syncConfigurationRequiredRequest } from "./main/provider-forms.ts";
import { openSettingsMenuTarget, runPaletteAction, runStandalonePaletteAction, runBack, jumpMenuContentWidth, closeJumpMenu, renderJumpMenu, runJumpTo } from "./main/palette-jump.ts";
import { openJumpMenuOverlay, openWorkTab, focusWorkspaceSidebar, openWorkspaceSidebar, cycleLiveSession, refreshWorkspaceSidebarRoster, applyWorkspaceRail, resizeWorkspaceRailAt, closeWorkspaceSidebar, runWorkspaceSidebarAction, openResumePicker, closeWorkSurfaces, runWorkTabAction, runSearchOverlayAction, beginSearch, openNamePrompt, openSearchOverlay, openCommandPalette, openHelp } from "./main/workspace-ops.ts";
import { applyOverridesReset, applySettingsPickerTransition, closeSettingsPickerSurface } from "./main/settings-picker-transition.ts";
import { closeOnboardingWizard, openOnboardingWizard, renderOnboardingWizard, runOnboardingWizardAction, settleWizardVerification, updateWizardSession, wizardTookModelSettings } from "./main/onboarding-wizard-ops.ts";
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
export { closeOnboardingWizard, openOnboardingWizard, renderOnboardingWizard, runOnboardingWizardAction, settleWizardVerification, updateWizardSession, wizardTookModelSettings };
export { switchToClient, destinationIsLive, openSwitchDestination, requestCloseSession, beginParkToJsonl, runHomeAction, returnToHome, refreshHomeSessions, resumeJsonlView, beginCreateSession, beginSessionResume, currentDraft, beginSessionTrash, performSessionTrash, requestModelSettingsChange, formatContextLimit, retryPoolAdmission };
export { applyOverridesReset, applySettingsPickerTransition, closeSettingsPickerSurface };
export { openJumpMenuOverlay, openWorkTab, focusWorkspaceSidebar, openWorkspaceSidebar, cycleLiveSession, refreshWorkspaceSidebarRoster, applyWorkspaceRail, resizeWorkspaceRailAt, closeWorkspaceSidebar, runWorkspaceSidebarAction, openResumePicker, closeWorkSurfaces, runWorkTabAction, runSearchOverlayAction, beginSearch, openNamePrompt, openSearchOverlay, openCommandPalette, openHelp };
export { openSettingsMenuTarget, runPaletteAction, runStandalonePaletteAction, runBack, jumpMenuContentWidth, closeJumpMenu, renderJumpMenu, runJumpTo };
export { forgetProvider, forgetProviderCredential, defaultLoginProvider, openProviderEndpointForm, openRequestOptionsEditor, applyRequestOptionsEditorTransition, applyProviderFormTransition, applySecretPromptTransition, applySessionRenamePromptTransition, performSessionRename, refreshSessionPicker, openSettingsMenu, openSettingsDestination, openConfigurationRequiredRequest, activateConfigurationRequiredRequest, respondToConfigurationRequired, openNextConfigurationRequiredRequest, finishConfigurationPicker, syncConfigurationRequiredRequest };
export { openReviewerMenu, openReviewerPicker, reviewerPatchFor, reviewerToast, openModelPicker, modelRequestOptionsFacts, modelPickerActionOptions, isModelShortlisted, refreshableProvidersOf, catalogSizeOf, currentModelAssignmentRows, openModelAssignmentPicker, bindModelAssignmentFromPicker, configureDisplayPath, configureFiles, openConfigurePicker, openConfigureEditor, modelLevelFacts, currentModelLevels, openReasoningPicker, openPermissionsPicker, openThemePicker, openPreferencesList, openStandingNudges, providerHasCredential, openProviderEditForm, openProviderPicker, connectProvider, homeNeedsProvider };
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
export { openExtensionAgent, focusedAgentClient, isCurrentExtensionComposeTarget, focusedAgentState, modelSettingsForAgent, modelSettingsForOpenPicker, dialPool, dialCatalog, committedDialPair, openDials, openAgentPicker, describeAgentRow, selectAgent, requestAgentCatalog, stopAutoModeAnimation, startAutoModeAnimation, closeDials, closeTransientOverlaysForUiRequest, commitDials, setSidebarFocused, focusedUiRequest, focusedAbortRequested, focusedAgentCanAbort, composerIsAtLeftBoundary, abortFocusedAgent, releaseFocusedQueuedPrompts, hostOwnsPromptQueue, visibleMentions };
export { applyTerminalTitle, fallbackSessionTitle, adoptFallbackSessionTitle, refreshTerminalTitle, toggleMainHeader, toggleSidebarHeader, readStandingNudgeRules, adoptStandingNudgesState, isSearchLanding, markSearchLanding, clearSearchLanding, appendPendingSidebarContextNotice, refreshKeymap, coreHelpCommands, registeredPaletteEntries, workerFreeAction, createMarkdownStyle, clearSidebarEntryNodes, closeSidebarPane, composerSlotHeight, setSurfaceBottomInsets, setComposerMargin, positionCommandSuggestions, resizeComposer };

registerTuiParsers();

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

export function quietHintColumns(): number {
    return HUD_HINT.length + MODEL_PICKER_HINT.length + SIDEBAR_HINT.length + 6;
}
export const WORKING_HINT = `esc stop · ${tuiKeyHint("interrupt")}`;
export const STOPPING_HINT = "stopping…";
const CONNECTION_FAILURE_HINT_LIMIT = 44;

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
export const DOUBLE_ESCAPE_REWIND_WINDOW_MS = 500;
export const SUGGESTIONS_RESERVED_ROWS = 12;

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
    /** How Outrider is found and run. Supplied by a test that has no binary on the machine. */
    readonly outrider?: OutriderDriver;
    readonly appearance?: TuiAppearance;
    readonly copyText?: (text: string) => Promise<void>;
    readonly openConfigurationFile?: (path: string) => Promise<void>;
    readonly openConfigure?: () => Promise<void>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    readonly forgetProvider?: (provider: string, workspace?: string) => Promise<ModelTurnSettings | undefined>;
    readonly operateModels?: (operation: ModelOperation, onResult: (result: ModelOperationResult) => void, workspace?: string) => Promise<ModelTurnSettings | undefined>;
    readonly readHostModelSettings?: (
        workspace: string,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly refreshHostCatalog?: (
        provider: string,
        workspace: string,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly homeHasSessions?: boolean;
    readonly listSessionPage?: (
        options: ListAgentsOptions,
    ) => Promise<ListedAgentsPage>;
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
    readonly closeSession?: (agentId: string) => Promise<CloseAgentResult>;
    readonly searchSessions?: (
        query: SessionSearchQuery,
    ) => Promise<SessionSearchResults>;
    readonly reconnectSession?: (
        agentId: string,
        options?: { readonly replaceExisting?: boolean },
    ) => Promise<TuiAgentClient>;
    readonly onSessionEntered?: (agentId: string) => void;
    readonly initialDraft?: TuiDraft;
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
    readonly doctor?: () => Promise<VeraDoctorReport>;
    readonly openUsagePage?: () => Promise<AnnexUrlResult>;
    /** Test override for `~/.vera/auth.json`. */
    readonly authStorage?: AuthStorage;
    readonly probeHealthRung?: (
        rung: HealthRung,
        signal: AbortSignal,
    ) => Promise<boolean>;
    readonly healthEnv?: Readonly<Record<string, string | undefined>>;
    readonly loginProvider?: (
        providerId: string,
        onAuthorizationUrl: (url: string) => void,
    ) => Promise<void>;
    readonly flightRecorder?: TuiFlightRecorder;
    readonly createRenderer?: () => Promise<CliRenderer>;
}

export interface TuiDraft {
    readonly text: string;
    readonly attachmentIds: readonly string[];
}

export interface TuiExit {
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
    // Optional: requiring config made attach fail against an already-running host.
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
    const homeHasSessions = resolvedTarget.type !== "home"
        ? undefined
        : await hostHasSessions(host.socket_path);
    const client = agentId === undefined
        ? createHomeClient(process.cwd(), {
            readModelSettings: (workspace) =>
                readModelSettingsThroughHost(host.socket_path, workspace),
            refreshCatalog: (provider, workspace) =>
                refreshCatalogThroughHost(host.socket_path, provider, workspace),
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
    const attach = (id: string) => agentClients.attach(id);
    try {
        const listAgents = () => listAgentsThroughHost(host.socket_path);
        const listSessionPage = (options: ListAgentsOptions) =>
            listAgentPageThroughHost(host.socket_path, options);
        const worktreeNotice = worktreeRuntimeNotice();
        const startupNotices = [
            ...(worktreeNotice === undefined ? [] : [worktreeNotice]),
            ...poolFileIssueNotices(
                loadPoolFile({ projectRoot: process.cwd() }).issues,
            ),
        ];
        const exit = await startTui({
            client,
            forgetProvider: (provider, workspace) => forgetProviderThroughHost(host.socket_path, provider, workspace),
            operateModels: (operation, onResult, workspace) => operateModelsThroughHost(host.socket_path, operation, onResult, workspace),
            readHostModelSettings: (workspace) =>
                readModelSettingsThroughHost(host.socket_path, workspace),
            refreshHostCatalog: (provider, workspace) =>
                refreshCatalogThroughHost(host.socket_path, provider, workspace),
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
            // Search through the host; a client-resolved path can miss the attached profile.
            searchSessions: (query) =>
                searchSessionsThroughHost(host.socket_path, query),
            reconnectSession: async (currentAgentId, options) => {
                // Typed /reconnect confirms a wedge. Auto-restart after a drop does not. A busy host must refuse.
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

    rt.client = rt.dependencies.client;
    rt.homeClientOptions = {
        ...(rt.dependencies.readHostModelSettings === undefined
            ? {}
            : { readModelSettings: rt.dependencies.readHostModelSettings }),
        ...(rt.dependencies.refreshHostCatalog === undefined
            ? {}
            : { refreshCatalog: rt.dependencies.refreshHostCatalog }),
    };
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
    // Request the kitty keyboard protocol so ctrl+shift chords actually arrive.
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
    // One automatic host restart per drop. Clear only after the reconnected session is idle, or a dying worker loops.
    rt.hostReconnectAttempted = false;
    // agent_failed already arrived; the later stream close is not a dropped host.
    rt.agentFailedThisAttachment = false;
    rt.statusNoticeVersion = 0;
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
    rt.dismissedComposeSuggesters = new Set<string>();

    rt.pendingAgentCatalogs = new Map<
        string,
        (catalog: TuiAgentCatalog | undefined) => void
    >();
    rt.pendingSkillInvocations = new Map<string, string>();
    rt.messageInterceptPending = false;
    rt.standingNudgesProfileDirectory = veraProfileDirectory();
    rt.standingNudgeRules = readStandingNudgeRules(rt);

    rt.workspaceSidebarFocused = false;
    rt.workspaceSidebarDocked = loadTuiWorkspaceSidebarDocked();
    rt.workspaceRailPreferred = loadTuiWorkspaceSidebarWidth();
    rt.workspaceRailDragging = false;
    rt.workspacePinnedIds = loadTuiPinnedSessionIds();
    // /back is a single origin, not a stack. Hold the id; resolve path and title from the listing.
    rt.terminalFocused = true;
    rt.searchInFlight = false;

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
    rt.pendingPoolChanges = new Map<string, PoolChangeUndo>();
    rt.pendingPoolUndos = new Map<string, {
        readonly undo: PoolChangeUndo;
        readonly completesOnSettings: boolean;
    }>();
    rt.catalogRefreshes = new Map<string, string>();
    /** The settings change each in-flight admission was meant to end in, applied when its "added" verdict lands. */
    rt.sessionTrashPending = false;
    rt.sessionCloseConfirm = false;
    rt.commandSuggestionIndex = 0;
    rt.commandSuggestionMoved = false;
    rt.argumentSuggestions = [];
    rt.extensionMentions = [];
    rt.activity = "thinking";
    rt.themeApplicationVersion = 0;
    rt.clientGeneration = 0;
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
                    // Shutdown already released the pane; keep its durable restore record.
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
    rt.transcriptWorking = new TextRenderable(rt.renderer, {
        id: "transcript-working",
        width: "100%",
        height: 1,
        flexShrink: 0,
        marginTop: 1,
        marginLeft: rt.appearance.activityIndent,
        visible: false,
    });
    rt.transcript.add(rt.transcriptWorking);

    // Parallel sparse arrays keyed by reduced transcript index; assign or delete node and kind together.
    rt.entryNodes = [];
    rt.entryNodeKinds = [];
    rt.entryNodeSources = new WeakMap<
        TextRenderable | MarkdownRenderable | BoxRenderable,
        TuiTranscriptEntry
    >();
    rt.materializedEntryStart = 0;
    rt.materializedEntryEnd = 0;
    rt.measuredEntryRows = [];
    rt.measuredEntryRowsWidth = 0;
    rt.sidebarEntryNodes = [];
    rt.sidebarEntryNodeKinds = [];
    rt.sidebarEntryGeneration = 0;

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
        // No borderColor either: OpenTUI treats any border* option as wanting a border and overrides border: false.
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
    // Status glyphs do not fill the row; the band must be the same box so hiding a row also hides the paint.
    rt.statusBand = new BoxRenderable(rt.renderer, {
        id: "status-band",
        position: "absolute",
        left: 0,
        bottom: APP_PADDING_BOTTOM,
        width: "100%",
        height: "auto",
        flexDirection: "column",
        // Indent lives on the band: a flex text child does not carry its own padding.
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

    rt.tipsConfig = loadOptionalVeraConfig();
    rt.tipsEnabled = rt.tipsConfig === undefined
        || configuredTipsEnabled(rt.tipsConfig);
    rt.tipState = rt.tipsEnabled
        ? beginTuiTipLaunch()
        : { launches: 0, history: {} };
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

    rt.quoteText = new TextRenderable(rt.renderer, {
        id: "pending-quote",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });
    rt.statusBand.add(rt.quoteText);

    rt.heldAddressText = new TextRenderable(rt.renderer, {
        id: "held-address",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });

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
        // The editor value is not what submitPrompt's parameter means.
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
    rt.extensionsListView = createTuiExtensionsListView(rt.renderer);
    rt.commandPaletteView = createTuiCommandPaletteView(rt.renderer);
    rt.workTabView = createTuiLinesView(rt.renderer, "work-tab");
    rt.workspaceSidebarView = createTuiLinesView(
        rt.renderer,
        "workspace-sidebar",
        { railDivider: true, railPadding: 2 },
    );
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
    rt.overridesResetConfirmView =
        createTuiOverridesResetConfirmView(rt.renderer);
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
        rt.extensionsListView,
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
        rt.overridesResetConfirmView,
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
        rt.extensionsList = undefined;
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

    rt.composerMarginRows = 2;
    rt.agentNoticeRows = 0;
    rt.jsonlCommandMode = false;

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
        homeNeedsProvider(rt),
    );
    rt.homeSubmitPending = false;
    rt.onboardingPromptWaiting = false;
    rt.onboardingPromptRequest = undefined;
    rt.homeView = createTuiHomeView(rt.renderer, (action) => {
        runHomeAction(rt, action);
    });
    rt.homeView.applyAppearance({
        textColor: rt.theme.text,
        mutedColor: rt.theme.muted,
        accentColor: rt.theme.accent,
        successColor: rt.theme.success,
        backgroundColor: rt.theme.background,
    });
    rt.homeView.update(rt.homeState);
    rt.onboardingWizard = undefined;
    rt.onboardingWizardTimer = undefined;
    rt.onboardingRuntimeCommand = undefined;
    rt.onboardingCatalogRefresh = undefined;
    rt.onboardingWizardView = createTuiOnboardingView(rt.renderer, (action) => {
        runOnboardingWizardAction(rt, action);
    });
    rt.onboardingWizardView.applyAppearance({
        textColor: rt.theme.text,
        mutedColor: rt.theme.muted,
        accentColor: rt.theme.accent,
        dangerColor: rt.theme.danger,
        successColor: rt.theme.success,
        backgroundColor: rt.theme.background,
    });
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
                    }
                }
                return;
            }
            if (rt.bodyFocus.release(anyOverlayOpen(rt))) {
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
            }
        },
        onHeaderClick: (() => toggleSidebarHeader(rt)),
        onMainHeaderClick: (() => toggleMainHeader(rt)),
        onPanelRelease: () => {
            if (rt.hostedSidebar.pane === undefined || anyOverlayOpen(rt)) return;
            rt.composer.focus();
            renderState(rt);
        },
        onPanelClick: () => {
            if (rt.hostedSidebar.pane !== undefined) {
                return;
            }
            const declared = rt.clientExtensionRegistry
                ?.experimentalHostedAgentAddressing(rt.hostedSidebar.owner);
            const first = declared?.secondary ?? visibleMentions(rt)[0];
            if (first === undefined) return;
            // Already addressing someone: a second click must not stack another mention.
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

    /** Keep a side agent's running pair while accepting the main host's fresh global shortlist. */

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
        left: 0,
        top: -APP_PADDING_TOP,
        bottom: -APP_PADDING_BOTTOM,
        width: "100%",
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
    rt.timelinePickerView.pointer = rowPointer(rt, (index) => {
        if (rt.timelinePicker === undefined) return;
        if (rt.timelinePicker.screen !== "select") return;
        rt.timelinePicker = { ...rt.timelinePicker, selectedIndex: index };
    });
    rt.settingsPickerView.pointer = rowPointer(rt, (index) => {
        if (rt.settingsPicker === undefined) return;
        rt.settingsPicker = moveTuiSettingsPickerPointer(rt.settingsPicker, index);
    });
    rt.settingsPickerView.onTab = (tab) => {
        const pane = rt.settingsPicker?.kind === "provider"
            ? rt.settingsPicker.parent
            : rt.settingsPicker;
        if (pane === undefined || pane.kind !== "model") {
            return;
        }
        // A click on a chip is the same act as tabbing onto it: the reader is
        // choosing tabs, so they are left on the strip with the page beneath.
        rt.settingsPicker = { ...switchedModelTab(pane, tab), pickerLevel: "strip" };
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
    rt.approvalView.pointer = rowPointer(rt, () => {}, "digit");
    rt.questionView.pointer = rowPointer(rt, () => {}, "digit");
    rt.settingsPickerView.box.onMouseScroll = (event) => {
        const scroll = event.scroll;
        if (rt.settingsPicker === undefined || scroll === undefined) return;
        const transition = handleTuiSettingsPickerScroll(rt.settingsPicker, scroll);
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        applySettingsPickerTransition(rt, transition);
    };
    rt.app.add(rt.settingsPickerView.surface);
    rt.app.add(rt.secretPromptView.box);
    rt.app.add(rt.namePromptView.surface);
    rt.app.add(rt.providerFormView.surface);
    rt.app.add(rt.requestOptionsEditorView.surface);
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
    rt.extensionsListView.pointer = rowPointer(rt, (index) => {
        if (rt.extensionsList === undefined) return;
        rt.extensionsList = rt.extensionsList.screen === "detail"
            ? { ...rt.extensionsList, actionIndex: index }
            : { ...rt.extensionsList, selectedIndex: index };
    });
    rt.extensionsListView.box.onMouseScroll = (event) => {
        if (rt.extensionsList === undefined || event.scroll === undefined) return;
        if (rt.extensionsListView.scroll(event.scroll)) {
            event.preventDefault();
            event.stopPropagation();
        }
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
    rt.app.add(rt.extensionsListView.box);
    rt.app.add(rt.commandPaletteView.surface);
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
    rt.workspaceSidebarView.pointer = {
        hover: (rowId) => {
            if (focusedUiRequest(rt) !== undefined) return;
            if (rt.workspaceSidebar === undefined) return;
            if (rt.workspaceSidebar.selectedId === rowId) return;
            rt.workspaceSidebar = { ...rt.workspaceSidebar, selectedId: rowId };
            renderState(rt);
        },
        activate: (rowId) => {
            // A question or approval owns this session pane. The rail stays visible for context, but its dimmed controls must not queue a hidden picker or start a session transition behind.
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
    rt.app.add(rt.overridesResetConfirmView.surface);
    rt.app.add(rt.composerTipText);
    rt.app.add(rt.experimentalTuiHost.footer);
    rt.app.add(rt.experimentalTuiHost.composerAdornment);
    rt.app.add(rt.heldAddressText);
    rt.app.add(rt.dialCard);
    rt.app.add(rt.homeView.surface);
    rt.app.add(rt.onboardingWizardView.surface);
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

    rt.renderCoalescer = createRenderCoalescer({ render: (() => renderState(rt)) });

    rt.renderer.on(CliRenderEvents.FRAME, () => {
        settleTranscriptScrollState(rt);
        measureMaterializedTranscriptEntries(rt);
        if (
            rt.pendingSearchTarget === undefined
            && !maybeSnapTranscriptWindowToTail(rt)
            && !maybeMaterializeEarlierTranscriptEntries(rt)
            && !maybeMaterializeLaterTranscriptEntries(rt)
        ) {
            maybeEvictTranscriptEntries(rt);
        }
        if (rt.pendingTranscriptScrollAnchor !== undefined) {
            rt.renderer.root.calculateLayout();
            applyTranscriptScrollAnchor(rt);
        }
        showSearchTarget(rt);
    });

    let lastTimedSurfaceRefresh = 0;
    rt.statusTimer = setInterval(() => {
        renderStatus(rt);
        if (Date.now() - lastTimedSurfaceRefresh >= STATUS_REFRESH_INTERVAL_MS) {
            refreshTimedSurfaces(rt);
            lastTimedSurfaceRefresh = Date.now();
        }
    }, rt.activityAnimation === "off"
        ? STATUS_REFRESH_INTERVAL_MS
        : SHIMMER_FRAME_INTERVAL_MS);
    watchBackgroundAgents(rt, rt.dependencies.client);
    watchWorkIndex(rt, rt.dependencies.client);
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
                    speaker: entry.kind === "user" ? "you" : "agent",
                }];
            }),
            ...rt.sidebar.blocks(),
        ];
        if (
            isTranscriptSelection(selection, [
                rt.composer,
                ...copyableNodes,
                ...rt.sidebar.blocks().map((block) => block.node),
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
        if (
            visibleMentions(rt).length > 0 && speaker !== undefined
            && selected.trim().length > 0
        ) {
            rt.pendingQuote = { source: speaker, text: selected };
            if (!anyOverlayOpen(rt)) {
                rt.composer.focus();
            }
            renderState(rt);
        }
    });

    rt.renderer.keyInput.on("paste", (event) => {
        rt.lastIdleEscapeAt = undefined;
        const uiRequest = focusedUiRequest(rt);
        const pasted = (): string =>
            stripAnsiSequences(decodePasteBytes(event.bytes));
        if (
            rt.onboardingWizard !== undefined
            && wizardFieldIsOpen(onboardingInput(rt), rt.onboardingWizard)
        ) {
            event.preventDefault();
            event.stopPropagation();
            updateWizardSession(rt, {
                ...rt.onboardingWizard,
                key: rt.onboardingWizardView.handleFieldPaste(pasted()),
            });
            return;
        }
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
            && rt.settingsPickerView.surface.visible
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
            rt.providerForm = rt.providerFormView.handlePaste(
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
        rt.secretPrompt = rt.secretPromptView.handlePaste(
            rt.secretPrompt,
            stripAnsiSequences(decodePasteBytes(event.bytes)),
        );
        renderState(rt);
    });

    rt.renderer.keyInput.on("keypress", ((key: KeyEvent) => handleKeypress(rt, key)));
    rt.lastInputRecordAt = 0;

    rt.settingsSnapshotRetries = new WeakMap<TuiAgentClient, number>();
    rt.MAX_SETTINGS_SNAPSHOT_RETRIES = 5;

    void receiveAgentUpdates(rt);
    if (rt.client.failed !== true && rt.client.viewOnly !== true) {
        void loadExtensionCommands(rt);
        requestSkillCommands(rt);
        requestSessionSettings(rt);
    } else if (isHomeClient(rt.client)) {
        requestSessionSettings(rt);
    }
    void restorePersistedAgentPane(rt);
    if (rt.workspaceSidebarDocked) {
        openWorkspaceSidebar(rt, { focus: false, persist: false });
    }

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
        const unreadable = unreadableAuthStoragePath();
        if (unreadable !== undefined) {
            rt.state = appendTuiError(
                rt.state,
                `${unreadable} could not be read, so no provider shows as connected. Connecting one rewrites it.`,
            );
        }
    }
    rt.connectingProviders = new Set<string>();

    rt.poolAdmissionAttempts = new Map<string, {
        readonly provider: string;
        readonly model: string;
        readonly verify: boolean;
        readonly retry: boolean;
    }>();
    rt.pendingOnboardingStep = undefined;
    rt.onboardingVerification = undefined;

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
            successColor: activeTheme.success,
            backgroundColor: activeTheme.background,
        }),
        (activeTheme) => rt.onboardingWizardView.applyAppearance({
            textColor: activeTheme.text,
            mutedColor: activeTheme.muted,
            accentColor: activeTheme.accent,
            dangerColor: activeTheme.danger,
            successColor: activeTheme.success,
            backgroundColor: activeTheme.background,
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
        tuiThemeProperties(rt.extensionsListView.box, {
            backgroundColor: "panel",
        }),
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
        ...rt.overridesResetConfirmView.themeBindings,
    ];

    return rt.finished.promise;

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

const OVERRIDE_FIELD_NAMES: Readonly<Record<string, string>> = {
    contextLimit: "context limit",
    compactionTriggerFraction: "compaction trigger",
    compactionTriggerTokens: "compaction trigger tokens",
    compactionTargetTokens: "compaction target tokens",
    postCompactionTargetFraction: "post-compaction target",
    summaryWordCap: "summary word cap",
    retainedUserTurns: "retained user turns",
    toolResultCeilingBytes: "tool result ceiling",
    toolResultTotalBudgetBytes: "tool result budget",
    toolResultStubAfterTurns: "stub after turns",
    toolResultAgingLevel: "aging level",
};

export function overrideChangeLabel(
    patch: OverrideSettingsPatch | null,
): string {
    if (patch === null) {
        return "every override back to its default";
    }
    const [field, value] = Object.entries(patch)[0] ?? [];
    const name = field === undefined
        ? "overrides"
        : OVERRIDE_FIELD_NAMES[field] ?? "overrides";
    return value === null || value === undefined
        ? `${name} back to its default`
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
