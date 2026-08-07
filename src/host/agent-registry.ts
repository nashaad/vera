import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { realpath } from "node:fs/promises";

import { EngineEventBus } from "../engine/events.ts";
import type { PoolAdmissionVerdict } from "../engine/events.ts";
import {
    builtInPermissionMode,
    isApprovalMode,
    type ApprovalMode,
    type PermissionMode,
} from "../engine/permissions.ts";
import type { ToolHooks } from "../engine/hooks.ts";
import { UserFacingError } from "../user-facing-error.ts";
import type { PermissionPreferenceStore } from "../engine/permission-preferences.ts";
import type { ModelFallbackPolicy } from "../engine/recovery.ts";
import type { EffortPool } from "../model/effort-pool.ts";
import {
    availableModels,
    contextWindowForModel,
    isModelReasoningEffort,
    publishedReasoningLevels,
    reasoningEffortForModel,
    type ModelSettingsPatch,
    type ModelTurnSettings,
} from "../engine/model-settings.ts";
import { inferReasoningSelection } from "../model/reasoning-effort.ts";
import type { EffectiveCatalogOptions } from "../model/catalog.ts";
import {
    runHeadlessLoop,
    sessionScratchDir,
} from "../engine/run-turn.ts";
import {
    BUNDLED_COMPACTION_STRATEGIES,
    bindCompaction,
} from "../engine/compaction-binding.ts";
import type { ResolvedCompactionProfile } from "../config/model-catalog.ts";
import {
    createSubagentEffectApplier,
    resolveSpawnModelChoice,
    type SpawnModelDefault,
    type SubagentPoolPolicy,
} from "../engine/subagent.ts";
import type { InboundCommandRouter } from "../engine/inbound-command-router.ts";
import {
    isToolApprovalUiRequestUpdate,
    isUserQuestionUiRequestUpdate,
    type ModelSubstitutionUpdate,
    type ToolApprovalUiRequestUpdate,
    type UiRequestUpdate,
} from "../engine/protocol.ts";
import {
    DEFAULT_MAX_CONCURRENT_CHILD_AGENTS,
    validChildAgentLimit,
} from "../engine/agent-limits.ts";
import type { ToolReviewerSettings } from "../engine/reviewer.ts";
import { loadPoolFile } from "../model/pool-file-loader.ts";
import { providerOf } from "../model/pool-file.ts";
import { resolvePoolRef } from "../model/pool-names.ts";
import type {
    ModelAdapter,
    ModelReasoningEffort,
} from "../model/types.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import {
    availableModelsWithLevels,
    type PooledModel,
} from "../model/catalog-view.ts";
import { projectTranscript } from "../engine/protocol.ts";
import type {
    ApplyToolEffect,
    MessageSubagentEffect,
    NotifyParentEffect,
    RegisteredTool,
    SpawnAsyncSubagentEffect,
    ToolOutput,
} from "../tools/types.ts";
import {
    defaultSessionPath,
    SessionStore,
} from "../store/session-store.ts";
import { createSessionBranch } from "../store/session-branch.ts";
import type { UserMessage } from "../model/types.ts";
import { recordDeliveryAndNotify } from "./delivery-notifier.ts";
import { agentNameKey, mintAgentName } from "./agent-name.ts";
import type {
    InboxDeliveryCoordinator,
    InboxDeliverySession,
} from "./inbox-delivery.ts";
import {
    ImageAttachmentService,
    sessionAttachmentName,
} from "../attachments/service.ts";
import { ProviderRoutingAdapter } from "../providers/routing.ts";
import {
    createFailedRequestCapture,
    type FailedRequestCapture,
} from "../providers/failed-request-capture.ts";
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
    /**
     * The identity name this session posts under, `slug:hex4:purpose`. Carried
     * on the listing because a list keyed by uuid is unreadable; the id stays
     * because it is what every other command takes.
     */
    readonly name?: string;
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
    /** The resident parent that launched this async subagent. */
    readonly parent_id?: string;
    /**
     * The session this one was branched from, absent on a session that was
     * started rather than forked. The id alone rather than the whole header
     * `origin`: a client threads rows by parentage, and where in the parent the
     * branch was taken is a fact about the transcript, not about the list.
     */
    readonly forked_from?: string;
    /**
     * Bytes the session transcript occupies on disk, absent when the file
     * cannot be stat'd. Read fresh on every listing rather than tracked on
     * append: compaction and trash rewrite the file behind the store, so a
     * running total would drift with no event to correct it.
     */
    readonly size_bytes?: number;
}

export interface AgentRegistryOptions {
    /**
     * The workspace is passed alongside the provider because a project pool
     * can name levels the user pool does not, and an adapter built without it
     * would send a request the project's own settings do not describe. The
     * capture sink rides along because its caps are per session, and the
     * session is known here rather than where the host builds its adapters.
     */
    readonly createAdapter: (
        provider?: string,
        projectRoot?: string,
        captureFailedRequest?: FailedRequestCapture,
    ) => ModelAdapter;
    /**
     * Where a session's failed provider requests are kept. Defaults to the
     * per-user capture directory; a test points it somewhere it owns.
     */
    readonly createFailedRequestCapture?: (
        sessionId: string,
    ) => FailedRequestCapture;
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
    /**
     * Reads and writes the declarative model pool. The host owns the file; the
     * engine only ever sees this interface.
     *
     * Built per agent from that agent's workspace, because the pool has a
     * project scope: one host serves agents in different checkouts, and a
     * single pool built at startup would apply one project's overlay to all
     * of them.
     */
    readonly createEffortPool?: (projectRoot: string) => EffortPool;
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
     * Read per settings snapshot, not once at startup: the pool changes while
     * the host runs, so a snapshot taken when it came up would freeze the
     * list for the life of the host.
     */
    readonly readPool?: (projectRoot?: string) => readonly PooledModel[];
    readonly sessionPathForId?: (agentId: string) => string;
    readonly eventLogPathForId?: (agentId: string, cwd: string) => string;
    readonly updateModelDefaults?: (settings: ModelTurnSettings) => void;
    /**
     * Writes the pool entry for one model, and probes it first when asked.
     * Separate from `readPool` because the two have different lifetimes:
     * reads happen on every snapshot, admission only when the user asks.
     * Only a verifying admission reaches the provider; a plain one is the
     * catalog copy and never blocks on a call.
     */
    readonly admitToPool?: (
        entry: { readonly provider: string; readonly model: string },
        onStep: (step: {
            readonly step: string;
            readonly label: string;
            readonly status: "running" | "passed" | "failed" | "skipped";
            readonly detail?: string;
        }) => void,
        options?: { readonly verify?: boolean },
    ) => Promise<{
        readonly verdict: PoolAdmissionVerdict;
        readonly reason?: string;
        readonly statusCode?: number;
    }>;
    readonly removeFromPool?: (
        entry: { readonly provider: string; readonly model: string },
    ) => void;
    /** False when the name was refused, so nothing was written. */
    readonly namePoolEntry?: (
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
        projectRoot: string,
    ) => boolean;
    readonly updateApprovalDefault?: (mode: ApprovalMode) => void;
    readonly trashSessionArtifacts?: (artifacts: SessionArtifacts) => Promise<void>;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly disabledPromptContributions?: readonly string[];
    /** Builds each resident agent's tool hooks; absent means none. */
    readonly createToolHooks?: () => ToolHooks;
    /** What a spawn with no model override runs on; absent, the parent model. */
    readonly subagentModel?: SpawnModelDefault;
    /**
     * Allow/deny, the failsafe list and declared families for the subagent
     * ladder. Read per spawn for the same reason as `readPool`: the user
     * edits the pool file while the host runs.
     */
    readonly readPolicy?: (projectRoot?: string) => SubagentPoolPolicy;
    /**
     * Where discovery snapshots are read from when resolving a model's
     * reasoning levels; absent, the per-user cache directory.
     */
    readonly cacheDir?: string;
    /** Absent when the experimental inbox is off; nothing downstream re-checks. */
    readonly inboxDelivery?: InboxDeliveryCoordinator;
    /**
     * The actor a session's own turns write into inbox entries. Self-echo
     * suppression matches the (actor, session) pair, so a session with no
     * known actor suppresses nothing.
     */
    readonly inboxActorForSession?: (agentId: string) => string | null;
}

export interface CreateRegisteredAgentOptions {
    readonly id?: string;
    readonly workspace: string;
    readonly sessionPath?: string;
    readonly eventLogPath?: string;
    /**
     * The mode this agent starts in, when it must not be the host default.
     * It is written to the session like any other approval-mode change, so a
     * client that resumes the session later reads it back.
     */
    readonly approvalMode?: ApprovalMode;
}

export interface RunOnceOptions extends CreateRegisteredAgentOptions {
    readonly prompt: string;
    /**
     * The model this one run uses, as a pool name or a `provider/model` id.
     * A run with nobody watching draws from the curated pool only, so a ref
     * the pool does not hold ends the run instead of reaching the provider.
     */
    readonly modelRef?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface RunOnceResult {
    readonly agentId: string;
    readonly sessionPath: string;
    /** The final assistant text, empty when the turn produced none. */
    readonly text: string;
    readonly outcome: "completed" | "error" | "aborted";
    /** Present only with the error outcome. */
    readonly error?: string;
    /** What the run decided on the user's behalf, in the user's words. */
    readonly notes: readonly string[];
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
/**
 * What an attached client is told when it prompts a bounded run.
 *
 * Watching one is fully supported. Steering it is not, because the run
 * answers to whoever launched it, and its one input is the prompt they gave.
 */
const CLIENT_PROMPT_REFUSAL =
    "This agent is running a single bounded turn, so it takes no prompts. "
    + "Start your own session to continue this work.";

/**
 * Point the run at the model it was launched with, before the turn starts.
 *
 * This is the ordinary model-settings command an interactive model change
 * sends, so pool and catalog resolution, effort coarsening, and substitution
 * notices all behave the way they do in a session. A refusal ends the run
 * here: a bounded run that quietly fell back to the configured model would
 * report results for a model nobody asked for.
 */
/**
 * The pooled model a `-p` run asked for, by name or by id.
 *
 * Throws rather than falling back: a headless run is the easiest place to
 * slip an unvetted endpoint into a workspace with nobody watching, so the ref
 * has to be one the user curated, and a miss is loud.
 */
function resolveRunOnceModel(
    options: RunOnceOptions,
): { readonly provider?: string; readonly model: string } | undefined {
    if (options.modelRef === undefined) {
        return undefined;
    }
    const pool = loadPoolFile({ projectRoot: options.workspace }).merged;
    const id = resolvePoolRef(pool, options.modelRef);
    if (id === undefined) {
        throw new UserFacingError(
            `Model "${options.modelRef}" is not in the pool. `
                + "A print-mode run uses pooled models only: add it with "
                + "ctrl+s in the model picker, or /pool add.",
        );
    }
    const provider = providerOf(id);
    return provider === undefined
        ? { model: id }
        : { provider, model: id.slice(provider.length + 1) };
}

async function selectRunOnceModel(
    attachment: AgentAttachment,
    options: RunOnceOptions,
    model: { readonly provider?: string; readonly model: string } | undefined,
): Promise<void> {
    if (model === undefined && options.reasoningEffort === undefined) {
        return;
    }
    const requestId = randomUUID();
    attachment.send({
        type: "update_model_settings",
        requestId,
        patch: {
            ...(model?.provider === undefined
                ? {}
                : { provider: model.provider }),
            ...(model === undefined ? {} : { model: model.model }),
            ...(options.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: options.reasoningEffort }),
        },
    });
    while (true) {
        const update = await attachment.receive();
        if (update.type === "model_settings" && update.requestId === requestId) {
            return;
        }
        if (
            update.type === "model_settings_rejected"
            && update.requestId === requestId
        ) {
            throw new Error(
                `${describeRunOnceModel(options)} was refused: `
                + (update.reason === "unavailable"
                    ? "this host cannot change the model."
                    : "no such model, or the effort is not one it accepts."),
            );
        }
    }
}

function describeRunOnceModel(options: RunOnceOptions): string {
    if (options.modelRef === undefined) {
        return `Effort ${options.reasoningEffort}`;
    }
    return options.reasoningEffort === undefined
        ? `Model ${options.modelRef}`
        : `Model ${options.modelRef} at effort ${options.reasoningEffort}`;
}

function substitutionNote(update: ModelSubstitutionUpdate): string {
    const using = update.using ?? "no reasoning level";
    return `Ran on ${update.model} with ${using} instead of `
        + `${update.requested}: ${update.reason}`;
}

/** The text a caller waiting on one turn is waiting for. */
function finalAssistantText(store: SessionStore | undefined): string {
    return store?.messages()
        .findLast((message) => message.role === "assistant")
        ?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim() ?? "";
}

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
    /**
     * The identity name this session posts and is addressed under, minted at
     * registration and stable for the entry's lifetime. Changing it
     * mid-session would break self-echo suppression on the next arc post.
     */
    readonly arcName: string;
    readonly events: EngineEventBus;
    readonly adapter?: ProviderRoutingAdapter;
    readonly eventLogPath?: string;
    readonly parentId?: string;
    modelSettings: ModelTurnSettings;
    /**
     * The level the last settings change asked for when it had to be coerced.
     * Held beside the settings rather than inside them because it describes
     * the request, not the choice, and must not reach the session store. It
     * is cleared by the next change that needs no coercion, which is what
     * makes the client's note disappear on its own.
     */
    requestedReasoningEffort?: ModelReasoningEffort;
    approvalMode: ApprovalMode;
    inbound?: InboundCommandRouter;
    inbox?: InboxDeliverySession;
    run: Promise<void>;
    completed: boolean;
    pendingAsyncTurns: number;
    pendingCompletionDeliveries: number;
    completionSequence: number;
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
    /** Child id to the ladder notice its spawn produced, if any. */
    private readonly spawnNotices = new Map<string, string>();
    private readonly catalog: EffectiveCatalogOptions;
    private readonly rosterListeners = new Set<() => void>();

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
        this.catalog = options.cacheDir === undefined
            ? {}
            : { cacheDir: options.cacheDir };
    }

    async create(
        options: CreateRegisteredAgentOptions,
    ): Promise<ResidentAgent> {
        return this.createWithKind(
            options,
            "interactive",
            options.approvalMode === undefined
                ? undefined
                : { approvalMode: options.approvalMode },
        );
    }

    /**
     * One prompt against a fresh agent, then the agent is gone.
     *
     * The bounded lifecycle is the whole feature: the agent is an ordinary
     * resident agent running an ordinary turn, so it lists, attaches, and
     * persists like any other, and the only thing that differs is that the
     * host, not the client, owns when it ends. A client that dies mid-run
     * cannot leak it, because nothing about the close depends on the client.
     */
    async runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
        const agent = await this.createWithKind(
            options,
            "interactive",
            options.approvalMode === undefined
                ? undefined
                : { approvalMode: options.approvalMode },
            CLIENT_PROMPT_REFUSAL,
        );
        const sessionPath = this.agents.get(agent.id)?.store.path ?? "";
        const notes: string[] = [];
        let outcome: RunOnceResult["outcome"] = "completed";
        let error: string | undefined;
        try {
            const attachment = agent.attach();
            try {
                await selectRunOnceModel(
                    attachment,
                    options,
                    resolveRunOnceModel(options),
                );
                agent.sendPrompt(options.prompt);
                while (true) {
                    const update = await attachment.receive();
                    if (update.type === "model_substitution") {
                        notes.push(substitutionNote(update));
                        continue;
                    }
                    if (update.type === "ui_request") {
                        notes.push(this.refuseHeadlessRequest(
                            attachment,
                            update,
                        ));
                        continue;
                    }
                    if (update.type === "agent_failed") {
                        outcome = "error";
                        error = update.detail;
                        break;
                    }
                    if (update.type === "turn_finished") {
                        if (update.outcome !== undefined) {
                            outcome = update.outcome;
                            error = update.error;
                        }
                        break;
                    }
                }
            } finally {
                attachment.detach();
            }
            return {
                agentId: agent.id,
                sessionPath,
                text: finalAssistantText(this.agents.get(agent.id)?.store),
                outcome,
                ...(error === undefined ? {} : { error }),
                notes,
            };
        } finally {
            await this.closeAgent(agent.id);
        }
    }

    /**
     * Stop one agent and forget it, leaving its session on disk.
     *
     * Distinct from `abort`, which cancels a turn and leaves the agent
     * running, and from `trashSession`, which is this plus deleting what the
     * session wrote. Idempotent: the second call finds nothing to close, which
     * is what makes "closed exactly once" checkable.
     */
    async closeAgent(id: string): Promise<"closed" | "not_found"> {
        const entry = this.agents.get(id);
        if (entry === undefined) {
            return "not_found";
        }
        entry.agent.close();
        await entry.run;
        entry.inbox?.release();
        this.agents.delete(id);
        this.spawnNotices.delete(id);
        this.notifyRosterChanged();
        return "closed";
    }

    /**
     * The answer a run with nobody watching gives to a question it cannot ask.
     *
     * Always denial, even when a client happens to be attached: a bounded run
     * that sometimes waits for a human is a bounded run that sometimes hangs,
     * and the same prompt would then produce different work depending on who
     * was looking.
     */
    private refuseHeadlessRequest(
        attachment: AgentAttachment,
        update: UiRequestUpdate,
    ): string {
        if (isToolApprovalUiRequestUpdate(update)) {
            attachment.send({
                type: "ui_response",
                requestId: update.requestId,
                response: { type: "tool_approval", decision: "deny" },
            });
            return `Denied ${update.request.toolCall.name}: `
                + "a print-mode run never waits for approval. "
                + "Re-run with an approval mode that allows it, "
                + "or run it interactively.";
        }
        if (isUserQuestionUiRequestUpdate(update)) {
            attachment.send({
                type: "ui_response",
                requestId: update.requestId,
                response: { type: "user_question", outcome: "cancelled" },
            });
            return `Cancelled a question from the model: `
                + `${update.request.question}`;
        }
        return "Refused a request that needs someone watching.";
    }

    private async createWithKind(
        options: CreateRegisteredAgentOptions,
        kind: RegisteredAgentKind,
        inherited?: InheritedAgentSettings,
        clientPromptRefusal?: string,
    ): Promise<ResidentAgent> {
        const id = options.id ?? randomUUID();
        this.reserveId(id);
        try {
            const workspace = await realpath(options.workspace);
            const store = await SessionStore.create(
                options.sessionPath
                    ?? this.options.sessionPathForId?.(id)
                    ?? defaultSessionPath(id),
                {
                    sessionId: id,
                    cwd: workspace,
                    ...(inherited?.parentId === undefined
                        ? {}
                        : { parentId: inherited.parentId }),
                },
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
                clientPromptRefusal,
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
            const parentId = store.header.parentId;
            return parentId === undefined
                ? this.start(store, "interactive", options.eventLogPath)
                : this.start(
                    store,
                    "background",
                    options.eventLogPath,
                    parentId,
                );
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
            || [...this.agents.values()].some(
                (candidate) =>
                    candidate.parentId === targetId
                    && candidate.failure === undefined
                    && !candidate.agent.failed
                    && !candidate.agent.closed
                    && (
                        !candidate.completed
                        || candidate.pendingCompletionDeliveries > 0
                    ),
            )
        ) {
            return "busy";
        }

        await this.closeAgent(targetId);
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

    /** The identity name a live session posts under, `undefined` when gone. */
    arcNameOf(id: string): string | undefined {
        const entry = this.agents.get(id);
        return entry?.agent.closed === false ? entry.arcName : undefined;
    }

    /**
     * Resolves an arc `session` value to the live session it names. Names
     * match on `slug:hex4` so a purpose tail never changes addressing; a
     * value that is not a name still resolves as a raw agent id, because
     * entries recorded before naming carry ids.
     */
    agentIdForArcSession(value: string): string | undefined {
        const key = agentNameKey(value);
        if (key !== null) {
            for (const [id, entry] of this.agents) {
                if (
                    !entry.agent.closed
                    && agentNameKey(entry.arcName) === key
                ) {
                    return id;
                }
            }
            return undefined;
        }
        return this.find(value)?.id;
    }

    private arcNameKeyTaken(key: string): boolean {
        for (const entry of this.agents.values()) {
            if (agentNameKey(entry.arcName) === key) {
                return true;
            }
        }
        return false;
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
                && patch.provider !== "ollama"
                && patch.provider !== "cerebras")
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
        // Pool membership does not gate this. The pool is the user's curated
        // shortlist, not the set of models they are allowed to run: choosing a
        // model from the catalog runs it and adds nothing.
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
        // Checked against exactly what the picker was served, through the
        // same reader: a level published for this model is always acceptable
        // here, whichever layer published it.
        const published = publishedReasoningLevels(
            provider,
            model,
            this.options.readPool?.(entry.store.header.cwd),
            this.catalog,
        );
        // A level the model does not publish is coerced rather than promoted:
        // the model's own default, else a middle level, never the top. Same
        // rule as request-time resolution, so a switch and a turn place an
        // unknown level identically. The coerced level comes back in the
        // returned settings, which is how the client learns of the
        // substitution.
        //
        // A model that publishes no levels at all is the one case an
        // effort-only patch still refuses: there is no dial to move, and
        // there the level is the whole request.
        // The level asked for, kept so the client can say what it asked for
        // beside what it got. Undefined again the moment a change validates
        // as published, which is how the note clears.
        let requestedReasoningEffort: ModelReasoningEffort | undefined;
        if (
            reasoningEffort !== undefined
            && !published.efforts.includes(reasoningEffort)
        ) {
            if (
                published.efforts.length === 0
                && patch.model === undefined
                && patch.provider === undefined
            ) {
                return undefined;
            }
            const requested = reasoningEffort;
            reasoningEffort = inferReasoningSelection(
                requested,
                published.efforts,
                published.defaultLevel,
            ).providerEffort;
            if (reasoningEffort !== undefined && reasoningEffort !== requested) {
                requestedReasoningEffort = requested;
            }
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
        entry.requestedReasoningEffort = requestedReasoningEffort;
        return settingsForClient(
            entry.modelSettings,
            entry.modelSettings.provider ?? this.defaultProvider,
            this.catalog,
            this.options.availableModels,
            this.options.readPool?.(entry.store.header.cwd),
            this.options.subagentModel,
            entry.requestedReasoningEffort,
        );
    }

    /**
     * Editing the pool never changes which model runs, so the settings that
     * come back are unchanged apart from the new pool. It refuses an unknown
     * agent for the same reason every other command does: the reply is that
     * agent's snapshot, and there is none to send.
     */
    async poolAdd(
        id: string,
        entry: { readonly provider: string; readonly model: string },
        onStep: Parameters<
            NonNullable<AgentRegistryOptions["admitToPool"]>
        >[1],
        options?: { readonly verify?: boolean },
    ): Promise<{
        verdict: PoolAdmissionVerdict;
        reason?: string;
        statusCode?: number;
        settings?: ModelTurnSettings;
    }> {
        const agentEntry = this.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || this.options.admitToPool === undefined
        ) {
            return { verdict: "unavailable", reason: "admission unavailable" };
        }
        const outcome = await this.options.admitToPool({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        }, onStep, options);
        if (outcome.verdict !== "added") {
            return outcome;
        }
        return {
            ...outcome,
            settings: settingsForClient(
                agentEntry.modelSettings,
                agentEntry.modelSettings.provider ?? this.defaultProvider,
                this.catalog,
                this.options.availableModels,
                this.options.readPool?.(agentEntry.store.header.cwd),
                this.options.subagentModel,
                agentEntry.requestedReasoningEffort,
            ),
        };
    }

    /**
     * The `pool_add` tool's effect: the same admission hook the client's
     * checklist calls, one model at a time, reported back as per-model
     * verdict lines. Verdicts land in the tool result rather than as
     * progress updates: the transcript is the surface the agent path owns.
     */
    private async applyPoolAddEffect(
        effect: { readonly models: readonly string[] },
    ): Promise<ToolOutput> {
        if (this.options.admitToPool === undefined) {
            return {
                kind: "output",
                output: "Pool admission is not available in this host.",
                isError: true,
            };
        }
        const lines: string[] = [];
        let failed = false;
        for (const identifier of effect.models) {
            const separator = identifier.indexOf("/");
            if (separator <= 0 || separator === identifier.length - 1) {
                lines.push(`${identifier}: not a provider/model identifier`);
                failed = true;
                continue;
            }
            const outcome = await this.options.admitToPool({
                provider: identifier.slice(0, separator),
                model: identifier.slice(separator + 1),
            }, () => {});
            if (outcome.verdict === "added") {
                lines.push(`${identifier}: added to the pool`);
            } else if (outcome.verdict === "incompatible") {
                lines.push(`${identifier}: incompatible (${
                    outcome.reason ?? "no reason recorded"
                }); it stays out of the pool`);
            } else {
                lines.push(`${identifier}: unavailable (${
                    outcome.reason ?? "provider did not answer"
                }); nothing recorded, retry later`);
            }
        }
        return { kind: "output", output: lines.join("\n"), isError: failed };
    }

    async poolRemove(
        id: string,
        entry: { readonly provider: string; readonly model: string },
    ): Promise<ModelTurnSettings | undefined> {
        const agentEntry = this.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || this.options.removeFromPool === undefined
        ) {
            return undefined;
        }
        this.options.removeFromPool({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        });
        return settingsForClient(
            agentEntry.modelSettings,
            agentEntry.modelSettings.provider ?? this.defaultProvider,
            this.catalog,
            this.options.availableModels,
            this.options.readPool?.(agentEntry.store.header.cwd),
            this.options.subagentModel,
            agentEntry.requestedReasoningEffort,
        );
    }

    async poolName(
        id: string,
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
    ): Promise<ModelTurnSettings | undefined> {
        const agentEntry = this.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || this.options.namePoolEntry === undefined
        ) {
            return undefined;
        }
        const named = this.options.namePoolEntry({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        }, name === null ? null : name.trim(), agentEntry.store.header.cwd);
        if (!named) {
            return undefined;
        }
        return settingsForClient(
            agentEntry.modelSettings,
            agentEntry.modelSettings.provider ?? this.defaultProvider,
            this.catalog,
            this.options.availableModels,
            this.options.readPool?.(agentEntry.store.header.cwd),
            this.options.subagentModel,
            agentEntry.requestedReasoningEffort,
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
     * The posture a session ran under, for a spawn that has one to inherit.
     * `undefined` when the id names no session here, which is the cold case.
     */
    approvalModeOf(agentId: string): ApprovalMode | undefined {
        return this.agents.get(agentId)?.approvalMode;
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

    /**
     * Watch for anything that would change what `list` answers about who is
     * registered and what is running: a session registered or forgotten, and
     * any agent starting or stopping a turn.
     *
     * Returns the unsubscribe. Listeners are told that something changed, not
     * what changed, because the only reader wants a fresh derivation anyway.
     */
    onRosterChanged(listener: () => void): () => void {
        this.rosterListeners.add(listener);
        return (): void => {
            this.rosterListeners.delete(listener);
        };
    }

    private notifyRosterChanged(): void {
        for (const listener of [...this.rosterListeners]) {
            try {
                listener();
            } catch {
                // One client's failure must not stop the others being told.
            }
        }
    }

    list(): RegisteredAgentSummary[] {
        const sizeOnDisk = (path: string): number | undefined => {
            try {
                return statSync(path).size;
            } catch {
                // A session whose file is gone still belongs on the list; it
                // just has no size to report.
                return undefined;
            }
        };

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
                const size = sizeOnDisk(entry.store.path);
                return {
                    id: entry.agent.id,
                    name: entry.arcName,
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
                    ...(entry.parentId === undefined
                            || !this.agents.has(entry.parentId)
                        ? {}
                        : { parent_id: entry.parentId }),
                    updated_at: entry.store.agentFailure()?.timestamp
                        ?? activeEntries.at(-1)?.timestamp
                        ?? entry.store.header.timestamp,
                    ...(size === undefined ? {} : { size_bytes: size }),
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
            entry.inbox?.release();
            entry.agent.close();
        }
        await Promise.all(entries.map((entry) => entry.run));
        await Promise.all([...this.deliveryTasks]);
    }

    private start(
        store: SessionStore,
        kind: RegisteredAgentKind,
        eventLogPath = this.options.eventLogPathForId?.(
            store.header.id,
            store.header.cwd,
        ),
        parentId?: string,
        clientPromptRefusal?: string,
    ): ResidentAgent {
        const storedFailure = store.agentFailure();
        const captureFailedRequest = (
            this.options.createFailedRequestCapture
                ?? ((sessionId) => createFailedRequestCapture({ sessionId }))
        )(store.header.id);
        const adapter = storedFailure === undefined
            ? new ProviderRoutingAdapter(
                (provider) =>
                    this.options.createAdapter(
                        provider,
                        store.header.cwd,
                        captureFailedRequest,
                    ),
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
            onRunStateChanged: () => this.notifyRosterChanged(),
            ...(clientPromptRefusal === undefined
                ? {}
                : { clientPromptRefusal }),
        });
        const events = new EngineEventBus();
        const storedSettings = store.modelSettings();
        const entry: RegisteredAgentEntry = {
            agent,
            store,
            kind,
            arcName: mintAgentName((key) => this.arcNameKeyTaken(key)),
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
                this.catalog,
            ),
            approvalMode: store.approvalMode() ?? this.defaultApprovalMode,
            run: Promise.resolve(),
            completed: false,
            pendingAsyncTurns: 0,
            pendingCompletionDeliveries: 0,
            completionSequence: 0,
            ...(storedFailure === undefined
                ? {}
                : { failure: new Error(storedFailure.detail) }),
        };
        this.agents.set(agent.id, entry);
        this.notifyRosterChanged();
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
            scratchDir: sessionScratchDir(store.header.id),
            ...(this.options.disabledPromptContributions === undefined
                ? {}
                : {
                    disabledPromptContributions:
                        this.options.disabledPromptContributions,
                }),
            extensionTools: this.options.extensionTools,
            ...(this.options.readPool === undefined
                ? {}
                : {
                    readPool: () =>
                        this.options.readPool?.(store.header.cwd) ?? [],
                }),
            ...(this.options.subagentModel === undefined
                ? {}
                : { subagentModel: this.options.subagentModel }),
            ...(this.options.readPolicy === undefined
                ? {}
                : {
                    readPolicy: () =>
                        this.options.readPolicy?.(store.header.cwd)
                            ?? {},
                }),
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
        const applyToolEffect: ApplyToolEffect = (effect, signal, context) => {
            if (effect.type === "spawn_async_subagent") {
                return this.spawnAsyncSubagent(
                    store,
                    effect,
                    context,
                );
            }
            if (effect.type === "message_subagent") {
                return this.messageSubagent(store, effect);
            }
            if (effect.type === "notify_parent") {
                return this.notifyParent(store, effect);
            }
            if (effect.type === "pool_add") {
                return this.applyPoolAddEffect(effect);
            }
            return applySubagentEffect(effect, signal, context);
        };
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
                // Every shell this session spawns carries its identity name,
                // so arc stamps the session's posts with it and self-echo
                // suppression matches with no manual export.
                toolEnv: { ARC_SESSION: entry.arcName },
                modelFallback: this.options.modelFallback,
                ...(this.options.createEffortPool === undefined
                    ? {}
                    : {
                        effortPool: this.options.createEffortPool(
                            store.header.cwd,
                        ),
                    }),
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
                enabledToolEffects: kind === "interactive"
                    ? [
                        "spawn_subagent",
                        "spawn_async_subagent",
                        "message_subagent",
                        "pool_add",
                    ]
                    : ["notify_parent"],
                enableUserInteraction: kind === "interactive",
                extensionTools: this.options.extensionTools,
                onInboundReady: (inbound) => {
                    entry.inbound = inbound;
                },
                readModelSettings: () => settingsForClient(
                    entry.modelSettings,
                    entry.modelSettings.provider ?? this.defaultProvider,
                    this.catalog,
                    this.options.availableModels,
                    this.options.readPool?.(store.header.cwd),
                    this.options.subagentModel,
                    entry.requestedReasoningEffort,
                ),
                updateModelSettings: (patch) =>
                    this.updateModelSettings(agent.id, patch),
                poolAdd: (entry, onStep, options) =>
                    this.poolAdd(agent.id, entry, onStep, options),
                poolRemove: (entry) =>
                    this.poolRemove(agent.id, entry),
                poolName: (entry, name) =>
                    this.poolName(agent.id, entry, name),
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
                ...(this.options.disabledPromptContributions === undefined
                    ? {}
                    : {
                        disabledPromptContributions:
                            this.options.disabledPromptContributions,
                    }),
                ...(this.options.createToolHooks === undefined
                    ? {}
                    : { hooks: this.options.createToolHooks() }),
            },
        ).catch(async (error: unknown) => {
            entry.inbox?.release();
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
        if (kind === "interactive" && this.options.inboxDelivery !== undefined) {
            const inbox = this.options.inboxDelivery.attach({
                label: agent.id,
                actor: this.options.inboxActorForSession?.(agent.id) ?? null,
                // The minted name, not the agent id: arc stamps posts with
                // the ARC_SESSION the shell carries, which is this name, so
                // the self-echo pair must hold the same value.
                session: entry.arcName,
                target: {
                    recordDelivery: (delivery) =>
                        recordDeliveryAndNotify(store, events, delivery),
                    pendingDeliveryIds: () =>
                        store.pendingDeliveries().map((delivery) => delivery.id),
                },
                triggerTurn: () => {
                    if (!agent.closed && !agent.failed) {
                        agent.triggerDeliveryTurn();
                    }
                },
            });
            entry.inbox = inbox;
            this.trackDelivery(inbox.pump());
        }
        const pendingDeliveries = store.pendingDeliveries();
        for (const delivery of pendingDeliveries) {
            events.emit({
                type: "task_notification",
                deliveryId: delivery.id,
                sourceAgentId: delivery.sourceAgentId,
                content: delivery.content,
                kind: delivery.kind ?? "completion",
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

    private async spawnAsyncSubagent(
        parentStore: SessionStore,
        effect: SpawnAsyncSubagentEffect,
        context: Parameters<ApplyToolEffect>[2],
    ): Promise<ToolOutput> {
        const running = [...this.agents.values()].filter(
            (entry) =>
                entry.kind === "background"
                && entry.parentId === parentStore.header.id
                && entry.failure === undefined
                && !entry.agent.failed
                && !entry.agent.closed
                && entry.pendingAsyncTurns > 0,
        ).length
            + (this.startingBackgroundAgents.get(parentStore.header.id) ?? 0);
        if (running >= this.maxConcurrentBackgroundAgents) {
            return {
                kind: "output",
                output: `Async subagent limit reached `
                    + `(${this.maxConcurrentBackgroundAgents} running).`,
                isError: true,
            };
        }
        this.startingBackgroundAgents.set(
            parentStore.header.id,
            (this.startingBackgroundAgents.get(parentStore.header.id) ?? 0) + 1,
        );
        const resolved = resolveSpawnModelChoice(
            effect,
            context,
            this.options.readPool === undefined
                ? undefined
                : () => this.options.readPool?.(parentStore.header.cwd) ?? [],
            this.options.subagentModel,
            this.options.readPolicy?.(parentStore.header.cwd),
        );
        if (!resolved.ok) {
            return { kind: "output", output: resolved.error, isError: true };
        }
        let child: ResidentAgent;
        try {
            child = await this.createWithKind(
                { workspace: parentStore.header.cwd },
                "background",
                {
                    approvalMode: context.approvalMode,
                    parentId: parentStore.header.id,
                    modelSettings: {
                        provider: resolved.provider ?? this.defaultProvider,
                        model: resolved.model,
                        ...(resolved.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: resolved.reasoningEffort }),
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
        const childEntry = this.agents.get(child.id);
        if (childEntry === undefined) {
            child.close();
            throw new Error(`Async subagent ${child.id} was not registered`);
        }
        // Tracked here rather than on every queued prompt: a completion
        // belongs to the parent only for work the parent asked for. A client
        // attaching to the child and prompting it is a conversation the user
        // is already reading, not an assignment to report back on.
        try {
            child.sendPrompt(effect.description);
        } catch (error) {
            child.close();
            throw error;
        }
        this.trackAsyncSubagentTurn(child.id);
        if (resolved.notice !== undefined) {
            this.spawnNotices.set(child.id, resolved.notice);
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

    private async messageSubagent(
        parentStore: SessionStore,
        effect: MessageSubagentEffect,
    ): Promise<ToolOutput> {
        const child = this.agents.get(effect.subagentId);
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
        this.trackAsyncSubagentTurn(effect.subagentId);
        return {
            kind: "output",
            output: `Message queued for async subagent ${effect.subagentId}.`,
            isError: false,
        };
    }

    private trackAsyncSubagentTurn(childId: string): void {
        const child = this.agents.get(childId);
        const parent = child?.parentId === undefined
            ? undefined
            : this.agents.get(child.parentId);
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
        this.monitorAsyncSubagent(
            parent.store,
            childId,
            attachment,
            child.completionSequence,
        );
    }

    private monitorAsyncSubagent(
        parentStore: SessionStore,
        childId: string,
        attachment: AgentAttachment,
        completionSequence: number,
    ): void {
        const deliveryTask = this.deliverBackgroundResult(
            parentStore,
            childId,
            attachment,
            completionSequence,
        ).catch((error: unknown) => {
            const entry = this.agents.get(childId);
            if (entry !== undefined) {
                entry.pendingCompletionDeliveries = Math.max(
                    0,
                    entry.pendingCompletionDeliveries - 1,
                );
                entry.failure = error;
                entry.agent.close();
            }
            const parent = this.agents.get(parentStore.header.id);
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
        this.deliveryTasks.add(deliveryTask);
        void deliveryTask.then(() => this.deliveryTasks.delete(deliveryTask));
    }

    private async notifyParent(
        childStore: SessionStore,
        effect: NotifyParentEffect,
    ): Promise<ToolOutput> {
        const child = this.agents.get(childStore.header.id);
        const parentId = child?.parentId;
        if (child?.kind !== "background" || parentId === undefined) {
            return {
                kind: "output",
                output: "This agent has no parent to notify.",
                isError: true,
            };
        }

        const parent = this.agents.get(parentId);
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

    private async deliverBackgroundResult(
        parentStore: SessionStore,
        childId: string,
        attachment: AgentAttachment,
        completionSequence: number,
    ): Promise<void> {
        let content = "Async subagent failed before producing a summary.";
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
                    const entry = this.agents.get(childId);
                    if (entry === undefined) {
                        break;
                    }
                    entry.pendingAsyncTurns = Math.max(
                        0,
                        entry.pendingAsyncTurns - 1,
                    );
                    if (entry.pendingAsyncTurns === 0) {
                        // Mark the completion write pending at the same boundary
                        // that ends this assignment. A later prompt becomes a
                        // new assignment, while parent trash remains blocked
                        // until this result has been saved.
                        entry.pendingCompletionDeliveries += 1;
                        break;
                    }
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
        // A substitution the parent cannot see is a silent success on the
        // wrong model, so it rides the completion the parent actually reads,
        // not only the spawn call it made turns ago.
        const substitution = this.spawnNotices.get(childId);
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
        const parentEvents = this.agents.get(parentStore.header.id)?.events;
        const recorded = parentEvents === undefined
            ? await parentStore.recordDelivery(delivery)
            : await recordDeliveryAndNotify(parentStore, parentEvents, delivery);
        const entry = this.agents.get(childId);
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

    /** Keeps shutdown waiting on a delivery that is mid-flight. */
    private trackDelivery(task: Promise<void>): void {
        this.deliveryTasks.add(task);
        void task.then(() => this.deliveryTasks.delete(task));
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
    catalog: EffectiveCatalogOptions = {},
): ModelTurnSettings {
    const effort = reasoningEffortForModel(
        settings.provider,
        settings.model,
        settings.reasoningEffort,
        catalog,
    );
    if (effort === settings.reasoningEffort) {
        return settings;
    }
    const { reasoningEffort: _dropped, ...supported } = settings;
    return supported;
}

/**
 * The levels are resolved here rather than where the runnable list is built,
 * so every client sees the catalog as it is now, and a client can show the
 * levels of a model the user is only looking at.
 */
function settingsForClient(
    settings: ModelTurnSettings,
    provider: string,
    catalog: EffectiveCatalogOptions = {},
    models: readonly SuggestedModel[] = availableModels(),
    pooled: readonly PooledModel[] = [],
    subagentModel?: SpawnModelDefault,
    requestedReasoningEffort?: ModelReasoningEffort,
): ModelTurnSettings {
    const contextWindow = contextWindowForModel(provider, settings.model, models);
    const { efforts } = publishedReasoningLevels(
        provider,
        settings.model,
        pooled,
        catalog,
    );
    // A running session's stored effort can outlive discovery deciding the
    // model has no levels at all; serving it anyway shows a dial the model
    // cannot have. Same emptiness rule as `reasoningEffortForModel`.
    const { reasoningEffort, ...rest } = settings;
    const served = efforts.length > 0 && reasoningEffort !== undefined;
    return {
        ...rest,
        ...(served ? { reasoningEffort } : {}),
        // Only alongside a level that is actually served, and only while the
        // two still disagree: on its own it would name a level nothing is
        // running at.
        ...(served
                && requestedReasoningEffort !== undefined
                && requestedReasoningEffort !== reasoningEffort
            ? { requestedReasoningEffort }
            : {}),
        availableReasoningEfforts: efforts,
        availableModels: availableModelsWithLevels(models),
        pooled,
        subagentDefault: subagentModel === undefined
            ? { mode: "inherit" }
            : {
                mode: "fixed",
                ...(subagentModel.provider === undefined
                    ? {}
                    : { provider: subagentModel.provider }),
                model: subagentModel.model,
                ...(subagentModel.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: subagentModel.reasoningEffort }),
            },
        ...(contextWindow === undefined ? {} : { contextWindow }),
    };
}
