import { randomUUID } from "node:crypto";
import type { VeraExtensionConfig } from "../../config.ts";
import { AsyncQueue } from "../../engine/async-queue.ts";
import { InboundCommandRouter } from "../../engine/inbound-command-router.ts";
import type { RunHeadlessLoopData, RunHeadlessLoopServices } from "../../engine/loop-services.ts";
import { isOneshotReplyUpdate, isSessionNameReplyUpdate, isTimelineReplyUpdate, isToolApprovalUiRequestUpdate, type ToolApprovalUiRequestUpdate } from "../../engine/protocol.ts";
import { resolveSpawnModelChoice, subagentModelBoundary, type MissingSubagentConfigurationRequest, type SpawnModelResolution, type SubagentPoolPolicy } from "../../engine/subagent.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import { SessionStore } from "../../store/session-store.ts";
import { ToolRuntime } from "../../tools/runtime.ts";
import type { ApplyToolEffect, CloseSubagentEffect, MessageSubagentEffect, NotifyParentEffect, RegisteredTool, SpawnAsyncSubagentEffect, ToolEffectContext, ToolOutput } from "../../tools/types.ts";
import { HOST_OWNED_COMMANDS, WORKER_EXTENSIONS_ENV, WorkerCapReachedError, cancelledSubagentConfiguration, defaultConcurrentWorkerCap, loopStateOf, readSessionSeed, requestedSubagentLabel, subagentResolutionLabel, unavailableSubagentConfiguration, workerOutcomeDetail } from "./helpers.ts";
import { CHILD_TOOL_APPROVAL_TIMEOUT_MS, closeSubagentOutput, type PendingSubagentConfigurationBatch, type PendingSubagentLaunch, type RegisteredAgentEntry } from "./support.ts";
import { recordDeliveryAndNotify } from "../delivery-notifier.ts";
import { ResidentAgent, type AgentAttachment } from "../resident-agent.ts";
import { startWorker } from "../worker/handle.ts";
import type { WorkerAdapterSpec } from "../worker/start.ts";
import type { AgentRegistry } from "../agent-registry.ts";

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
        if ((process.env[WORKER_EXTENSIONS_ENV] ?? "") !== "1") {
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
        const handle = await startWorker({
            store,
            session: await readSessionSeed(store.path),
            model: reg.defaultModel,
            ...(reg.defaultReasoningEffort === undefined
                ? {}
                : { reasoningEffort: reg.defaultReasoningEffort }),
            adapter: options.adapter,
            data: options.data,
            services,
            offers: {
                approvalModeRead: services.readApprovalMode !== undefined,
                modelSettings: services.readModelSettings !== undefined,
                selectedAgent: services.readSelectedAgent !== undefined,
            },
            state: loopStateOf(services),
            ...(workerExtensions === undefined
                ? {}
                : { extensions: workerExtensions }),
            ...(options.extensionTools === undefined
                ? {}
                : {
                    extensionTools: options.extensionTools,
                    toolRuntime: new ToolRuntime(
                        store.header.cwd,
                        undefined,
                        undefined,
                        options.data.toolEnv,
                        options.data.instructionRoot?.path,
                        undefined,
                        store.header.parentId !== undefined,
                    ),
                }),
            onUpdate: (update, ownerId) => {
                if (ownerId === undefined) {
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
            },
        });
        options.entry.worker = handle;
        store.watchRecords(handle.server.pushRecord);
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
        })().catch(() => {
            if (agent.closed && !pumping.signal.aborted) {
                stopping = true;
                handle.kill();
            }
        });
        try {
            const outcome = await handle.outcome;
            if (stopping || outcome.kind === "finished") {
                return;
            }
            throw new Error(workerOutcomeDetail(outcome));
        } finally {
            pumping.abort();
            ownerCommands.fail(new Error("The worker owner channel closed"));
            options.entry.workerOwnerRouter = undefined;
            if (options.entry.worker === handle) {
                options.entry.worker = undefined;
            }
        }
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
        const running = [...reg.agents.values()].filter(
            (entry) =>
                entry.kind === "background"
                && entry.parentId === parentStore.header.id
                && entry.failure === undefined
                && !entry.agent.failed
                && !entry.agent.closed
                && entry.pendingAsyncTurns > 0,
        ).length
            + (reg.startingBackgroundAgents.get(parentStore.header.id) ?? 0);
        if (running >= reg.maxConcurrentBackgroundAgents) {
            return {
                kind: "output",
                output: `Async subagent limit reached `
                    + `(${reg.maxConcurrentBackgroundAgents} running).`,
                isError: true,
            };
        }
        reg.startingBackgroundAgents.set(
            parentStore.header.id,
            (reg.startingBackgroundAgents.get(parentStore.header.id) ?? 0) + 1,
        );
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
        } finally {
            const remaining =
                (reg.startingBackgroundAgents.get(parentStore.header.id) ?? 1)
                - 1;
            if (remaining === 0) {
                reg.startingBackgroundAgents.delete(parentStore.header.id);
            } else {
                reg.startingBackgroundAgents.set(
                    parentStore.header.id,
                    remaining,
                );
            }
        }
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
    }

export async function messageSubagent(reg: AgentRegistry, parentStore: SessionStore, effect: MessageSubagentEffect): Promise<ToolOutput> {
        const child = reg.agents.get(effect.subagentId);
        if (
            child === undefined
            || child.kind !== "background"
            || child.parentId !== parentStore.header.id
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

        child.agent.sendPrompt(effect.message);
        reg.trackAsyncSubagentTurn(effect.subagentId);
        return {
            kind: "output",
            output: `Message queued for async subagent ${effect.subagentId}.`,
            isError: false,
        };
    }

export async function closeSubagent(reg: AgentRegistry, callerId: string, effect: CloseSubagentEffect): Promise<ToolOutput> {
        try {
            const result = await reg.closeDescendantTree(
                callerId,
                effect.subagentId,
            );
            return closeSubagentOutput({
                requested_subagent_id: effect.subagentId,
                closed: result.status === "closed",
                reason: result.status,
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
        const parent = child?.parentId === undefined
            ? undefined
            : reg.agents.get(child.parentId);
        if (child?.kind !== "background" || parent === undefined) {
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
            parent.store,
            child,
            attachment,
            child.completionSequence,
        );
    }

export function monitorAsyncSubagent(reg: AgentRegistry, parentStore: SessionStore, childEntry: RegisteredAgentEntry, attachment: AgentAttachment, completionSequence: number): void {
        const childId = childEntry.agent.id;
        const deliveryTask = reg.deliverBackgroundResult(
            parentStore,
            childEntry,
            attachment,
            completionSequence,
        ).catch((error: unknown) => {
            const entry = reg.agents.get(childId);
            if (entry !== undefined) {
                entry.pendingCompletionDeliveries = Math.max(
                    0,
                    entry.pendingCompletionDeliveries - 1,
                );
                entry.failure = error;
                entry.agent.close();
            }
            const parent = reg.agents.get(parentStore.header.id);
            if (parent !== undefined && !parent.agent.closed) {
                parent.events.emit({
                    type: "task_notification",
                    deliveryId: `completion-failed:${childId}:${completionSequence}`,
                    sourceAgentId: childId,
                    content: `Async subagent result could not be saved: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    kind: "completion",
                });
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

        const parent = reg.agents.get(parentId);
        if (parent === undefined || parent.agent.closed || parent.agent.failed) {
            return {
                kind: "output",
                output: "The parent agent is unavailable.",
                isError: true,
            };
        }
        const delivery = {
            id: `attention:${childStore.header.id}:${randomUUID()}`,
            sourceAgentId: childStore.header.id,
            content: effect.message,
            kind: "attention" as const,
        };
        await recordDeliveryAndNotify(parent.store, parent.events, delivery);
        parent.agent.triggerDeliveryTurn();
        return {
            kind: "output",
            output: "Parent agent notified.",
            isError: false,
        };
    }

export async function deliverBackgroundResult(reg: AgentRegistry, parentStore: SessionStore, childEntry: RegisteredAgentEntry, attachment: AgentAttachment, completionSequence: number): Promise<void> {
        const childId = childEntry.agent.id;
        let content = "Async subagent failed before producing a summary.";
        try {
            while (true) {
                const update = await attachment.receive();
                if (
                    update.type === "ui_request"
                    && isToolApprovalUiRequestUpdate(update)
                ) {
                    const parent = reg.agents.get(parentStore.header.id);
                    const child = reg.agents.get(childId);
                    const decision = parent === undefined
                        ? "deny"
                        : await reg.relayChildToolApproval(
                            parent,
                            update,
                            childId,
                            child?.store.messages()
                                .find((message) => message.role === "user")
                                ?.content
                                .filter((block) => block.type === "text")
                                .map((block) => block.text)
                                .join("\n") ?? "Background task",
                        );
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
            const finalMessage = childStore?.messages().findLast(
                (message) => message.role === "assistant",
            );
            const summary = finalMessage?.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n")
                .trim();
            if (summary !== undefined && summary.length > 0) {
                content = summary;
            }
        } catch {
        } finally {
            attachment.detach();
        }
        if (
            reg.suppressedCompletionDeliveries.has(childEntry)
            || reg.closingCompletionRecipients.has(parentStore)
        ) {
            childEntry.pendingAsyncTurns = 0;
            childEntry.pendingCompletionDeliveries = 0;
            return;
        }
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
        const parentEvents = reg.agents.get(parentStore.header.id)?.events;
        const recorded = parentEvents === undefined
            ? await parentStore.recordDelivery(delivery)
            : await recordDeliveryAndNotify(parentStore, parentEvents, delivery);
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
        const parent = reg.agents.get(parentStore.header.id)?.agent;
        if (parent !== undefined && !parent.closed && !parent.failed) {
            parent.triggerDeliveryTurn();
        }
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
