import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import { defaultEventLogPath, EngineEventBus } from "../engine/events.ts";
import {
    builtInPermissionMode,
    isApprovalMode,
    type ApprovalMode,
    type PermissionMode,
} from "../engine/permissions.ts";
import type { PermissionPreferenceStore } from "../engine/permission-preferences.ts";
import type { ModelFallbackPolicy } from "../engine/recovery.ts";
import {
    availableModels,
    availableReasoningEfforts,
    isModelReasoningEffort,
    type ModelSettingsPatch,
    type ModelTurnSettings,
} from "../engine/model-settings.ts";
import { runHeadlessLoop } from "../engine/run-turn.ts";
import { createSubagentEffectApplier } from "../engine/subagent.ts";
import type { ToolReviewerSettings } from "../engine/reviewer.ts";
import type {
    ModelAdapter,
    ModelReasoningEffort,
} from "../model/types.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import { projectTranscript } from "../engine/protocol.ts";
import type {
    ApplyToolEffect,
    SpawnBackgroundAgentEffect,
    ToolOutput,
} from "../tools/types.ts";
import {
    defaultSessionPath,
    SessionStore,
} from "../store/session-store.ts";
import { createSessionBranch } from "../store/session-branch.ts";
import type { UserMessage } from "../model/types.ts";
import { recordDeliveryAndNotify } from "./delivery-notifier.ts";
import { ImageAttachmentService } from "../attachments/service.ts";
import { ProviderRoutingAdapter } from "../providers/routing.ts";
import {
    type AgentAttachment,
    ResidentAgent,
} from "./resident-agent.ts";
import {
    trashSessionArtifacts,
    type SessionArtifacts,
} from "./session-trash.ts";

export type RegisteredAgentStatus =
    | "idle"
    | "working"
    | "waiting"
    | "completed"
    | "closed"
    | "failed";

export type RegisteredAgentKind = "interactive" | "background";

const IMAGE_ATTACHMENT_LIMITS = {
    maxBytes: 20 * 1_024 * 1_024,
    maxWidth: 16_384,
    maxHeight: 16_384,
} as const;

export interface RegisteredAgentSummary {
    readonly id: string;
    readonly workspace: string;
    readonly session_path: string;
    readonly kind: RegisteredAgentKind;
    readonly status: RegisteredAgentStatus;
    readonly title?: string;
    readonly updated_at?: string;
}

export interface AgentRegistryOptions {
    readonly createAdapter: (provider?: string) => ModelAdapter;
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly approvalMode: ApprovalMode;
    readonly modelFallback?: ModelFallbackPolicy;
    /** Overrides the model the automatic approval reviewer runs on. */
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    /**
     * Durable preferences, deliberately one store shared by every agent:
     * the file is per-user, not per-session, so an allow the user persists
     * in one agent applies in the next one without a restart.
     */
    readonly permissionPreferences?: PermissionPreferenceStore;
    readonly availableModels?: readonly SuggestedModel[];
    readonly sessionPathForId?: (agentId: string) => string;
    readonly eventLogPathForId?: (agentId: string) => string;
    readonly updateModelDefaults?: (settings: ModelTurnSettings) => void;
    readonly updateApprovalDefault?: (mode: ApprovalMode) => void;
    readonly trashSessionArtifacts?: (artifacts: SessionArtifacts) => Promise<void>;
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

export interface BranchRegisteredAgentOptions {
    readonly sourceId: string;
    readonly position: "before" | "at";
    readonly entryId?: string;
    readonly id?: string;
    readonly sessionPath?: string;
    readonly eventLogPath?: string;
}

export interface BranchedRegisteredAgent {
    readonly agent: ResidentAgent;
    readonly prompt?: UserMessage;
}

interface InheritedAgentSettings {
    readonly approvalMode: ApprovalMode;
    readonly modelSettings?: ModelTurnSettings;
}

interface RegisteredAgentEntry {
    readonly agent: ResidentAgent;
    readonly store: SessionStore;
    readonly kind: RegisteredAgentKind;
    readonly events: EngineEventBus;
    readonly adapter?: ProviderRoutingAdapter;
    readonly eventLogPath: string;
    modelSettings: ModelTurnSettings;
    approvalMode: ApprovalMode;
    run: Promise<void>;
    completed: boolean;
    failure?: unknown;
}

export class AgentRegistry {
    private readonly agents = new Map<string, RegisteredAgentEntry>();
    private readonly startingIds = new Set<string>();
    private readonly deliveryTasks = new Set<Promise<void>>();
    private defaultModel: string;
    private defaultProvider: string;
    private defaultReasoningEffort: ModelReasoningEffort | undefined;
    private defaultApprovalMode: ApprovalMode;
    private isClosed = false;
    private readonly trashArtifacts: (artifacts: SessionArtifacts) => Promise<void>;

    constructor(private readonly options: AgentRegistryOptions) {
        this.defaultModel = options.model;
        this.defaultProvider = options.provider ?? "unknown";
        this.defaultReasoningEffort = options.reasoningEffort;
        this.defaultApprovalMode = options.approvalMode;
        this.trashArtifacts = options.trashSessionArtifacts
            ?? trashSessionArtifacts;
    }

    async create(
        options: CreateRegisteredAgentOptions,
    ): Promise<ResidentAgent> {
        return this.createWithKind(options, "interactive");
    }

    private async createWithKind(
        options: CreateRegisteredAgentOptions,
        kind: RegisteredAgentKind,
        inherited?: InheritedAgentSettings,
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
            if (inherited !== undefined) {
                await store.appendApprovalMode(inherited.approvalMode);
                if (inherited.modelSettings !== undefined) {
                    await store.appendModelSettings(inherited.modelSettings);
                }
            }
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

    async branch(
        options: BranchRegisteredAgentOptions,
    ): Promise<BranchedRegisteredAgent | undefined> {
        const source = this.agents.get(options.sourceId);
        if (
            source === undefined
            || source.agent.closed
            || source.agent.failed
            || source.agent.status !== "idle"
        ) {
            return undefined;
        }
        const id = options.id ?? randomUUID();
        this.reserveId(id);
        try {
            const created = await createSessionBranch({
                source: source.store,
                destinationPath: options.sessionPath
                    ?? this.options.sessionPathForId?.(id)
                    ?? defaultSessionPath(id),
                sessionId: id,
                position: options.position,
                ...(options.entryId === undefined
                    ? {}
                    : { entryId: options.entryId }),
            });
            this.requireOpen();
            return {
                agent: this.start(
                    created.store,
                    "interactive",
                    options.eventLogPath,
                ),
                ...(created.prompt === undefined
                    ? {}
                    : { prompt: created.prompt }),
            };
        } finally {
            this.startingIds.delete(id);
        }
    }

    async trashSession(
        targetId: string,
    ): Promise<"trashed" | "busy" | "not_found" | "failed"> {
        const entry = this.agents.get(targetId);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return "not_found";
        }
        if (
            entry.kind !== "interactive"
            || !entry.agent.idleForShutdown()
        ) {
            return "busy";
        }

        entry.agent.close();
        await entry.run;
        this.agents.delete(targetId);
        try {
            await this.trashArtifacts({
                sessionPath: entry.store.path,
                attachmentsPath: `${entry.store.path}.attachments`,
                eventLogPath: entry.eventLogPath,
            });
            return "trashed";
        } catch {
            try {
                const store = await SessionStore.open(entry.store.path);
                this.start(store, entry.kind, entry.eventLogPath);
            } catch {
                // A partial trash failure can leave the session unavailable.
            }
            return "failed";
        }
    }

    find(id: string): ResidentAgent | undefined {
        const agent = this.agents.get(id)?.agent;
        return agent?.closed === false ? agent : undefined;
    }

    async updateModelSettings(
        id: string,
        patch: ModelSettingsPatch,
    ): Promise<ModelTurnSettings | undefined> {
        const entry = this.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return undefined;
        }
        if (
            (patch.provider === undefined && patch.model === undefined && patch.reasoningEffort === undefined)
            || (patch.provider !== undefined && patch.provider.trim().length === 0)
            || (patch.provider !== undefined
                && patch.provider !== "openrouter"
                && patch.provider !== "openai-codex"
                && patch.provider !== "ollama")
            || (patch.model !== undefined && patch.model.trim().length === 0)
            || (patch.reasoningEffort !== undefined
                && patch.reasoningEffort !== null
                && !isModelReasoningEffort(patch.reasoningEffort))
        ) {
            return undefined;
        }
        const provider = patch.provider?.trim()
            ?? entry.modelSettings.provider
            ?? this.defaultProvider;
        const model = patch.model?.trim() ?? entry.modelSettings.model;
        try {
            entry.adapter?.prepareProvider(provider);
        } catch {
            return undefined;
        }
        let reasoningEffort = patch.reasoningEffort === undefined
            ? entry.modelSettings.reasoningEffort
            : patch.reasoningEffort === null
                ? undefined
                : patch.reasoningEffort;
        if (provider === "openai-codex") reasoningEffort = undefined;
        const availableEfforts = availableReasoningEfforts(
            provider,
            model,
        );
        if (
            patch.model !== undefined
            && patch.reasoningEffort === undefined
            && reasoningEffort !== undefined
            && !availableEfforts.includes(reasoningEffort)
        ) {
            reasoningEffort = strongestReasoningEffort(availableEfforts);
        }
        if (
            reasoningEffort !== undefined
            && !availableEfforts.includes(reasoningEffort)
        ) {
            return undefined;
        }
        const settings: ModelTurnSettings = {
            provider,
            model,
            ...(reasoningEffort === undefined
                ? {}
                : { reasoningEffort }),
        };
        await entry.store.appendModelSettings(settings);
        this.options.updateModelDefaults?.(settings);
        this.defaultModel = settings.model;
        this.defaultProvider = settings.provider ?? this.defaultProvider;
        this.defaultReasoningEffort = settings.reasoningEffort;
        entry.modelSettings = settings;
        return settingsForClient(
            entry.modelSettings,
            entry.modelSettings.provider ?? this.defaultProvider,
            this.options.availableModels,
        );
    }

    async updateApprovalMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        const entry = this.agents.get(id);
        if (
            entry === undefined
            || entry.agent.closed
            || entry.agent.failed
            || !isApprovalMode(mode)
            || (
                builtInPermissionMode(mode) === undefined
                && this.options.permissionModes?.[mode] === undefined
            )
        ) {
            return undefined;
        }
        await entry.store.appendApprovalMode(mode);
        this.options.updateApprovalDefault?.(mode);
        this.defaultApprovalMode = mode;
        entry.approvalMode = mode;
        return entry.approvalMode;
    }

    async updateSessionName(
        id: string,
        name: string | null,
    ): Promise<string | null | undefined> {
        const entry = this.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return undefined;
        }
        await entry.store.appendName(name);
        return entry.store.name() ?? null;
    }

    list(): RegisteredAgentSummary[] {
        return [...this.agents.values()]
            .map((entry) => {
                const activeEntries = entry.store.activeEntries();
                const firstUserEntry = activeEntries.find(
                    (candidate) => candidate.message.role === "user"
                        && candidate.message.internal !== true,
                );
                const firstUserMessage = firstUserEntry?.message;
                const fallbackTitle = firstUserMessage?.role === "user"
                    ? firstUserMessage.content
                        .flatMap((content) => content.type === "text"
                            ? [content.text]
                            : [])
                        .join(" ")
                        .replaceAll(/\s+/g, " ")
                        .trim()
                    : undefined;
                const title = entry.store.name() ?? fallbackTitle;
                return {
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
                    ...(title === undefined || title.length === 0
                        ? {}
                        : { title: title.slice(0, 80) }),
                    updated_at: entry.store.agentFailure()?.timestamp
                        ?? activeEntries.at(-1)?.timestamp
                        ?? entry.store.header.timestamp,
                };
            })
            .sort((left, right) => left.id.localeCompare(right.id));
    }

    idleForShutdown(): boolean {
        return this.startingIds.size === 0
            && this.deliveryTasks.size === 0
            && [...this.agents.values()].every(
                (entry) => entry.agent.idleForShutdown(),
            );
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
        const storedFailure = store.agentFailure();
        const adapter = storedFailure === undefined
            ? new ProviderRoutingAdapter(
                (provider) => this.options.createAdapter(provider),
                this.defaultProvider,
                this.options.createAdapter(this.defaultProvider),
            )
            : undefined;
        const imageAttachments = new ImageAttachmentService(
            store,
            IMAGE_ATTACHMENT_LIMITS,
        );
        const agent = new ResidentAgent(store.header.id, store.header.cwd, {
            attachImage: (path, signal) =>
                imageAttachments.attachFile(path, signal),
        });
        const events = new EngineEventBus();
        const storedSettings = store.modelSettings();
        const entry: RegisteredAgentEntry = {
            agent,
            store,
            kind,
            events,
            eventLogPath,
            ...(adapter === undefined ? {} : { adapter }),
            modelSettings: storedSettings === undefined
                ? {
                    provider: this.defaultProvider,
                    model: this.defaultModel,
                    ...(this.defaultReasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: this.defaultReasoningEffort }),
                }
                : {
                    ...storedSettings,
                    provider: storedSettings.provider ?? this.defaultProvider,
                },
            approvalMode: store.approvalMode() ?? this.defaultApprovalMode,
            run: Promise.resolve(),
            completed: false,
            ...(storedFailure === undefined
                ? {}
                : { failure: new Error(storedFailure.detail) }),
        };
        this.agents.set(agent.id, entry);
        if (storedFailure !== undefined) {
            agent.restoreFailure({
                type: "history",
                entries: projectTranscript(store.messages()),
                seq: 0,
            }, storedFailure.id, storedFailure.detail);
            return agent;
        }
        if (adapter === undefined) {
            throw new Error("Active resident agent has no model adapter");
        }
        const applySubagentEffect = createSubagentEffectApplier({
            adapter,
            workspace: store.header.cwd,
            ...(this.options.modelFallback === undefined
                ? {}
                : { modelFallback: this.options.modelFallback }),
        });
        const applyToolEffect: ApplyToolEffect = (effect, signal, context) =>
            effect.type === "spawn_background_agent"
                ? this.spawnBackgroundAgent(
                    store,
                    effect,
                    context,
                )
                : applySubagentEffect(effect, signal, context);
        entry.run = runHeadlessLoop(
            agent.engine,
            adapter,
            this.defaultModel,
            this.defaultReasoningEffort,
            {
                sessionStore: store,
                eventLogPath,
                eventBus: events,
                approvalMode: entry.approvalMode,
                modelFallback: this.options.modelFallback,
                ...(this.options.reviewer === undefined
                    ? {}
                    : { reviewer: this.options.reviewer }),
                ...(this.options.reviewers === undefined
                    ? {}
                    : { reviewers: this.options.reviewers }),
                ...(this.options.permissionModes === undefined
                    ? {}
                    : { permissionModes: this.options.permissionModes }),
                applyToolEffect,
                enabledToolEffects: [
                    "spawn_subagent",
                    "spawn_background_agent",
                ],
                enableUserInteraction: kind === "interactive",
                readModelSettings: () => settingsForClient(
                    entry.modelSettings,
                    entry.modelSettings.provider ?? this.defaultProvider,
                    this.options.availableModels,
                ),
                updateModelSettings: (patch) =>
                    this.updateModelSettings(agent.id, patch),
                readApprovalMode: () => entry.approvalMode,
                updateApprovalMode: (mode) =>
                    this.updateApprovalMode(agent.id, mode),
                ...(this.options.permissionPreferences === undefined ? {} : {
                    readPermissionPreferences: () =>
                        this.options.permissionPreferences!.list(),
                    addPermissionPreference: (when) =>
                        this.options.permissionPreferences!.add(when),
                    removePermissionPreference: (id) =>
                        this.options.permissionPreferences!.remove(id),
                }),
                updateSessionName: (name) =>
                    this.updateSessionName(agent.id, name),
                sendTimelineReply: (ownerId, reply) =>
                    agent.sendTimelineReply(ownerId, reply),
                sendSessionNameReply: (ownerId, reply) =>
                    agent.sendSessionNameReply(ownerId, reply),
            },
        ).catch(async (error: unknown) => {
            if (!agent.closed) {
                entry.failure = error;
                const failureId = randomUUID();
                const detail = "Resident agent stopped unexpectedly";
                try {
                    await store.appendAgentFailure(failureId, detail);
                } catch {
                    // Live clients still need a terminal outcome when the
                    // failure record itself cannot be persisted.
                }
                agent.fail(failureId, detail);
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
        context: Parameters<ApplyToolEffect>[2],
    ): Promise<ToolOutput> {
        const child = await this.createWithKind(
            { workspace: parentStore.header.cwd },
            "background",
            {
                approvalMode: context.approvalMode,
                modelSettings: {
                    ...(context.provider === undefined
                        ? { provider: this.defaultProvider }
                        : { provider: context.provider }),
                    model: context.model,
                    ...(context.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: context.reasoningEffort }),
                },
            },
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

function strongestReasoningEffort(
    efforts: readonly ModelReasoningEffort[],
): ModelReasoningEffort | undefined {
    const strongestFirst: readonly ModelReasoningEffort[] = [
        "max",
        "high",
        "medium",
        "low",
        "off",
    ];
    return strongestFirst.find((effort) => efforts.includes(effort));
}

function settingsForClient(
    settings: ModelTurnSettings,
    provider: string,
    models: readonly SuggestedModel[] = availableModels(),
): ModelTurnSettings {
    const selected = models.find((model) =>
        model.provider === provider && model.model === settings.model
    );
    return {
        ...settings,
        availableReasoningEfforts: availableReasoningEfforts(
            provider,
            settings.model,
        ),
        availableModels: models,
        ...(selected?.contextWindow === undefined
            ? {}
            : { contextWindow: selected.contextWindow }),
    };
}
