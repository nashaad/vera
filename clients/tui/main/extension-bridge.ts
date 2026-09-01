import type { AgentUpdate, ClientCommand, SkillCatalogUpdate } from "../../../src/engine/protocol.ts";
import { HOST_CAPABILITY_SKILL_COMMANDS } from "../../../src/host/capabilities.ts";
import type { VeraClientModelSettingsPatch, VeraClientModelSettingsUpdateResult, VeraClientOneshotRequest, VeraClientOneshotResult, VeraClientPickerRequest, VeraClientPickerResult } from "../../../src/sdk/extensions.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import { updateTuiCommandPaletteCommands } from "../command-palette.ts";
import { registerExtensionTuiCommands, registerSkillTuiCommands } from "../commands.ts";
import { updateTuiHelpCommands } from "../help.ts";
import { anyOverlayOpen, describeModelPatch, focusActiveSurface, modelPatchSubject, renderCommandSuggestions, renderState, reportConnectionError, showStatusNotice } from "../main.ts";
import { focusedAgentClient } from "../main/agents-dials.ts";
import { adoptFallbackSessionTitle, coreHelpCommands, registeredPaletteEntries } from "../main/chrome.ts";
import { startTuiExtensionPicker, type TuiExtensionPickerAction } from "../settings-picker.ts";
import { appendTuiError, appendTuiNotice, beginTuiTurn, queueTuiPrompt } from "../state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";

export function sendCommand(rt: TuiRuntime, command: ClientCommand): void {
    if (command.type === "prompt") {
        rt.flightRecorder?.record({ type: "submit_dispatched" });
    }
    void rt.client.send(command).then(() => {
        if (command.type === "prompt") {
            rt.flightRecorder?.record({ type: "submit_accepted" });
        }
    }).catch((error) => {
        if (command.type === "prompt") {
            rt.flightRecorder?.record({
                type: "submit_failed",
                error: error instanceof Error ? error.message : String(error),
            });
        }
        reportConnectionError(rt, error);
    });
}

export function requestExtensionModelSettingsUpdate(rt: TuiRuntime, 
    patch: VeraClientModelSettingsPatch,
    signal: AbortSignal,
): Promise<VeraClientModelSettingsUpdateResult> {
    if (signal.aborted) {
        return Promise.reject(signal.reason);
    }
    const requestId = randomUUID();
    const target = rt.extensionAgentTarget.getStore() ?? focusedAgentClient(rt);
    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            rt.pendingExtensionSettings.delete(requestId);
            rt.requestedModelChanges.delete(requestId);
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        // An extension edit is a settings edit like any other: it says what
        // it asked for while it is in flight, and a refusal names the same
        // thing rather than leaving the user to guess what was tried.
        const subject = modelPatchSubject(patch);
        rt.requestedModelChanges.set(requestId, { subject, patch, target });
        showStatusNotice(rt, `model → ${describeModelPatch(patch)}`);
        rt.pendingExtensionSettings.set(requestId, {
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
            rt.pendingExtensionSettings.delete(requestId);
            rt.requestedModelChanges.delete(requestId);
            signal.removeEventListener("abort", onAbort);
            reject(error);
        });
    });
}

export function settleExtensionModelSettings(rt: TuiRuntime, 
    update: Extract<
        AgentUpdate,
        { type: "model_settings" | "model_settings_rejected" }
    >,
    target: TuiAgentClient,
): void {
    const pending = rt.pendingExtensionSettings.get(update.requestId);
    if (pending === undefined || pending.target !== target) return;
    rt.pendingExtensionSettings.delete(update.requestId);
    pending.removeAbortListener();
    pending.resolve(update.type === "model_settings"
        ? { status: "accepted", settings: update.settings }
        : { status: "rejected", reason: update.reason });
}

export function rejectPendingExtensionSettingsFor(rt: TuiRuntime, 
    target: TuiAgentClient,
    reason: unknown,
): void {
    for (const [requestId, pending] of rt.pendingExtensionSettings) {
        if (pending.target !== target) continue;
        rt.pendingExtensionSettings.delete(requestId);
        rt.requestedModelChanges.delete(requestId);
        pending.removeAbortListener();
        pending.reject(reason);
    }
}

export function notifyExtensionSettings(rt: TuiRuntime, 
    settings: NonNullable<typeof rt.state.modelSettings>,
): void {
    for (const listener of rt.extensionSettingsListeners) {
        try {
            listener(structuredClone(settings));
        } catch {
            // One extension listener cannot stop client updates.
        }
    }
}

export function requireSidebarOwner(rt: TuiRuntime, extensionId: string): void {
    rt.hostedSidebar.requireOwner(extensionId);
}

export function resolvePooledModel(rt: TuiRuntime, 
    request: VeraClientOneshotRequest,
): VeraClientOneshotRequest {
    const wanted = request.model.toLowerCase();
    for (const entry of rt.state.modelSettings?.pooled ?? []) {
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

export function requestExtensionOneshot(rt: TuiRuntime, 
    oneshotRequest: VeraClientOneshotRequest,
    signal: AbortSignal,
): Promise<VeraClientOneshotResult> {
    const request = resolvePooledModel(rt, oneshotRequest);
    if (signal.aborted) {
        return Promise.reject(signal.reason as Error);
    }
    const requestId = randomUUID();
    return new Promise<VeraClientOneshotResult>((resolve, reject) => {
        const settle = (): void => {
            signal.removeEventListener("abort", onAbort);
            rt.pendingOneshots.delete(requestId);
        };
        const onAbort = (): void => {
            settle();
            reject(signal.reason as Error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        rt.pendingOneshots.set(requestId, {
            resolve: (result) => {
                settle();
                resolve(result);
            },
            reject: (reason) => {
                settle();
                reject(reason);
            },
        });
        sendCommand(rt, {
            type: "oneshot",
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

export function requestExtensionPicker(rt: TuiRuntime, 
    request: VeraClientPickerRequest,
    signal: AbortSignal,
): Promise<VeraClientPickerResult> {
    if (signal.aborted) {
        return Promise.reject(signal.reason);
    }
    if (rt.pendingExtensionPicker !== undefined || anyOverlayOpen(rt)) {
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
    rt.settingsPicker = startTuiExtensionPicker(
        request.title,
        request.rows,
        request.selectedId,
        actions,
        request.subtitle,
    );
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            if (rt.pendingExtensionPicker?.resolve !== resolve) {
                return;
            }
            rt.pendingExtensionPicker = undefined;
            rt.settingsPicker = undefined;
            focusActiveSurface(rt);
            renderState(rt);
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        rt.pendingExtensionPicker = {
            resolve,
            reject,
            removeAbortListener: () =>
                signal.removeEventListener("abort", onAbort),
        };
    });
}

export async function loadExtensionCommands(rt: TuiRuntime): Promise<void> {
    if (rt.client.listExtensionCommands === undefined) {
        return;
    }
    const generation = ++rt.extensionCommandsGeneration;
    try {
        const commands = await rt.client.listExtensionCommands();
        if (generation !== rt.extensionCommandsGeneration) {
            return;
        }
        // Extensions own their names ahead of skills. A skill catalog can
        // arrive first on startup, so clear it before rebuilding the
        // extension generation and request it again afterwards.
        rt.skillCatalogRequestId = undefined;
        rt.disposeSkillCommands();
        rt.disposeSkillCommands = () => {};
        rt.disposeHostExtensionCommands();
        const disposers: (() => void)[] = [];
        rt.hostExtensionCommands = commands;
        const commandsBySource = Map.groupBy(
            commands,
            (command) => command.source,
        );
        for (const [source, sourceCommands] of commandsBySource) {
            try {
                disposers.push(registerExtensionTuiCommands(
                    rt.commandRegistry,
                    sourceCommands,
                ));
            } catch (error) {
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                rt.state = appendTuiNotice(
                    rt.state,
                    `${source}: ${message}`,
                );
            }
        }
        rt.disposeHostExtensionCommands = () => {
            for (const dispose of disposers) {
                dispose();
            }
        };
        if (rt.commandPalette !== undefined) {
            rt.commandPalette = updateTuiCommandPaletteCommands(
                rt.commandPalette,
                registeredPaletteEntries(rt),
            );
        }
        if (rt.help !== undefined) {
            rt.help = updateTuiHelpCommands(
                rt.help,
                coreHelpCommands(rt),
                rt.hostExtensionCommands,
            );
        }
        renderCommandSuggestions(rt);
        renderState(rt);
        requestSkillCommands(rt);
    } catch (error) {
        if (rt.shuttingDown || generation !== rt.extensionCommandsGeneration) {
            return;
        }
        const message = error instanceof Error
            ? error.message
            : String(error);
        rt.state = appendTuiError(
            rt.state,
            `Could not load extension commands: ${message}`,
        );
        renderState(rt);
    } finally {
        if (generation === rt.extensionCommandsGeneration) {
            rt.extensionCommandsLoading = false;
        }
    }
}

export function supportsSkillCommands(rt: TuiRuntime, target: TuiAgentClient): boolean {
    return target.failed !== true
        && target.viewOnly !== true
        && target.supportsHostCapability?.(
            HOST_CAPABILITY_SKILL_COMMANDS,
        ) === true;
}

export function requestSkillCommands(rt: TuiRuntime): void {
    if (!supportsSkillCommands(rt, rt.client)) {
        rt.skillCatalogRequestId = undefined;
        rt.skillCommandsLoading = false;
        rt.disposeSkillCommands();
        rt.disposeSkillCommands = () => {};
        return;
    }
    const requestId = randomUUID();
    rt.skillCatalogRequestId = requestId;
    rt.skillCommandsLoading = true;
    void rt.client.send({ type: "list_skills", requestId }).catch((error) => {
        if (rt.shuttingDown || rt.skillCatalogRequestId !== requestId) return;
        rt.skillCatalogRequestId = undefined;
        rt.skillCommandsLoading = false;
        rt.state = appendTuiError(
            rt.state,
            `Could not load skill commands: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function receiveSkillCatalog(rt: TuiRuntime, update: SkillCatalogUpdate): void {
    if (update.requestId !== rt.skillCatalogRequestId) return;
    rt.skillCatalogRequestId = undefined;
    rt.skillCommandsLoading = false;
    rt.disposeSkillCommands();
    const registration = registerSkillTuiCommands(
        rt.commandRegistry,
        update.skills,
    );
    rt.disposeSkillCommands = registration.dispose;
    for (const notice of [...update.warnings, ...registration.warnings]) {
        if (rt.announcedSkillCommandNotices.has(notice)) continue;
        rt.announcedSkillCommandNotices.add(notice);
        rt.state = appendTuiNotice(rt.state, notice);
    }
    if (rt.commandPalette !== undefined) {
        rt.commandPalette = updateTuiCommandPaletteCommands(
            rt.commandPalette,
            registeredPaletteEntries(rt),
        );
    }
    if (rt.help !== undefined) {
        rt.help = updateTuiHelpCommands(
            rt.help,
            coreHelpCommands(rt),
            rt.hostExtensionCommands,
        );
    }
    renderCommandSuggestions(rt);
    renderState(rt);
}

export function receiveSkillInvocation(rt: TuiRuntime, 
    update: Extract<
        AgentUpdate,
        {
            readonly type:
                | "skill_invocation_accepted"
                | "skill_invocation_rejected";
        }
    >,
): void {
    const prompt = rt.pendingSkillInvocations.get(update.requestId);
    if (prompt === undefined) return;
    rt.pendingSkillInvocations.delete(update.requestId);
    rt.promptSubmitting = rt.pendingSkillInvocations.size > 0;
    if (update.type === "skill_invocation_rejected") {
        if (rt.composer.plainText.length === 0) {
            rt.composer.setComposerText(prompt);
            renderCommandSuggestions(rt);
        }
        rt.state = appendTuiError(rt.state, update.reason);
        renderState(rt);
        return;
    }
    rt.state = update.queued
        ? queueTuiPrompt(rt.state, update.prompt)
        : beginTuiTurn(rt.state, update.prompt);
    adoptFallbackSessionTitle(rt, update.prompt);
    if (!update.queued && rt.workingSince === undefined) {
        rt.workingSince = Date.now();
        rt.phaseSince = rt.workingSince;
        rt.activity = "thinking";
    }
    renderState(rt);
}

export function failPendingSkillInvocations(rt: TuiRuntime): void {
    const prompt = rt.pendingSkillInvocations.values().next().value;
    rt.pendingSkillInvocations.clear();
    rt.promptSubmitting = false;
    if (prompt !== undefined && rt.composer.plainText.length === 0) {
        rt.composer.setComposerText(prompt);
        renderCommandSuggestions(rt);
    }
}
