import { isConfigurationRequiredUiRequestUpdate, isTimelineReplyUpdate } from "../../../src/engine/protocol.ts";
import { anyOverlayOpen, applyTimelineTransition, catalogRefreshSweepResult, defaultModelChangeNotice, dropSettledVerificationConsole, failPendingSkillInvocations, finishStreamingAssistant, finishThoughtPhase, focusActiveSurface, hideVerificationConsole, modelPickerActionOptions, notifyExtensionSettings, observeActivity, openNamePrompt, poolVerifySweepResult, receiveSkillCatalog, receiveSkillInvocation, refreshSessionPicker, refreshWorkspaceSidebarRoster, rejectPendingExtensionSettingsFor, rejectionNotice, renderJumpToBottom, renderState, reportConnectionError, requestSkillCommands, retryPoolAdmission, sendCommand, settleExtensionModelSettings, showStatusNotice, syncConfigurationRequiredRequest } from "../main.ts";
import { closeTransientOverlaysForUiRequest, hostOwnsPromptQueue, modelSettingsForOpenPicker, receiveDialHistory, setSidebarFocused } from "../main/agents-dials.ts";
import { adoptFallbackSessionTitle, applyTerminalTitle, refreshTerminalTitle } from "../main/chrome.ts";
import { isSettingsRetryTrigger, noticeRepeatedModelFailure, retryMissingAgentSettings } from "../main/diagnostics-ops.ts";
import { settleWizardVerification, wizardTookCatalogRefresh, wizardTookModelSettings } from "../main/onboarding-wizard-ops.ts";
import { releaseDroppedImage } from "../main/prompt-routing.ts";
import { submitPrompt } from "../main/submit-prompt.ts";
import { syncTuiPreferencesList } from "../preferences-list.ts";
import { startTuiOverridesMenu, startTuiReviewerMenu, syncTuiModelPicker, withTuiPickerParent } from "../settings-picker.ts";
import { appendTuiError, appendTuiNotice, applyAgentUpdate, beginNextQueuedTuiTurn } from "../state.ts";
import { applyTuiTimelineReply } from "../timeline-picker.ts";
import { applyTuiUiRequestUpdate } from "../ui-request-queue.ts";
import type { TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";
import { refreshProviderPicker } from "./model-pickers.ts";

export async function receiveAgentUpdates(rt: TuiRuntime): Promise<void> {
    const generation = rt.clientGeneration;
    const source = rt.client;
    try {
        while (!rt.shuttingDown && generation === rt.clientGeneration) {
            const update = await source.receive();
            if (rt.shuttingDown || generation !== rt.clientGeneration) {
                return;
            }
            if (
                rt.sessionSwitchPending
                && rt.sessionSwitchOperation === "clear"
                && rt.sessionSwitchClearingMain
            ) {
                rt.sessionSwitchBufferedUpdates.push(update);
                continue;
            }
            if (
                update.type === "image_attached"
                || update.type === "image_attachment_rejected"
            ) {
                releaseDroppedImage(rt, update.requestId);
                const imageIndex = rt.pendingImages.findIndex(
                    (image) => image.requestId === update.requestId,
                );
                if (imageIndex === -1) continue;
                if (update.type === "image_attached") {
                    rt.pendingImages[imageIndex] = {
                        ...rt.pendingImages[imageIndex],
                        requestId: update.requestId,
                        id: update.attachment.id,
                        name: update.attachment.name,
                    };
                    showStatusNotice(rt, 
                        `attached ${update.attachment.name} · ${rt.pendingImages.length} pending`,
                    );
                    if (
                        rt.submitAfterImageAttachment
                        && rt.pendingImages.every((image) => image.id !== undefined)
                    ) {
                        rt.submitAfterImageAttachment = false;
                        queueMicrotask(((interceptedText?: string, injectedPrefix?: number) => submitPrompt(rt, interceptedText, injectedPrefix)));
                    }
                } else {
                    rt.submitAfterImageAttachment = false;
                    const [rejected] = rt.pendingImages.splice(imageIndex, 1);
                    if (rejected !== undefined) {
                        rt.composer.removeImageChip(rejected.requestId);
                    }
                    rt.state = appendTuiError(
                        rt.state,
                        `Could not attach image: ${update.error}`,
                    );
                    renderState(rt);
                }
                rt.composer.focus();
                continue;
            }
            if (
                update.type === "oneshot_result"
                || update.type === "oneshot_rejected"
            ) {
                const pending = rt.pendingOneshots.get(update.requestId);
                if (pending === undefined) continue;
                if (update.type === "oneshot_result") {
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
                if (update.requestId !== rt.pendingSessionRename?.requestId) {
                    continue;
                }
                const pending = rt.pendingSessionRename;
                rt.pendingSessionRename = undefined;
                if (update.type === "session_name") {
                    rt.state = appendTuiNotice(
                        rt.state,
                        update.name === null
                            ? "session name cleared"
                            : `session renamed: ${update.name}`,
                    );
                    if (update.name === null) {
                        rt.sessionTitle = undefined;
                        refreshTerminalTitle(rt);
                    } else {
                        rt.sessionTitle = update.name;
                        applyTerminalTitle(rt);
                    }
                } else {
                    if (
                        pending.commandText !== undefined
                        && rt.composer.expandedText().length === 0
                    ) {
                        rt.composer.setComposerText(pending.commandText);
                    }
                    rt.state = appendTuiError(
                        rt.state,
                        update.reason === "invalid"
                            ? "Session name must be 1 to 200 UTF-8 bytes"
                            : "Could not rename this session",
                    );
                }
                if (
                    update.type === "session_name"
                    && rt.settingsPicker?.kind === "session"
                ) {
                    void refreshSessionPicker(rt);
                }
                if (
                    update.type === "session_name"
                    && rt.workspaceSidebar !== undefined
                ) {
                    refreshWorkspaceSidebarRoster(rt);
                }
                renderState(rt);
                if (!anyOverlayOpen(rt)) {
                    rt.composer.focus();
                }
                focusActiveSurface(rt);
                continue;
            }
            if (
                update.type === "ui_request"
                || update.type === "ui_request_closed"
            ) {
                if (update.type === "ui_request") {
                    if (rt.pendingUiRequest === undefined) {
                        rt.followTranscriptAfterUiRequest = rt.transcript.scrollTop
                            >= rt.transcript.scrollHeight
                                - rt.transcript.viewport.height;
                    }
                    if (!(
                        isConfigurationRequiredUiRequestUpdate(update)
                        && rt.activeConfigurationRequest !== undefined
                        && rt.activeConfigurationRequest.requestId
                            !== update.requestId
                    )) {
                        setSidebarFocused(rt, false);
                    }
                    finishThoughtPhase(rt);
                    rt.phaseSince = undefined;
                    rt.activity = update.request.type === "tool_approval"
                        ? "waiting for approval"
                        : update.request.type === "configuration_required"
                        ? "waiting for configuration"
                        : "waiting for answer";
                } else {
                    rt.phaseSince = undefined;
                    rt.activity = "resuming";
                }
                const previousRequest = rt.pendingUiRequest;
                rt.pendingUiRequest = applyTuiUiRequestUpdate(
                    rt.pendingUiRequest,
                    rt.queuedUiRequests,
                    update,
                );
                if (
                    previousRequest === undefined
                    && rt.pendingUiRequest !== undefined
                ) {
                    closeTransientOverlaysForUiRequest(rt);
                }
                if (rt.pendingUiRequest !== previousRequest) {
                    syncConfigurationRequiredRequest(rt, 
                        rt.pendingUiRequest,
                        rt.client,
                    );
                    renderState(rt);
                    if (
                        update.type === "ui_request_closed"
                        && rt.pendingUiRequest === undefined
                        && rt.followTranscriptAfterUiRequest
                    ) {
                        rt.transcript.scrollTo(rt.transcript.scrollHeight);
                        rt.followTranscriptAfterUiRequest = false;
                        renderJumpToBottom(rt);
                    }
                    focusActiveSurface(rt);
                }
                continue;
            }
            if (isTimelineReplyUpdate(update)) {
                if (rt.timelinePicker !== undefined) {
                    applyTimelineTransition(rt, 
                        applyTuiTimelineReply(
                            rt.timelinePicker,
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
                const poolChange = rt.pendingPoolChanges.get(update.requestId);
                rt.pendingPoolChanges.delete(update.requestId);
                if (
                    poolChange !== undefined
                    && update.type === "model_settings"
                ) {
                    rt.poolChangeUndo = poolChange;
                }
                const pendingUndo = rt.pendingPoolUndos.get(update.requestId);
                rt.pendingPoolUndos.delete(update.requestId);
                if (
                    pendingUndo?.completesOnSettings === true
                    && update.type === "model_settings"
                ) {
                    rt.poolChangeUndo = undefined;
                    showStatusNotice(rt, "library change undone");
                } else if (
                    pendingUndo !== undefined
                    && update.type === "model_settings_rejected"
                ) {
                    rt.poolChangeUndo = pendingUndo.undo;
                    if (rt.settingsPicker?.kind === "model") {
                        rt.settingsPicker = {
                            ...rt.settingsPicker,
                            canUndoPoolChange: true,
                        };
                    }
                    rt.state = appendTuiError(
                        rt.state,
                        rejectionNotice("undo that library change", update.reason),
                    );
                }
                settleExtensionModelSettings(rt, update, rt.client);
                const change = rt.requestedModelChanges.get(
                    update.requestId,
                );
                if (change?.target === rt.client) {
                    rt.requestedModelChanges.delete(update.requestId);
                }
                if (
                    change?.target === rt.client
                    && update.type === "model_settings"
                    && update.updatedDefaults === true
                ) {
                    rt.state = appendTuiNotice(
                        rt.state,
                        defaultModelChangeNotice(
                            change.patch,
                            update.settings,
                        ),
                        "soft",
                    );
                } else if (
                    change?.target === rt.client
                    && update.type === "model_settings_rejected"
                ) {
                    rt.state = appendTuiError(
                        rt.state,
                        rejectionNotice(change.subject, update.reason),
                    );
                }
                if (rt.onboardingPromptRequest === update.requestId) {
                    // A prompt typed before the provider existed. It runs now
                    // that its model is live; a rejection leaves it in the
                    // composer for the user to send or edit.
                    rt.onboardingPromptRequest = undefined;
                    rt.onboardingPromptWaiting = false;
                    if (update.type === "model_settings") {
                        submitPrompt(rt);
                    }
                }
            }
            if (update.type === "pool_admission_result") {
                hideVerificationConsole(rt, update.requestId);
            }
            dropSettledVerificationConsole(rt);
            observeActivity(rt, update);
            if (
                update.type === "pool_admission_result"
                && retryPoolAdmission(rt, update.requestId, update.verdict)
            ) {
                renderState(rt);
                continue;
            }
            if (update.type === "skill_catalog") {
                receiveSkillCatalog(rt, update);
                continue;
            }
            if (
                update.type === "skill_invocation_accepted"
                || update.type === "skill_invocation_rejected"
            ) {
                receiveSkillInvocation(rt, update);
                continue;
            }
            rt.state = applyAgentUpdate(rt.state, update);
            if (update.type === "session_model_settings_history") receiveDialHistory(rt, update, source);
            if (isSettingsRetryTrigger(rt, update)) {
                retryMissingAgentSettings(rt, source, rt.state);
            }
            if (
                update.type === "compaction"
                && update.phase === "finished"
                && update.outcome !== "busy"
                && update.stoppedWithTurn !== true
            ) {
                rt.abortRequested = false;
            }
            if (
                update.type === "turn_finished"
                && update.outcome === "error"
            ) {
                rt.state = noticeRepeatedModelFailure(rt, rt.state);
            }
            if (update.type === "agent_catalog") {
                rt.agentCatalog = {
                    selected: update.selected,
                    agents: update.agents,
                    notices: update.notices,
                };
                rt.pendingAgentCatalogs.get(update.requestId)?.(rt.agentCatalog);
                rt.pendingAgentCatalogs.delete(update.requestId);
            }
            if (update.type === "agent_selected" && rt.agentCatalog !== undefined) {
                rt.agentCatalog = { ...rt.agentCatalog, selected: update.name };
            }
            if (
                source === rt.client
                && (update.type === "agent_selected"
                    || update.type === "turn_finished")
            ) {
                requestSkillCommands(rt);
            }
            if (
                update.type === "pool_admission_result"
                && poolVerifySweepResult(rt, update.requestId, update.verdict)
            ) {
                renderState(rt);
                continue;
            }
            if (
                update.type === "pool_admission_result"
                && settleWizardVerification(rt, update)
            ) {
                renderState(rt);
                continue;
            }
            if (update.type === "pool_admission_result") {
                const pendingUndo = rt.pendingPoolUndos.get(update.requestId);
                if (
                    pendingUndo !== undefined
                    && update.verdict === "added"
                    && pendingUndo.undo.poolName !== undefined
                ) {
                    rt.pendingPoolUndos.delete(update.requestId);
                    const nameRequestId = randomUUID();
                    rt.pendingPoolUndos.set(nameRequestId, {
                        undo: pendingUndo.undo,
                        completesOnSettings: true,
                    });
                    sendCommand(rt, {
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
                    rt.pendingPoolUndos.delete(update.requestId);
                    rt.poolChangeUndo = pendingUndo.undo;
                    if (rt.settingsPicker?.kind === "model") {
                        rt.settingsPicker = {
                            ...rt.settingsPicker,
                            canUndoPoolChange: true,
                        };
                    }
                }
            }
            if (
                update.type === "pool_admission_result"
                && rt.pendingPoolName?.requestId === update.requestId
            ) {
                const pending = rt.pendingPoolName;
                rt.pendingPoolName = undefined;
                if (update.verdict === "added" && rt.namePrompt === undefined) {
                    openNamePrompt(rt, 
                        {
                            kind: "pool",
                            provider: pending.provider,
                            model: pending.model,
                        },
                        pending.label,
                        rt.settingsPicker?.kind === "model"
                            ? rt.settingsPicker
                            : undefined,
                    );
                }
            }
            if (
                update.type === "model_settings"
                && rt.state.modelSettings !== undefined
                && !rt.sidebar.isFocused()
            ) {
                notifyExtensionSettings(rt, rt.state.modelSettings);
            }
            if (update.type === "model_settings") {
                wizardTookModelSettings(rt);
            }
            if (
                update.type === "model_settings"
                || update.type === "model_settings_rejected"
            ) {
                wizardTookCatalogRefresh(rt, update.requestId);
            }
            if (
                update.type === "model_settings"
                && rt.settingsPicker?.kind === "model"
            ) {
                const pickerSettings = modelSettingsForOpenPicker(rt, 
                    rt.state.modelSettings,
                );
                rt.settingsPicker = syncTuiModelPicker(
                    rt.settingsPicker,
                    {
                        ...(pickerSettings ?? {}),
                        actionOptions: modelPickerActionOptions(rt, 
                            pickerSettings,
                        ),
                    },
                );
                if (rt.poolChangeUndo !== undefined) {
                    rt.settingsPicker = {
                        ...rt.settingsPicker,
                        canUndoPoolChange: true,
                    };
                }
            }
            if (
                (update.type === "model_settings"
                    || update.type === "model_settings_rejected")
                && catalogRefreshSweepResult(rt, 
                    update.requestId,
                    update.type === "model_settings",
                )
            ) {
            } else if (
                (update.type === "model_settings"
                    || update.type === "model_settings_rejected")
                && rt.catalogRefreshes.has(update.requestId)
            ) {
                const provider = rt.catalogRefreshes.get(update.requestId)!;
                rt.catalogRefreshes.delete(update.requestId);
                if (update.type === "model_settings_rejected") {
                    refreshProviderPicker(rt, `Could not refresh ${provider}; its saved list stands.`);
                    showStatusNotice(rt, 
                        `could not ask ${provider}, its saved list stands`,
                    );
                } else {
                    const count = (rt.state.modelSettings?.availableModels ?? [])
                        .filter((entry) => entry.provider === provider)
                        .length;
                    showStatusNotice(rt, `${provider}: ${count} models`);
                    refreshProviderPicker(rt, `${provider}: ${count} models`);
                }
            }
            if (
                update.type === "model_settings"
                && rt.settingsPicker?.kind === "reviewer_settings"
            ) {
                rt.settingsPicker = withTuiPickerParent(
                    startTuiReviewerMenu(rt.state.modelSettings?.reviewerDefault),
                    rt.settingsPicker.parent,
                );
            }
            if (
                update.type === "model_settings"
                && rt.settingsPicker?.kind === "overrides_settings"
            ) {
                // The rows are the same eleven levers either way, so the
                // cursor stays on the one that was just changed.
                const repainted = startTuiOverridesMenu(
                    rt.state.modelSettings?.overrides,
                );
                rt.settingsPicker = withTuiPickerParent(
                    {
                        ...repainted,
                        selectedIndex: Math.min(
                            rt.settingsPicker.selectedIndex,
                            repainted.options.length - 1,
                        ),
                    },
                    rt.settingsPicker.parent,
                );
            }
            if (update.type === "permissions" && rt.preferencesList !== undefined) {
                rt.preferencesList = syncTuiPreferencesList(
                    rt.preferencesList,
                    rt.state.permissionInspection,
                );
            }
            if (update.type === "permissions") {
                rt.requestedPermissionChanges.delete(update.requestId);
            }
            if (update.type === "permissions_rejected") {
                const subject = rt.requestedPermissionChanges.get(
                    update.requestId,
                );
                rt.requestedPermissionChanges.delete(update.requestId);
                if (subject !== undefined) {
                    rt.state = appendTuiError(
                        rt.state,
                        rejectionNotice(subject, update.reason),
                    );
                } else if (rt.preferencesList !== undefined) {
                    rt.state = appendTuiError(
                        rt.state,
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
                rt.composer.loadSubmittedTexts(userTexts);
                if (userTexts[0] !== undefined) {
                    adoptFallbackSessionTitle(rt, userTexts[0]);
                }
                rt.pendingTranscriptReseed = true;
                rt.transcriptSeeded = true;
                for (const notice of rt.deferredKeymapNotices.splice(0)) {
                    rt.state = appendTuiNotice(rt.state, notice);
                }
                if (
                    rt.pendingBackNotice !== undefined
                    && update.entries.length > 0
                ) {
                    rt.state = appendTuiNotice(rt.state, rt.pendingBackNotice);
                    rt.pendingBackNotice = undefined;
                }
                if (rt.pendingSessionSwitchNotice !== undefined) {
                    rt.state = appendTuiNotice(
                        rt.state,
                        rt.pendingSessionSwitchNotice,
                    );
                    rt.pendingSessionSwitchNotice = undefined;
                }
            }
            if (update.type === "status" && update.state === "idle") {
                finishStreamingAssistant(rt);
                rt.hostReconnectAttempted = false;
                rt.abortRequested = false;
            }
            if (update.type === "user_prompt") {
                rt.abortRequested = false;
            }
            if (
                update.type === "turn_finished"
                || update.type === "agent_failed"
            ) {
                if (
                    update.type === "turn_finished"
                    && !hostOwnsPromptQueue(rt, rt.client)
                ) {
                    rt.state = beginNextQueuedTuiTurn(rt.state);
                }
                rt.abortRequested = false;
                finishStreamingAssistant(rt);
                if (update.type === "agent_failed") {
                    rt.agentFailedThisAttachment = true;
                    rt.pendingUiRequest = undefined;
                    rt.timelinePicker = undefined;
                    rt.settingsPicker = undefined;
                }
                if (rt.state.working) {
                    rt.workingSince = Date.now();
                    rt.phaseSince = rt.workingSince;
                    rt.activity = "thinking";
                } else {
                    rt.workingSince = undefined;
                    rt.phaseSince = undefined;
                    rt.activity = "ready";
                }
            }
            rt.renderCoalescer.request(update.type);

            if (update.type === "agent_failed") {
                failPendingSkillInvocations(rt);
                rejectPendingExtensionSettingsFor(rt, 
                    rt.client,
                    new Error(update.detail),
                );
                focusActiveSurface(rt);
                continue;
            }

            if (
                !rt.state.working
                && rt.pendingUiRequest === undefined
                && rt.timelinePicker === undefined
            ) {
                focusActiveSurface(rt);
            }
        }
    } catch (error) {
        if (generation === rt.clientGeneration) {
            failPendingSkillInvocations(rt);
            rejectPendingExtensionSettingsFor(rt, rt.client, error);
            reportConnectionError(rt, error);
        }
    }
}
