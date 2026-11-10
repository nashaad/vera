import { randomUUID } from "node:crypto";
import type { VeraExtensionConfig } from "../../config.ts";
import { AsyncQueue } from "../../engine/async-queue.ts";
import { InboundCommandRouter } from "../../engine/inbound-command-router.ts";
import { createModelFailureRecorder } from "../../engine/model-failure-recorder.ts";
import type { RunHeadlessLoopData, RunHeadlessLoopServices } from "../../engine/loop-services.ts";
import { isOneshotReplyUpdate, isSessionNameReplyUpdate, isTimelineReplyUpdate, isToolApprovalUiRequestUpdate, type AgentUpdate, type ToolApprovalUiRequestUpdate } from "../../engine/protocol.ts";
import { resolveSpawnModelChoice, subagentModelBoundary, type MissingSubagentConfigurationRequest, type SpawnModelResolution, type SubagentPoolPolicy } from "../../engine/subagent.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import { SessionStore } from "../../store/session-store.ts";
import { ToolRuntime } from "../../tools/runtime.ts";
import type { ApplyToolEffect, CloseSubagentEffect, MessageSubagentEffect, NotifyParentEffect, RegisteredTool, SpawnAsyncSubagentEffect, ToolEffectContext, ToolOutput } from "../../tools/types.ts";
import { HOST_OWNED_COMMANDS, ReportedWorkerFailure, WorkerCapReachedError, cancelledSubagentConfiguration, defaultConcurrentWorkerCap, loopStateOf, requestedSubagentLabel, subagentResolutionLabel, unavailableSubagentConfiguration, workerExtensionsEnabled, workerOutcomeDetail } from "./helpers.ts";
import { CHILD_TOOL_APPROVAL_TIMEOUT_MS, closeSubagentOutput, type PendingSubagentConfigurationBatch, type PendingSubagentLaunch, type RegisteredAgentEntry, type SessionBlockControl } from "./support.ts";
import { recordDeliveryAndNotify } from "../delivery-notifier.ts";
import { ResidentAgent, SessionBlockedError, type AgentAttachment } from "../resident-agent.ts";
import { startSeededWorker, type WorkerHandle } from "../worker/handle.ts";
import type { WorkerAdapterSpec } from "../worker/start.ts";
import type { AgentRegistry } from "../agent-registry.ts";

const CLOSE_ABORT_TIMEOUT_MS = 2_000;

export interface SubagentParent {
    readonly id: string;
    readonly store?: SessionStore;
}

export function workerAdapterSpecFor(reg: AgentRegistry, store: SessionStore, entry: RegisteredAgentEntry): WorkerAdapterSpec | undefined {
        if (reg.options.workerAdapterSpec === undefined) {
            return undefined;
        }
        return reg.options.workerAdapterSpec({
            provider: entry.modelSettings.provider ?? reg.defaultProvider,
            projectRoot: store.header.cwd,
            sessionId: store.header.id,
        });
    }

export function workerExtensions(reg: AgentRegistry): readonly VeraExtensionConfig[] | undefined {
        if (!workerExtensionsEnabled()) {
            return undefined;
        }
        const configured = reg.options.workerExtensions?.() ?? [];
        return configured.length === 0 ? undefined : configured;
    }

export function pushWorkerState(reg: AgentRegistry, id: string): void {
        const entry = reg.agents.get(id);
        const worker = entry?.worker;
        if (worker === undefined || entry?.loopServices === undefined) return;
        worker.pushState(loopStateOf(entry.loopServices));
    }

export function pushWorkerStateEverywhere(reg: AgentRegistry): void {
        for (const id of reg.agents.keys()) reg.pushWorkerState(id);
    }

export function liveWorkerCount(reg: AgentRegistry): number {
        let count = 0;
        for (const entry of reg.agents.values()) {
            if (entry.worker !== undefined) count += 1;
        }
        return count;
    }

function hostToolRuntime(
    store: SessionStore,
    data: RunHeadlessLoopData,
): ToolRuntime {
    const runtime = new ToolRuntime(
        store.header.cwd,
        undefined,
        undefined,
        data.toolEnv,
        data.instructionRoot?.path,
        undefined,
        store.header.parentId !== undefined,
    );
    runtime.sessionId = store.header.id;
    return runtime;
}

export function forwardWorkerUpdate(agent: ResidentAgent, update: AgentUpdate, ownerId: string | undefined): void {
        if (ownerId === undefined) {
            // The worker's last updates can land after the conversation closed or failed; broadcast would throw on them.
            if (agent.closed || agent.failed) return;
            agent.engine.send(update);
            return;
        }
        if (isTimelineReplyUpdate(update)) {
            agent.sendTimelineReply(ownerId, update);
            return;
        }
        if (isSessionNameReplyUpdate(update)) {
            agent.sendSessionNameReply(ownerId, update);
            return;
        }
        if (isOneshotReplyUpdate(update)) {
            agent.sendOneshotReply(ownerId, update);
            return;
        }
        throw new Error(
            `Worker sent an unowned private update: ${update.type}`,
        );
    }

export async function runInWorker(reg: AgentRegistry, options: {
        readonly agent: ResidentAgent;
        readonly store: SessionStore;
        readonly entry: RegisteredAgentEntry;
        readonly adapter: WorkerAdapterSpec;
        readonly data: RunHeadlessLoopData;
        readonly services: RunHeadlessLoopServices;
        readonly extensionTools?: readonly RegisteredTool[];
    }): Promise<void> {
        const { agent, store, services } = options;
        const cap = reg.options.maxConcurrentWorkers
            ?? defaultConcurrentWorkerCap();
        if (reg.liveWorkerCount() >= cap) {
            throw new WorkerCapReachedError(cap);
        }
        const workerExtensions = reg.workerExtensions();
        // A question needs the owner router here and the worker's loop listening there, in either order.
        let heardWorker = false;
        let ownerRouterSet = false;
        let closedTurnFinished = false;
        let resolveClosedTurn: (() => void) | undefined;
        const markReady = (): void => {
            if (heardWorker && ownerRouterSet) options.entry.markLoopReady();
        };
        const handle = await startSeededWorker({
            store,
            model: reg.defaultModel,
            ...(reg.defaultReasoningEffort === undefined
                ? {}
                : { reasoningEffort: reg.defaultReasoningEffort }),
            adapter: options.adapter,
            data: options.data,
            services,
            ...(reg.options.sessionBlockDirectory === undefined
                ? {}
                : { blockedDirectory: reg.options.sessionBlockDirectory }),
            offers: {
                approvalModeRead: services.readApprovalMode !== undefined,
                modelSettings: services.readModelSettings !== undefined,
                selectedAgent: services.readSelectedAgent !== undefined,
            },
            state: loopStateOf(services),
            ...(workerExtensions === undefined
                ? {}
                : { extensions: workerExtensions }),
            ...(reg.options.home === undefined
                ? {}
                : { home: reg.options.home }),
            ...(options.extensionTools === undefined
                ? {}
                : {
                    extensionTools: options.extensionTools,
                    toolRuntime: hostToolRuntime(store, options.data),
                }),
            onUpdate: (update, ownerId) => {
                if (agent.closed && ownerId === undefined && update.type === "turn_finished") {
                    closedTurnFinished = true;
                    resolveClosedTurn?.();
                }
                forwardWorkerUpdate(agent, update, ownerId);
                // A root update comes from the worker's loop, which listens for events by the time it sends one.
                if (ownerId === undefined) {
                    heardWorker = true;
                    markReady();
                }
            },
        });
        options.entry.worker = handle;
        let workerExited = false;
        void handle.outcome.then(() => {
            workerExited = true;
            resolveClosedTurn?.();
        });
        options.entry.blockControl = workerBlockControl(agent, handle);
        // A worker started on a blocked session halts itself; the host counts that halt from the start.
        if (reg.blockRefusalFor(store.header.id) !== undefined) {
            agent.noteRouterHalted(false);
        }
        // The ledger stays in the host; the worker's events reach it on this bus.
        const stopRecordingFailures = services.modelFailureLedger === undefined
                || services.eventBus === undefined
            ? undefined
            : services.eventBus.subscribe(createModelFailureRecorder({
                ledger: services.modelFailureLedger,
                sessionId: store.header.id,
            }));
        const pumping = new AbortController();
        let stopping = false;
        const ownerCommands = new AsyncQueue<EngineCommand>();
        options.entry.workerOwnerRouter = new InboundCommandRouter(
            {
                send: (update) => agent.engine.send(update),
                receive: (signal) => ownerCommands.receive(signal),
            },
            options.entry.events,
            {
                ...(services.readModelSettings === undefined
                    ? {}
                    : {
                        readModelSettings: () => {
                            reg.pushWorkerState(agent.id);
                            return services.readModelSettings!();
                        },
                    }),
                ...(services.readApprovalMode === undefined
                    ? {}
                    : { readApprovalMode: services.readApprovalMode }),
                ...(services.router ?? {}),
                sendSessionNameReply: services.router?.sendSessionNameReply
                    ?? ((_ownerId, reply) => agent.engine.send(reply)),
                hasPendingDeliveryTurn: () => false,
            },
        );
        ownerRouterSet = true;
        markReady();
        void (async () => {
            for (;;) {
                const command = await agent.engine.receive(pumping.signal);
                if (
                    HOST_OWNED_COMMANDS.has(command.type)
                    || (
                        command.type === "ui_response"
                        && options.entry.workerOwnerRouter?.ownsUiRequest(
                            command.requestId,
                        ) === true
                    )
                ) {
                    ownerCommands.push(command);
                    continue;
                }
                handle.send(command);
            }
        })().catch(async () => {
            if (agent.closed && !pumping.signal.aborted) {
                stopping = true;
                if (agent.hasPendingTurn() && !closedTurnFinished) {
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, CLOSE_ABORT_TIMEOUT_MS);
                        resolveClosedTurn = () => {
                            clearTimeout(timer);
                            resolve();
                        };
                    });
                }
                if (!workerExited) handle.kill();
            }
        });
        try {
            const outcome = await handle.outcome;
            if (stopping || agent.closed) {
                try {
                    await store.exclusively(async () => {});
                    if (options.entry.releasingForTransfer !== true) {
                        await store.finishAbortedTurn();
                        for (const queued of store.queuedPrompts()) {
                            await store.removeQueuedPrompt(queued.id);
                        }
                    }
                } catch (error) {
                    options.entry.closeFailure = error;
                    options.entry.failure = error;
                }
                return;
            }
            if (outcome.kind === "finished" || outcome.kind === "failed") {
                await store.exclusively(async () => {});
                for (const queued of store.queuedPrompts()) {
                    await store.removeQueuedPrompt(queued.id);
                }
            }
            if (outcome.kind === "finished") {
                return;
            }
            const detail = workerOutcomeDetail(outcome);
            throw outcome.kind === "failed" && handle.reportedFailure
                ? new ReportedWorkerFailure(detail)
                : new Error(detail);
        } finally {
            stopRecordingFailures?.();
            pumping.abort();
            ownerCommands.fail(new Error("The worker owner channel closed"));
            options.entry.workerOwnerRouter = undefined;
            if (options.entry.worker === handle) {
                options.entry.worker = undefined;
                options.entry.blockControl = undefined;
            }
        }
    }

// Block answers from the worker move the host counters with the worker's router.
export function workerBlockControl(agent: ResidentAgent, handle: WorkerHandle): SessionBlockControl {
    return {
        confirmBlock: async (timeoutMs) => {
            const latched = await handle.confirmBlock(timeoutMs);
            if (latched) agent.noteRouterHalted(false);
            return latched;
        },
        releaseBlock: async (timeoutMs) => {
            const released = await handle.releaseBlock(timeoutMs);
            if (released) agent.noteRouterCleared();
            return released;
        },
    };
}

export function requestMissingSubagentConfiguration(reg: AgentRegistry, entry: RegisteredAgentEntry, request: MissingSubagentConfigurationRequest, context: ToolEffectContext, signal: AbortSignal): Promise<SpawnModelResolution> {
        if (entry.store.header.delegation !== undefined) {
            return Promise.resolve({
                ok: false,
                reason: "unavailable",
                error: "A delegated session cannot widen its persisted subagent model boundary.",
            });
        }
        if (signal.aborted) {
            return Promise.resolve(cancelledSubagentConfiguration());
        }

        let queue = reg.pendingSubagentConfigurations.get(entry.agent.id);
        if (queue === undefined) {
            queue = [];
            reg.pendingSubagentConfigurations.set(entry.agent.id, queue);
        }
        let batch = queue.at(-1);
        if (batch === undefined || batch.processing) {
            batch = {
                id: randomUUID(),
                entryId: entry.agent.id,
                actions: [],
                abort: new AbortController(),
                scheduled: false,
                processing: false,
            };
            queue.push(batch);
        }
        const target = batch;
        const result = new Promise<SpawnModelResolution>((resolve) => {
            const action: PendingSubagentLaunch = {
                id: randomUUID(),
                request: structuredClone(request),
                context: structuredClone(context),
                signal,
                resolve,
                settled: false,
            };
            action.onAbort = () => {
                reg.settlePendingSubagentLaunch(
                    action,
                    cancelledSubagentConfiguration(),
                );
                if (target.actions.every((candidate) => candidate.settled)) {
                    target.abort.abort();
                    if (!target.processing) {
                        reg.completeSubagentConfigurationBatch(target);
                    }
                }
            };
            target.actions.push(action);
            signal.addEventListener("abort", action.onAbort, { once: true });
        });
        reg.scheduleSubagentConfigurationBatch(target);
        return result;
    }

export function scheduleSubagentConfigurationBatch(reg: AgentRegistry, batch: PendingSubagentConfigurationBatch): void {
        const queue = reg.pendingSubagentConfigurations.get(batch.entryId);
        if (
            queue?.[0] !== batch
            || batch.scheduled
            || batch.processing
        ) return;
        batch.scheduled = true;
        setTimeout(() => {
            batch.scheduled = false;
            batch.processing = true;
            void reg.processMissingSubagentConfiguration(batch).catch(
                () => reg.finishSubagentConfigurationBatch(
                    batch,
                    unavailableSubagentConfiguration(),
                ),
            );
        }, 0);
    }

export async function processMissingSubagentConfiguration(reg: AgentRegistry, batch: PendingSubagentConfigurationBatch): Promise<void> {
        const entry = reg.agents.get(batch.entryId);
        const router = entry === undefined
            ? undefined
            : entry.workerOwnerRouter ?? entry.inbound;
        const active = (): PendingSubagentLaunch[] =>
            batch.actions.filter((action) => !action.settled);
        if (
            entry === undefined
            || entry.agent.closed
            || !entry.agent.attached
            || router === undefined
            || active().length === 0
        ) {
            reg.finishSubagentConfigurationBatch(
                batch,
                unavailableSubagentConfiguration(),
            );
            return;
        }

        let choices = active().map((action) =>
            reg.resolveConfiguredSubagentLaunch(entry, action));
        const needsConfiguration = choices.some((choice) =>
            !choice.resolution.ok
            && choice.resolution.reason === "configuration_required");
        if (needsConfiguration) {
            let outcome: "configured" | "cancelled" | "unavailable";
            try {
                outcome = await router.requestConfigurationRequired({
                    destination: {
                        kind: "model_assignment",
                        assignment: "subagents",
                    },
                    reason: active().length === 1
                        ? "A subagent launch is waiting, but no subagent models are configured."
                        : `${active().length} subagent launches are waiting, but no subagent models are configured.`,
                    pendingAction: {
                        id: batch.id,
                        kind: "subagent_launch",
                        count: active().length,
                    },
                }, { signal: batch.abort.signal });
            } catch {
                outcome = "unavailable";
            }
            if (outcome !== "configured") {
                reg.finishSubagentConfigurationBatch(
                    batch,
                    outcome === "cancelled"
                        ? cancelledSubagentConfiguration()
                        : unavailableSubagentConfiguration(),
                );
                return;
            }

            reg.pushWorkerState(entry.agent.id);
            choices = active().map((action) =>
                reg.resolveConfiguredSubagentLaunch(entry, action));
        }
        const failed = choices.find((choice) => !choice.resolution.ok);
        if (failed !== undefined) {
            for (const choice of choices) {
                reg.settlePendingSubagentLaunch(
                    choice.action,
                    choice.resolution.ok ? failed.resolution : choice.resolution,
                );
            }
            reg.completeSubagentConfigurationBatch(batch);
            return;
        }

        const replacements = choices.map((choice) => {
            const resolution = choice.resolution;
            if (!resolution.ok) return "";
            const requested = requestedSubagentLabel(choice.action.request);
            const replacement = subagentResolutionLabel(resolution);
            return `${requested}→${replacement}`;
        });
        const confirmationRouter = entry.workerOwnerRouter ?? entry.inbound;
        if (confirmationRouter === undefined || entry.agent.closed) {
            reg.finishSubagentChoices(
                choices,
                unavailableSubagentConfiguration(),
            );
            reg.completeSubagentConfigurationBatch(batch);
            return;
        }
        const confirmation = await confirmationRouter.requestUserQuestion({
            question: `Continue ${choices.length} waiting subagent launch${
                choices.length === 1 ? "" : "es"
            }?\n${replacements.join(" · ")}`,
            choices: [
                {
                    id: "continue",
                    label: "Continue",
                    description: "Start these waiting launches once with the configured replacements.",
                },
                {
                    id: "cancel",
                    label: "Cancel",
                    description: "Start none of the waiting launches.",
                },
            ],
        }, { signal: batch.abort.signal });
        if (
            confirmation.outcome !== "selected"
            || confirmation.choice.id !== "continue"
        ) {
            reg.finishSubagentChoices(
                choices,
                cancelledSubagentConfiguration(),
            );
            reg.completeSubagentConfigurationBatch(batch);
            return;
        }
        for (const choice of choices) {
            reg.settlePendingSubagentLaunch(choice.action, choice.resolution);
        }
        reg.completeSubagentConfigurationBatch(batch);
    }

export function resolveConfiguredSubagentLaunch(reg: AgentRegistry, entry: RegisteredAgentEntry, action: PendingSubagentLaunch): {
        readonly action: PendingSubagentLaunch;
        readonly resolution: SpawnModelResolution;
    } {
        const policy = reg.options.readPolicy === undefined
            ? { allowSelf: true }
            : reg.options.readPolicy(entry.store.header.cwd);
        const pool = reg.options.readPool === undefined
            ? undefined
            : () => reg.options.readPool?.(entry.store.header.cwd) ?? [];
        let resolution = resolveSpawnModelChoice(
            action.request,
            action.context,
            pool,
            reg.options.subagentModel,
            policy,
            action.request.agentDefault,
        );
        if (
            !resolution.ok
            && resolution.reason === "not_permitted"
            && action.request.model !== undefined
        ) {
            resolution = resolveSpawnModelChoice(
                {},
                action.context,
                pool,
                reg.options.subagentModel,
                policy,
                action.request.agentDefault,
            );
        }
        return { action, resolution };
    }

export function finishSubagentConfigurationBatch(reg: AgentRegistry, batch: PendingSubagentConfigurationBatch, resolution: SpawnModelResolution): void {
        for (const action of batch.actions) {
            reg.settlePendingSubagentLaunch(action, resolution);
        }
        reg.completeSubagentConfigurationBatch(batch);
    }

export function completeSubagentConfigurationBatch(reg: AgentRegistry, batch: PendingSubagentConfigurationBatch): void {
        const queue = reg.pendingSubagentConfigurations.get(batch.entryId);
        if (queue === undefined) return;
        const index = queue.indexOf(batch);
        if (index === -1) return;
        queue.splice(index, 1);
        if (queue.length === 0) {
            reg.pendingSubagentConfigurations.delete(batch.entryId);
            return;
        }
        reg.scheduleSubagentConfigurationBatch(queue[0]!);
    }

export function finishSubagentChoices(reg: AgentRegistry, choices: readonly {
            readonly action: PendingSubagentLaunch;
            readonly resolution: SpawnModelResolution;
        }[], resolution: SpawnModelResolution): void {
        for (const choice of choices) {
            reg.settlePendingSubagentLaunch(choice.action, resolution);
        }
    }

export function settlePendingSubagentLaunch(_reg: AgentRegistry, action: PendingSubagentLaunch, resolution: SpawnModelResolution): void {
        if (action.settled) return;
        action.settled = true;
        if (action.onAbort !== undefined) {
            action.signal.removeEventListener("abort", action.onAbort);
        }
        action.resolve(resolution);
    }

export async function spawnAsyncSubagent(reg: AgentRegistry, parentStore: SessionStore, effect: SpawnAsyncSubagentEffect, context: Parameters<ApplyToolEffect>[2], signal: AbortSignal): Promise<ToolOutput> {
        const admission = reg.subagentAdmission;
        const running = admission === undefined ? [...reg.agents.values()].filter(
            (entry) =>
                entry.kind === "background"
                && entry.parentId === parentStore.header.id
                && entry.failure === undefined
                && !entry.agent.failed
                && !entry.agent.closed
                && entry.pendingAsyncTurns > 0,
        ).length
            + (reg.startingBackgroundAgents.get(parentStore.header.id) ?? 0) : 0;
        const admitted = admission === undefined
            ? running < reg.maxConcurrentBackgroundAgents
            : await admission.reserveSubagentStart(parentStore.header.id, reg.maxConcurrentBackgroundAgents);
        if (!admitted) {
            return {
                kind: "output",
                output: `Async subagent limit reached `
                    + `(${reg.maxConcurrentBackgroundAgents} running).`,
                isError: true,
            };
        }
        if (admission === undefined) {
            reg.startingBackgroundAgents.set(
                parentStore.header.id,
                (reg.startingBackgroundAgents.get(parentStore.header.id) ?? 0) + 1,
            );
        }
        let policy: SubagentPoolPolicy;
        let resolved: SpawnModelResolution;
        let child: ResidentAgent;
        try {
            policy = reg.options.readPolicy === undefined
                ? { allowSelf: true }
                : reg.options.readPolicy(parentStore.header.cwd);
            resolved = resolveSpawnModelChoice(
                effect,
                context,
                reg.options.readPool === undefined
                    ? undefined
                    : () => reg.options.readPool?.(parentStore.header.cwd) ?? [],
                reg.options.subagentModel,
                policy,
            );
            if (!resolved.ok && resolved.reason === "configuration_required") {
                const entry = reg.agents.get(parentStore.header.id);
                if (entry !== undefined) {
                    resolved = await reg.requestMissingSubagentConfiguration(
                        entry,
                        {
                            description: effect.description,
                            ...(effect.model === undefined
                                ? {}
                                : { model: effect.model }),
                            ...(effect.reasoningEffort === undefined ? {} : {
                                reasoningEffort: effect.reasoningEffort,
                            }),
                        },
                        context,
                        signal,
                    );
                    policy = reg.options.readPolicy === undefined
                        ? { allowSelf: true }
                        : reg.options.readPolicy(parentStore.header.cwd);
                }
            }
            if (!resolved.ok) {
                return { kind: "output", output: resolved.error, isError: true };
            }
            if (signal.aborted) {
                const cancelled = cancelledSubagentConfiguration();
                return {
                    kind: "output",
                    output: cancelled.ok
                        ? "The waiting subagent launch was cancelled; no child started."
                        : cancelled.error,
                    isError: true,
                };
            }
            child = await reg.createWithKind(
                {
                    workspace: parentStore.header.cwd,
                    ...(parentStore.header.contextAssemblyMode === undefined
                        ? {}
                        : {
                            startupProfile:
                                parentStore.header.contextAssemblyMode,
                        }),
                },
                "background",
                {
                    approvalMode: context.approvalMode,
                    parentId: parentStore.header.id,
                    delegation: {
                        kind: "subagent",
                        parentId: parentStore.header.id,
                        models: subagentModelBoundary(policy, context),
                    },
                    modelSettings: {
                        provider: resolved.provider ?? reg.defaultProvider,
                        model: resolved.model,
                        ...(resolved.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: resolved.reasoningEffort }),
                    },
                },
            );
            const childEntry = reg.agents.get(child.id);
            if (childEntry === undefined) {
                child.close();
                throw new Error(`Async subagent ${child.id} was not registered`);
            }
            try {
                child.sendPrompt(effect.description);
            } catch (error) {
                child.close();
                throw error;
            }
            reg.trackAsyncSubagentTurn(child.id);
            if (resolved.notice !== undefined) {
                reg.spawnNotices.set(child.id, resolved.notice);
            }
            const started =
                `Async subagent ${child.id} started. Its final summary will arrive as a task notification.`;
            return {
                kind: "output",
                output: resolved.notice === undefined
                    ? started
                    : `${resolved.notice}\n\n${started}`,
                isError: false,
                ...(resolved.substitutions === undefined
                        || resolved.substitutions.length === 0
                    ? {}
                    : { substitutions: resolved.substitutions }),
            };
        } finally {
            if (admission !== undefined) {
                await admission.releaseSubagentStart(parentStore.header.id);
            } else {
                const remaining =
                    (reg.startingBackgroundAgents.get(parentStore.header.id) ?? 1)
                    - 1;
                if (remaining === 0) {
                    reg.startingBackgroundAgents.delete(parentStore.header.id);
                } else {
                    reg.startingBackgroundAgents.set(parentStore.header.id, remaining);
                }
            }
        }
    }

export async function messageSubagent(reg: AgentRegistry, parentStore: SessionStore, effect: MessageSubagentEffect): Promise<ToolOutput> {
        if (reg.subagentSessions !== undefined) {
            return reg.subagentSessions.messageSubagent(parentStore.header.id, effect);
        }
        return localMessageSubagent(reg, parentStore.header.id, effect);
    }

export async function localMessageSubagent(reg: AgentRegistry, parentId: string, effect: MessageSubagentEffect): Promise<ToolOutput> {
        const child = reg.agents.get(effect.subagentId);
        if (
            child === undefined
            || child.kind !== "background"
            || child.parentId !== parentId
        ) {
            return {
                kind: "output",
                output: `Async subagent ${effect.subagentId} is not a child of this agent.`,
                isError: true,
            };
        }
        if (child.failure !== undefined || child.agent.closed) {
            return {
                kind: "output",
                output: `Async subagent ${effect.subagentId} is no longer running.`,
                isError: true,
            };
        }

        try {
            child.agent.sendPrompt(effect.message);
        } catch (error) {
            if (error instanceof SessionBlockedError) {
                return {
                    kind: "output",
                    output: error.message,
                    isError: true,
                };
            }
            throw error;
        }
        reg.trackAsyncSubagentTurn(effect.subagentId);
        return {
            kind: "output",
            output: `Message queued for async subagent ${effect.subagentId}.`,
            isError: false,
        };
    }

export async function closeSubagent(reg: AgentRegistry, callerId: string, effect: CloseSubagentEffect): Promise<ToolOutput> {
        try {
            const result = reg.subagentSessions === undefined
                ? await reg.closeDescendantTree(callerId, effect.subagentId)
                : await reg.subagentSessions.closeSubagent(callerId, effect.subagentId);
            return closeSubagentOutput({
                requested_subagent_id: effect.subagentId,
                closed: result.status === "closed",
                // The tool result has no busy reason.
                reason: result.status === "busy" ? "failed" : result.status,
                ...(result.status === "closed"
                    ? { session_retained: result.sessionRetained }
                    : {}),
            });
        } catch {
            return closeSubagentOutput({
                requested_subagent_id: effect.subagentId,
                closed: false,
                reason: "failed",
            });
        }
    }

export function trackAsyncSubagentTurn(reg: AgentRegistry, childId: string): void {
        const child = reg.agents.get(childId);
        const parentId = child?.parentId;
        const parent = parentId === undefined
            ? undefined
            : reg.agents.get(parentId);
        if (child?.kind !== "background" || parentId === undefined
            || (parent === undefined && reg.subagentSessions === undefined)) {
            return;
        }
        if (child.pendingAsyncTurns > 0) {
            child.pendingAsyncTurns += 1;
            return;
        }

        const attachment = child.agent.attach();
        child.completed = false;
        child.pendingAsyncTurns = 1;
        child.completionSequence += 1;
        reg.monitorAsyncSubagent(
            { id: parentId, ...(parent === undefined ? {} : { store: parent.store }) },
            child,
            attachment,
            child.completionSequence,
        );
    }

export function monitorAsyncSubagent(reg: AgentRegistry, parent: SubagentParent, childEntry: RegisteredAgentEntry, attachment: AgentAttachment, completionSequence: number): void {
        const childId = childEntry.agent.id;
        const deliveryTask = reg.deliverBackgroundResult(
            parent,
            childEntry,
            attachment,
            completionSequence,
        ).catch(async (error: unknown) => {
            const entry = reg.agents.get(childId);
            if (entry !== undefined) {
                entry.pendingCompletionDeliveries = Math.max(
                    0,
                    entry.pendingCompletionDeliveries - 1,
                );
                entry.failure = error;
                entry.agent.close();
            }
            const delivery = {
                id: `completion-failed:${childId}:${completionSequence}`,
                sourceAgentId: childId,
                content: `Async subagent result could not be saved: ${error instanceof Error ? error.message : String(error)}`,
                kind: "completion" as const,
            };
            if (reg.subagentSessions !== undefined) {
                await reg.subagentSessions.completionFailure(parent.id, delivery);
            } else {
                const entry = reg.agents.get(parent.id);
                if (entry !== undefined && !entry.agent.closed) {
                    entry.events.emit({ type: "task_notification", deliveryId: delivery.id, sourceAgentId: childId, content: delivery.content, kind: "completion" });
                }
            }
        });
        reg.deliveryTasks.add(deliveryTask);
        void deliveryTask.then(() => reg.deliveryTasks.delete(deliveryTask));
    }

export async function notifyParent(reg: AgentRegistry, childStore: SessionStore, effect: NotifyParentEffect): Promise<ToolOutput> {
        const child = reg.agents.get(childStore.header.id);
        const parentId = child?.parentId;
        if (child?.kind !== "background" || parentId === undefined) {
            return {
                kind: "output",
                output: "This agent has no parent to notify.",
                isError: true,
            };
        }

        const delivery = {
            id: `attention:${childStore.header.id}:${randomUUID()}`,
            sourceAgentId: childStore.header.id,
            content: effect.message,
            kind: "attention" as const,
        };
        if (reg.subagentSessions !== undefined) {
            if (!await reg.subagentSessions.notifyParent(parentId, delivery)) {
                return { kind: "output", output: "The parent agent is unavailable.", isError: true };
            }
        } else {
            const parent = reg.agents.get(parentId);
            if (parent === undefined || parent.agent.closed || parent.agent.failed) {
                return { kind: "output", output: "The parent agent is unavailable.", isError: true };
            }
            await recordDeliveryAndNotify(parent.store, parent.events, delivery);
            parent.agent.triggerDeliveryTurn();
        }
        return {
            kind: "output",
            output: "Parent agent notified.",
            isError: false,
        };
    }

export async function deliverBackgroundResult(reg: AgentRegistry, parent: SubagentParent, childEntry: RegisteredAgentEntry, attachment: AgentAttachment, completionSequence: number): Promise<void> {
        const childId = childEntry.agent.id;
        let content = "Async subagent failed before producing a summary.";
        let failed = true;
        try {
            while (true) {
                const update = await attachment.receive();
                if (
                    update.type === "ui_request"
                    && isToolApprovalUiRequestUpdate(update)
                ) {
                    const parentEntry = reg.agents.get(parent.id);
                    const child = reg.agents.get(childId);
                    const task = await firstUserTask(child?.store) ?? "Background task";
                    const decision = reg.subagentSessions !== undefined
                        ? await reg.subagentSessions.childApproval(parent.id, update, childId, task)
                        : parentEntry === undefined ? "deny" : await reg.relayChildToolApproval(parentEntry, update, childId, task);
                    attachment.send({
                        type: "ui_response",
                        requestId: update.requestId,
                        response: {
                            type: "tool_approval",
                            decision,
                        },
                    });
                }
                if (update.type === "turn_finished") {
                    failed = update.outcome !== undefined;
                    const entry = reg.agents.get(childId);
                    if (entry === undefined) {
                        break;
                    }
                    entry.pendingAsyncTurns = Math.max(
                        0,
                        entry.pendingAsyncTurns - 1,
                    );
                    if (entry.pendingAsyncTurns === 0) {
                        entry.pendingCompletionDeliveries += 1;
                        break;
                    }
                }
            }
            const childStore = reg.agents.get(childId)?.store;
            const summary = await lastAssistantText(childStore);
            if (summary !== undefined && summary.length > 0) {
                content = summary;
            } else {
                failed = true;
            }

        } catch {
            failed = true;
        } finally {
            attachment.detach();
        }
        if (
            reg.suppressedCompletionDeliveries.has(childEntry)
            || (parent.store !== undefined && reg.closingCompletionRecipients.has(parent.store))
            || (reg.subagentSessions !== undefined && await reg.subagentSessions.parentClosing(parent.id))
        ) {
            childEntry.pendingAsyncTurns = 0;
            childEntry.pendingCompletionDeliveries = 0;
            return;
        }
        reg.options.onSubagentFinished?.({
            type: "subagent_finished",
            parentSessionId: parent.id,
            subagentId: childId,
            workspace: childEntry.store.header.cwd,
            background: true,
            outcome: failed ? "error" : "completed",
            text: content,
        });
        const substitution = reg.spawnNotices.get(childId);
        if (substitution !== undefined) {
            content = `${substitution}\n\n${content}`;
        }
        const delivery = {
            id: completionSequence === 1
                ? `completion:${childId}`
                : `completion:${childId}:${completionSequence}`,
            sourceAgentId: childId,
            content,
            kind: "completion" as const,
        };
        let recorded: boolean;
        if (reg.subagentSessions !== undefined) {
            recorded = await reg.subagentSessions.deliverCompletion(parent.id, delivery) === "recorded";
        } else {
            const parentEvents = reg.agents.get(parent.id)?.events;
            if (parent.store === undefined) throw new Error("Parent session store is unavailable");
            recorded = parentEvents === undefined
                ? await parent.store.recordDelivery(delivery)
                : await recordDeliveryAndNotify(parent.store, parentEvents, delivery);
        }
        const entry = reg.agents.get(childId);
        if (entry !== undefined) {
            entry.pendingCompletionDeliveries = Math.max(
                0,
                entry.pendingCompletionDeliveries - 1,
            );
            if (
                entry.failure === undefined
                && entry.pendingAsyncTurns === 0
                && entry.pendingCompletionDeliveries === 0
                && entry.completionSequence === completionSequence
            ) {
                entry.completed = true;
            }
        }
        if (!recorded) {
            return;
        }
        const parentAgent = reg.agents.get(parent.id)?.agent;
        if (reg.subagentSessions === undefined && parentAgent !== undefined && !parentAgent.closed && !parentAgent.failed) {
            parentAgent.triggerDeliveryTurn();
        }
    }

async function firstUserTask(store: SessionStore | undefined): Promise<string | undefined> {
    const head = store?.activeHeadId();
    if (store === undefined || head === null || head === undefined) return undefined;
    for await (const entry of store.walkMessageBranch(head)) {
        if (entry.message.role === "user") {
            return entry.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
        }
    }
    return undefined;
}

async function lastAssistantText(store: SessionStore | undefined): Promise<string | undefined> {
    const head = store?.activeHeadId();
    if (store === undefined || head === null || head === undefined) return undefined;
    for await (const entry of store.walkMessageAncestors(head)) {
        if (entry.message.role === "assistant") {
            return entry.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
        }
    }
    return undefined;
}

export async function relayChildToolApproval(_reg: AgentRegistry, parent: RegisteredAgentEntry, update: ToolApprovalUiRequestUpdate, sourceAgentId: string, sourceTask: string, signal?: AbortSignal): Promise<"allow_once" | "deny"> {
        const result = await parent.inbound?.requestToolApproval(
            update.request.toolCall,
            update.request.reason,
            {
                timeoutMs: CHILD_TOOL_APPROVAL_TIMEOUT_MS,
                sourceAgentId,
                sourceTask,
                ...(signal === undefined ? {} : { signal }),
            },
        );
        return result?.behavior === "allow" ? "allow_once" : "deny";
    }

export function trackDelivery(reg: AgentRegistry, task: Promise<void>): void {
        reg.deliveryTasks.add(task);
        void task.then(() => reg.deliveryTasks.delete(task));
    }
