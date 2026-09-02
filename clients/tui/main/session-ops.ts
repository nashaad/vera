import type { ModelSettingsPatch } from "../../../src/engine/model-settings.ts";
import type { RegisteredAgentSummary } from "../../../src/host/agent-registry.ts";
import type { TrashSessionResult } from "../../../src/host/session-trash-client.ts";
import { startTuiAdmissionDialog } from "../admission-dialog.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import { createHomeClient, isHomeClient } from "../home-client.ts";
import { createHomeState, type HomeAction } from "../home-screen.ts";
import { createJsonlViewClient, isJsonlViewClient, isWorkerFreeClient } from "../jsonl-view-client.ts";
import { SESSION_SWITCH_TIMEOUT_MS, recentSessionSaveFailure, removeSessionPickerOption, renderCommandSuggestions, renderStatus, requestPoolAdmission, requireIdentifiedClient, showStatusNotice, watchBackgroundAgents, watchWorkIndex, type TuiDraft } from "../main.ts";
import { receiveAgentUpdates } from "../main/agent-updates.ts";
import { focusedAgentClient, focusedAgentState, openExtensionAgent, setSidebarFocused } from "../main/agents-dials.ts";
import { homeNeedsProvider, openProviderPicker } from "../main/model-pickers.ts";
import { applyTerminalTitle, clearSidebarEntryNodes, closeSidebarPane, refreshTerminalTitle } from "../main/chrome.ts";
import { requestSessionSettings } from "../main/diagnostics-ops.ts";
import { loadExtensionCommands, rejectPendingExtensionSettingsFor, requestSkillCommands, supportsSkillCommands } from "../main/extension-bridge.ts";
import { discardCreatedSwitchTarget, discardSwitchTarget, focusActiveSurface, leaveSwitchSource, recordSessionSwitchOutcome, reportConnectionError, withSessionSwitchDeadline } from "../main/focus-switch.ts";
import { clearTranscriptNodes, renderState } from "../main/render-state.ts";
import { forgetPersistedAgentPane, rememberOpenPaneGroup } from "../main/sidebar-pane.ts";
import { submitPrompt } from "../main/submit-prompt.ts";
import { openCommandPalette, openResumePicker, openSearchOverlay, refreshWorkspaceSidebarRoster } from "../main/workspace-ops.ts";
import type { TuiSessionLeaveDisposition, TuiSessionLeaveResult } from "../session-lifecycle.ts";
import { sessionPickerLists, startTuiSessionPicker } from "../settings-picker.ts";
import { appendTuiError, appendTuiNotice, applyAgentUpdate, createTuiState, dropTuiAdmission, setTuiWorkspaceRoot } from "../state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";

export function switchToClient(rt: TuiRuntime, 
    next: TuiAgentClient,
    draft?: TuiDraft,
    options: { readonly preserveSidebar?: boolean } = {},
): void {
    recordSessionSwitchOutcome(rt, "completed");
    const previous = rt.client;
    rt.clientGeneration += 1;
    rt.agentFailedThisAttachment = false;
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
    // A hop the notice never landed in is over; it must not surface in whichever conversation rebuilds next.
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
    rt.extensionsList = undefined;
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
    if (action.kind === "connect_provider") {
        openProviderPicker(rt);
        return;
    }
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
        return;
    }
    if (!isHomeClient(rt.client)) return;
    rt.homeState = createHomeState(
        agents.some((agent) => sessionPickerLists(agent)),
        homeNeedsProvider(rt),
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
