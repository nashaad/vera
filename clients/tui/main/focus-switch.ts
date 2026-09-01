import { isToolApprovalUiRequestUpdate, isUserQuestionUiRequestUpdate } from "../../../src/engine/protocol.ts";
import { HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE } from "../../../src/host/capabilities.ts";
import { HostReplacementBusyError } from "../../../src/host/discovery.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import { isHomeClient } from "../home-client.ts";
import { isJsonlViewClient, isWorkerFreeClient } from "../jsonl-view-client.ts";
import { SESSION_SWITCH_TIMEOUT_MS, closeSessionFailure, currentDraft, reconnectBusyMessage, renderState, switchToClient } from "../main.ts";
import { focusedUiRequest } from "../main/agents-dials.ts";
import { sendCommand } from "../main/extension-bridge.ts";
import type { TuiSessionLeaveDisposition, TuiSessionLeaveResult } from "../session-lifecycle.ts";
import { appendTuiError, failTuiConnection } from "../state.ts";
import type { TuiTimelinePickerTransition } from "../timeline-picker.ts";
import type { TuiRuntime } from "./runtime.ts";

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
    if (isHomeClient(rt.client)) {
        rt.state = appendTuiError(rt.state, message);
        renderState(rt);
        return;
    }
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
