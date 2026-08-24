import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import {
    link,
    mkdir,
    mkdtemp,
    readdir,
    realpath,
    rm,
    rmdir,
    unlink,
} from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { AsyncQueue } from "../engine/async-queue.ts";
import { EngineEventBus } from "../engine/events.ts";
import type { SessionFacts } from "../store/session-facts.ts";
import type { InstructionRoot } from "../engine/memory.ts";
import type { WorkAgentFacts, WorkScheduleFacts } from "./work-index.ts";
import type { PromptContribution } from "../engine/prompt-contributions.ts";
import type { PoolAdmissionVerdict } from "../engine/events.ts";
import type { ModelFailureLedger } from "../store/model-failures.ts";
import {
    BUILT_IN_PERMISSION_MODE_NAMES,
    builtInPermissionMode,
    isApprovalMode,
    type ApprovalMode,
    type PermissionMode,
} from "../engine/permissions.ts";
import type { ToolHooks } from "../engine/hooks.ts";
import {
    ProviderUnavailableError,
    UserFacingError,
} from "../user-facing-error.ts";
import type { PermissionPreferenceStore } from "../engine/permission-preferences.ts";
import type { ModelFallbackPolicy } from "../engine/recovery.ts";
import type { EffortPool } from "../model/effort-pool.ts";
import {
    availableModels,
    contextWindowForModel,
    effectiveContextWindow,
    isModelReasoningEffort,
    publishedReasoningLevels,
    reasoningEffortForModel,
    type DeveloperSettings,
    type DeveloperSettingsPatch,
    type ModelSettingsPatch,
    type ModelTurnSettings,
} from "../engine/model-settings.ts";
import { inferReasoningSelection } from "../model/reasoning-effort.ts";
import type { EffectiveCatalogOptions } from "../model/catalog.ts";
import {
    runHeadlessLoop,
    sessionScratchDir,
} from "../engine/run-turn.ts";
import type {
    RunHeadlessLoopData,
    RunHeadlessLoopServices,
} from "../engine/loop-services.ts";
import { createRoutedCompletionService } from "../engine/completion-service.ts";
import {
    BUNDLED_COMPACTION_STRATEGIES,
    bindCompaction,
    type CompactionOverrides,
} from "../engine/compaction-binding.ts";
import type {
    ResolvedCompactionProfile,
    VeraCatalogModel,
} from "../config/model-catalog.ts";
import { isVeraProviderId } from "../config.ts";
import {
    createSubagentEffectApplier,
    resolveSpawnModelChoice,
    subagentModelBoundary,
    type MissingSubagentConfigurationRequest,
    type SpawnModelDefault,
    type SpawnModelResolution,
    type SubagentPoolPolicy,
} from "../engine/subagent.ts";
import { InboundCommandRouter } from "../engine/inbound-command-router.ts";
import {
    isConsultReplyUpdate,
    isConfigurationRequiredUiRequestUpdate,
    isSessionNameReplyUpdate,
    isTimelineReplyUpdate,
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
import type { ReviewLog } from "../engine/review-log.ts";
import type { ToolReviewerSettings } from "../engine/reviewer.ts";
import type {
    ReviewerModelDefault,
    ReviewerSettingsPatch,
} from "../engine/model-settings.ts";
import { loadPoolFile } from "../model/pool-file-loader.ts";
import { providerOf } from "../model/pool-file.ts";
import { resolvePoolRef } from "../model/pool-names.ts";
import type {
    ModelAdapter,
    ModelMessage,
    ModelReasoningEffort,
} from "../model/types.ts";
import { emptyUsage } from "../model/types.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import {
    admittedEffortIds,
    availableModelsWithLevels,
    type PooledModel,
} from "../model/catalog-view.ts";
import { projectTranscript } from "../engine/protocol.ts";
import type {
    AgentInboxEffect,
    AgentSendEffect,
    AppliedToolEffectOutput,
    ApplyCommittedToolEffect,
    ApplyToolEffect,
    CommitEffect,
    MessageSubagentEffect,
    NotifyParentEffect,
    RegisteredTool,
    SpawnAsyncSubagentEffect,
    ToolEffectContext,
    ToolOutput,
} from "../tools/types.ts";
import { ManagedProcessRegistry } from "../tools/process-runtime.ts";
import { ToolRuntime } from "../tools/runtime.ts";
import {
    defaultSessionPath,
    SessionStore,
    type SessionDelegation,
    type SessionSettingOrigin,
} from "../store/session-store.ts";
import {
    findCatalogAgent,
    loadAgentCatalog,
    type AgentCatalog,
} from "../agents/catalog.ts";
import {
    DEFAULT_AGENT,
    type AgentDefinition,
} from "../agents/definition.ts";
import {
    agentSnapshotDrift,
    resolveAgentSnapshot,
    type AgentWearSnapshot,
} from "../agents/wear.ts";
import { writeAgentDefaultPair } from "../agents/writer.ts";
import type { InboxEntry, InboxEntryInput } from "../store/inbox.ts";
import { sessionChangedFiles } from "../store/preimage-stash.ts";
import type { EmittedScheduleRun } from "../scheduler/types.ts";
import {
    copySessionMessageAttachments,
    createSessionBranch,
} from "../store/session-branch.ts";
import {
    disabledContributionsForProfile,
    storedStartupProfile,
    type StartupProfile,
} from "../startup-profile.ts";
import type { UserMessage } from "../model/types.ts";
import type { ConsultMessage } from "../engine/protocol.ts";
import type { EngineCommand } from "../engine/timeline-control.ts";
import type { LoopState } from "../engine/host-protocol.ts";
import type { VeraExtensionConfig } from "../config.ts";
import { recordDeliveryAndNotify } from "./delivery-notifier.ts";
import { agentNameKey, mintAgentName } from "./agent-name.ts";
import { workspaceKey } from "../workspace-key.ts";
import type {
    InboxDeliveryCoordinator,
    InboxDeliverySession,
    InboxAdmissionCandidate,
    InboxAdmissionDecision,
} from "./inbox-delivery.ts";
import {
    ImageAttachmentService,
    sessionAttachmentName,
} from "../attachments/service.ts";
import { ProviderRoutingAdapter } from "../providers/routing.ts";
import {
    startWorker,
    type WorkerHandle,
    type WorkerOutcome,
} from "./worker/handle.ts";
import type {
    WorkerAdapterSpec,
    WorkerSessionSeed,
} from "./worker/start.ts";
import type { PrepareModelRequest } from "../providers/routing.ts";
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
import { SOURCE_GAP_KIND } from "../watch/source.ts";
import {
    PEER_MESSAGE_KIND,
    PEER_READ_KIND,
    VERA_INBOX_SOURCE,
    parsePeerMessage,
    parsePeerRead,
    type PeerMessagePayload,
} from "./local-participation.ts";

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

/** How many peer messages may chain before the host stops waking anyone. */
const MAX_PEER_HOP = 3;
/** Peer wakes one session may take inside {@link PEER_WAKE_WINDOW_MS}. */
const MAX_PEER_WAKES_PER_WINDOW = 6;
const PEER_WAKE_WINDOW_MS = 60_000;

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
    /** Live process hosting this session's loop, when process mode is active. */
    readonly worker_pid?: number;
    /** External lease supervisor paired with `worker_pid`, when active. */
    readonly supervisor_pid?: number;
    readonly title?: string;
    /** Whether the transcript contains a non-internal user message. */
    readonly has_user_content?: boolean;
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
    /** The time the session was started, from its header. */
    readonly created_at?: string;
    /**
     * Optional facts, present only for the names the caller passed in
     * `include`. Absent means "not asked for, or not available"; it never
     * means zero, so a reader must distinguish the two before summing.
     */
    readonly facts?: SessionFacts;
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
    /**
     * How a worker builds its own adapter, when a session runs in one.
     *
     * Absent means no session runs in a worker, whatever the environment says.
     * The owner supplies it only when the adapter it would build in process
     * can be rebuilt from plain JSON, which is what a host with an injected
     * adapter factory or a live model-request hook cannot promise.
     */
    readonly workerAdapterSpec?: (context: {
        readonly provider: string;
        readonly projectRoot: string;
        readonly sessionId: string;
    }) => WorkerAdapterSpec;
    /**
     * How many sessions may run their loop in a separate process at once.
     * Defaults to what the machine's memory affords. A session that would
     * exceed it fails to start rather than running unisolated, because an
     * unisolated session is the one that cannot be killed.
     */
    readonly maxConcurrentWorkers?: number;
    readonly provider?: string;
    /**
     * Config-declared provider ids accepted alongside Vera's built-ins. Read
     * on each call, so a provider declared mid-session is usable without a
     * restart.
     */
    readonly customProviderIds?: () => readonly string[];
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
    readonly reviewLog?: ReviewLog;
    /** Persists a reviewer choice. `null` clears it. */
    readonly writeReviewer?: (
        reviewer: ToolReviewerSettings | null,
    ) => void;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    /** Agents an extension registered, the lowest-precedence source. */
    readonly registeredAgents?: readonly AgentDefinition[];
    /** Resolved once at startup, bound per agent to that agent's adapter. */
    readonly compaction?: ResolvedCompactionProfile;
    /** What a strategy slot the profile did not name falls back to. */
    readonly compactionModels?: readonly VeraCatalogModel[];
    /** Read per agent, so a change reaches the next session without a restart. */
    readonly compactionOverrides?: CompactionOverrides;
    /**
     * Durable preferences, deliberately one store shared by every agent:
     * the file is per-user, not per-session, so an allow the user persists
     * in one agent applies in the next one without a restart.
     */
    readonly permissionPreferences?: PermissionPreferenceStore;
    readonly availableModels?: readonly SuggestedModel[];
    /** Rebuilds dynamic provider rows after credentials change in this process. */
    readonly refreshAvailableModels?: () => readonly SuggestedModel[];
    /**
     * Asks a provider for its model list now, past whatever age the snapshot
     * would otherwise be trusted for, and returns the replacement list.
     * `undefined` means nothing could be asked and the remembered list stands.
     */
    readonly refreshCatalog?: (
        provider: string,
    ) => Promise<readonly SuggestedModel[] | undefined>;
    /**
     * Read per settings snapshot, not once at startup: the pool changes while
     * the host runs, so a snapshot taken when it came up would freeze the
     * list for the life of the host.
     */
    readonly readPool?: (projectRoot?: string) => readonly PooledModel[];
    readonly sessionPathForId?: (agentId: string) => string;
    readonly eventLogPathForId?: (agentId: string, cwd: string) => string;
    /** Shared by every session: a failing model is a fact about the machine. */
    readonly modelFailureLedger?: ModelFailureLedger;
    readonly updateModelDefaults?: (settings: ModelTurnSettings) => void;
    /** Read on each snapshot so a TUI change takes effect without restart. */
    readonly contextLimit?: () => number | undefined;
    readonly updateContextLimit?: (limit: number | null) => void;
    /** Read live, so a change reaches the next snapshot without a restart. */
    readonly developerSettings?: () => DeveloperSettings;
    readonly updateDeveloperSettings?: (patch: DeveloperSettingsPatch) => void;
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
    /**
     * Moves a pool entry by `delta` places in the pool's declared order.
     * False means nothing moved.
     */
    readonly movePoolEntry?: (
        entry: { readonly provider: string; readonly model: string },
        delta: number,
        projectRoot: string,
    ) => boolean;
    readonly updateApprovalDefault?: (mode: ApprovalMode) => void;
    readonly trashSessionArtifacts?: (artifacts: SessionArtifacts) => Promise<void>;
    readonly extensionTools?: readonly RegisteredTool[];
    /**
     * The extension configs a worker loads for itself, so that an extension
     * tool runs in the process a kill lands on rather than in this one.
     *
     * Only read when `VERA_WORKER_EXTENSIONS=1`, because loading them twice
     * means an extension that opens a connection opens one per session.
     */
    readonly workerExtensions?: () => readonly VeraExtensionConfig[];
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
        allowedSkills?: readonly string[],
    ) => Promise<readonly PromptContribution[]>;
    readonly disabledPromptContributions?: readonly string[];
    /** Builds each resident agent's tool hooks; absent means none. */
    readonly createToolHooks?: () => ToolHooks;
    /** Adds extension-owned, namespaced fields before a provider request. */
    readonly prepareModelRequest?: (
        context: { readonly sessionId: string; readonly workspace: string },
    ) => PrepareModelRequest;
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

export interface CloseAgentTreeResult {
    readonly status: "closed" | "not_found";
    /**
     * Whether the durable transcript is still on disk afterwards. False for an
     * ephemeral agent, whose session directory is removed with it, so a client
     * never offers a resume that cannot work.
     */
    readonly sessionRetained: boolean;
}

export interface CreateRegisteredAgentOptions {
    readonly id?: string;
    readonly workspace: string;
    readonly sessionPath?: string;
    readonly eventLogPath?: string;
    /** Keep this session only for the lifetime of the resident host. */
    readonly ephemeral?: boolean;
    readonly startupProfile?: StartupProfile;
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
    /** Keep the branch only for the lifetime of the resident host. */
    readonly ephemeral?: boolean;
    /** Override the approval mode copied from the source session. */
    readonly approvalMode?: ApprovalMode;
    /** Model-visible messages appended only to the new branch before it starts. */
    readonly initialMessages?: readonly UserMessage[];
    /** Keep inherited model context out of the branch's local transcript. */
    readonly hideInheritedMessages?: boolean;
    readonly signal?: AbortSignal;
    /** Keep the branch out of public lookup until `commitBranch` publishes it. */
    readonly deferPublication?: boolean;
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

/**
 * The checkout a workspace belongs to, so every worktree of one project reads
 * the same project-scoped state. A directory that is not a repository resolves
 * to itself, which is an ordinary case rather than a failure.
 */
export function resolveInstructionRoot(workspace: string): InstructionRoot {
    const remembered = instructionRoots.get(workspace);
    if (remembered !== undefined) {
        return remembered;
    }
    const resolved = readInstructionRoot(workspace);
    instructionRoots.set(workspace, resolved);
    return resolved;
}

/**
 * One answer per workspace for the life of the host. Resolving spawns git, and
 * restoring the stored sessions asks the same handful of directories hundreds
 * of times: without this, the spawns alone keep the host from listening.
 */
const instructionRoots = new Map<string, InstructionRoot>();

function readInstructionRoot(workspace: string): InstructionRoot {
    try {
        const git = spawnSync(
            "git",
            ["rev-parse", "--git-common-dir"],
            { cwd: workspace, encoding: "utf8" },
        );
        const output = git.status === 0 ? git.stdout.trim() : "";
        if (output.length > 0) {
            return {
                path: dirname(resolve(workspace, output)),
                source: "git",
            };
        }
    } catch {
        // git is not required to run a session.
    }
    return { path: workspace, source: "workspace" };
}

function sameWorkspace(
    left: RegisteredAgentEntry,
    right: RegisteredAgentEntry,
): boolean {
    return workspaceKey(left.agent.workspace) === workspaceKey(right.agent.workspace);
}

function entryStatus(entry: RegisteredAgentEntry): RegisteredAgentStatus {
    return entry.failure !== undefined
        ? "failed"
        : entry.agent.closed
            ? "closed"
            : entry.completed && entry.agent.status === "idle"
                ? "completed"
                : entry.agent.status;
}

function entryIsLive(entry: RegisteredAgentEntry): boolean {
    return !entry.agent.closed
        && !entry.agent.failed
        && entry.failure === undefined
        && (
            entry.agent.attached
            || entry.agent.status === "working"
            || entry.agent.status === "waiting"
        );
}

function entryUpdatedAt(entry: RegisteredAgentEntry): string {
    return entry.store.agentFailure()?.timestamp
        ?? entry.store.activeEntries().at(-1)?.timestamp
        ?? entry.store.header.timestamp;
}

interface GitRosterFacts {
    readonly repository: string | null;
    readonly git_common_directory: string | null;
    readonly worktree: string;
    readonly branch: string | null;
    readonly head: string | null;
    readonly dirty: boolean;
    readonly changed_files: readonly string[];
    readonly changed_file_count: number;
    readonly changed_files_truncated: boolean;
}

const MAX_ROSTER_CHANGED_FILES = 200;

function gitRosterFacts(workspace: string): GitRosterFacts {
    const worktree = gitOutput(workspace, ["rev-parse", "--show-toplevel"]);
    const common = gitOutput(workspace, ["rev-parse", "--git-common-dir"]);
    if (worktree === undefined || common === undefined) {
        return {
            repository: null,
            git_common_directory: null,
            worktree: workspace,
            branch: null,
            head: null,
            dirty: false,
            changed_files: [],
            changed_file_count: 0,
            changed_files_truncated: false,
        };
    }
    const commonDirectory = resolve(workspace, common);
    const status = gitOutput(workspace, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    ], false) ?? "";
    const tracked = nulList(gitOutput(workspace, [
        "diff",
        "--name-only",
        "-z",
        "HEAD",
    ], false));
    const untracked = nulList(gitOutput(workspace, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
    ], false));
    const fallback = status.split("\n")
        .filter((line) => line.length >= 4)
        .map((line) => line.slice(3));
    const changed = [...new Set(
        tracked.length + untracked.length > 0 ? [...tracked, ...untracked] : fallback,
    )].sort();
    return {
        repository: dirname(commonDirectory),
        git_common_directory: commonDirectory,
        worktree,
        branch: gitOutput(workspace, ["branch", "--show-current"]) || null,
        head: gitOutput(workspace, ["rev-parse", "HEAD"]) ?? null,
        dirty: status.length > 0,
        changed_files: changed.slice(0, MAX_ROSTER_CHANGED_FILES),
        changed_file_count: changed.length,
        changed_files_truncated: changed.length > MAX_ROSTER_CHANGED_FILES,
    };
}

function gitOutput(
    workspace: string,
    args: readonly string[],
    trim: boolean = true,
): string | undefined {
    try {
        const result = spawnSync("git", args, {
            cwd: workspace,
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            timeout: 2_000,
        });
        if (result.status !== 0) return undefined;
        return trim ? result.stdout.trim() : result.stdout;
    } catch {
        return undefined;
    }
}

function nulList(value: string | undefined): string[] {
    return value === undefined
        ? []
        : value.split("\0").filter((item) => item.length > 0);
}

function toolError(output: string): ToolOutput {
    return { kind: "output", output, isError: true };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function resolveAgentWorkspace(workspace: string): Promise<string> {
    try {
        return await realpath(workspace);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new UserFacingError(
                `Session workspace is unavailable: ${workspace}`,
            );
        }
        throw error;
    }
}

function peerReadReceipt(
    readerId: string,
    senderId: string,
    messageId: number,
): InboxEntryInput {
    return {
        source: VERA_INBOX_SOURCE,
        kind: PEER_READ_KIND,
        actor: readerId,
        session: readerId,
        address: senderId,
        payload: JSON.stringify({ message_id: messageId, complete: true }),
    };
}

function acknowledgeAfterCommit(
    seq: number,
    receiptTo?: string,
): CommitEffect {
    return {
        key: "inbox.acknowledge",
        data: {
            seq,
            ...(receiptTo === undefined ? {} : { receipt_to: receiptTo }),
        },
    };
}

function genericInboxResult(entry: InboxEntry): Record<string, unknown> {
    const payload = boundedUtf8(entry.payload, 24 * 1024);
    return {
        message_id: entry.seq,
        source: entry.source,
        kind: entry.kind,
        actor: entry.actor,
        session: entry.session,
        address: entry.address,
        payload: payload.text,
        payload_truncated: payload.truncated,
        complete: true,
    };
}

function boundedUtf8(
    value: string,
    maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
    if (encodedStringBytes(value) <= maxBytes) {
        return { text: value, truncated: false };
    }
    let text = "";
    let bytes = 0;
    for (const character of value) {
        const next = encodedStringBytes(character);
        if (bytes + next > maxBytes) break;
        text += character;
        bytes += next;
    }
    return { text, truncated: true };
}

function encodedStringBytes(value: string): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
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
    readonly delegation?: SessionDelegation;
}

/**
 * Whether two pairs are the same dial setting.
 *
 * Absent effort is its own value rather than a wildcard: a model with no
 * effort dial has exactly one pair, and treating "no effort" as matching any
 * effort would make the override marker wrong on every such model.
 */
function samePair(
    left: ModelTurnSettings,
    right: ModelTurnSettings,
): boolean {
    return left.model === right.model
        && (left.provider ?? "") === (right.provider ?? "")
        && left.reasoningEffort === right.reasoningEffort;
}

/**
 * The request id a resume-time wear carries.
 *
 * Nobody asked for it, so there is no request to answer; a fixed id is what
 * lets a client tell the unsolicited update from the reply to its own /agent.
 */
const RESUME_WEAR_REQUEST_ID = "resume";

interface RegisteredAgentEntry {
    readonly agent: ResidentAgent;
    readonly store: SessionStore;
    readonly kind: RegisteredAgentKind;
    readonly ephemeral: boolean;
    pendingPublication: boolean;
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
    /**
     * The agent this session is wearing, resolved when it went on. Undefined
     * is the virtual `default`: every tool, every skill, the host's posture.
     */
    agentWear?: AgentWearSnapshot;
    inbound?: InboundCommandRouter;
    /** Answers host-owned commands while this session's loop is in a worker. */
    workerOwnerRouter?: InboundCommandRouter;
    /** The services the loop was built from, re-read to push owner state. */
    loopServices?: RunHeadlessLoopServices;
    /** Last source entry incorporated after this branch was created. */
    syncedSourceEntryId?: string | null;
    inbox?: InboxDeliverySession;
    /**
     * How many peer messages deep the work in this session is. A message sent
     * while running at hop N arrives at hop N + 1, and a client prompt puts it
     * back to zero, so two agents cannot keep each other awake forever.
     */
    peerHop: number;
    /** Epoch milliseconds of the peer messages that woke this session. */
    peerWakes: number[];
    run: Promise<void>;
    /** The process running this session's loop, when it runs in one. */
    worker?: WorkerHandle;
    completed: boolean;
    pendingAsyncTurns: number;
    pendingCompletionDeliveries: number;
    completionSequence: number;
    failure?: unknown;
}

interface PendingSubagentLaunch {
    readonly id: string;
    readonly request: MissingSubagentConfigurationRequest;
    readonly context: ToolEffectContext;
    readonly signal: AbortSignal;
    readonly resolve: (resolution: SpawnModelResolution) => void;
    settled: boolean;
    onAbort?: () => void;
}

interface PendingSubagentConfigurationBatch {
    readonly id: string;
    readonly entryId: string;
    readonly actions: PendingSubagentLaunch[];
    readonly abort: AbortController;
    scheduled: boolean;
    processing: boolean;
}

export class AgentRegistry {
    private readonly agents = new Map<string, RegisteredAgentEntry>();
    private readonly startingIds = new Set<string>();
    private readonly deliveryTasks = new Set<Promise<void>>();
    private defaultModel: string;
    private defaultProvider: string;
    private defaultReasoningEffort: ModelReasoningEffort | undefined;
    private defaultApprovalMode: ApprovalMode;
    /**
     * The reviewer route in effect. Held here rather than read from options
     * because choosing a reviewer has to reach a session already running: an
     * agent reads it at each review, not once at start.
     */
    private reviewerSettings: ToolReviewerSettings | undefined;
    private isClosed = false;
    private readonly trashArtifacts: (artifacts: SessionArtifacts) => Promise<void>;
    private readonly maxConcurrentBackgroundAgents: number;
    private readonly startingBackgroundAgents = new Map<string, number>();
    /** Child id to the ladder notice its spawn produced, if any. */
    private readonly spawnNotices = new Map<string, string>();
    private readonly pendingSubagentConfigurations = new Map<
        string,
        PendingSubagentConfigurationBatch[]
    >();
    private readonly catalog: EffectiveCatalogOptions;
    private availableModels: readonly SuggestedModel[];
    private readonly rosterListeners = new Set<() => void>();
    private readonly processRegistry = new ManagedProcessRegistry();

    constructor(private readonly options: AgentRegistryOptions) {
        this.reviewerSettings = options.reviewer;
        this.defaultModel = options.model;
        this.defaultProvider = options.provider ?? "unknown";
        this.defaultReasoningEffort = options.reasoningEffort;
        this.availableModels = options.availableModels ?? [];
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

    private modelsForClient(): readonly SuggestedModel[] {
        const refreshed = this.options.refreshAvailableModels?.();
        if (refreshed !== undefined) {
            this.availableModels = refreshed;
        }
        return this.availableModels;
    }

    private isKnownProvider(provider: string): boolean {
        return isVeraProviderId(provider)
            || this.options.customProviderIds?.().includes(provider) === true;
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
        await this.reapClosedAgent(id, entry);
        this.notifyRosterChanged();
        return "closed";
    }

    /**
     * Close one agent and every live agent descended from it.
     *
     * Fence first, quiesce second. `agent.close()` is synchronous and shuts
     * admission, so every member of the subtree is fenced in one pass before
     * anything is awaited; awaiting a child first would leave the parent live
     * for the seconds that child takes to exit, long enough to spawn a
     * subagent nothing is walking any more. Fencing is then repeated to a
     * fixpoint, because a spawn can still have raced the very first pass.
     * Roster entries are removed only at the end, so the parent links the
     * walk follows are still intact while the subtree is being quiesced.
     * Idempotent for the same reason `closeAgent` is: a second call finds
     * nothing left to close and says so.
     */
    async closeAgentTree(id: string): Promise<CloseAgentTreeResult> {
        const present = this.agents.has(id);
        // Read before the walk: an ephemeral entry is gone from the roster by
        // the time anyone could ask, and its transcript goes with it.
        const sessionRetained = this.agents.get(id)?.ephemeral !== true;
        const quiesced = new Map<string, RegisteredAgentEntry>();
        while (true) {
            const members = [id, ...this.liveDescendantsOf(id)]
                .filter((memberId) =>
                    this.agents.has(memberId) && !quiesced.has(memberId)
                );
            if (members.length === 0) {
                break;
            }
            for (const memberId of members) {
                this.agents.get(memberId)?.agent.close();
            }
            for (const memberId of members) {
                const entry = this.agents.get(memberId);
                if (entry === undefined) {
                    continue;
                }
                await entry.run;
                quiesced.set(memberId, entry);
            }
        }
        for (const [memberId, entry] of quiesced) {
            await this.reapClosedAgent(memberId, entry);
        }
        if (quiesced.size > 0) {
            this.notifyRosterChanged();
        }
        return {
            status: present || quiesced.size > 0 ? "closed" : "not_found",
            sessionRetained,
        };
    }

    /** Release what a quiesced entry still holds and take it off the roster. */
    private async reapClosedAgent(
        id: string,
        entry: RegisteredAgentEntry,
    ): Promise<void> {
        entry.inbox?.release();
        this.agents.delete(id);
        this.spawnNotices.delete(id);
        if (entry.ephemeral) {
            await rm(dirname(entry.store.path), { recursive: true, force: true });
        }
    }

    /** Every live agent under `id`, deepest first. */
    private liveDescendantsOf(id: string): readonly string[] {
        const ordered: string[] = [];
        // A corrupt header could name a parent cycle; without this the walk
        // would never return.
        const seen = new Set<string>([id]);
        const visit = (parentId: string): void => {
            for (const [childId, entry] of this.agents) {
                if (entry.parentId !== parentId || seen.has(childId)) {
                    continue;
                }
                seen.add(childId);
                visit(childId);
                ordered.push(childId);
            }
        };
        visit(id);
        return ordered;
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
        if (isConfigurationRequiredUiRequestUpdate(update)) {
            attachment.send({
                type: "ui_response",
                requestId: update.requestId,
                response: {
                    type: "configuration_required",
                    outcome: "unavailable",
                },
            });
            return "Subagent configuration is unavailable in print mode; no child started.";
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
        let createdPath: string | undefined;
        let ephemeralDirectory: string | undefined;
        try {
            const workspace = await resolveAgentWorkspace(options.workspace);
            const startupProfile = storedStartupProfile(
                options.startupProfile ?? "default",
            );
            ephemeralDirectory = options.ephemeral === true
                ? await mkdtemp(join(tmpdir(), "vera-ephemeral-agent-"))
                : undefined;
            const store = await SessionStore.create(
                options.sessionPath
                    ?? (ephemeralDirectory === undefined
                        ? undefined
                        : join(ephemeralDirectory, `${id}.jsonl`))
                    ?? this.options.sessionPathForId?.(id)
                    ?? defaultSessionPath(id),
                {
                    sessionId: id,
                    cwd: workspace,
                    ...(startupProfile === undefined
                        ? {}
                        : { startupProfile }),
                    ...(inherited?.parentId === undefined
                        ? {}
                        : { parentId: inherited.parentId }),
                    ...(inherited?.delegation === undefined
                        ? {}
                        : { delegation: inherited.delegation }),
                },
            );
            createdPath = store.path;
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
                options.ephemeral === true,
            );
        } catch (error) {
            await this.closeAgent(id).catch(() => {});
            if (ephemeralDirectory !== undefined) {
                await rm(ephemeralDirectory, { recursive: true, force: true })
                    .catch(() => {});
            } else if (createdPath !== undefined) {
                await rm(createdPath, { force: true }).catch(() => {});
            }
            throw error;
        } finally {
            this.startingIds.delete(id);
        }
    }

    async resume(
        options: ResumeRegisteredAgentOptions,
    ): Promise<ResidentAgent> {
        const sessionPath = await realpath(options.sessionPath);
        const store = await SessionStore.open(sessionPath);
        const storedProvider = store.modelSettings()?.provider;
        if (
            store.header.delegation !== undefined
            && store.modelSettings() !== undefined
            && !delegationAllows(
                store.header.delegation,
                store.modelSettings()!,
            )
        ) {
            throw new UserFacingError(
                "This delegated session's stored model is outside its persisted boundary.",
            );
        }
        if (
            store.agentFailure() === undefined
            && storedProvider !== undefined
            && !(storedProvider === "unknown" && this.defaultProvider === "unknown")
            && !this.isKnownProvider(storedProvider)
        ) {
            throw new ProviderUnavailableError(storedProvider);
        }
        this.reserveId(store.header.id);
        try {
            this.requireOpen();
            const parentId = store.header.delegation?.parentId
                ?? store.header.parentId;
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
        if (options.ephemeral === true && options.sessionPath !== undefined) {
            throw new Error("An ephemeral branch cannot use a session path");
        }
        options.signal?.throwIfAborted();
        const ephemeralDirectory = options.ephemeral === true
            ? await mkdtemp(join(tmpdir(), "vera-ephemeral-agent-"))
            : undefined;
        const source = this.agents.get(options.sourceId);
        if (
            source === undefined
            || source.agent.closed
            || source.agent.failed
            || source.agent.status !== "idle"
        ) {
            if (ephemeralDirectory !== undefined) {
                await rm(ephemeralDirectory, { recursive: true, force: true });
            }
            return undefined;
        }
        const id = options.id ?? randomUUID();
        let createdPath: string | undefined;
        let stagingPath: string | undefined;
        let publishedAttachments: PublishedBranchAttachments | undefined;
        const approvalMode = options.approvalMode ?? source.approvalMode;
        try {
            this.reserveId(id);
            const destinationPath = options.sessionPath
                ?? (ephemeralDirectory === undefined
                    ? undefined
                    : join(ephemeralDirectory, `${id}.jsonl`))
                ?? this.options.sessionPathForId?.(id)
                ?? defaultSessionPath(id);
            stagingPath = options.ephemeral === true
                ? destinationPath
                : join(
                    dirname(destinationPath),
                    `.${basename(destinationPath)}.${randomUUID()}.branch`,
                );
            const created = await createSessionBranch({
                source: source.store,
                destinationPath: stagingPath,
                sessionId: id,
                position: options.position,
                ...(options.entryId === undefined
                    ? {}
                    : { entryId: options.entryId }),
                ...(options.hideInheritedMessages === true
                    ? { hideInheritedMessages: true }
                    : {}),
            });
            options.signal?.throwIfAborted();
            await created.store.appendApprovalMode(approvalMode);
            for (const message of options.initialMessages ?? []) {
                options.signal?.throwIfAborted();
                await created.store.appendMessage(message);
            }
            options.signal?.throwIfAborted();
            let store = created.store;
            if (options.ephemeral !== true) {
                publishedAttachments = await publishBranchAttachments(
                    stagingPath,
                    destinationPath,
                    options.signal,
                );
                options.signal?.throwIfAborted();
                await link(stagingPath, destinationPath);
                createdPath = destinationPath;
                await rm(stagingPath, { force: true });
                stagingPath = undefined;
                store = await SessionStore.open(destinationPath);
            } else {
                createdPath = stagingPath;
            }
            this.requireOpen();
            return {
                agent: this.start(
                    store,
                    "interactive",
                    options.eventLogPath,
                    undefined,
                    undefined,
                    options.ephemeral === true,
                    options.deferPublication === true,
                ),
                ...(created.prompt === undefined
                    ? {}
                    : { prompt: created.prompt }),
            };
        } catch (error) {
            if (ephemeralDirectory !== undefined) {
                await rm(ephemeralDirectory, { recursive: true, force: true })
                    .catch(() => {});
            } else if (createdPath !== undefined) {
                await rm(createdPath, { force: true }).catch(() => {});
                await rm(`${createdPath}.attachments`, {
                    recursive: true,
                    force: true,
                }).catch(() => {});
            }
            if (stagingPath !== undefined) {
                await rm(stagingPath, { force: true }).catch(() => {});
                await rm(`${stagingPath}.attachments`, {
                    recursive: true,
                    force: true,
                }).catch(() => {});
            }
            if (publishedAttachments !== undefined) {
                await removePublishedBranchAttachments(publishedAttachments);
            }
            throw error;
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
        const entry = this.agents.get(id);
        const agent = entry?.pendingPublication === true
            ? undefined
            : entry?.agent;
        return agent?.closed === false ? agent : undefined;
    }

    commitBranch(id: string): boolean {
        const entry = this.agents.get(id);
        if (entry === undefined || !entry.pendingPublication) {
            return false;
        }
        entry.pendingPublication = false;
        this.notifyRosterChanged();
        return true;
    }

    async syncBranchContext(
        targetId: string,
    ): Promise<{
        readonly status:
            | "synced"
            | "unchanged"
            | "busy"
            | "stale_cursor"
            | "not_found";
        readonly turns: number;
    }> {
        const target = this.agents.get(targetId);
        const sourceId = target?.store.header.origin?.sessionId;
        const source = sourceId === undefined
            ? undefined
            : this.agents.get(sourceId);
        if (target === undefined || source === undefined) {
            return { status: "not_found", turns: 0 };
        }
        if (
            target.agent.closed
            || target.agent.failed
            || source.agent.closed
            || source.agent.failed
            || target.agent.status !== "idle"
            || source.agent.status !== "idle"
            || target.inbound === undefined
        ) {
            return { status: "busy", turns: 0 };
        }
        const active = source.store.activeEntries();
        const lastCompletedIndex = active.findLastIndex((entry) =>
            entry.message.role === "assistant"
        );
        if (lastCompletedIndex < 0) {
            return { status: "unchanged", turns: 0 };
        }
        const completed = active.slice(0, lastCompletedIndex + 1);
        const cursor = target.syncedSourceEntryId
            ?? target.store.header.origin?.entryId
            ?? null;
        const cursorIndex = cursor === null
            ? -1
            : completed.findIndex((entry) => entry.id === cursor);
        // A rewind of the primary drops the synced entry from its history, so
        // the branch can never catch up again. It is a distinct outcome: the
        // caller drops this branch instead of retrying against a dead cursor.
        if (cursor !== null && cursorIndex < 0) {
            return { status: "stale_cursor", turns: 0 };
        }
        const additions = completed.slice(cursorIndex + 1);
        const turns = additions.filter((entry) =>
            entry.message.role === "user"
            && entry.message.internal !== true
        ).length;
        if (additions.length === 0 || turns === 0) {
            return { status: "unchanged", turns: 0 };
        }
        await copySessionMessageAttachments(
            source.store,
            target.store,
            additions.map((entry) => entry.message),
        );
        const appended = await target.inbound.appendContext(
            additions.map((entry) => entry.message),
            {
                text: `Caught up with ${turns} new ${turns === 1 ? "turn" : "turns"} from the primary conversation.`,
                tone: "soft",
            },
        );
        if (!appended) {
            return { status: "busy", turns: 0 };
        }
        target.syncedSourceEntryId = additions.at(-1)!.id;
        return { status: "synced", turns };
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

    private reviewerDefault(): ReviewerModelDefault {
        return reviewerDefaultOf(this.reviewerSettings);
    }

    /** The reviewer route agents read at each review, not once at start. */
    readReviewer(): ToolReviewerSettings | undefined {
        return this.reviewerSettings;
    }

    /**
     * Applies a reviewer choice to every running agent and writes it to the
     * config file, so the session the user is in changes with the file rather
     * than at the next start. Any model may be a reviewer: nothing here checks
     * the pool or the catalog, because a reviewer that turns out to be
     * unreachable falls through to the failsafe on its own.
     */
    private applyReviewerPatch(patch: ReviewerSettingsPatch | null): boolean {
        if (patch === null) {
            this.reviewerSettings = undefined;
            this.options.writeReviewer?.(null);
            return true;
        }
        const carried = this.reviewerSettings;
        const fallback = patch.fallback === undefined
            ? carried?.models[1]
            : patch.fallback === null
                ? undefined
                : patch.fallback;
        this.reviewerSettings = {
            ...carried,
            models: [
                { ...patch.primary },
                ...(fallback === undefined ? [] : [{ ...fallback }]),
            ],
        };
        this.options.writeReviewer?.(this.reviewerSettings);
        return true;
    }

    /**
     * Validate a pair patch and answer with the settings it resolves to.
     *
     * Shared by the global write and the session-scoped one so a chord and a
     * picker cannot disagree about which levels a model publishes, or coerce an
     * unpublished level differently.
     */
    private resolveModelPatch(
        entry: RegisteredAgentEntry,
        patch: ModelSettingsPatch,
    ): {
        readonly settings: ModelTurnSettings;
        readonly requestedReasoningEffort?: ModelReasoningEffort;
    } | undefined {
        if (
            (patch.provider === undefined && patch.model === undefined && patch.reasoningEffort === undefined)
            || (patch.provider !== undefined && patch.provider.trim().length === 0)
            || (patch.provider !== undefined
                && !this.isKnownProvider(patch.provider.trim()))
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
        if (
            entry.store.header.delegation !== undefined
            && !delegationAllows(entry.store.header.delegation, {
                provider,
                model,
            })
        ) {
            return undefined;
        }
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
        const scope = {
            ...this.catalog,
            projectRoot: entry.store.header.cwd,
        };
        const unnarrowed = publishedReasoningLevels(
            provider,
            model,
            this.options.readPool?.(entry.store.header.cwd),
            this.catalog,
        );
        const published = {
            ...unnarrowed,
            efforts: admittedEffortIds(
                provider,
                model,
                unnarrowed.efforts,
                scope,
            ),
        };
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
        return {
            settings,
            ...(requestedReasoningEffort === undefined
                ? {}
                : { requestedReasoningEffort }),
        };
    }

    async updateModelSettings(
        id: string,
        patch: ModelSettingsPatch,
    ): Promise<ModelTurnSettings | undefined> {
        const result = await this.applyModelSettings(id, patch);
        this.pushWorkerState(id);
        return result;
    }

    private async applyModelSettings(
        id: string,
        patch: ModelSettingsPatch,
    ): Promise<ModelTurnSettings | undefined> {
        const entry = this.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return undefined;
        }
        if (patch.developer !== undefined) {
            if (this.options.updateDeveloperSettings === undefined) {
                return undefined;
            }
            this.options.updateDeveloperSettings(
                patch.developer === null ? { enabled: false } : patch.developer,
            );
        }
        if (
            patch.developer !== undefined
            && patch.contextLimit === undefined
            && patch.provider === undefined
            && patch.model === undefined
            && patch.reasoningEffort === undefined
            && patch.reviewer === undefined
        ) {
            return settingsForClient(
                entry.modelSettings,
                entry.modelSettings.provider ?? this.defaultProvider,
                this.catalog,
                this.modelsForClient(),
                this.options.readPool?.(entry.store.header.cwd),
                this.options.subagentModel,
                entry.requestedReasoningEffort,
                this.reviewerDefault(),
                this.options.contextLimit?.(),
                this.options.developerSettings?.(),
                entry.store.header.cwd,
            );
        }
        if (patch.contextLimit !== undefined) {
            if (this.options.updateContextLimit === undefined) return undefined;
            this.options.updateContextLimit(patch.contextLimit);
            if (
                patch.provider === undefined
                && patch.model === undefined
                && patch.reasoningEffort === undefined
                && patch.reviewer === undefined
            ) {
                return settingsForClient(
                    entry.modelSettings,
                    entry.modelSettings.provider ?? this.defaultProvider,
                    this.catalog,
                    this.modelsForClient(),
                    this.options.readPool?.(entry.store.header.cwd),
                    this.options.subagentModel,
                    entry.requestedReasoningEffort,
                    this.reviewerDefault(),
                    this.options.contextLimit?.(),
                this.options.developerSettings?.(),
                    entry.store.header.cwd,
                );
            }
        }
        if (patch.reviewer !== undefined) {
            if (!this.applyReviewerPatch(patch.reviewer)) {
                return undefined;
            }
            if (
                patch.provider === undefined
                && patch.model === undefined
                && patch.reasoningEffort === undefined
            ) {
                // A reviewer-only patch changes no running model, so the reply
                // is the current settings carrying the new reviewer.
                return settingsForClient(
                    entry.modelSettings,
                    entry.modelSettings.provider ?? this.defaultProvider,
                    this.catalog,
                    this.modelsForClient(),
                    this.options.readPool?.(entry.store.header.cwd),
                    this.options.subagentModel,
                    entry.requestedReasoningEffort,
                    this.reviewerDefault(),
                    this.options.contextLimit?.(),
                this.options.developerSettings?.(),
                    entry.store.header.cwd,
                );
            }
        }
        const resolved = this.resolveModelPatch(entry, patch);
        if (resolved === undefined) {
            return undefined;
        }
        const settings = resolved.settings;
        await entry.store.appendModelSettings(
            settings,
            this.originFor(entry, settings),
        );
        this.options.updateModelDefaults?.(settings);
        this.defaultModel = settings.model;
        this.defaultProvider = settings.provider ?? this.defaultProvider;
        this.defaultReasoningEffort = settings.reasoningEffort;
        entry.modelSettings = settings;
        entry.requestedReasoningEffort = resolved.requestedReasoningEffort;
        return settingsForClient(
            entry.modelSettings,
            entry.modelSettings.provider ?? this.defaultProvider,
            this.catalog,
            this.modelsForClient(),
            this.options.readPool?.(entry.store.header.cwd),
            this.options.subagentModel,
            entry.requestedReasoningEffort,
            this.reviewerDefault(),
            this.options.contextLimit?.(),
                this.options.developerSettings?.(),
            entry.store.header.cwd,
        );
    }

    /**
     * The pair a session falls back to when nobody has dialed it.
     *
     * Today that is the host default. Once an agent can carry a `default_pair`
     * the worn agent's answer comes first, and everything that compares against
     * "the default" goes through here so there is one answer to compare with.
     */
    private effectiveDefaultPair(
        entry: RegisteredAgentEntry,
    ): ModelTurnSettings {
        const agentPair = this.wornAgentDefaultPair?.(entry);
        return agentPair ?? {
            provider: this.defaultProvider,
            model: this.defaultModel,
            ...(this.defaultReasoningEffort === undefined
                ? {}
                : { reasoningEffort: this.defaultReasoningEffort }),
        };
    }

    /**
     * Derived at write time on every path, never carried forward.
     *
     * Reclassifying here is what makes dialing back to the default clear the
     * override: a stale `user` origin sitting on a pair that equals the default
     * would show a marker the user could not get rid of by any means except
     * knowing about the record.
     */
    private originFor(
        entry: RegisteredAgentEntry,
        settings: ModelTurnSettings,
    ): SessionSettingOrigin {
        return samePair(settings, this.effectiveDefaultPair(entry))
            ? "agent-default"
            : "user";
    }

    /**
     * Dial one session. The host's defaults, and every session that is not this
     * one, are left exactly as they were.
     */
    async updateSessionModelSettings(
        id: string,
        patch: ModelSettingsPatch,
    ): Promise<
        { settings: ModelTurnSettings; origin: SessionSettingOrigin } | undefined
    > {
        const result = await this.applySessionModelSettings(id, patch);
        this.pushWorkerState(id);
        return result;
    }

    private async applySessionModelSettings(
        id: string,
        patch: ModelSettingsPatch,
    ): Promise<
        { settings: ModelTurnSettings; origin: SessionSettingOrigin } | undefined
    > {
        const entry = this.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return undefined;
        }
        const resolved = this.resolveModelPatch(entry, patch);
        if (resolved === undefined) {
            return undefined;
        }
        const origin = this.originFor(entry, resolved.settings);
        await entry.store.appendModelSettings(resolved.settings, origin);
        entry.modelSettings = resolved.settings;
        entry.requestedReasoningEffort = resolved.requestedReasoningEffort;
        return {
            settings: settingsForClient(
                entry.modelSettings,
                entry.modelSettings.provider ?? this.defaultProvider,
                this.catalog,
                this.modelsForClient(),
                this.options.readPool?.(entry.store.header.cwd),
                this.options.subagentModel,
                entry.requestedReasoningEffort,
                this.reviewerDefault(),
                this.options.contextLimit?.(),
                this.options.developerSettings?.(),
                entry.store.header.cwd,
            ),
            origin,
        };
    }

    sessionModelSettingsHistory(id: string): readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: SessionSettingOrigin;
        readonly timestamp: string;
    }[] {
        const entry = this.agents.get(id);
        if (entry === undefined) return [];
        return entry.store.modelSettingsHistory().map((record) => ({
            settings: record.settings,
            origin: record.origin ?? "user",
            timestamp: record.timestamp,
        }));
    }

    /** The posture for this session alone, leaving the host default alone. */
    async updateSessionPermissionMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        const result = await this.applySessionPermissionMode(id, mode);
        this.pushWorkerState(id);
        return result;
    }

    private async applySessionPermissionMode(
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
        await this.leaveAgentThatForbidsAccess(entry, id, mode);
        await entry.store.appendApprovalMode(
            mode,
            mode === this.wornAgentPosture(entry) ? "agent-default" : "user",
        );
        entry.approvalMode = mode;
        return entry.approvalMode;
    }

    /**
     * An explicit permission choice wins over an incompatible agent.
     *
     * The host owns this transition so `/permissions`, the HUD, and other
     * clients cannot disagree. The agent update is deliberately loud and
     * durable: the client receives a sticky transcript notice explaining why
     * the session returned to default.
     */
    private async leaveAgentThatForbidsAccess(
        entry: RegisteredAgentEntry,
        id: string,
        mode: ApprovalMode,
    ): Promise<void> {
        const active = entry.agentWear;
        if (active?.forbiddenAccess?.includes(mode) !== true) return;
        const switched = await this.wearAgentFor(id, DEFAULT_AGENT.name);
        if (switched === undefined) return;
        entry.events.emit({
            type: "agent_worn",
            update: {
                requestId: `permissions-${mode}`,
                ...switched,
                notice:
                    `Switched to default because ${active.name} does not allow ${mode.replaceAll("_", " ")} access.`,
            },
        });
    }

    /**
     * The worn agent's default pair, resolved against the pool as it stands.
     *
     * Undefined when the agent names none, or names one the pool no longer
     * has: in both cases the effective default is the host's own, which is
     * what row 7 and row 9 of the origin table say.
     */
    private wornAgentDefaultPair(
        entry: RegisteredAgentEntry,
    ): ModelTurnSettings | undefined {
        const pair = entry.agentWear?.defaultPair;
        if (pair === undefined) return undefined;
        const pooled = this.options.readPool?.(entry.store.header.cwd) ?? [];
        const pooledEntry = pooled.find((candidate) =>
            candidate.poolName === pair.name
        );
        return pooledEntry === undefined ? undefined : {
            provider: pooledEntry.provider,
            model: pooledEntry.model,
            ...(pair.effort === undefined ? {} : { reasoningEffort: pair.effort }),
        } as ModelTurnSettings;
    }

    /**
     * The worn agent's posture. Omitted on the agent means the host's current
     * default, resolved now rather than frozen at wear: editing the default
     * has to reach the sessions that never named one.
     */
    private wornAgentPosture(
        entry: RegisteredAgentEntry,
    ): ApprovalMode | undefined {
        const named = entry.agentWear?.posture;
        return named !== undefined && isApprovalMode(named)
            ? named
            : this.defaultApprovalMode;
    }

    /** Every agent this session could wear, with the one in force named. */
    async listAgentsFor(id: string): Promise<{
        readonly worn: string;
        readonly agents: readonly {
            readonly name: string;
            readonly description?: string;
            readonly scope: "project" | "user" | "extension";
            readonly writable: boolean;
            readonly tools?: readonly string[];
            readonly skills?: readonly string[];
            readonly posture?: string;
            readonly forbiddenAccess?: readonly string[];
            readonly defaultPair?: {
                readonly name: string;
                readonly effort?: string;
            };
        }[];
        readonly notices: readonly string[];
    }> {
        const entry = this.agents.get(id);
        if (entry === undefined) {
            return { worn: DEFAULT_AGENT.name, agents: [], notices: [] };
        }
        const catalog = await this.agentCatalogFor(entry);
        return {
            worn: entry.agentWear?.name ?? DEFAULT_AGENT.name,
            agents: catalog.agents.map((agent) => ({
                name: agent.definition.name,
                ...(agent.definition.description === undefined
                    ? {}
                    : { description: agent.definition.description }),
                scope: agent.scope,
                writable: agent.writable,
                ...(agent.definition.tools === undefined
                    ? {}
                    : { tools: agent.definition.tools }),
                ...(agent.definition.skills === undefined
                    ? {}
                    : { skills: agent.definition.skills }),
                ...(agent.definition.posture === undefined
                    ? {}
                    : { posture: agent.definition.posture }),
                ...(agent.definition.forbiddenAccess === undefined
                    ? {}
                    : { forbiddenAccess: agent.definition.forbiddenAccess }),
                ...(agent.definition.defaultPair === undefined
                    ? {}
                    : { defaultPair: agent.definition.defaultPair }),
            })),
            notices: catalog.notices,
        };
    }

    private async agentCatalogFor(
        entry: RegisteredAgentEntry,
    ): Promise<AgentCatalog> {
        return loadAgentCatalog({
            projectRoot: entry.store.header.cwd,
            permissionModes: [
                ...BUILT_IN_PERMISSION_MODE_NAMES,
                ...Object.keys(this.options.permissionModes ?? {}),
            ],
            interactive: true,
            ...(this.options.registeredAgents === undefined
                ? {}
                : { registered: this.options.registeredAgents }),
        });
    }

    /**
     * Put an agent on. Records the resolved definition, adopts its default
     * pair when nobody has dialled this session, and answers with what is now
     * in force.
     */
    async wearAgentFor(id: string, name: string): Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
        readonly permissionChanged?: boolean;
    } | undefined> {
        const result = await this.applyAgentWear(id, name);
        this.pushWorkerState(id);
        return result;
    }

    private async applyAgentWear(id: string, name: string): Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
        readonly permissionChanged?: boolean;
    } | undefined> {
        const entry = this.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return undefined;
        }
        const catalog = await this.agentCatalogFor(entry);
        const found = findCatalogAgent(catalog, name);
        if (found === undefined) return undefined;
        const snapshot = resolveAgentSnapshot(found.definition);
        await entry.store.appendAgentWear(snapshot.name, snapshot);
        entry.agentWear = snapshot;
        let permissionChanged = false;
        if (snapshot.forbiddenAccess?.includes(entry.approvalMode) === true) {
            const fallback = snapshot.posture !== undefined
                    && !snapshot.forbiddenAccess!.includes(snapshot.posture)
                ? snapshot.posture
                : [
                    ...BUILT_IN_PERMISSION_MODE_NAMES,
                    ...Object.keys(this.options.permissionModes ?? {}),
                ].find((mode) => !snapshot.forbiddenAccess!.includes(mode));
            if (fallback !== undefined && isApprovalMode(fallback)) {
                await entry.store.appendApprovalMode(fallback, "agent-default");
                entry.approvalMode = fallback;
                permissionChanged = true;
            }
        }
        const notice = await this.adoptAgentDefaultPair(entry, found.definition);
        return {
            name: snapshot.name,
            ...(snapshot.tools === undefined ? {} : { tools: snapshot.tools }),
            ...(snapshot.skills === undefined
                ? {}
                : { skills: snapshot.skills }),
            ...(snapshot.posture === undefined
                ? {}
                : { posture: snapshot.posture }),
            ...(snapshot.forbiddenAccess === undefined
                ? {}
                : { forbiddenAccess: snapshot.forbiddenAccess }),
            ...(permissionChanged ? { permissionChanged: true } : {}),
            ...(notice === undefined ? {} : { notice }),
        };
    }

    /**
     * Rows 7 to 9 of the origin table, in one place.
     *
     * A session the user has dialled keeps its pair: the override survives an
     * agent switch, which is the difference between a dial and a default.
     */
    private async adoptAgentDefaultPair(
        entry: RegisteredAgentEntry,
        definition: AgentDefinition,
    ): Promise<string | undefined> {
        const origin = entry.store.modelSettingsOrigin();
        if (origin === "user") return undefined;
        const unresolvable = definition.defaultPair !== undefined
            && this.wornAgentDefaultPair(entry) === undefined;
        const target = this.effectiveDefaultPair(entry);
        if (
            entry.store.header.delegation !== undefined
            && !delegationAllows(entry.store.header.delegation, target)
        ) {
            return `${definition.name}'s default model is outside this delegated session's persisted boundary.`;
        }
        if (!samePair(target, entry.modelSettings)) {
            await entry.store.appendModelSettings(target, "agent-default");
            entry.modelSettings = target;
            entry.requestedReasoningEffort = undefined;
        }
        return unresolvable
            ? `${definition.name} names the pair ${definition.defaultPair!.name}, which is not in your pool. The session kept the host default.`
            : undefined;
    }

    /**
     * Table 8.2: what a resumed session does about the agent it was wearing.
     *
     * Agents are by reference, so a definition that moved is worn as it is
     * now. The notice is what stops that from being a silent change of what
     * the session can reach.
     */
    private async reconcileResumedAgentWear(
        entry: RegisteredAgentEntry,
        events: EngineEventBus,
    ): Promise<void> {
        const recorded = entry.agentWear;
        if (recorded === undefined) return;
        try {
            const catalog = await this.agentCatalogFor(entry);
            const found = findCatalogAgent(catalog, recorded.name);
            if (found === undefined) {
                entry.agentWear = undefined;
                events.emit({
                    type: "agent_worn",
                    update: {
                        requestId: RESUME_WEAR_REQUEST_ID,
                        name: DEFAULT_AGENT.name,
                        notice:
                            `The agent ${recorded.name} is gone, so this session switched to default.`,
                    },
                });
                return;
            }
            const current = resolveAgentSnapshot(found.definition);
            entry.agentWear = current;
            const drift = agentSnapshotDrift(recorded, current);
            if (drift.length > 0) {
                events.emit({
                    type: "agent_worn",
                    update: {
                        requestId: RESUME_WEAR_REQUEST_ID,
                        name: current.name,
                        ...(current.tools === undefined
                            ? {}
                            : { tools: current.tools }),
                        ...(current.skills === undefined
                            ? {}
                            : { skills: current.skills }),
                        ...(current.posture === undefined
                            ? {}
                            : { posture: current.posture }),
                        notice: `${recorded.name} changed since it was selected: ${
                            drift.join(", ")
                        }.`,
                    },
                });
            }
        } catch {
            // A catalog that will not load leaves the recorded snapshot in
            // force, which is the scope the session already had.
        }
    }

    /** The narrow writer: one key, one file, temp-and-rename. */
    async updateAgentDefaultPairFor(
        id: string,
        name: string,
        pair: { readonly name: string; readonly effort?: string } | null,
    ): Promise<string | undefined> {
        const entry = this.agents.get(id);
        if (entry === undefined) return "No such session";
        const catalog = await this.agentCatalogFor(entry);
        const found = findCatalogAgent(catalog, name);
        if (found === undefined) return `No agent named ${name}`;
        if (!found.writable || found.path === undefined) {
            return `${name} is registered by an extension, so its file cannot be written`;
        }
        try {
            await writeAgentDefaultPair(found.path, pair);
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
        // The pair now IS the default, so the session record is reclassified
        // in the same operation rather than left showing an override.
        if (entry.agentWear?.name === name) {
            entry.agentWear = {
                ...entry.agentWear,
                ...(pair === null ? {} : { defaultPair: pair }),
            };
            if (pair === null) {
                const { defaultPair: _cleared, ...rest } = entry.agentWear;
                entry.agentWear = rest;
            }
            await entry.store.appendModelSettings(
                entry.modelSettings,
                this.originFor(entry, entry.modelSettings),
            );
        }
        return undefined;
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
                this.modelsForClient(),
                this.options.readPool?.(agentEntry.store.header.cwd),
                this.options.subagentModel,
                agentEntry.requestedReasoningEffort,
                this.reviewerDefault(),
                this.options.contextLimit?.(),
                this.options.developerSettings?.(),
                agentEntry.store.header.cwd,
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

    /**
     * The `agent_roster` tool's effect: the host's live session table, cut to
     * the caller's workspace and to the sessions still running in it.
     *
     * Every field is observed. The name was minted when the session
     * registered, the activity time is the last thing written to that
     * session's log, and the path is where the log lives. Nothing here is
     * declared by an agent and nothing is stored, so a host that is gone and
     * an empty roster mean the same thing.
     */
    private applyAgentRosterEffect(
        callerId: string,
        details: boolean,
    ): Promise<ToolOutput> {
        const caller = this.agents.get(callerId);
        if (caller === undefined) {
            return Promise.resolve({
                kind: "output",
                output: "This session is no longer registered with the host.",
                isError: true,
            });
        }
        // Keyed rather than path-compared, so a session started under a
        // symlinked or differently-spelled path lands in the same workspace.
        const here = workspaceKey(caller.agent.workspace);
        const rows = [...this.agents.entries()]
            .filter(([id, entry]) =>
                id !== callerId
                && workspaceKey(entry.agent.workspace) === here
                && entryStatus(entry) !== "closed"
                && entryStatus(entry) !== "failed"
                && entryStatus(entry) !== "completed"
                && (details || entryIsLive(entry))
            )
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, entry]) => {
                const unread = entry.inbox?.consumer.unreadStatus({
                    limit: 99,
                    addresses: [id],
                    excludeKinds: [SOURCE_GAP_KIND],
                }) ?? { count: 0, oldestAgeMs: null };
                const compact = {
                    participant_id: id,
                    name: entry.arcName,
                    status: entryStatus(entry),
                    live: entryIsLive(entry),
                };
                if (!details) return compact;
                return {
                    ...compact,
                    workspace: entry.agent.workspace,
                    workspace_key: workspaceKey(entry.agent.workspace),
                    ...gitRosterFacts(entry.agent.workspace),
                    kind: entry.kind,
                    last_activity: entryUpdatedAt(entry),
                    notice: entry.inbox !== undefined && entry.agent.attached
                        ? "ui"
                        : "none",
                    unread_count: unread.count,
                    oldest_unread_age_ms: unread.oldestAgeMs,
                    session_path: entry.store.path,
                };
            });
        return Promise.resolve({
            kind: "output",
            output: JSON.stringify({
                self_participant_id: callerId,
                participants: rows,
            }),
            isError: false,
        });
    }

    private async applyAgentSendEffect(
        callerId: string,
        effect: AgentSendEffect,
    ): Promise<ToolOutput> {
        const caller = this.agents.get(callerId);
        const recipient = this.agents.get(effect.to);
        const inbox = this.options.inboxDelivery;
        if (caller === undefined || caller.inbox === undefined || inbox === undefined) {
            return toolError("Native inbox participation is unavailable in this session.");
        }
        if (effect.to === callerId) {
            return toolError("agent_send cannot send a message to its own session.");
        }
        if (
            recipient === undefined
            || recipient.kind !== "interactive"
            || recipient.inbox === undefined
            || recipient.agent.closed
            || recipient.agent.failed
        ) {
            return toolError(`No native Vera participant ${effect.to}.`);
        }
        if (!sameWorkspace(caller, recipient)) {
            return toolError("agent_send recipients must be in the same workspace.");
        }
        let replyTo: number | undefined;
        if (effect.replyTo !== undefined) {
            const replied = inbox.entry(effect.replyTo);
            const message = replied === undefined ? undefined : parsePeerMessage(replied);
            const readThrough = caller.inbox.consumer.offset();
            if (!(
                message === undefined
                || message.from !== effect.to
                || message.to !== callerId
                || readThrough < effect.replyTo
            )) {
                replyTo = effect.replyTo;
            }
        }
        const payload: PeerMessagePayload = {
            version: 1,
            from: callerId,
            to: effect.to,
            text: effect.text,
            ...(replyTo === undefined ? {} : { reply_to: replyTo }),
        };
        const recipientLive = entryIsLive(recipient);
        const notice = recipient.agent.attached ? "ui" as const : "none" as const;
        const stored = await inbox.append({
            source: VERA_INBOX_SOURCE,
            kind: PEER_MESSAGE_KIND,
            actor: callerId,
            session: callerId,
            address: effect.to,
            payload: JSON.stringify(payload),
        });
        const delivery = inbox.hasAdmissionPath()
            ? recipient.agent.attached
                && recipient.inbox.isAdmittedSource("peer")
                ? { delivered: true as const }
                : {
                    delivered: false as const,
                    reason: "admission" as const,
                }
            : await this.wakeForPeerMessage(caller, recipient, stored.seq);
        return {
            kind: "output",
            output: JSON.stringify({
                message_id: stored.seq,
                stored: true,
                recipient_live: recipientLive,
                notice,
                delivered: delivery.delivered,
                ...(delivery.delivered
                    ? {}
                    : { not_delivered_because: delivery.reason }),
                ...(effect.replyTo === undefined
                    ? {}
                    : { reply_to_applied: replyTo !== undefined }),
            }),
            isError: false,
        };
    }

    /**
     * Wakes the recipient for a peer message it just received, when the host
     * is willing to. Three things can hold it back, and the sender is told
     * which: a session that does not run tools on its own does not get its
     * turn taken by another agent either, a chain of messages may only run so
     * deep, and no session may be woken faster than a person could follow.
     *
     * What arrives is a notice, never the message. The text stays in the inbox
     * until the recipient reads it there, so the read receipt keeps meaning
     * what it says.
     */
    private async wakeForPeerMessage(
        caller: RegisteredAgentEntry,
        recipient: RegisteredAgentEntry,
        seq: number,
    ): Promise<{
        readonly delivered: boolean;
        readonly reason?:
            | "approval_mode"
            | "hop_limit"
            | "rate_limit"
            | "unavailable"
            | "admission";
    }> {
        if (
            recipient.approvalMode !== "auto"
            && recipient.approvalMode !== "full_access"
        ) {
            return { delivered: false, reason: "approval_mode" };
        }
        const hop = caller.peerHop + 1;
        if (hop > MAX_PEER_HOP) {
            return { delivered: false, reason: "hop_limit" };
        }
        const now = Date.now();
        const wakes = recipient.peerWakes.filter(
            (at) => now - at < PEER_WAKE_WINDOW_MS,
        );
        if (wakes.length >= MAX_PEER_WAKES_PER_WINDOW) {
            recipient.peerWakes = wakes;
            return { delivered: false, reason: "rate_limit" };
        }
        try {
            await recordDeliveryAndNotify(recipient.store, recipient.events, {
                id: `peer:${caller.store.header.id}:${seq}`,
                sourceAgentId: caller.store.header.id,
                content: `Peer ${caller.store.header.id} sent message ${seq}. `
                    + "Read it with agent_inbox.",
                kind: "peer",
            });
            recipient.agent.triggerDeliveryTurn();
        } catch {
            return { delivered: false, reason: "unavailable" };
        }
        recipient.peerWakes = [...wakes, now];
        recipient.peerHop = hop;
        return { delivered: true };
    }

    private async applyAgentInboxEffect(
        callerId: string,
        effect: AgentInboxEffect,
    ): Promise<AppliedToolEffectOutput> {
        const caller = this.agents.get(callerId);
        const coordinator = this.options.inboxDelivery;
        if (caller === undefined || caller.inbox === undefined || coordinator === undefined) {
            return toolError("Native inbox participation is unavailable in this session.");
        }
        const entry = caller.inbox.consumer.read({
            limit: 1,
            addresses: [callerId],
        })[0];
        if (entry === undefined) {
            return {
                kind: "output",
                output: JSON.stringify({ unread: false }),
                isError: false,
            };
        }
        if (effect.messageId !== undefined && effect.messageId !== entry.seq) {
            return toolError(
                `Message ${effect.messageId} is not next; read message ${entry.seq} first.`,
            );
        }
        const message = parsePeerMessage(entry);
        if (message === undefined) {
            const read = parsePeerRead(entry);
            const output = read === undefined
                ? genericInboxResult(entry)
                : {
                    message_id: entry.seq,
                    kind: PEER_READ_KIND,
                    from: entry.actor,
                    to: entry.address,
                    read_message_id: read.message_id,
                    complete: true,
                };
            return {
                kind: "output",
                output: JSON.stringify(output),
                isError: false,
                afterCommit: acknowledgeAfterCommit(entry.seq),
            };
        }

        const envelope = {
            message_id: entry.seq,
            kind: PEER_MESSAGE_KIND,
            from: message.from,
            to: message.to,
            text: message.text,
            ...(message.reply_to === undefined
                ? {}
                : { reply_to: message.reply_to }),
        };
        return {
            kind: "output",
            output: JSON.stringify({ ...envelope, complete: true }),
            isError: false,
            afterCommit: acknowledgeAfterCommit(
                entry.seq,
                message.from,
            ),
        };
    }

    /**
     * Refetches a provider's list on the user's say-so and answers with the
     * settings the refreshed list produces, so the pane that asked can redraw
     * from one reply. A provider that cannot be asked leaves the list alone:
     * a stale list beats an empty one, which is the same rule discovery
     * itself follows on a failed fetch.
     */
    async refreshCatalog(
        id: string,
        provider: string,
    ): Promise<ModelTurnSettings | undefined> {
        const agentEntry = this.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || this.options.refreshCatalog === undefined
        ) {
            return undefined;
        }
        const refreshed = await this.options.refreshCatalog(provider);
        if (refreshed === undefined) {
            return undefined;
        }
        this.availableModels = refreshed;
        return settingsForClient(
            agentEntry.modelSettings,
            agentEntry.modelSettings.provider ?? this.defaultProvider,
            this.catalog,
            this.availableModels,
            this.options.readPool?.(agentEntry.store.header.cwd),
            this.options.subagentModel,
            agentEntry.requestedReasoningEffort,
            this.reviewerDefault(),
            this.options.contextLimit?.(),
                this.options.developerSettings?.(),
            agentEntry.store.header.cwd,
        );
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
            this.modelsForClient(),
            this.options.readPool?.(agentEntry.store.header.cwd),
            this.options.subagentModel,
            agentEntry.requestedReasoningEffort,
            this.reviewerDefault(),
            this.options.contextLimit?.(),
                this.options.developerSettings?.(),
            agentEntry.store.header.cwd,
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
            this.modelsForClient(),
            this.options.readPool?.(agentEntry.store.header.cwd),
            this.options.subagentModel,
            agentEntry.requestedReasoningEffort,
            this.reviewerDefault(),
            this.options.contextLimit?.(),
                this.options.developerSettings?.(),
            agentEntry.store.header.cwd,
        );
    }

    async poolMove(
        id: string,
        entry: { readonly provider: string; readonly model: string },
        delta: number,
    ): Promise<ModelTurnSettings | undefined> {
        const agentEntry = this.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || this.options.movePoolEntry === undefined
        ) {
            return undefined;
        }
        const moved = this.options.movePoolEntry({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        }, delta, agentEntry.store.header.cwd);
        if (!moved) {
            return undefined;
        }
        return settingsForClient(
            agentEntry.modelSettings,
            agentEntry.modelSettings.provider ?? this.defaultProvider,
            this.catalog,
            this.modelsForClient(),
            this.options.readPool?.(agentEntry.store.header.cwd),
            this.options.subagentModel,
            agentEntry.requestedReasoningEffort,
            this.reviewerDefault(),
            this.options.contextLimit?.(),
                this.options.developerSettings?.(),
            agentEntry.store.header.cwd,
        );
    }

    async updateApprovalMode(
        id: string,
        mode: ApprovalMode,
    ): Promise<ApprovalMode | undefined> {
        const result = await this.applyApprovalMode(id, mode);
        this.pushWorkerState(id);
        return result;
    }

    private async applyApprovalMode(
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
        await this.leaveAgentThatForbidsAccess(entry, id, mode);
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
            .filter((entry) => !entry.ephemeral && !entry.pendingPublication)
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
                    ...(entry.worker === undefined
                        ? {}
                        : {
                            worker_pid: entry.worker.pid,
                            ...(entry.worker.supervisor?.pid === null
                                    || entry.worker.supervisor?.pid === undefined
                                ? {}
                                : { supervisor_pid: entry.worker.supervisor.pid }),
                        }),
                    ...(title === undefined || title.length === 0
                        ? {}
                        : { title: title.slice(0, 80) }),
                    has_user_content: firstUserEntry !== undefined,
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

    /**
     * The live facts the work index is built from, one entry per listed agent.
     *
     * A separate reading rather than more fields on the listing: these are the
     * facts of a running process (what it is blocked on, what tool is in
     * flight) and they are meaningless for the sessions that are merely on
     * disk, which is most of what a listing returns.
     */
    workFacts(): readonly WorkAgentFacts[] {
        const unreadResults = new Set<string>();
        for (const entry of this.agents.values()) {
            for (const delivery of entry.store.pendingDeliveries()) {
                if (delivery.kind !== "attention") {
                    unreadResults.add(delivery.sourceAgentId);
                }
            }
        }
        return this.list().flatMap((summary) => {
            const entry = this.agents.get(summary.id);
            if (entry === undefined) return [];
            const failure = entry.store.agentFailure()?.detail;
            const activeTool = entry.agent.activeTool;
            // Only for a session that has stopped: a session still working is
            // still changing things, and counting its files mid-flight would
            // put a number on screen that is wrong the moment it is drawn.
            const changed = summary.status === "working"
                    || summary.status === "waiting"
                ? 0
                : sessionChangedFiles(summary.id).length;
            return [{
                id: summary.id,
                session_path: summary.session_path,
                title: summary.title ?? summary.name ?? summary.id,
                workspace: summary.workspace,
                kind: summary.kind,
                status: summary.status,
                live: summary.live,
                updated_at: summary.updated_at
                    ?? entry.store.header.timestamp,
                ...(summary.parent_id === undefined
                    ? {}
                    : { parent_id: summary.parent_id }),
                ...(entry.agent.pendingRequests[0] === undefined
                    ? {}
                    : { pending_request: entry.agent.pendingRequests[0] }),
                ...(activeTool === undefined ? {} : { active_tool: activeTool }),
                ...(unreadResults.has(summary.id) ? { unread_result: true } : {}),
                ...(changed === 0 ? {} : { changed_files: changed }),
                ...(failure === undefined ? {} : { failure }),
            }];
        });
    }

    /**
     * Turn emitted schedule runs into work rows, dropping the ones with no
     * session behind them.
     *
     * A schedule addresses a consumer label, and a session's label is its
     * agent id, so a run that named a session this host holds resolves here.
     * One that named anything else is left out: a row whose enter key opens
     * nothing is worse than no row.
     */
    scheduleWorkFacts(
        runs: readonly EmittedScheduleRun[],
        agents: readonly WorkAgentFacts[],
    ): readonly WorkScheduleFacts[] {
        // Resolved against the facts the caller already read rather than a
        // second listing: a listing stats every session on disk, and two of
        // them per index build could also disagree with each other.
        const listed = new Map(agents.map((agent) => [agent.id, agent]));
        return runs.flatMap((run) => {
            const agent = listed.get(run.address);
            return agent === undefined ? [] : [{
                schedule_id: run.scheduleId,
                session_id: agent.id,
                session_path: agent.session_path,
                title: agent.title,
                workspace: agent.workspace,
                completed_at: run.emittedAt,
            }];
        });
    }

    idleForShutdown(): boolean {
        return this.startingIds.size === 0
            && this.deliveryTasks.size === 0
            && !this.processRegistry.hasLiveProcesses()
            && [...this.agents.values()].every(
                (entry) => entry.agent.idleForShutdown(),
            );
    }

    idleForReplacement(): boolean {
        return this.startingIds.size === 0
            && this.deliveryTasks.size === 0
            && !this.processRegistry.hasLiveProcesses()
            && [...this.agents.values()].every(
                (entry) => entry.agent.idleForReplacement(),
            );
    }

    async close(): Promise<void> {
        this.isClosed = true;
        const entries = [...this.agents.values()];
        for (const entry of entries) {
            entry.inbox?.release();
            entry.agent.close();
        }
        await Promise.all([
            this.processRegistry.close(),
            ...entries.map((entry) => entry.run),
        ]);
        await Promise.all([...this.deliveryTasks]);
        await Promise.all(entries
            .filter((entry) => entry.ephemeral)
            .map((entry) => rm(dirname(entry.store.path), {
                recursive: true,
                force: true,
            })));
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
        ephemeral = false,
        pendingPublication = false,
    ): ResidentAgent {
        const startupProfile = store.header.startupProfile ?? "default";
        const extensionTools = startupProfile === "default"
            ? this.options.extensionTools
            : [];
        // Named so the getters below can reach the registry's own options:
        // inside an object literal `this` is the literal, not the registry.
        const registry = this;
        const disabledPromptContributions = () =>
            disabledContributionsForProfile(
                startupProfile,
                registry.options.disabledPromptContributions,
            );
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
                this.options.prepareModelRequest?.({
                    sessionId: store.header.id,
                    workspace: store.header.cwd,
                }),
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
            onClientPrompt: () => {
                const woken = this.agents.get(store.header.id);
                if (woken !== undefined) {
                    woken.peerHop = 0;
                }
            },
            ...(clientPromptRefusal === undefined
                ? {}
                : { clientPromptRefusal }),
        });
        const events = new EngineEventBus();
        const instructionRoot = resolveInstructionRoot(store.header.cwd);
        const storedSettings = store.modelSettings();
        const entry: RegisteredAgentEntry = {
            agent,
            store,
            kind,
            ephemeral,
            pendingPublication,
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
            // Resume wears the recorded agent immediately, so the first turn
            // after a restart runs under the same scope the last one did. The
            // comparison against the current definition happens below, once
            // the catalog can be read.
            ...(store.agentWear() === undefined
                ? {}
                : { agentWear: store.agentWear()!.snapshot }),
            run: Promise.resolve(),
            completed: false,
            peerHop: 0,
            peerWakes: [],
            pendingAsyncTurns: 0,
            pendingCompletionDeliveries: 0,
            completionSequence: 0,
            ...(store.header.origin === undefined
                ? {}
                : { syncedSourceEntryId: store.header.origin.entryId }),
            ...(storedFailure === undefined
                ? {}
                : { failure: new Error(storedFailure.detail) }),
        };
        this.agents.set(agent.id, entry);
        this.notifyRosterChanged();
        void this.reconcileResumedAgentWear(entry, events);
        if (storedFailure !== undefined) {
            agent.restoreFailure({
                type: "history",
                entries: projectTranscript(
                    store.messages(),
                    sessionAttachmentName(store),
                    store.activeMessageIds(),
                    store.projectedHarnessMessages(),
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
            loadAgent: async (name) => {
                const catalog = await loadAgentCatalog({
                    projectRoot: store.header.cwd,
                    permissionModes: [
                        ...BUILT_IN_PERMISSION_MODE_NAMES,
                        ...Object.keys(this.options.permissionModes ?? {}),
                    ],
                    // A spawn has no surface for a nudge, and the parser is
                    // what says so.
                    interactive: false,
                    ...(this.options.registeredAgents === undefined
                        ? {}
                        : { registered: this.options.registeredAgents }),
                });
                return findCatalogAgent(catalog, name)?.definition;
            },
            workspace: store.header.cwd,
            instructionRoot,
            scratchDir: sessionScratchDir(store.header.id),
            processRegistry: this.processRegistry,
            get disabledPromptContributions() {
                return disabledPromptContributions();
            },
            extensionTools,
            ...(startupProfile !== "default"
                || this.options.loadContextualContributions === undefined
                ? {}
                : {
                    loadContextualContributions:
                        this.options.loadContextualContributions,
                }),
            offerTools: startupProfile !== "prompt_only",
            loadOptionalContext: startupProfile === "default",
            ...(store.header.startupProfile === undefined
                ? {}
                : {
                    sessionMetadata: {
                        startupProfile: store.header.startupProfile,
                    },
                }),
            ...(this.options.readPool === undefined
                ? {}
                : {
                    readPool: () =>
                        this.options.readPool?.(store.header.cwd) ?? [],
                }),
            ...(this.options.subagentModel === undefined
                ? {}
                : { subagentModel: this.options.subagentModel }),
            readPolicy: () => delegatedSubagentPolicy(
                this.options.readPolicy === undefined
                    ? { allowSelf: true }
                    : this.options.readPolicy(store.header.cwd),
                store.header.delegation,
            ),
            requestMissingConfiguration: (request, context, signal) =>
                this.requestMissingSubagentConfiguration(
                    entry,
                    request,
                    context,
                    signal,
                ),
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
            ...(this.options.reviewer === undefined
                ? {}
                : { reviewer: this.options.reviewer }),
            readReviewer: () => this.readReviewer(),
            ...(this.options.reviewers === undefined
                ? {}
                : { reviewers: this.options.reviewers }),
            ...(this.options.reviewLog === undefined
                ? {}
                : { reviewLog: this.options.reviewLog }),
            ...(this.options.permissionModes === undefined
                ? {}
                : { permissionModes: this.options.permissionModes }),
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
            this.options.compactionModels,
            this.options.compactionOverrides,
        );
        const applyToolEffect: ApplyToolEffect = (effect, signal, context) => {
            if (effect.type === "spawn_async_subagent") {
                return this.spawnAsyncSubagent(
                    store,
                    effect,
                    context,
                    signal,
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
            if (effect.type === "agent_roster") {
                return this.applyAgentRosterEffect(agent.id, effect.details);
            }
            if (effect.type === "agent_send") {
                return this.applyAgentSendEffect(agent.id, effect);
            }
            if (effect.type === "agent_inbox") {
                return this.applyAgentInboxEffect(agent.id, effect);
            }
            return applySubagentEffect(effect, signal, context);
        };
        const applyCommittedToolEffect: ApplyCommittedToolEffect = async (
            effect,
        ) => {
            if (effect.key !== "inbox.acknowledge") {
                throw new Error(`Unknown committed tool effect: ${effect.key}`);
            }
            const seq = effect.data.seq;
            const receiptTo = effect.data.receipt_to;
            if (!Number.isSafeInteger(seq) || (seq as number) <= 0) {
                throw new Error("Invalid inbox acknowledgement sequence");
            }
            if (receiptTo !== undefined && (
                typeof receiptTo !== "string" || receiptTo.length === 0
            )) {
                throw new Error("Invalid inbox read-receipt recipient");
            }
            if (entry.inbox === undefined) {
                throw new Error("inbox consumer closed before acknowledgement");
            }
            const acknowledged = entry.inbox.consumer.acknowledge(
                seq as number,
                receiptTo === undefined
                    ? undefined
                    : peerReadReceipt(agent.id, receiptTo as string, seq as number),
            );
            if (acknowledged.receipt !== undefined) {
                await this.options.inboxDelivery?.pumpAll();
            }
        };
        const loopData: RunHeadlessLoopData = {
                eventLogPath,
                approvalMode: entry.approvalMode,
                // Every shell this session spawns carries its identity name,
                // so arc stamps the session's posts with it and self-echo
                // suppression matches with no manual export.
                toolEnv: { ARC_SESSION: entry.arcName },
                instructionRoot,
                enabledToolEffects: kind === "interactive"
                    ? [
                        "spawn_subagent",
                        "spawn_async_subagent",
                        "message_subagent",
                        "pool_add",
                        "agent_roster",
                        ...(this.options.inboxDelivery === undefined
                            ? []
                            : ["agent_send" as const, "agent_inbox" as const]),
                    ]
                    : ["notify_parent", "agent_roster"],
                enableUserInteraction: kind === "interactive",
                offerTools: startupProfile !== "prompt_only",
                loadOptionalContext: startupProfile === "default",
        };
        const loopServices: RunHeadlessLoopServices = {
                sessionStore: store,
                ...(this.options.modelFailureLedger === undefined
                    ? {}
                    : { modelFailureLedger: this.options.modelFailureLedger }),
                eventBus: events,
                processRegistry: this.processRegistry,
                ...(this.options.createEffortPool === undefined
                    ? {}
                    : {
                        effortPool: this.options.createEffortPool(
                            store.header.cwd,
                        ),
                    }),
                readReviewer: () => this.readReviewer(),
                ...(this.options.reviewLog === undefined
                    ? {}
                    : { reviewLog: this.options.reviewLog }),
                ...(compaction === undefined ? {} : { compaction }),
                applyToolEffect,
                requestMissingSubagentConfiguration:
                    (request, context, signal) =>
                        this.requestMissingSubagentConfiguration(
                            entry,
                            request,
                            context,
                            signal,
                        ),
                applyCommittedToolEffect,
                extensionTools,
                ...(startupProfile !== "default"
                    || this.options.loadContextualContributions === undefined
                    ? {}
                    : {
                        loadContextualContributions:
                            this.options.loadContextualContributions,
                    }),
                // Read at each use, not copied for the session: a setting the
                // user changes has to reach a session already running.
                readPolicy: () => ({
                    ...(store.header.delegation !== undefined
                            || registry.options.modelFallback === undefined
                        ? {}
                        : {
                        modelFallback: registry.options.modelFallback,
                    }),
                    ...(registry.options.permissionModes === undefined ? {} : {
                        permissionModes: registry.options.permissionModes,
                    }),
                    ...(registry.options.reviewer === undefined ? {} : {
                        reviewer: registry.options.reviewer,
                    }),
                    ...(registry.options.reviewers === undefined ? {} : {
                        reviewers: registry.options.reviewers,
                    }),
                    disabledPromptContributions: disabledPromptContributions(),
                    subagentPolicy: delegatedSubagentPolicy(
                        this.options.readPolicy === undefined
                            ? { allowSelf: true }
                            : this.options.readPolicy(store.header.cwd),
                        store.header.delegation,
                    ),
                }),
                readModelSettings: () => settingsForClient(
                    entry.modelSettings,
                    entry.modelSettings.provider ?? this.defaultProvider,
                    this.catalog,
                    this.modelsForClient(),
                    this.options.readPool?.(store.header.cwd),
                    this.options.subagentModel,
                    entry.requestedReasoningEffort,
                    this.reviewerDefault(),
                    this.options.contextLimit?.(),
                    this.options.developerSettings?.(),
                    store.header.cwd,
                ),
                readAgentWear: () => entry.agentWear,
                readApprovalMode: () => entry.approvalMode,
                updateApprovalMode: (mode) =>
                    this.updateApprovalMode(agent.id, mode),
                ...(this.options.permissionPreferences === undefined ? {} : {
                    readPermissionPreferences: () =>
                        this.options.permissionPreferences!.list(),
                }),
                ...(startupProfile !== "default"
                        || this.options.createToolHooks === undefined
                    ? {}
                    : { hooks: this.options.createToolHooks() }),
                router: {
                    onInboundReady: (inbound) => {
                        entry.inbound = inbound;
                    },
                    hasPendingDeliveryTurn: () =>
                        entry.inbox?.hasAdmittedPending() === true,
                    onDeliveryTurnDiscarded: () =>
                        agent.deliveryTurnDiscarded(),
                    updateModelSettings: (patch) =>
                        this.updateModelSettings(agent.id, patch),
                    updateSessionModelSettings: (patch) =>
                        this.updateSessionModelSettings(agent.id, patch),
                    readSessionModelSettingsHistory: () =>
                        this.sessionModelSettingsHistory(agent.id),
                    updateSessionPermissionMode: (mode) =>
                        this.updateSessionPermissionMode(agent.id, mode),
                    wearAgent: (name) => this.wearAgentFor(agent.id, name),
                    listAgents: () => this.listAgentsFor(agent.id),
                    updateAgentDefaultPair: (name, pair) =>
                        this.updateAgentDefaultPairFor(agent.id, name, pair),
                    poolAdd: (poolEntry, onStep, poolOptions) =>
                        this.poolAdd(agent.id, poolEntry, onStep, poolOptions),
                    poolRemove: (poolEntry) =>
                        this.poolRemove(agent.id, poolEntry),
                    refreshCatalog: (provider) =>
                        this.refreshCatalog(agent.id, provider),
                    poolName: (poolEntry, name) =>
                        this.poolName(agent.id, poolEntry, name),
                    poolMove: (poolEntry, delta) =>
                        this.poolMove(agent.id, poolEntry, delta),
                    ...(adapter === undefined ? {} : {
                        consult: (request, signal) => {
                            // One candidate, so the route cannot fall back:
                            // the caller named a model and gets that model or
                            // an error.
                            const complete = createRoutedCompletionService(
                                adapter,
                                {
                                    models: [{
                                        model: request.model,
                                        ...(request.provider === undefined
                                            ? {}
                                            : { provider: request.provider }),
                                        ...(request.reasoningEffort
                                                === undefined
                                            ? {}
                                            : isModelReasoningEffort(
                                                    request.reasoningEffort,
                                                )
                                            ? {
                                                reasoningEffort:
                                                    request.reasoningEffort,
                                            }
                                            : {}),
                                    }],
                                },
                            );
                            return complete({
                                systemPrompt: request.systemPrompt ?? "",
                                messages: request.messages.map((message) =>
                                    consultModelMessage(message)
                                ),
                                ...(request.maxTokens === undefined
                                    ? {}
                                    : { maxTokens: request.maxTokens }),
                            }, signal);
                        },
                    }),
                    sendConsultReply: (ownerId, reply) =>
                        agent.sendConsultReply(ownerId, reply),
                    readApprovalModeOrigin: () =>
                        entry.store.approvalModeOrigin(),
                    ...(this.options.permissionPreferences === undefined
                        ? {}
                        : {
                            addPermissionPreference: async (when) => {
                                const added = await this.options
                                    .permissionPreferences!.add(when);
                                // Preferences are the host's, not the
                                // session's, so every worker needs the new
                                // list, not just this one.
                                this.pushWorkerStateEverywhere();
                                return added;
                            },
                            removePermissionPreference: async (id) => {
                                const removed = await this.options
                                    .permissionPreferences!.remove(id);
                                this.pushWorkerStateEverywhere();
                                return removed;
                            },
                        }),
                    updateSessionName: (name) =>
                        this.updateSessionName(agent.id, name),
                    sendTimelineReply: (ownerId, reply) =>
                        agent.sendTimelineReply(ownerId, reply),
                    sendSessionNameReply: (ownerId, reply) =>
                        agent.sendSessionNameReply(ownerId, reply),
                },
        };
        entry.loopServices = loopServices;
        const adapterSpec = this.workerAdapterSpecFor(store, entry);
        entry.run = (adapterSpec === undefined
            ? runHeadlessLoop(
                agent.engine,
                adapter,
                this.defaultModel,
                this.defaultReasoningEffort,
                loopData,
                loopServices,
            )
            : this.runInWorker({
                agent,
                store,
                entry,
                adapter: adapterSpec,
                data: loopData,
                services: loopServices,
                extensionTools,
            })
        ).catch(async (error: unknown) => {
            entry.inbox?.release();
            if (!agent.closed) {
                entry.failure = error;
                const failureId = randomUUID();
                // A refused start is a decision with a next action, so it
                // reaches the client as itself rather than as the generic
                // outcome used when a running agent stops.
                const detail = error instanceof WorkerCapReachedError
                    ? error.message
                    : "Resident agent stopped unexpectedly";
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
            const inboxDelivery = this.options.inboxDelivery;
            const admissionPath = inboxDelivery.hasAdmissionPath();
            const inbox = inboxDelivery.attach({
                label: agent.id,
                actor: this.options.inboxActorForSession?.(agent.id) ?? null,
                projectRoot: agent.workspace,
                // The minted name, not the agent id: arc stamps posts with
                // the ARC_SESSION the shell carries, which is this name, so
                // the self-echo pair must hold the same value.
                session: entry.arcName,
                notify: (notice) => {
                    if (!agent.closed && !agent.failed) {
                        events.emit({
                            type: "notice",
                            key: "inbox",
                            count: notice.unreadCount,
                        });
                    }
                },
                canStartTurn: () => agent.attached,
                startTurn: () => agent.triggerDeliveryTurn(),
                ...(admissionPath ? {
                    requestAdmission: (candidate: InboxAdmissionCandidate, signal: AbortSignal) =>
                        this.requestInboxAdmission(entry, candidate, signal),
                    onAdmissionFailure: (candidate: InboxAdmissionCandidate) => {
                        if (!agent.closed && !agent.failed && agent.attached) {
                            events.emit({
                                type: "task_notification",
                                deliveryId: `inbox-admission:${candidate.seq}`,
                                sourceAgentId: agent.id,
                                content:
                                    `Could not save admission for ${candidate.sourceFamily}; `
                                    + "the inbox entry is still held.",
                                kind: "attention",
                            });
                        }
                    },
                } : {}),
            });
            entry.inbox = inbox;
            agent.onAttachmentChanged((attached) => {
                inbox.clientAttachmentChanged(attached);
                if (attached) {
                    this.trackDelivery(inbox.pump());
                }
            });
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

    /**
     * How this session's worker would build its adapter, or nothing.
     *
     * A spec is the default. Nothing means the turn runs in this process,
     * which happens when the owner cannot rebuild the adapter from JSON or
     * when the environment has asked for the in-process loop.
     */
    private workerAdapterSpecFor(
        store: SessionStore,
        entry: RegisteredAgentEntry,
    ): WorkerAdapterSpec | undefined {
        if (this.options.workerAdapterSpec === undefined) {
            return undefined;
        }
        if ((process.env[WORKER_ENV] ?? "") === "0") {
            return undefined;
        }
        return this.options.workerAdapterSpec({
            provider: entry.modelSettings.provider ?? this.defaultProvider,
            projectRoot: store.header.cwd,
            sessionId: store.header.id,
        });
    }

    /**
     * Runs the turn loop in a separate process, and reports how it stopped.
     *
     * The client channel is pumped in both directions here rather than by the
     * loop, and every durable service stays on this side. A `kill -9` on the
     * worker therefore lands on `handle.outcome` as one typed value, and the
     * session file it was writing through is already complete on disk.
     */
    /**
     * The extensions a worker should load for itself, or nothing.
     *
     * Nothing is the default: the tools stay in this process and the worker
     * reaches them over the boundary.
     */
    private workerExtensions(): readonly VeraExtensionConfig[] | undefined {
        if ((process.env[WORKER_EXTENSIONS_ENV] ?? "") !== "1") {
            return undefined;
        }
        const configured = this.options.workerExtensions?.();
        return configured === undefined || configured.length === 0
            ? undefined
            : configured;
    }

    /**
     * Sends this session's worker the owner state as it now stands.
     *
     * A no-op for a session whose loop runs in this process, which reads the
     * same values directly.
     */
    private pushWorkerState(id: string): void {
        const entry = this.agents.get(id);
        const worker = entry?.worker;
        if (worker === undefined || entry?.loopServices === undefined) return;
        worker.pushState(loopStateOf(entry.loopServices));
    }

    /** Sends every running worker the owner state as it now stands. */
    private pushWorkerStateEverywhere(): void {
        for (const id of this.agents.keys()) this.pushWorkerState(id);
    }

    /** Sessions whose loop currently runs in a separate process. */
    private liveWorkerCount(): number {
        let count = 0;
        for (const entry of this.agents.values()) {
            if (entry.worker !== undefined) count += 1;
        }
        return count;
    }

    private async runInWorker(options: {
        readonly agent: ResidentAgent;
        readonly store: SessionStore;
        readonly entry: RegisteredAgentEntry;
        readonly adapter: WorkerAdapterSpec;
        readonly data: RunHeadlessLoopData;
        readonly services: RunHeadlessLoopServices;
        readonly extensionTools?: readonly RegisteredTool[];
    }): Promise<void> {
        const { agent, store, services } = options;
        const cap = this.options.maxConcurrentWorkers
            ?? defaultConcurrentWorkerCap();
        if (this.liveWorkerCount() >= cap) {
            throw new WorkerCapReachedError(cap);
        }
        const workerExtensions = this.workerExtensions();
        const handle = await startWorker({
            store,
            session: await readSessionSeed(store.path),
            model: this.defaultModel,
            ...(this.defaultReasoningEffort === undefined
                ? {}
                : { reasoningEffort: this.defaultReasoningEffort }),
            adapter: options.adapter,
            data: options.data,
            services,
            offers: {
                approvalModeRead: services.readApprovalMode !== undefined,
                modelSettings: services.readModelSettings !== undefined,
                agentWear: services.readAgentWear !== undefined,
            },
            state: loopStateOf(services),
            ...(workerExtensions === undefined
                ? {}
                : { extensions: workerExtensions }),
            ...(options.extensionTools === undefined
                ? {}
                : {
                    extensionTools: options.extensionTools,
                    // An extension tool runs on this side, against a runtime
                    // built from the same workspace the loop was given.
                    toolRuntime: new ToolRuntime(
                        store.header.cwd,
                        undefined,
                        undefined,
                        options.data.toolEnv,
                        options.data.instructionRoot?.path,
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
                if (isConsultReplyUpdate(update)) {
                    agent.sendConsultReply(ownerId, update);
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
        // Closing the agent stops its command channel, and a worker with no
        // channel left has nothing to run. The process is ended the same way
        // any other worker ends, so the outcome below is expected, not a
        // failure to report on a session that already stopped.
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
                            this.pushWorkerState(agent.id);
                            return services.readModelSettings!();
                        },
                    }),
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

    private async requestInboxAdmission(
        entry: RegisteredAgentEntry,
        candidate: InboxAdmissionCandidate,
        signal: AbortSignal,
    ): Promise<InboxAdmissionDecision | undefined> {
        const inbound = entry.inbound;
        if (inbound === undefined || !entry.agent.attached) return undefined;

        const result = await inbound.requestUserQuestion({
            question:
                `Inbox source ${candidate.sourceFamily}: ${candidate.kind} `
                + `from ${candidate.source} (${candidate.ts})\n`
                + "Admit this source?",
            choices: [
                {
                    id: "once",
                    label: "Once",
                    description: "Admit this entry and hold future entries.",
                },
                {
                    id: "session",
                    label: "This session",
                    description: "Admit this source family until disconnect.",
                },
                {
                    id: "always",
                    label: "Always",
                    description: "Remember this source family after choosing a scope.",
                },
            ],
        }, { signal, outOfBand: true });
        if (result.outcome !== "selected") return undefined;
        if (result.choice.id === "once") return { mode: "once" };
        if (result.choice.id === "session") return { mode: "session" };
        if (result.choice.id !== "always") return undefined;

        const scopeResult = await inbound.requestUserQuestion({
            question: `Where should ${candidate.sourceFamily} be admitted?`,
            choices: [
                {
                    id: "user",
                    label: "User",
                    description: "Apply this admission across your Vera sessions.",
                },
                {
                    id: "project",
                    label: "Project",
                    description: "Apply this admission in this workspace.",
                },
            ],
        }, { signal, outOfBand: true });
        if (scopeResult.outcome !== "selected") return undefined;
        if (scopeResult.choice.id === "user") {
            return { mode: "always", scope: "user" };
        }
        if (
            scopeResult.choice.id === "project"
        ) {
            return { mode: "always", scope: "project" };
        }
        return undefined;
    }

    private requestMissingSubagentConfiguration(
        entry: RegisteredAgentEntry,
        request: MissingSubagentConfigurationRequest,
        context: ToolEffectContext,
        signal: AbortSignal,
    ): Promise<SpawnModelResolution> {
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

        let queue = this.pendingSubagentConfigurations.get(entry.agent.id);
        if (queue === undefined) {
            queue = [];
            this.pendingSubagentConfigurations.set(entry.agent.id, queue);
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
                this.settlePendingSubagentLaunch(
                    action,
                    cancelledSubagentConfiguration(),
                );
                if (target.actions.every((candidate) => candidate.settled)) {
                    target.abort.abort();
                    if (!target.processing) {
                        this.completeSubagentConfigurationBatch(target);
                    }
                }
            };
            target.actions.push(action);
            signal.addEventListener("abort", action.onAbort, { once: true });
        });
        this.scheduleSubagentConfigurationBatch(target);
        return result;
    }

    /** One event-loop turn admits siblings; later arrivals queue behind it. */
    private scheduleSubagentConfigurationBatch(
        batch: PendingSubagentConfigurationBatch,
    ): void {
        const queue = this.pendingSubagentConfigurations.get(batch.entryId);
        if (
            queue?.[0] !== batch
            || batch.scheduled
            || batch.processing
        ) return;
        batch.scheduled = true;
        setTimeout(() => {
            batch.scheduled = false;
            batch.processing = true;
            void this.processMissingSubagentConfiguration(batch).catch(
                () => this.finishSubagentConfigurationBatch(
                    batch,
                    unavailableSubagentConfiguration(),
                ),
            );
        }, 0);
    }

    private async processMissingSubagentConfiguration(
        batch: PendingSubagentConfigurationBatch,
    ): Promise<void> {
        const entry = this.agents.get(batch.entryId);
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
            this.finishSubagentConfigurationBatch(
                batch,
                unavailableSubagentConfiguration(),
            );
            return;
        }

        let choices = active().map((action) =>
            this.resolveConfiguredSubagentLaunch(entry, action));
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
                this.finishSubagentConfigurationBatch(
                    batch,
                    outcome === "cancelled"
                        ? cancelledSubagentConfiguration()
                        : unavailableSubagentConfiguration(),
                );
                return;
            }

            // The settings write and its owner-side refresh precede the response
            // on one command stream. Push once more before answering a worker so
            // its next policy read cannot observe the pre-dialog snapshot.
            this.pushWorkerState(entry.agent.id);
            choices = active().map((action) =>
                this.resolveConfiguredSubagentLaunch(entry, action));
        }
        const failed = choices.find((choice) => !choice.resolution.ok);
        if (failed !== undefined) {
            for (const choice of choices) {
                this.settlePendingSubagentLaunch(
                    choice.action,
                    choice.resolution.ok ? failed.resolution : choice.resolution,
                );
            }
            this.completeSubagentConfigurationBatch(batch);
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
            this.finishSubagentChoices(
                choices,
                unavailableSubagentConfiguration(),
            );
            this.completeSubagentConfigurationBatch(batch);
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
            this.finishSubagentChoices(
                choices,
                cancelledSubagentConfiguration(),
            );
            this.completeSubagentConfigurationBatch(batch);
            return;
        }
        for (const choice of choices) {
            this.settlePendingSubagentLaunch(choice.action, choice.resolution);
        }
        this.completeSubagentConfigurationBatch(batch);
    }

    private resolveConfiguredSubagentLaunch(
        entry: RegisteredAgentEntry,
        action: PendingSubagentLaunch,
    ): {
        readonly action: PendingSubagentLaunch;
        readonly resolution: SpawnModelResolution;
    } {
        const policy = this.options.readPolicy === undefined
            ? { allowSelf: true }
            : this.options.readPolicy(entry.store.header.cwd);
        const pool = this.options.readPool === undefined
            ? undefined
            : () => this.options.readPool?.(entry.store.header.cwd) ?? [];
        let resolution = resolveSpawnModelChoice(
            action.request,
            action.context,
            pool,
            this.options.subagentModel,
            policy,
            action.request.agentDefault,
        );
        // This one-time substitution is authorized by the confirmation that
        // follows. A request made while policy already existed never enters
        // this workflow and remains a loud out-of-policy refusal.
        if (
            !resolution.ok
            && resolution.reason === "not_permitted"
            && action.request.model !== undefined
        ) {
            resolution = resolveSpawnModelChoice(
                {},
                action.context,
                pool,
                this.options.subagentModel,
                policy,
                action.request.agentDefault,
            );
        }
        return { action, resolution };
    }

    private finishSubagentConfigurationBatch(
        batch: PendingSubagentConfigurationBatch,
        resolution: SpawnModelResolution,
    ): void {
        for (const action of batch.actions) {
            this.settlePendingSubagentLaunch(action, resolution);
        }
        this.completeSubagentConfigurationBatch(batch);
    }

    private completeSubagentConfigurationBatch(
        batch: PendingSubagentConfigurationBatch,
    ): void {
        const queue = this.pendingSubagentConfigurations.get(batch.entryId);
        if (queue === undefined) return;
        const index = queue.indexOf(batch);
        if (index === -1) return;
        queue.splice(index, 1);
        if (queue.length === 0) {
            this.pendingSubagentConfigurations.delete(batch.entryId);
            return;
        }
        this.scheduleSubagentConfigurationBatch(queue[0]!);
    }

    private finishSubagentChoices(
        choices: readonly {
            readonly action: PendingSubagentLaunch;
            readonly resolution: SpawnModelResolution;
        }[],
        resolution: SpawnModelResolution,
    ): void {
        for (const choice of choices) {
            this.settlePendingSubagentLaunch(choice.action, resolution);
        }
    }

    private settlePendingSubagentLaunch(
        action: PendingSubagentLaunch,
        resolution: SpawnModelResolution,
    ): void {
        if (action.settled) return;
        action.settled = true;
        if (action.onAbort !== undefined) {
            action.signal.removeEventListener("abort", action.onAbort);
        }
        action.resolve(resolution);
    }

    private async spawnAsyncSubagent(
        parentStore: SessionStore,
        effect: SpawnAsyncSubagentEffect,
        context: Parameters<ApplyToolEffect>[2],
        signal: AbortSignal,
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
        let policy: SubagentPoolPolicy;
        let resolved: SpawnModelResolution;
        let child: ResidentAgent;
        try {
            policy = this.options.readPolicy === undefined
                ? { allowSelf: true }
                : this.options.readPolicy(parentStore.header.cwd);
            resolved = resolveSpawnModelChoice(
                effect,
                context,
                this.options.readPool === undefined
                    ? undefined
                    : () => this.options.readPool?.(parentStore.header.cwd) ?? [],
                this.options.subagentModel,
                policy,
            );
            if (!resolved.ok && resolved.reason === "configuration_required") {
                const entry = this.agents.get(parentStore.header.id);
                if (entry !== undefined) {
                    resolved = await this.requestMissingSubagentConfiguration(
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
                    policy = this.options.readPolicy === undefined
                        ? { allowSelf: true }
                        : this.options.readPolicy(parentStore.header.cwd);
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
            child = await this.createWithKind(
                {
                    workspace: parentStore.header.cwd,
                    ...(parentStore.header.startupProfile === undefined
                        ? {}
                        : {
                            startupProfile:
                                parentStore.header.startupProfile,
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

interface PublishedBranchAttachments {
    readonly path: string;
    readonly names: readonly string[];
}

async function publishBranchAttachments(
    stagingSessionPath: string,
    destinationSessionPath: string,
    signal?: AbortSignal,
): Promise<PublishedBranchAttachments | undefined> {
    const source = `${stagingSessionPath}.attachments`;
    let names: string[];
    try {
        names = await readdir(source);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    const destination = `${destinationSessionPath}.attachments`;
    await mkdir(destination, { mode: 0o700 });
    const published: string[] = [];
    try {
        for (const name of names) {
            signal?.throwIfAborted();
            await link(join(source, name), join(destination, name));
            published.push(name);
        }
    } catch (error) {
        await removePublishedBranchAttachments({
            path: destination,
            names: published,
        });
        throw error;
    }
    await rm(source, { recursive: true, force: true }).catch(() => {});
    return { path: destination, names: published };
}

async function removePublishedBranchAttachments(
    publication: PublishedBranchAttachments,
): Promise<void> {
    for (const name of publication.names) {
        await unlink(join(publication.path, name)).catch(() => {});
    }
    await rmdir(publication.path).catch(() => {});
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
    reviewerDefault?: ReviewerModelDefault,
    contextLimit?: number,
    developer?: DeveloperSettings,
    projectRoot?: string,
): ModelTurnSettings {
    const modelContextWindow = contextWindowForModel(
        provider,
        settings.model,
        models,
    );
    const contextWindow = effectiveContextWindow(
        modelContextWindow,
        contextLimit,
    );
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
    // The picker and the check a settings change goes through read one
    // admission rule, so a level cannot be dropped from one and kept by the
    // other. A pool entry's own list is already narrowed, so this is a no-op
    // there and only bites the catalog fallback. The stored level rides along
    // in the same read: it is served when admission has not refused it, which
    // includes a level config set that was never published.
    const asked = reasoningEffort !== undefined
            && !efforts.includes(reasoningEffort)
        ? [...efforts, reasoningEffort]
        : efforts;
    const admittedAsked = admittedEffortIds(provider, settings.model, asked, {
        ...catalog,
        ...(projectRoot === undefined ? {} : { projectRoot }),
    });
    const admitted = admittedAsked.filter((level) => efforts.includes(level));
    const served = admitted.length > 0 && reasoningEffort !== undefined
        && admittedAsked.includes(reasoningEffort);
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
        availableReasoningEfforts: admitted,
        availableModels: availableModelsWithLevels(models, {
            ...catalog,
            ...(projectRoot === undefined ? {} : { projectRoot }),
        }),
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
        ...(reviewerDefault === undefined ? {} : { reviewerDefault }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(modelContextWindow === undefined
            ? {}
            : { modelContextWindow }),
        ...(contextLimit === undefined ? {} : { contextLimit }),
        ...(developer === undefined ? {} : { developer }),
    };
}

/**
 * The reviewer route as the client sees it. The first entry is the reviewer
 * auto mode consults; a second is the failsafe, tried only when the first
 * cannot answer. No configured reviewer means auto mode reviews on the
 * agent's own model, which is `agent` rather than an empty selection.
 */
function reviewerDefaultOf(
    settings: ToolReviewerSettings | undefined,
): ReviewerModelDefault {
    const primary = settings?.models[0];
    if (primary === undefined) {
        return { mode: "agent" };
    }
    const fallback = settings?.models[1];
    return {
        mode: "fixed",
        primary: { ...primary },
        ...(fallback === undefined ? {} : { fallback: { ...fallback } }),
    };
}

/**
 * A consult carries plain text in both directions, so the peer turns it
 * replays are reconstructed rather than taken from a transcript.
 */
function consultModelMessage(message: ConsultMessage): ModelMessage {
    const content = [{ type: "text" as const, text: message.content }];
    if (message.role === "user") {
        return { role: "user", content };
    }
    return {
        role: "assistant",
        content,
        source: { provider: "consult", api: "consult", model: "consult" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

/** Set to `0` to run each session's turn loop in the host process. */
const WORKER_ENV = "VERA_WORKER";
const WORKER_EXTENSIONS_ENV = "VERA_WORKER_EXTENSIONS";

function cancelledSubagentConfiguration(): SpawnModelResolution {
    return {
        ok: false,
        reason: "cancelled",
        error: "The waiting subagent launches were cancelled; no child started.",
    };
}

function unavailableSubagentConfiguration(): SpawnModelResolution {
    return {
        ok: false,
        reason: "unavailable",
        error: "Subagent configuration requires an attached interactive client; no child started.",
    };
}

function requestedSubagentLabel(
    request: MissingSubagentConfigurationRequest,
): string {
    if (request.model !== undefined) return request.model;
    if (request.agentDefault !== undefined) {
        return request.agentDefault.provider === undefined
            ? request.agentDefault.model
            : `${request.agentDefault.provider}/${request.agentDefault.model}`;
    }
    return "assigned default";
}

function subagentResolutionLabel(
    resolution: Extract<SpawnModelResolution, { readonly ok: true }>,
): string {
    const model = resolution.provider === undefined
        ? resolution.model
        : `${resolution.provider}/${resolution.model}`;
    return resolution.reasoningEffort === undefined
        ? model
        : `${model} (${resolution.reasoningEffort})`;
}

/**
 * One reading of everything the owner may change while a turn is running.
 *
 * Taken at spawn and again after every host-side change, because a worker
 * answers each read from its last copy rather than calling back.
 */
function loopStateOf(services: RunHeadlessLoopServices): LoopState {
    return {
        policy: services.readPolicy?.() ?? {},
        ...(services.readModelSettings === undefined ? {} : {
            modelSettings: services.readModelSettings(),
        }),
        ...(services.readAgentWear === undefined ? {} : {
            agentWear: services.readAgentWear(),
        }),
        ...(services.readApprovalMode === undefined ? {} : {
            approvalMode: services.readApprovalMode(),
        }),
        ...(services.readPermissionPreferences === undefined ? {} : {
            permissionPreferences: services.readPermissionPreferences(),
        }),
        ...(services.readReviewer === undefined ? {} : {
            reviewer: services.readReviewer(),
        }),
    };
}

/** A delegated session can narrow with current policy, never widen past birth. */
function delegatedSubagentPolicy(
    current: SubagentPoolPolicy,
    delegation: SessionDelegation | undefined,
): SubagentPoolPolicy {
    if (delegation === undefined) return current;
    const boundary = new Set(delegation.models.map((entry) =>
        `${entry.provider ?? ""}/${entry.model}`));
    return {
        ...current,
        assigned: (current.assigned ?? []).filter((entry) =>
            boundary.has(`${entry.provider ?? ""}/${entry.model}`)),
        // The persisted parent pair is already represented in `models`.
        // Recomputing self from a resumed child's current parent would mint a
        // new candidate that was never authorized at this child's spawn.
        allowSelf: false,
    };
}

function delegationAllows(
    delegation: SessionDelegation,
    settings: Pick<ModelTurnSettings, "provider" | "model">,
): boolean {
    const providerKey = (provider: string | undefined): string =>
        provider === undefined || provider === "unknown" ? "" : provider;
    return delegation.models.some((allowed) =>
        allowed.model === settings.model
        && providerKey(allowed.provider) === providerKey(settings.provider));
}


/**
 * Commands the host answers itself while the loop runs in a worker.
 *
 * Each one reads or writes state this process owns outright: the catalog, the
 * pool, the roster, the session header, consults, and the dials. The loop keeps
 * no copy it could answer from, and every dial change is pushed into the worker
 * as a new `LoopState` before the next read.
 *
 * Wear is not here on purpose. It is queued FIFO with the prompts, so the loop
 * decides when it takes effect; the worker keeps it and asks the host for the
 * agent over the boundary.
 */
const HOST_OWNED_COMMANDS: ReadonlySet<string> = new Set([
    "get_model_settings",
    "get_session_model_settings_history",
    "list_agents",
    "update_agent_default_pair",
    "pool_add",
    "pool_remove",
    "pool_name",
    "pool_move",
    "catalog_refresh",
    "update_session_name",
    "owned_session_name_command",
    "consult",
    "owned_consult_command",
    "update_model_settings",
    "update_session_model_settings",
    "update_session_permission_mode",
    "add_permission_preference",
    "remove_permission_preference",
]);


/**
 * Measured on 2026-08-22: a worker is about 280 MB resident and its
 * supervisor about 27 MB, nearly all of it runtime rather than session state.
 * The default cap spends about a quarter of the machine on isolated sessions
 * and is clamped so a small machine keeps a usable number and a large one does
 * not spawn without bound.
 */
const WORKER_FOOTPRINT_BYTES = 320 * 1024 * 1024;
const MIN_WORKER_CAP = 2;
const MAX_WORKER_CAP = 16;

export function defaultConcurrentWorkerCap(total = totalmem()): number {
    const affordable = Math.floor((total * 0.25) / WORKER_FOOTPRINT_BYTES);
    return Math.min(MAX_WORKER_CAP, Math.max(MIN_WORKER_CAP, affordable));
}

export class WorkerCapReachedError extends Error {
    readonly cap: number;

    constructor(cap: number) {
        super(
            `${cap} ${cap === 1 ? "session is" : "sessions are"} already `
            + "taking a turn, which is this host's limit. A slot frees as "
            + "soon as one of them finishes. To take one now, stop a turn "
            + "with 'vera abort <agent-id>'; 'vera ls' shows which sessions "
            + "are working.",
        );
        this.name = "WorkerCapReachedError";
        this.cap = cap;
    }
}

/**
 * The session file as a worker is given it: the header verbatim, then every
 * record after it in file order. The worker folds a projection out of these
 * and never opens the file itself.
 */
async function readSessionSeed(path: string): Promise<WorkerSessionSeed> {
    const lines = (await Bun.file(path).text())
        .split("\n")
        .filter((line) => line.length > 0);
    const [header, ...records] = lines;
    return {
        path,
        header: JSON.parse(header ?? "{}") as Record<string, unknown>,
        records: records.map(
            (line) => JSON.parse(line) as Record<string, unknown>,
        ),
    };
}

function workerOutcomeDetail(outcome: WorkerOutcome): string {
    switch (outcome.kind) {
        case "failed":
            return outcome.error;
        case "killed":
            return `The agent process was killed (${outcome.signal})`;
        case "exited":
            return `The agent process exited with code ${outcome.code}`;
        default:
            return "The agent process stopped";
    }
}
