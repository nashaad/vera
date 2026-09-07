import { modelSelectionCleared } from "../../../src/host/model-catalog-settings.ts";
import { isHomeClient } from "../home-client.ts";
import { isApprovalMode } from "../../../src/engine/permissions.ts";
import type { UiRequestUpdate } from "../../../src/engine/protocol.ts";
import { HOST_CAPABILITY_PROMPT_QUEUE_RELEASE, HOST_CAPABILITY_SESSION_SCOPED_STATE } from "../../../src/host/capabilities.ts";
import type { IdentifiedTuiAgentClient, TuiAgentClient } from "../agent-client.ts";
import { visibleTuiAgentMentions } from "../agent-message-routing.ts";
import { isCurrentTuiExtensionComposeTarget, type TuiExtensionComposeTarget } from "../client-extension-compose.ts";
import { AUTO_MODE_ANIMATION_DURATION_MS } from "../dial-paint.ts";
import { dialAccessAllowed, composeDialStrip, openDialStrip, type DialPair, type DialPoolEntry } from "../dials.ts";
import { abortProviderHealthCheck, displayModeLabel, focusActiveSurface, notifyExtensionSettings, rejectPendingExtensionSettingsFor, rememberOpenPaneGroup, renderState, reportConnectionError, requestAgentSettings, requestExtensionPicker, requestPermissionsChange, sendCommand, showModeToast, showStatusNotice, switchToClient } from "../main.ts";
import { clearSidebarEntryNodes } from "../main/chrome.ts";
import { mergeTuiModelPickerSettings } from "../settings-picker.ts";
import { appendTuiNotice, type TuiState } from "../state.ts";
import type { TuiAgentCatalog, TuiAgentCatalogRow, TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";
import { beginCreateSession, currentDraft } from "./session-ops.ts";

export async function openExtensionAgent(rt: TuiRuntime, 
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
        switchToClient(rt, next, undefined, { preserveSidebar: true });
        return;
    }
    const previousSidebarAgent = rt.hostedSidebar.pane;
    if (previousSidebarAgent !== undefined) {
        rejectPendingExtensionSettingsFor(rt, 
            previousSidebarAgent.client,
            new Error("The sidebar agent changed"),
        );
    }
    await rt.hostedSidebar.adopt({
        extensionId,
        client: next,
        replaceOwner: replaceSidebarOwner,
        mention,
        attachmentLifetime,
        initialApprovalMode,
        statusLabel,
        signal,
        activate(_attached, previousModeLabel) {
            rememberOpenPaneGroup(rt);
            rt.sidebarSessionTitle = undefined;
            rt.pendingSidebarSessionRename = undefined;
            clearSidebarEntryNodes(rt);
            rt.sidebar.clear();
            rt.sidebar.setHeader(undefined);
            rt.sidebarHeaderVisible = true;
            rt.sidebar.open();
            setSidebarFocused(rt, true);
            rt.hostedSidebar.start();
            requestAgentSettings(rt, next);
            renderState(rt);
            if (
                previousModeLabel !== undefined
                && statusLabel !== undefined
                && previousModeLabel !== statusLabel
            ) {
                showModeToast(rt, 
                    `Switched from ${displayModeLabel(previousModeLabel)} to ${displayModeLabel(statusLabel)} mode`,
                );
            }
        },
    });
}

export function focusedAgentClient(rt: TuiRuntime): TuiAgentClient {
    return rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined
        ? rt.hostedSidebar.pane.client
        : rt.client;
}

export function isCurrentExtensionComposeTarget(rt: TuiRuntime, 
    target: TuiExtensionComposeTarget,
): boolean {
    return isCurrentTuiExtensionComposeTarget(target, {
        client: focusedAgentClient(rt),
        clientGeneration: rt.clientGeneration,
        surfaceGeneration: rt.composeSurfaceGeneration,
        sessionSwitchPending: rt.sessionSwitchPending,
    });
}

export function focusedAgentState(rt: TuiRuntime): TuiState {
    return rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined
        ? rt.hostedSidebar.pane.state.state
        : rt.state;
}

export function modelSettingsForAgent(rt: TuiRuntime, 
    target: TuiAgentClient | undefined,
): TuiState["modelSettings"] {
    if (target === undefined || target === rt.client) {
        return rt.state.modelSettings;
    }
    return rt.hostedSidebar.pane?.client === target
        ? rt.hostedSidebar.pane.state.state.modelSettings
        : undefined;
}

export function modelSettingsForOpenPicker(rt: TuiRuntime, 
    poolSource?: TuiState["modelSettings"],
): TuiState["modelSettings"] {
    const target = modelSettingsForAgent(rt, rt.settingsPickerAgent);
    return mergeTuiModelPickerSettings(target, poolSource);
}

export function dialPool(rt: TuiRuntime): readonly DialPoolEntry[] {
    return (focusedAgentState(rt).modelSettings?.pooled ?? []).map(
        (entry) => ({
            provider: entry.provider,
            model: entry.model,
            poolName: entry.displayName ?? entry.poolName ?? entry.label,
            levels: entry.levels.map((level) => level.id),
            ...(entry.defaultLevel === undefined
                ? {}
                : { defaultLevel: entry.defaultLevel }),
            available: entry.available,
        }),
    );
}

export function dialCatalog(rt: TuiRuntime): readonly DialPoolEntry[] {
    return (focusedAgentState(rt).modelSettings?.availableModels ?? []).map(
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

export function committedDialPair(rt: TuiRuntime): DialPair | undefined {
    if (isHomeClient(focusedAgentClient(rt))) return undefined;
    const settings = focusedAgentState(rt).modelSettings;
    return settings === undefined || modelSelectionCleared(settings) ? undefined : {
        ...(settings.provider === undefined
            ? {}
            : { provider: settings.provider }),
        model: settings.model,
        ...(settings.reasoningEffort === undefined
            ? {}
            : { effort: settings.reasoningEffort }),
    };
}

export function openDials(rt: TuiRuntime): void {
    const target = focusedAgentClient(rt);
    if (
        target.supportsHostCapability?.(
            HOST_CAPABILITY_SESSION_SCOPED_STATE,
        ) === false
    ) {
        rt.state = appendTuiNotice(
            rt.state,
            "This host does not support session-scoped state, so the dial strip is unavailable.",
        );
        renderState(rt);
        return;
    }
    const catalog = rt.agentCatalog;
    void target.send({
        type: "get_session_model_settings_history",
        requestId: randomUUID(),
    }).catch(() => {
    });
    const composition = composeDialStrip({
        current: committedDialPair(rt),
        recents: [],
        pool: dialPool(rt),
        catalog: dialCatalog(rt),
        includePool: true,
        cap: Number.POSITIVE_INFINITY,
    });
    rt.dialStrip = openDialStrip(composition, committedDialPair(rt), {
        agents: catalog?.agents.map((agent) => agent.name),
        currentAgent: catalog?.selected ?? focusedAgentState(rt).agent?.name,
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
        permissionModes: ["readonly", "ask", "auto", "full_access"],
        disabledPermissionModes: ["full_access"],
        currentPermission: focusedAgentState(rt).approvalMode ?? "ask",
    });
    renderState(rt);
    focusActiveSurface(rt);
    if (catalog === undefined) {
        void requestAgentCatalog(rt, target).then((loaded) => {
            if (rt.dialStrip === undefined || loaded === undefined) return;
            const agents = loaded.agents.map((agent) => agent.name);
            rt.dialStrip = {
                ...rt.dialStrip,
                agents,
                agentIndex: Math.max(0, agents.indexOf(loaded.selected)),
                openedAgent: loaded.selected,
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
            renderState(rt);
        });
    }
}

export async function openAgentPicker(rt: TuiRuntime, selectedName?: string): Promise<void> {
    const target = focusedAgentClient(rt);
    let catalog = rt.agentCatalog;
    if (catalog === undefined) {
        catalog = await requestAgentCatalog(rt, target);
    }
    if (catalog === undefined) {
        rt.state = appendTuiNotice(
            rt.state,
            "This host does not support agents.",
        );
        renderState(rt);
        return;
    }
    if (
        selectedName !== undefined
        && !catalog.agents.some((agent) => agent.name === selectedName)
    ) {
        rt.state = appendTuiNotice(
            rt.state,
            `No agent named ${selectedName}; that settings destination is unavailable.`,
        );
        renderState(rt);
        return;
    }
    for (const notice of catalog.notices) {
        rt.state = appendTuiNotice(rt.state, notice, "soft");
    }
    while (true) {
        const current = rt.agentCatalog ?? catalog;
        const result = await requestExtensionPicker(rt, {
            title: "Agents",
            subtitle:
                "Switching agents re-reads the prefix, so the next turn is slower once.",
            rows: current.agents.map((agent) => ({
                id: agent.name,
                label: agent.scope === "extension" && agent.name !== "default"
                    ? `${agent.name} (ext)`
                    : agent.name,
                description: describeAgentRow(rt, agent),
                current: agent.name === current.selected,
            })),
            selectedId: selectedName ?? current.selected,
            actions: [
                { id: "select", label: "switch", keys: ["enter"] },
                {
                    id: "default",
                    label: "save session pair as default",
                    keys: ["d"],
                },
            ],
        }, new AbortController().signal);
        selectedName = undefined;
        if (result.outcome === "cancelled") return;
        const agent = current.agents.find(
            (candidate) => candidate.name === result.rowId,
        );
        if (agent === undefined) return;
        if (result.actionId === "select") {
            selectAgent(rt, agent.name);
            return;
        }
        if (!agent.writable) {
            rt.state = appendTuiNotice(
                rt.state,
                `${agent.name} is registered by an extension, so its file cannot be written.`,
            );
            renderState(rt);
            continue;
        }
        const pair = committedDialPair(rt);
        const named = pair === undefined ? undefined : dialPool(rt).find(
            (entry) =>
                entry.model === pair.model
                && (pair.provider === undefined
                    || entry.provider === pair.provider),
        )?.poolName;
        if (named === undefined) {
            rt.state = appendTuiNotice(
                rt.state,
                "Name this model in /model before saving it as an agent default.",
            );
            renderState(rt);
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
        rt.state = appendTuiNotice(
            rt.state,
            `${agent.name}: default pair is now ${named}${
                pair?.effort === undefined ? "" : `·${pair.effort}`
            }.`,
            "soft",
        );
        renderState(rt);
    }
}

export function describeAgentRow(rt: TuiRuntime, agent: TuiAgentCatalogRow): string {
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

export function selectAgent(rt: TuiRuntime, name: string): void {
    void focusedAgentClient(rt).send({
        type: "select_agent",
        requestId: randomUUID(),
        name,
    }).catch((error) => {
        rt.state = appendTuiNotice(
            rt.state,
            error instanceof Error ? error.message : String(error),
        );
        renderState(rt);
    });
    if (focusedAgentState(rt).working) {
        rt.state = appendTuiNotice(
            rt.state,
            `${name}: queued; applies after the current work.`,
            "soft",
        );
        renderState(rt);
    }
}

export function requestAgentCatalog(rt: TuiRuntime, 
    target: TuiAgentClient,
): Promise<TuiAgentCatalog | undefined> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
        rt.pendingAgentCatalogs.set(requestId, resolve);
        void target.send({ type: "list_agents", requestId }).catch(() => {
            rt.pendingAgentCatalogs.delete(requestId);
            resolve(undefined);
        });
        // A host that answers nothing must not leave /agent hanging.
        setTimeout(() => {
            if (rt.pendingAgentCatalogs.delete(requestId)) resolve(undefined);
        }, 5_000);
    });
}

export function stopAutoModeAnimation(rt: TuiRuntime): void {
    if (rt.autoModeAnimationTimer !== undefined) {
        clearInterval(rt.autoModeAnimationTimer);
        rt.autoModeAnimationTimer = undefined;
    }
    rt.autoModeAnimationStartedAt = undefined;
}

export function startAutoModeAnimation(rt: TuiRuntime): void {
    stopAutoModeAnimation(rt);
    rt.autoModeAnimationStartedAt = Date.now();
    rt.autoModeAnimationTimer = setInterval(() => {
        if (
            rt.shuttingDown
            || rt.dialStrip === undefined
            || rt.autoModeAnimationStartedAt === undefined
        ) {
            stopAutoModeAnimation(rt);
            return;
        }
        if (
            Date.now() - rt.autoModeAnimationStartedAt
            >= AUTO_MODE_ANIMATION_DURATION_MS
        ) {
            stopAutoModeAnimation(rt);
        }
        renderState(rt);
    }, 16);
}

export function closeDials(rt: TuiRuntime): void {
    stopAutoModeAnimation(rt);
    rt.dialStrip = undefined;
    renderState(rt);
    focusActiveSurface(rt);
}

export function closeTransientOverlaysForUiRequest(rt: TuiRuntime): void {
    stopAutoModeAnimation(rt);
    rt.dialStrip = undefined;
    rt.settingsPicker = undefined;
    rt.standingNudges = undefined;
    rt.extensionsList = undefined;
    rt.commandPalette = undefined;
    rt.help = undefined;
    rt.workTab = undefined;
    if (rt.workspaceRail === undefined) {
        rt.workspaceSidebar = undefined;
    } else {
        rt.workspaceSidebarFocused = false;
    }
    rt.searchOverlay = undefined;
    rt.queuedSearch = undefined;
    rt.workTabView.surface.visible = false;
    if (rt.workspaceRail === undefined) {
        rt.workspaceSidebarView.surface.visible = false;
    }
    rt.searchOverlayView.surface.visible = false;
    rt.doctorDialog = undefined;
    abortProviderHealthCheck(rt);
    rt.diagnosticsDialog = undefined;
    rt.extensionsDialog = undefined;
    rt.documentDialog = undefined;
    rt.jumpMenu = undefined;
    rt.jumpMenuBox.visible = false;
}

export function commitDials(rt: TuiRuntime, 
    pair: DialPair | undefined,
    agent: string | undefined,
    permission: string | undefined,
): void {
    const target = focusedAgentClient(rt);
    const opened = rt.dialStrip;
    if (opened !== undefined && permission !== undefined && !dialAccessAllowed(opened, permission, agent)) {
        rt.state = appendTuiNotice(rt.state, "That access mode is unavailable.");
        renderState(rt);
        return;
    }
    closeDials(rt);
    if (isHomeClient(target) && pair === undefined) {
        if (isApprovalMode(permission)) rt.state = { ...rt.state, approvalMode: permission };
        renderState(rt);
        return;
    }
    const apply = () => {
        const client = isHomeClient(target) ? focusedAgentClient(rt) : target;
        if (pair !== undefined && (opened?.opened === undefined
            || pair.model !== opened.opened.model
            || pair.provider !== opened.opened.provider
            || pair.effort !== opened.opened.effort)) {
            void client.send({
                type: "update_session_model_settings",
                requestId: randomUUID(),
                patch: {
                    ...(pair.provider === undefined
                        ? {}
                        : { provider: pair.provider }),
                    model: pair.model,
                    reasoningEffort: pair.effort ?? null,
                },
            }).catch(((error: unknown) => reportConnectionError(rt, error)));
        }
        if (agent !== undefined && agent !== opened?.openedAgent) {
            selectAgent(rt, agent);
        }
        if (permission !== undefined
            && permission !== opened?.openedPermission) {
            requestPermissionsChange(rt, permission, client, "session");
        }
    };
    if (isHomeClient(target)) {
        const draft = currentDraft(rt);
        beginCreateSession(rt, "stop", () => draft, apply);
    } else apply();
}

export function setSidebarFocused(rt: TuiRuntime, focused: boolean): void {
    if (rt.sidebar.isFocused() !== focused) {
        rt.composeSurfaceGeneration += 1;
    }
    rt.sidebar.setFocused(focused);
    rt.flightRecorder?.record({
        type: "focus_changed",
        surface: focused ? "sidebar_composer" : "main_composer",
    });
    const settings = focusedAgentState(rt).modelSettings;
    if (settings !== undefined) notifyExtensionSettings(rt, settings);
}

export function focusedUiRequest(rt: TuiRuntime): UiRequestUpdate | undefined {
    return rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined
        ? rt.hostedSidebar.pane.state.pendingUiRequest
        : rt.pendingUiRequest;
}

export function focusedAbortRequested(rt: TuiRuntime): boolean {
    return rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined
        ? rt.hostedSidebar.pane.state.abortRequested
        : rt.abortRequested;
}

export function focusedAgentCanAbort(rt: TuiRuntime): boolean {
    const focused = focusedAgentState(rt);
    return focused.working || focused.compactingSince !== undefined;
}

export function composerIsAtLeftBoundary(rt: TuiRuntime): boolean {
    const selection = rt.composer.getSelection();
    return rt.composer.plainText.length === 0 || (
        rt.composer.cursorOffset === 0
        && (selection === null || selection.start === selection.end)
    );
}

export function abortFocusedAgent(rt: TuiRuntime): void {
    if (rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined) {
        rt.hostedSidebar.pane.state.abortRequested = true;
        rt.hostedSidebar.pane.state.activity = "stopping";
        void rt.hostedSidebar.pane.client.send({ type: "abort" })
            .catch(((error: unknown) => reportConnectionError(rt, error)));
        return;
    }
    rt.abortRequested = true;
    rt.activity = "stopping";
    sendCommand(rt, { type: "abort" });
}

export function releaseFocusedQueuedPrompts(rt: TuiRuntime, mode: "one" | "all"): void {
    if (focusedAgentState(rt).queueDraining) return;
    const target = focusedAgentClient(rt);
    if (
        target.supportsHostCapability?.(
            HOST_CAPABILITY_PROMPT_QUEUE_RELEASE,
        ) === false
    ) {
        showStatusNotice(rt, "Queued release needs the current resident host");
        return;
    }
    void target.send({
        type: "release_queued_prompts",
        mode,
    }).catch(((error: unknown) => reportConnectionError(rt, error)));
}

export function hostOwnsPromptQueue(rt: TuiRuntime, target: TuiAgentClient): boolean {
    return target.supportsHostCapability?.(
        HOST_CAPABILITY_PROMPT_QUEUE_RELEASE,
    ) !== false;
}

export function visibleMentions(rt: TuiRuntime): readonly string[] {
    const declared = rt.clientExtensionRegistry
        ?.experimentalHostedAgentAddressing(rt.hostedSidebar.owner);
    return visibleTuiAgentMentions({
        declared,
        hasSidebar: rt.hostedSidebar.pane !== undefined,
        sidebarMention: rt.hostedSidebar.mention,
        extensionMentions: rt.extensionMentions,
    });
}
