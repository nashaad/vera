import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import { defaultEventLogPath, EngineEventBus } from "../engine/events.ts";
import type { ApprovalMode } from "../engine/permissions.ts";
import type { ModelFallbackPolicy } from "../engine/recovery.ts";
import { runHeadlessLoop } from "../engine/run-turn.ts";
import { createSubagentEffectApplier } from "../engine/subagent.ts";
import type {
    ModelAdapter,
    ModelReasoningEffort,
} from "../model/types.ts";
import type {
    ApplyToolEffect,
    SpawnBackgroundAgentEffect,
    ToolOutput,
} from "../tools/types.ts";
import {
    defaultSessionPath,
    SessionStore,
} from "../store/session-store.ts";
import { recordDeliveryAndNotify } from "./delivery-notifier.ts";
import {
    type AgentAttachment,
    ResidentAgent,
} from "./resident-agent.ts";

export type RegisteredAgentStatus =
    | "idle"
    | "working"
    | "waiting"
    | "completed"
    | "closed"
    | "failed";

export type RegisteredAgentKind = "interactive" | "background";

export interface RegisteredAgentSummary {
    readonly id: string;
    readonly workspace: string;
    readonly session_path: string;
    readonly kind: RegisteredAgentKind;
    readonly status: RegisteredAgentStatus;
}

export interface AgentRegistryOptions {
    readonly createAdapter: () => ModelAdapter;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly approvalMode: ApprovalMode;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly sessionPathForId?: (agentId: string) => string;
    readonly eventLogPathForId?: (agentId: string) => string;
}

export interface CreateRegisteredAgentOptions {
    readonly id?: string;
    readonly workspace: string;
    readonly sessionPath?: string;
    readonly eventLogPath?: string;
}

export interface ResumeRegisteredAgentOptions {
    readonly sessionPath: string;
    readonly eventLogPath?: string;
}

interface RegisteredAgentEntry {
    readonly agent: ResidentAgent;
    readonly store: SessionStore;
    readonly kind: RegisteredAgentKind;
    readonly events: EngineEventBus;
    run: Promise<void>;
    completed: boolean;
    failure?: unknown;
}

export class AgentRegistry {
    private readonly agents = new Map<string, RegisteredAgentEntry>();
    private readonly startingIds = new Set<string>();
    private readonly deliveryTasks = new Set<Promise<void>>();
    private isClosed = false;

    constructor(private readonly options: AgentRegistryOptions) {}

    async create(
        options: CreateRegisteredAgentOptions,
    ): Promise<ResidentAgent> {
        return this.createWithKind(options, "interactive");
    }

    private async createWithKind(
        options: CreateRegisteredAgentOptions,
        kind: RegisteredAgentKind,
    ): Promise<ResidentAgent> {
        const id = options.id ?? randomUUID();
        this.reserveId(id);
        try {
            const workspace = await realpath(options.workspace);
            const store = await SessionStore.create(
                options.sessionPath
                    ?? this.options.sessionPathForId?.(id)
                    ?? defaultSessionPath(id),
                { sessionId: id, cwd: workspace },
            );
            this.requireOpen();
            return this.start(store, kind, options.eventLogPath);
        } finally {
            this.startingIds.delete(id);
        }
    }

    async resume(
        options: ResumeRegisteredAgentOptions,
    ): Promise<ResidentAgent> {
        const sessionPath = await realpath(options.sessionPath);
        const store = await SessionStore.open(sessionPath);
        this.reserveId(store.header.id);
        try {
            this.requireOpen();
            return this.start(store, "interactive", options.eventLogPath);
        } finally {
            this.startingIds.delete(store.header.id);
        }
    }

    find(id: string): ResidentAgent | undefined {
        const agent = this.agents.get(id)?.agent;
        return agent?.closed === false ? agent : undefined;
    }

    list(): RegisteredAgentSummary[] {
        return [...this.agents.values()]
            .map((entry) => ({
                id: entry.agent.id,
                workspace: entry.agent.workspace,
                session_path: entry.store.path,
                kind: entry.kind,
                status: entry.failure !== undefined
                    ? "failed" as const
                    : entry.agent.closed
                        ? "closed" as const
                        : entry.completed && entry.agent.status === "idle"
                            ? "completed" as const
                            : entry.agent.status,
            }))
            .sort((left, right) => left.id.localeCompare(right.id));
    }

    async close(): Promise<void> {
        this.isClosed = true;
        const entries = [...this.agents.values()];
        for (const entry of entries) {
            entry.agent.close();
        }
        await Promise.all(entries.map((entry) => entry.run));
        await Promise.all([...this.deliveryTasks]);
    }

    private start(
        store: SessionStore,
        kind: RegisteredAgentKind,
        eventLogPath = this.options.eventLogPathForId?.(store.header.id)
            ?? defaultEventLogPath(store.header.id),
    ): ResidentAgent {
        const adapter = this.options.createAdapter();
        const agent = new ResidentAgent(store.header.id, store.header.cwd);
        const events = new EngineEventBus();
        const entry: RegisteredAgentEntry = {
            agent,
            store,
            kind,
            events,
            run: Promise.resolve(),
            completed: false,
        };
        this.agents.set(agent.id, entry);
        const applySubagentEffect = createSubagentEffectApplier({
            adapter,
            model: this.options.model,
            workspace: store.header.cwd,
            approvalMode: this.options.approvalMode,
            ...(this.options.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: this.options.reasoningEffort }),
            ...(this.options.modelFallback === undefined
                ? {}
                : { modelFallback: this.options.modelFallback }),
        });
        const applyToolEffect: ApplyToolEffect = (effect, signal) =>
            effect.type === "spawn_background_agent"
                ? this.spawnBackgroundAgent(store, effect)
                : applySubagentEffect(effect, signal);
        entry.run = runHeadlessLoop(
            agent.engine,
            adapter,
            this.options.model,
            this.options.reasoningEffort,
            {
                sessionStore: store,
                eventLogPath,
                eventBus: events,
                approvalMode: this.options.approvalMode,
                modelFallback: this.options.modelFallback,
                applyToolEffect,
                enabledToolEffects: [
                    "spawn_subagent",
                    "spawn_background_agent",
                ],
            },
        ).catch((error: unknown) => {
            if (!agent.closed) {
                entry.failure = error;
                agent.close();
            }
        });
        for (const delivery of store.pendingDeliveries()) {
            events.emit({
                type: "task_notification",
                deliveryId: delivery.id,
                sourceAgentId: delivery.sourceAgentId,
                content: delivery.content,
            });
        }
        return agent;
    }

    private async spawnBackgroundAgent(
        parentStore: SessionStore,
        effect: SpawnBackgroundAgentEffect,
    ): Promise<ToolOutput> {
        const child = await this.createWithKind(
            { workspace: parentStore.header.cwd },
            "background",
        );
        const attachment = child.attach();
        try {
            attachment.send({ type: "prompt", content: effect.description });
        } catch (error) {
            attachment.detach();
            child.close();
            throw error;
        }
        const deliveryTask = this.deliverBackgroundResult(
            parentStore,
            child.id,
            attachment,
        ).catch((error: unknown) => {
            const entry = this.agents.get(child.id);
            if (entry !== undefined) {
                entry.failure = error;
                entry.agent.close();
            }
        });
        this.deliveryTasks.add(deliveryTask);
        void deliveryTask.then(() => this.deliveryTasks.delete(deliveryTask));
        return {
            kind: "output",
            output: `Background agent ${child.id} started. Its final summary will arrive as a task notification.`,
            isError: false,
        };
    }

    private async deliverBackgroundResult(
        parentStore: SessionStore,
        childId: string,
        attachment: AgentAttachment,
    ): Promise<void> {
        let content = "Background agent failed before producing a summary.";
        try {
            while ((await attachment.receive()).type !== "turn_finished") {
                // The internal attachment only waits for the terminal update.
            }
            const childStore = this.agents.get(childId)?.store;
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
            // The durable failure delivery below is safer than exposing host internals.
        } finally {
            attachment.detach();
        }
        const delivery = {
            id: `completion:${childId}`,
            sourceAgentId: childId,
            content,
        };
        const parentEvents = this.agents.get(parentStore.header.id)?.events;
        if (parentEvents === undefined) {
            await parentStore.recordDelivery(delivery);
        } else {
            await recordDeliveryAndNotify(parentStore, parentEvents, delivery);
        }
        const entry = this.agents.get(childId);
        if (entry !== undefined && entry.failure === undefined) {
            entry.completed = true;
        }
    }

    private reserveId(id: string): void {
        this.requireOpen();
        if (this.agents.has(id) || this.startingIds.has(id)) {
            throw new Error(`Resident agent ${id} already exists`);
        }
        this.startingIds.add(id);
    }

    private requireOpen(): void {
        if (this.isClosed) {
            throw new Error("Agent registry is closed");
        }
    }
}
