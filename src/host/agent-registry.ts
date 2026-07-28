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
    contextWindowForModel,
    isModelReasoningEffort,
    reasoningEffortForModel,
    type ModelSettingsPatch,
    type ModelTurnSettings,
} from "../engine/model-settings.ts";
import { runHeadlessLoop } from "../engine/run-turn.ts";
import {
    BUNDLED_COMPACTION_STRATEGIES,
    bindCompaction,
} from "../engine/compaction-binding.ts";
import type { ResolvedCompactionProfile } from "../config/model-catalog.ts";
import { createSubagentEffectApplier } from "../engine/subagent.ts";
import type { InboundCommandRouter } from "../engine/inbound-command-router.ts";
import {
    isToolApprovalUiRequestUpdate,
    type ToolApprovalUiRequestUpdate,
} from "../engine/protocol.ts";
import {
    DEFAULT_MAX_CONCURRENT_CHILD_AGENTS,
    MAX_AGENT_DEPTH,
    validChildAgentLimit,
} from "../engine/agent-limits.ts";
import type { ToolReviewerSettings } from "../engine/reviewer.ts";
import type {
    ModelAdapter,
    ModelReasoningEffort,
} from "../model/types.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import {
    availableModelsWithLevels,
    type PinnedModel,
} from "../model/catalog-view.ts";
import { projectTranscript } from "../engine/protocol.ts";
import type {
    ApplyToolEffect,
    RegisteredTool,
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
import {
    ImageAttachmentService,
    sessionAttachmentName,
} from "../attachments/service.ts";
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
const CHILD_TOOL_APPROVAL_TIMEOUT_MS = 60_000;

export interface RegisteredAgentSummary {
    readonly id: string;
    readonly workspace: string;
    readonly session_path: string;
    readonly kind: RegisteredAgentKind;
    readonly status: RegisteredAgentStatus;
    /**
     * Whether anything is actually happening in this session right now.
     *
     * Separate from `status` because the two answer different questions. The
     * host holds every session on disk, so `idle` means the session exists,
     * not that it is running, and a list that showed only `status` would
     * describe a conversation from last month exactly as it describes the one
     * being typed into. Derived from what the host already knows about itself
     * and recomputed on every listing, so nothing durable records it.
     */
    readonly live: boolean;
    readonly title?: string;
    readonly updated_at?: string;
    /**
     * The session this one was branched from, absent on a session that was
     * started rather than forked. The id alone rather than the whole header
     * `origin`: a client threads rows by parentage, and where in the parent the
     * branch was taken is a fact about the transcript, not about the list.
     */
    readonly forked_from?: string;
}

export interface AgentRegistryOptions {
    readonly createAdapter: (provider?: string) => ModelAdapter;
    /**
     * Tells a running agent that a provider's credentials changed, so it stops
     * spending the key it started with. Absent in tests that never sign in.
     */
    readonly credentialFingerprint?: (provider: string) => string | undefined;
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly approvalMode: ApprovalMode;
    readonly maxConcurrentBackgroundAgents?: number;
    readonly modelFallback?: ModelFallbackPolicy;
    /** Overrides the model the automatic approval reviewer runs on. */
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    /** Resolved once at startup, bound per agent to that agent's adapter. */
    readonly compaction?: ResolvedCompactionProfile;
    /**
     * Durable preferences, deliberately one store shared by every agent:
     * the file is per-user, not per-session, so an allow the user persists
     * in one agent applies in the next one without a restart.
     */
    readonly permissionPreferences?: PermissionPreferenceStore;
    readonly availableModels?: readonly SuggestedModel[];
    /**
     * Read per settings snapshot, not once at startup: the user pins and unpins
     * while the host runs, so a snapshot taken when it came up would freeze the
     * list for the life of the host.
     */
    readonly readPins?: () => readonly PinnedModel[];
    readonly sessionPathForId?: (agentId: string) => string;
    readonly eventLogPathForId?: (agentId: string) => string;
    readonly updateModelDefaults?: (settings: ModelTurnSettings) => void;
    /**
     * Writes the pin list. Separate from `readPins` because the two have
     * different lifetimes: reads happen on every snapshot, writes only when the
     * user asks, and only the write touches the user's config file.
     */
    readonly updatePin?: (
        action: "add" | "remove",
        entry: { readonly provider: string; readonly model: string },
    ) => void;
    readonly updateApprovalDefault?: (mode: ApprovalMode) => void;
    readonly trashSessionArtifacts?: (artifacts: SessionArtifacts) => Promise<void>;
    readonly extensionTools?: readonly RegisteredTool[];
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

export type RenameSessionOutcome =
    | { readonly status: "renamed"; readonly name: string | null }
    | { readonly status: "invalid" | "busy" | "not_found" | "failed" };

/** Returns undefined for a name the attached path would also refuse. */
function normalizeSessionName(
    name: string | null,
): string | null | undefined {
    if (name === null) {
        return null;
    }
    const trimmed = name.trim();
    return trimmed.length === 0
            || trimmed.includes("\0")
            || Buffer.byteLength(trimmed, "utf8") > 200
        ? undefined
        : trimmed;
}

interface InheritedAgentSettings {
    readonly approvalMode: ApprovalMode;
    readonly modelSettings?: ModelTurnSettings;
    readonly parentId?: string;
}

interface RegisteredAgentEntry {
    readonly agent: ResidentAgent;
    readonly store: SessionStore;
    readonly kind: RegisteredAgentKind;
    readonly events: EngineEventBus;
    readonly adapter?: ProviderRoutingAdapter;
    readonly eventLogPath: string;
    readonly parentId?: string;
    modelSettings: ModelTurnSettings;
    approvalMode: ApprovalMode;
    inbound?: InboundCommandRouter;
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
    private readonly maxConcurrentBackgroundAgents: number;
    private readonly startingBackgroundAgents = new Map<string, number>();

    constructor(private readonly options: AgentRegistryOptions) {
        this.defaultModel = options.model;
        this.defaultProvider = options.provider ?? "unknown";
        this.defaultReasoningEffort = options.reasoningEffort;
        this.defaultApprovalMode = options.approvalMode;
        this.maxConcurrentBackgroundAgents = validChildAgentLimit(
            options.maxConcurrentBackgroundAgents
                ?? DEFAULT_MAX_CONCURRENT_CHILD_AGENTS,
        );
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
            return this.start(
                store,
                kind,
                options.eventLogPath,
                inherited?.parentId,
            );
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
        const availableEfforts = availableReasoningEfforts(
            provider,
            model,
        );
        // Carrying the old effort to a new target is the caller's convenience,
        // not their request, so a target that cannot take it gets coerced
        // rather than rejected. `strongestReasoningEffort` returns undefined
        // when the target offers no efforts at all, which drops the dial.
        if (
            (patch.model !== undefined || patch.provider !== undefined)
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
            this.options.readPins?.(),
        );
    }

    /**
     * Editing the pin list never changes which model runs, so this returns the
     * settings unchanged apart from the new pin list. It refuses an unknown agent
     * for the same reason every other command does: the reply is that agent's
     * snapshot, and there is none to send.
     */
    async updatePin(
        id: string,
        action: "add" | "remove",
        entry: { readonly provider: string; readonly model: string },
    ): Promise<ModelTurnSettings | undefined> {
        const agentEntry = this.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || this.options.updatePin === undefined
        ) {
            return undefined;
        }

        this.options.updatePin(action, {
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        });
        return settingsForClient(
            agentEntry.modelSettings,
            agentEntry.modelSettings.provider ?? this.defaultProvider,
            this.options.availableModels,
            this.options.readPins?.(),
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

    /**
     * Rename a session by id rather than through an attachment.
     *
     * An attached session is refused: its client holds the name it is
     * displaying and learns of a change only by replying to its own
     * `update_session_name`, so writing the store from here would leave that
     * client showing a name the session no longer has.
     */
    async renameSession(
        targetId: string,
        name: string | null,
    ): Promise<RenameSessionOutcome> {
        const requested = normalizeSessionName(name);
        if (requested === undefined) {
            return { status: "invalid" };
        }
        const entry = this.agents.get(targetId);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return { status: "not_found" };
        }
        if (entry.agent.attached) {
            return { status: "busy" };
        }
        try {
            const result = await this.updateSessionName(targetId, requested);
            return result === undefined
                ? { status: "not_found" }
                : { status: "renamed", name: result };
        } catch {
            return { status: "failed" };
        }
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
                    // A session someone has open counts as live even between
                    // turns: it is on screen and one keystroke from running.
                    // A background child with no client of its own counts only
                    // while it is working, which is the whole of its life.
                    //
                    // Both terms settle on their own, which is what makes this
                    // safe to show: an attachment ends when its client goes,
                    // and every turn resolves to idle. State that only clears
                    // when a particular update arrives was deliberately left
                    // out, because a turn ending without that update would
                    // strand a row reading as live with nothing running in it.
                    live: !entry.agent.closed
                        && !entry.agent.failed
                        && entry.failure === undefined
                        && (
                            entry.agent.attached
                            || entry.agent.status === "working"
                            || entry.agent.status === "waiting"
                        ),
                    ...(title === undefined || title.length === 0
                        ? {}
                        : { title: title.slice(0, 80) }),
                    ...(entry.store.header.origin === undefined
                        ? {}
                        : { forked_from: entry.store.header.origin.sessionId }),
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
        parentId?: string,
    ): ResidentAgent {
        const storedFailure = store.agentFailure();
        const adapter = storedFailure === undefined
            ? new ProviderRoutingAdapter(
                (provider) => this.options.createAdapter(provider),
                this.defaultProvider,
                this.options.credentialFingerprint,
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
            ...(parentId === undefined
                ? {}
                : { parentId }),
            ...(adapter === undefined ? {} : { adapter }),
            modelSettings: supportedModelSettings(
                storedSettings === undefined
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
            ),
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
                entries: projectTranscript(
                    store.messages(),
                    sessionAttachmentName(store),
                ),
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
            extensionTools: this.options.extensionTools,
            relayToolApproval: (update, sourceAgentId, sourceTask, signal) =>
                this.relayChildToolApproval(
                    entry,
                    update,
                    sourceAgentId,
                    sourceTask,
                    signal,
                ),
            ...(this.options.modelFallback === undefined
                ? {}
                : { modelFallback: this.options.modelFallback }),
        });
        const compaction = bindCompaction(
            this.options.compaction,
            adapter,
            {
                ...(entry.modelSettings.provider === undefined
                    ? {}
                    : { provider: entry.modelSettings.provider }),
                model: entry.modelSettings.model,
            },
            // The registry the host assembled. Extension-registered strategies
            // join this list when activation lands; binding stays agnostic.
            BUNDLED_COMPACTION_STRATEGIES,
        );
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
                ...(compaction === undefined ? {} : { compaction }),
                applyToolEffect,
                enabledToolEffects: (kind === "interactive" ? 0 : 1)
                        < MAX_AGENT_DEPTH
                    ? [
                        "spawn_subagent",
                        "spawn_background_agent",
                    ]
                    : [],
                enableUserInteraction: kind === "interactive",
                extensionTools: this.options.extensionTools,
                onInboundReady: (inbound) => {
                    entry.inbound = inbound;
                },
                readModelSettings: () => settingsForClient(
                    entry.modelSettings,
                    entry.modelSettings.provider ?? this.defaultProvider,
                    this.options.availableModels,
                    this.options.readPins?.(),
                ),
                updateModelSettings: (patch) =>
                    this.updateModelSettings(agent.id, patch),
                updatePin: (action, entry) =>
                    this.updatePin(agent.id, action, entry),
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
        const pendingDeliveries = store.pendingDeliveries();
        for (const delivery of pendingDeliveries) {
            events.emit({
                type: "task_notification",
                deliveryId: delivery.id,
                sourceAgentId: delivery.sourceAgentId,
                content: delivery.content,
            });
        }
        if (
            pendingDeliveries.length > 0
            || store.hasUnansweredDeliveryTurn()
        ) {
            agent.triggerDeliveryTurn();
        }
        return agent;
    }

    private async spawnBackgroundAgent(
        parentStore: SessionStore,
        effect: SpawnBackgroundAgentEffect,
        context: Parameters<ApplyToolEffect>[2],
    ): Promise<ToolOutput> {
        const running = [...this.agents.values()].filter(
            (entry) =>
                entry.kind === "background"
                && entry.parentId === parentStore.header.id
                && !entry.completed
                && !entry.agent.closed,
        ).length
            + (this.startingBackgroundAgents.get(parentStore.header.id) ?? 0);
        if (running >= this.maxConcurrentBackgroundAgents) {
            return {
                kind: "output",
                output: `Background agent limit reached `
                    + `(${this.maxConcurrentBackgroundAgents} running).`,
                isError: true,
            };
        }
        this.startingBackgroundAgents.set(
            parentStore.header.id,
            (this.startingBackgroundAgents.get(parentStore.header.id) ?? 0) + 1,
        );
        let child: ResidentAgent;
        try {
            child = await this.createWithKind(
                { workspace: parentStore.header.cwd },
                "background",
                {
                    approvalMode: context.approvalMode,
                    parentId: parentStore.header.id,
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
        } finally {
            const remaining =
                (this.startingBackgroundAgents.get(parentStore.header.id) ?? 1)
                - 1;
            if (remaining === 0) {
                this.startingBackgroundAgents.delete(parentStore.header.id);
            } else {
                this.startingBackgroundAgents.set(
                    parentStore.header.id,
                    remaining,
                );
            }
        }
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
            while (true) {
                const update = await attachment.receive();
                if (
                    update.type === "ui_request"
                    && isToolApprovalUiRequestUpdate(update)
                ) {
                    const parent = this.agents.get(parentStore.header.id);
                    const child = this.agents.get(childId);
                    const decision = parent === undefined
                        ? "deny"
                        : await this.relayChildToolApproval(
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
                    break;
                }
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
        const recorded = parentEvents === undefined
            ? await parentStore.recordDelivery(delivery)
            : await recordDeliveryAndNotify(parentStore, parentEvents, delivery);
        const entry = this.agents.get(childId);
        if (entry !== undefined && entry.failure === undefined) {
            entry.completed = true;
        }
        if (!recorded) {
            return;
        }
        const parent = this.agents.get(parentStore.header.id)?.agent;
        if (parent !== undefined && !parent.closed && !parent.failed) {
            parent.triggerDeliveryTurn();
        }
    }

    private async relayChildToolApproval(
        parent: RegisteredAgentEntry,
        update: ToolApprovalUiRequestUpdate,
        sourceAgentId: string,
        sourceTask: string,
        signal?: AbortSignal,
    ): Promise<"allow_once" | "deny"> {
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

/**
 * Drops a reasoning effort the provider cannot be asked for on this model.
 *
 * `updateModelSettings` already refuses an unsupported combination, but config
 * defaults and settings stored by an older build reach an agent without
 * passing through it. Without this the combination would survive to the
 * adapter and fail the first turn, which is a worse answer than starting with
 * the dial off. `reasoningEffortForModel` is deliberately looser than the
 * picker's menu: config is not a menu choice, so it keeps anything the adapter
 * can still resolve.
 */
function supportedModelSettings(
    settings: ModelTurnSettings,
): ModelTurnSettings {
    const effort = reasoningEffortForModel(
        settings.provider,
        settings.model,
        settings.reasoningEffort,
    );
    if (effort === settings.reasoningEffort) {
        return settings;
    }
    const { reasoningEffort: _dropped, ...supported } = settings;
    return supported;
}

function strongestReasoningEffort(
    efforts: readonly ModelReasoningEffort[],
): ModelReasoningEffort | undefined {
    const strongestFirst: readonly ModelReasoningEffort[] = [
        "max",
        "high",
        "medium",
        "low",
    ];
    return strongestFirst.find((effort) => efforts.includes(effort));
}

/**
 * The levels are resolved here rather than where the runnable list is built,
 * so every client sees the catalog as it is now, and a client can show the
 * levels of a model the user is only looking at.
 */
function settingsForClient(
    settings: ModelTurnSettings,
    provider: string,
    models: readonly SuggestedModel[] = availableModels(),
    pinned: readonly PinnedModel[] = [],
): ModelTurnSettings {
    const contextWindow = contextWindowForModel(provider, settings.model, models);
    return {
        ...settings,
        availableReasoningEfforts: availableReasoningEfforts(
            provider,
            settings.model,
        ),
        availableModels: availableModelsWithLevels(models),
        pinned,
        ...(contextWindow === undefined ? {} : { contextWindow }),
    };
}
