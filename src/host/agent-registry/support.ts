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

import { AsyncQueue } from "../../engine/async-queue.ts";
import { EngineEventBus } from "../../engine/events.ts";
import type { SessionFacts } from "../../store/session-facts.ts";
import type { InstructionRoot } from "../../engine/memory.ts";
import type { WorkAgentFacts, WorkScheduleFacts } from "../work-index.ts";
import type {
    ContextualContributionContext,
    PromptContribution,
} from "../../engine/prompt-contributions.ts";
import type { PoolAdmissionVerdict } from "../../engine/events.ts";
import type { ModelFailureLedger } from "../../store/model-failures.ts";
import {
    BUILT_IN_PERMISSION_MODE_NAMES,
    builtInPermissionMode,
    isApprovalMode,
    type ApprovalMode,
    type PermissionMode,
} from "../../engine/permissions.ts";
import type { ToolHooks } from "../../engine/hooks.ts";
import {
    ProviderUnavailableError,
    UserFacingError,
} from "../../user-facing-error.ts";
import type { PermissionPreferenceStore } from "../../engine/permission-preferences.ts";
import type { ModelFallbackPolicy } from "../../engine/recovery.ts";
import type { EffortPool } from "../../model/effort-pool.ts";
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
} from "../../engine/model-settings.ts";
import { inferReasoningSelection } from "../../model/reasoning-effort.ts";
import type { EffectiveCatalogOptions } from "../../model/catalog.ts";
import type {
    RunHeadlessLoopData,
    RunHeadlessLoopServices,
} from "../../engine/loop-services.ts";
import { createRoutedCompletionService } from "../../engine/completion-service.ts";
import {
    BUNDLED_COMPACTION_STRATEGIES,
    bindCompaction,
    type CompactionOverrides,
} from "../../engine/compaction-binding.ts";
import type {
    ResolvedCompactionProfile,
    VeraCatalogModel,
} from "../../config/model-catalog.ts";
import { isVeraProviderId } from "../../config.ts";
import {
    createSubagentEffectApplier,
    resolveSpawnModelChoice,
    subagentModelBoundary,
    type MissingSubagentConfigurationRequest,
    type SpawnModelDefault,
    type SpawnModelResolution,
    type SubagentPoolPolicy,
} from "../../engine/subagent.ts";
import { InboundCommandRouter } from "../../engine/inbound-command-router.ts";
import {
    isOneshotReplyUpdate,
    isSessionNameReplyUpdate,
    isTimelineReplyUpdate,
    isToolApprovalUiRequestUpdate,
    type ToolApprovalUiRequestUpdate,
} from "../../engine/protocol.ts";
import {
    DEFAULT_MAX_CONCURRENT_CHILD_AGENTS,
    validChildAgentLimit,
} from "../../engine/agent-limits.ts";
import type { ReviewLog } from "../../engine/review-log.ts";
import type { ToolReviewerSettings } from "../../engine/reviewer.ts";
import type {
    ReviewerModelDefault,
    ReviewerSettingsPatch,
} from "../../engine/model-settings.ts";
import type {
    ModelAdapter,
    ModelMessage,
    ModelReasoningEffort,
} from "../../model/types.ts";
import { emptyUsage } from "../../model/types.ts";
import type { SuggestedModel } from "../../model/supported-models.ts";
import {
    admittedEffortIds,
    availableModelsWithLevels,
    type PooledModel,
} from "../../model/catalog-view.ts";
import { withListedFacts } from "../../model/listed-facts.ts";
import { readWebDevArenaSnapshot } from "../../model/webdev-arena.ts";
import { projectTranscript } from "../../engine/protocol.ts";
import type {
    AgentInboxEffect,
    AgentSendEffect,
    AppliedToolEffectOutput,
    ApplyCommittedToolEffect,
    ApplyToolEffect,
    CloseSubagentEffect,
    CloseSubagentResult,
    CommitEffect,
    MessageSubagentEffect,
    NotifyParentEffect,
    RegisteredTool,
    SpawnAsyncSubagentEffect,
    ToolEffectContext,
    ToolOutput,
} from "../../tools/types.ts";
import { ManagedProcessRegistry } from "../../tools/process-runtime.ts";
import { ToolRuntime } from "../../tools/runtime.ts";
import {
    defaultSessionPath,
    sessionIsSubagent,
    SessionStore,
    type SessionDelegation,
    type SessionSettingOrigin,
} from "../../store/session-store.ts";
import {
    findCatalogAgent,
    loadAgentCatalog,
    type AgentCatalog,
} from "../../agents/catalog.ts";
import {
    DEFAULT_AGENT,
    type AgentDefinition,
} from "../../agents/definition.ts";
import {
    agentSnapshotDrift,
    resolveAgentSnapshot,
    type AgentWearSnapshot,
} from "../../agents/wear.ts";
import { writeAgentDefaultPair } from "../../agents/writer.ts";
import type { InboxEntry, InboxEntryInput } from "../../store/inbox.ts";
import { sessionChangedFiles } from "../../store/preimage-stash.ts";
import type { EmittedScheduleRun } from "../../scheduler/types.ts";
import {
    copySessionMessageAttachments,
    createSessionBranch,
} from "../../store/session-branch.ts";
import {
    disabledContributionsForProfile,
    storedStartupProfile,
    type StartupProfile,
} from "../../startup-profile.ts";
import type { UserMessage } from "../../model/types.ts";
import type { OneshotMessage } from "../../engine/protocol.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import { loopCompactionState, type LoopState } from "../../engine/host-protocol.ts";
import type { VeraExtensionConfig } from "../../config.ts";
import { discoverProjectExtensionConfigs } from "../../extensions/discovery.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistry,
} from "../../extensions/registry.ts";
import type {
    SessionIdentity,
    SessionIdentityProvider,
} from "../../sdk/extensions.ts";
import { recordDeliveryAndNotify } from "../delivery-notifier.ts";
import { workspaceKey } from "../../workspace-key.ts";
import type {
    InboxDeliveryCoordinator,
    InboxDeliverySession,
    InboxAdmissionCandidate,
    InboxAdmissionDecision,
} from "../inbox-delivery.ts";
import {
    ImageAttachmentService,
    sessionAttachmentName,
} from "../../attachments/service.ts";
import { ProviderRoutingAdapter } from "../../providers/routing.ts";
import {
    decideSkillInvocation,
    loadSkillCommandCatalog,
    type SkillCommandCatalog,
    type SkillInvocationDecision,
} from "../../skills/commands.ts";
import {
    startWorker,
    type WorkerHandle,
    type WorkerOutcome,
} from "../worker/handle.ts";
import type {
    WorkerAdapterSpec,
    WorkerSessionSeed,
} from "../worker/start.ts";
import type { PrepareModelRequest } from "../../providers/routing.ts";
import {
    createFailedRequestCapture,
    type FailedRequestCapture,
} from "../../providers/failed-request-capture.ts";
import {
    type AgentAttachment,
    ResidentAgent,
} from "../resident-agent.ts";
import {
    trashSessionArtifacts,
    type SessionArtifacts,
} from "../session-trash.ts";
import { SOURCE_GAP_KIND } from "../../watch/source.ts";
import {
    PEER_MESSAGE_KIND,
    PEER_READ_KIND,
    VERA_INBOX_SOURCE,
    parsePeerMessage,
    parsePeerRead,
    type PeerMessagePayload,
} from "../local-participation.ts";

export type RegisteredAgentStatus =
    | "idle"
    | "working"
    | "waiting"
    | "completed"
    | "closed"
    | "failed";

export type RegisteredAgentKind = "interactive" | "background";

export const IMAGE_ATTACHMENT_LIMITS = {
    maxBytes: 20 * 1_024 * 1_024,
    maxWidth: 16_384,
    maxHeight: 16_384,
} as const;

export const CHILD_TOOL_APPROVAL_TIMEOUT_MS = 60_000;

/** How many peer messages may chain before the host stops waking anyone. */
export const MAX_PEER_HOP = 3;

/** Peer wakes one session may take inside {@link PEER_WAKE_WINDOW_MS}. */
export const MAX_PEER_WAKES_PER_WINDOW = 6;

export const PEER_WAKE_WINDOW_MS = 60_000;

export interface RegisteredAgentSummary {
    readonly id: string;
    /**
     * The identity name this session posts under, when an identity extension
     * minted one. Carried on the listing because a list keyed by uuid is
     * unreadable; the id stays because it is what every other command takes.
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
    /**
     * Reads the current classifier binding. Hosts provide this when config can
     * change while they run; tests and embedded callers may keep using the
     * fixed `reviewer` value above.
     */
    readonly readReviewer?: () => ToolReviewerSettings | undefined;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly reviewLog?: ReviewLog;
    /** Persists a reviewer choice. `null` clears it. */
    readonly writeReviewer?: (
        reviewer: ToolReviewerSettings | null,
    ) => void;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    /** Agents an extension registered, the lowest-precedence source. */
    readonly registeredAgents?: readonly AgentDefinition[];
    /**
     * How a session is named. Absent means the session has no spoken identity
     * and shells do not get ARC_SESSION. The bundled session-identity
     * extension supplies the default.
     */
    readonly sessionIdentity?: SessionIdentityProvider;
    /** Durably reserves one identity key for one session. */
    readonly reserveSessionIdentity?: (
        sessionId: string,
        key: string,
    ) => Promise<"reserved" | "owned" | "taken">;
    /** Read live, so a change reaches a compact already in this session. */
    readonly compaction?: ResolvedCompactionProfile;
    /** Read live, so a change reaches a compact already running in this session. */
    readonly compactionModels?: readonly VeraCatalogModel[];
    /** Read live with the bound compaction, so a developer override takes effect without a restart. */
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
    /** Host-owned discovery capability, including providers with zero rows. */
    readonly refreshableProviders?: () => readonly string[];
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
    /** First live session in a workspace starts that workspace's sidecars. */
    readonly acquireWorkspaceSidecars?: (workspace: string) => Promise<void>;
    /** Last closed session in a workspace stops that workspace's sidecars. */
    readonly releaseWorkspaceSidecars?: (workspace: string) => Promise<void>;
    /**
     * The extension configs a worker loads for itself, so that an extension
     * tool runs in the process a kill lands on rather than in this one.
     *
     * Only read when `VERA_WORKER_EXTENSIONS=1`, because loading them twice
     * means an extension that opens a connection opens one per session.
     */
    readonly workerExtensions?: (
        workspace: string,
    ) => readonly VeraExtensionConfig[];
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
        allowedSkills?: readonly string[],
        context?: ContextualContributionContext,
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

export interface CloseDescendantNotOwnedResult {
    readonly status: "not_owned";
    readonly sessionRetained: boolean;
}

export type CloseDescendantTreeResult =
    | CloseAgentTreeResult
    | CloseDescendantNotOwnedResult;

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
export const instructionRoots = new Map<string, InstructionRoot>();

export function readInstructionRoot(workspace: string): InstructionRoot {
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

export function sameWorkspace(
    left: RegisteredAgentEntry,
    right: RegisteredAgentEntry,
): boolean {
    return workspaceKey(left.agent.workspace) === workspaceKey(right.agent.workspace);
}

export function entryStatus(entry: RegisteredAgentEntry): RegisteredAgentStatus {
    return entry.failure !== undefined
        ? "failed"
        : entry.agent.closed
            ? "closed"
            : entry.completed && entry.agent.status === "idle"
                ? "completed"
                : entry.agent.status;
}

export function entryIsLive(entry: RegisteredAgentEntry): boolean {
    return !entry.agent.closed
        && !entry.agent.failed
        && entry.failure === undefined
        && (
            entry.agent.attached
            || entry.agent.status === "working"
            || entry.agent.status === "waiting"
        );
}

export function entryUpdatedAt(entry: RegisteredAgentEntry): string {
    return entry.store.agentFailure()?.timestamp
        ?? entry.store.activeEntries().at(-1)?.timestamp
        ?? entry.store.header.timestamp;
}

export interface GitRosterFacts {
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

export const MAX_ROSTER_CHANGED_FILES = 200;

export function gitRosterFacts(workspace: string): GitRosterFacts {
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

export function gitOutput(
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

export function nulList(value: string | undefined): string[] {
    return value === undefined
        ? []
        : value.split("\0").filter((item) => item.length > 0);
}

export function toolError(output: string): ToolOutput {
    return { kind: "output", output, isError: true };
}

export function closeSubagentOutput(result: CloseSubagentResult): ToolOutput {
    return {
        kind: "output",
        output: JSON.stringify(result),
        isError: !result.closed,
    };
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function resolveAgentWorkspace(workspace: string): Promise<string> {
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

export function peerReadReceipt(
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

export function acknowledgeAfterCommit(
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

export function genericInboxResult(entry: InboxEntry): Record<string, unknown> {
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

export function boundedUtf8(
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

export function encodedStringBytes(value: string): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

export function normalizeSessionName(
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

/** Rename a durable session that has no resident agent in this host. */
export async function renameStoredSession(
    sessionPath: string,
    name: string | null,
): Promise<RenameSessionOutcome> {
    const requested = normalizeSessionName(name);
    if (requested === undefined) {
        return { status: "invalid" };
    }
    try {
        const store = await SessionStore.open(sessionPath);
        await store.appendName(requested);
        return { status: "renamed", name: store.name() ?? null };
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
            ? { status: "not_found" }
            : { status: "failed" };
    }
}

export interface InheritedAgentSettings {
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
export function samePair(
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
export const RESUME_WEAR_REQUEST_ID = "resume";

export interface BoundSessionIdentity extends SessionIdentity {
    readonly env: Readonly<Record<string, string>>;
}

export interface RegisteredAgentEntry {
    readonly agent: ResidentAgent;
    readonly store: SessionStore;
    readonly kind: RegisteredAgentKind;
    readonly ephemeral: boolean;
    pendingPublication: boolean;
    /**
     * The identity this session posts and is addressed under. Minted once,
     * persisted, and stable for the session. Changing it mid-session would
     * break self-echo suppression on the next arc post.
     */
    readonly identity?: BoundSessionIdentity;
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
    /** Project extensions loaded for this session's workspace. */
    projectExtensions?: ExtensionRegistry;
    completed: boolean;
    pendingAsyncTurns: number;
    pendingCompletionDeliveries: number;
    completionSequence: number;
    failure?: unknown;
}

export interface PendingSubagentLaunch {
    readonly id: string;
    readonly request: MissingSubagentConfigurationRequest;
    readonly context: ToolEffectContext;
    readonly signal: AbortSignal;
    readonly resolve: (resolution: SpawnModelResolution) => void;
    settled: boolean;
    onAbort?: () => void;
}

export interface PendingSubagentConfigurationBatch {
    readonly id: string;
    readonly entryId: string;
    readonly actions: PendingSubagentLaunch[];
    readonly abort: AbortController;
    scheduled: boolean;
    processing: boolean;
}
