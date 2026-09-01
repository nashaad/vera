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
import type {
    ContextualContributionContext,
    PromptContribution,
} from "../engine/prompt-contributions.ts";
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
    isOneshotReplyUpdate,
    isSessionNameReplyUpdate,
    isTimelineReplyUpdate,
    isToolApprovalUiRequestUpdate,
    type ToolApprovalUiRequestUpdate,
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
import { withListedFacts } from "../model/listed-facts.ts";
import { readWebDevArenaSnapshot } from "../model/webdev-arena.ts";
import { projectTranscript } from "../engine/protocol.ts";
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
} from "../tools/types.ts";
import { ManagedProcessRegistry } from "../tools/process-runtime.ts";
import { ToolRuntime } from "../tools/runtime.ts";
import {
    defaultSessionPath,
    sessionIsSubagent,
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
import type { OneshotMessage } from "../engine/protocol.ts";
import type { EngineCommand } from "../engine/timeline-control.ts";
import { loopCompactionState, type LoopState } from "../engine/host-protocol.ts";
import type { VeraExtensionConfig } from "../config.ts";
import { discoverProjectExtensionConfigs } from "../extensions/discovery.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistry,
} from "../extensions/registry.ts";
import type {
    SessionIdentity,
    SessionIdentityProvider,
} from "../sdk/extensions.ts";
import { recordDeliveryAndNotify } from "./delivery-notifier.ts";
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
    decideSkillInvocation,
    loadSkillCommandCatalog,
    type SkillCommandCatalog,
    type SkillInvocationDecision,
} from "../skills/commands.ts";
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

const MAX_PEER_HOP = 3;
const MAX_PEER_WAKES_PER_WINDOW = 6;
const PEER_WAKE_WINDOW_MS = 60_000;

export interface RegisteredAgentSummary {
    readonly id: string;
    readonly name?: string;
    readonly workspace: string;
    readonly session_path: string;
    readonly kind: RegisteredAgentKind;
    readonly status: RegisteredAgentStatus;
    readonly live: boolean;
    readonly worker_pid?: number;
    readonly supervisor_pid?: number;
    readonly title?: string;
    readonly has_user_content?: boolean;
    readonly updated_at?: string;
    readonly parent_id?: string;
    readonly forked_from?: string;
    readonly size_bytes?: number;
    readonly created_at?: string;
    readonly facts?: SessionFacts;
}

export interface AgentRegistryOptions {
    readonly createAdapter: (
        provider?: string,
        projectRoot?: string,
        captureFailedRequest?: FailedRequestCapture,
    ) => ModelAdapter;
    readonly createFailedRequestCapture?: (
        sessionId: string,
    ) => FailedRequestCapture;
    readonly credentialFingerprint?: (provider: string) => string | undefined;
    readonly workerAdapterSpec?: (context: {
        readonly provider: string;
        readonly projectRoot: string;
        readonly sessionId: string;
    }) => WorkerAdapterSpec;
    readonly maxConcurrentWorkers?: number;
    readonly provider?: string;
    readonly customProviderIds?: () => readonly string[];
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly approvalMode: ApprovalMode;
    readonly maxConcurrentBackgroundAgents?: number;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly createEffortPool?: (projectRoot: string) => EffortPool;
    readonly reviewer?: ToolReviewerSettings;
    readonly readReviewer?: () => ToolReviewerSettings | undefined;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly reviewLog?: ReviewLog;
    readonly writeReviewer?: (
        reviewer: ToolReviewerSettings | null,
    ) => void;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    readonly registeredAgents?: readonly AgentDefinition[];
    readonly sessionIdentity?: SessionIdentityProvider;
    readonly reserveSessionIdentity?: (
        sessionId: string,
        key: string,
    ) => Promise<"reserved" | "owned" | "taken">;
    readonly compaction?: ResolvedCompactionProfile;
    readonly compactionModels?: readonly VeraCatalogModel[];
    readonly compactionOverrides?: CompactionOverrides;
    readonly permissionPreferences?: PermissionPreferenceStore;
    readonly availableModels?: readonly SuggestedModel[];
    readonly refreshAvailableModels?: () => readonly SuggestedModel[];
    readonly refreshableProviders?: () => readonly string[];
    /** Asks a provider for its model list now, past whatever age the snapshot would otherwise be trusted for, and returns the replacement list. */
    readonly refreshCatalog?: (
        provider: string,
    ) => Promise<readonly SuggestedModel[] | undefined>;
    readonly readPool?: (projectRoot?: string) => readonly PooledModel[];
    readonly sessionPathForId?: (agentId: string) => string;
    readonly eventLogPathForId?: (agentId: string, cwd: string) => string;
    readonly modelFailureLedger?: ModelFailureLedger;
    readonly updateModelDefaults?: (settings: ModelTurnSettings) => void;
    readonly contextLimit?: () => number | undefined;
    readonly updateContextLimit?: (limit: number | null) => void;
    readonly developerSettings?: () => DeveloperSettings;
    readonly updateDeveloperSettings?: (patch: DeveloperSettingsPatch) => void;
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
    readonly namePoolEntry?: (
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
        projectRoot: string,
    ) => boolean;
    readonly movePoolEntry?: (
        entry: { readonly provider: string; readonly model: string },
        delta: number,
        projectRoot: string,
    ) => boolean;
    readonly updateApprovalDefault?: (mode: ApprovalMode) => void;
    readonly trashSessionArtifacts?: (artifacts: SessionArtifacts) => Promise<void>;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly acquireWorkspaceSidecars?: (workspace: string) => Promise<void>;
    readonly releaseWorkspaceSidecars?: (workspace: string) => Promise<void>;
    readonly workerExtensions?: (
        workspace: string,
    ) => readonly VeraExtensionConfig[];
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
        allowedSkills?: readonly string[],
        context?: ContextualContributionContext,
    ) => Promise<readonly PromptContribution[]>;
    readonly disabledPromptContributions?: readonly string[];
    readonly createToolHooks?: () => ToolHooks;
    readonly prepareModelRequest?: (
        context: { readonly sessionId: string; readonly workspace: string },
    ) => PrepareModelRequest;
    readonly subagentModel?: SpawnModelDefault;
    readonly readPolicy?: (projectRoot?: string) => SubagentPoolPolicy;
    readonly cacheDir?: string;
    readonly inboxDelivery?: InboxDeliveryCoordinator;
    readonly inboxActorForSession?: (agentId: string) => string | null;
}

export interface CloseAgentTreeResult {
    readonly status: "closed" | "not_found";
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
    readonly ephemeral?: boolean;
    readonly startupProfile?: StartupProfile;
    /** The mode this agent starts in, when it must not be the host default. It is written to the session like any other approval-mode change, so a client that resumes the session. */
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
    readonly ephemeral?: boolean;
    readonly approvalMode?: ApprovalMode;
    readonly initialMessages?: readonly UserMessage[];
    readonly hideInheritedMessages?: boolean;
    readonly signal?: AbortSignal;
    readonly deferPublication?: boolean;
}

export interface BranchedRegisteredAgent {
    readonly agent: ResidentAgent;
    readonly prompt?: UserMessage;
}

export type RenameSessionOutcome =
    | { readonly status: "renamed"; readonly name: string | null }
    | { readonly status: "invalid" | "busy" | "not_found" | "failed" };

export function resolveInstructionRoot(workspace: string): InstructionRoot {
    const remembered = instructionRoots.get(workspace);
    if (remembered !== undefined) {
        return remembered;
    }
    const resolved = readInstructionRoot(workspace);
    instructionRoots.set(workspace, resolved);
    return resolved;
}

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

function closeSubagentOutput(result: CloseSubagentResult): ToolOutput {
    return {
        kind: "output",
        output: JSON.stringify(result),
        isError: !result.closed,
    };
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

interface InheritedAgentSettings {
    readonly approvalMode: ApprovalMode;
    readonly modelSettings?: ModelTurnSettings;
    readonly parentId?: string;
    readonly delegation?: SessionDelegation;
}

function samePair(
    left: ModelTurnSettings,
    right: ModelTurnSettings,
): boolean {
    return left.model === right.model
        && (left.provider ?? "") === (right.provider ?? "")
        && left.reasoningEffort === right.reasoningEffort;
}

const RESUME_WEAR_REQUEST_ID = "resume";

interface BoundSessionIdentity extends SessionIdentity {
    readonly env: Readonly<Record<string, string>>;
}

interface RegisteredAgentEntry {
    readonly agent: ResidentAgent;
    readonly store: SessionStore;
    readonly kind: RegisteredAgentKind;
    readonly ephemeral: boolean;
    pendingPublication: boolean;
    readonly identity?: BoundSessionIdentity;
    readonly events: EngineEventBus;
    readonly adapter?: ProviderRoutingAdapter;
    readonly eventLogPath?: string;
    readonly parentId?: string;
    modelSettings: ModelTurnSettings;
    /** The level the last settings change asked for when it had to be coerced. Held beside the settings rather than inside them because it describes the request, not the choice, and. */
    requestedReasoningEffort?: ModelReasoningEffort;
    approvalMode: ApprovalMode;
    agentWear?: AgentWearSnapshot;
    inbound?: InboundCommandRouter;
    workerOwnerRouter?: InboundCommandRouter;
    loopServices?: RunHeadlessLoopServices;
    syncedSourceEntryId?: string | null;
    inbox?: InboxDeliverySession;
    peerHop: number;
    peerWakes: number[];
    run: Promise<void>;
    worker?: WorkerHandle;
    projectExtensions?: ExtensionRegistry;
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
    private readonly suppressedCompletionDeliveries = new WeakSet<
        RegisteredAgentEntry
    >();
    private readonly closingCompletionRecipients = new WeakSet<SessionStore>();
    private defaultModel: string;
    private defaultProvider: string;
    private defaultReasoningEffort: ModelReasoningEffort | undefined;
    private defaultApprovalMode: ApprovalMode;
    private reviewerSettings: ToolReviewerSettings | undefined;
    private isClosed = false;
    private readonly trashArtifacts: (artifacts: SessionArtifacts) => Promise<void>;
    private readonly maxConcurrentBackgroundAgents: number;
    private readonly startingBackgroundAgents = new Map<string, number>();
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

    ownedTreeIds(id: string): readonly string[] {
        return this.agents.has(id) ? [id, ...this.liveDescendantsOf(id)] : [];
    }

    async closeAgentTree(id: string): Promise<CloseAgentTreeResult> {
        const present = this.agents.has(id);
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
                const entry = this.agents.get(memberId);
                if (entry !== undefined) {
                    this.closingCompletionRecipients.add(entry.store);
                    entry.agent.close();
                }
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

    async closeDescendantTree(
        callerId: string,
        targetId: string,
    ): Promise<CloseDescendantTreeResult> {
        const target = this.agents.get(targetId);
        if (
            target === undefined
            || target.agent.closed
            || target.agent.failed
            || target.failure !== undefined
        ) {
            return { status: "not_found", sessionRetained: true };
        }
        const caller = this.agents.get(callerId);
        if (
            caller === undefined
            || caller.agent.closed
            || caller.agent.failed
            || caller.failure !== undefined
            || !this.liveDescendantsOf(callerId).includes(targetId)
        ) {
            return { status: "not_owned", sessionRetained: true };
        }

        if (
            target.parentId === callerId
            && (
                target.pendingAsyncTurns > 0
                || target.pendingCompletionDeliveries > 0
            )
        ) {
            this.suppressedCompletionDeliveries.add(target);
        }
        try {
            return await this.closeAgentTree(targetId);
        } catch (error) {
            this.suppressedCompletionDeliveries.delete(target);
            throw error;
        }
    }

    private async reapClosedAgent(
        id: string,
        entry: RegisteredAgentEntry,
    ): Promise<void> {
        entry.inbox?.release();
        await entry.projectExtensions?.close();
        await this.options.releaseWorkspaceSidecars?.(entry.store.header.cwd);
        this.agents.delete(id);
        this.spawnNotices.delete(id);
        if (entry.ephemeral) {
            await rm(dirname(entry.store.path), { recursive: true, force: true });
        }
    }

    private liveDescendantsOf(id: string): readonly string[] {
        const ordered: string[] = [];
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
                        : { contextAssemblyMode: startupProfile }),
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
            return await this.start(
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
                ? await this.start(store, "interactive", options.eventLogPath)
                : await this.start(
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
                agent: await this.start(
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
                await this.start(store, entry.kind, entry.eventLogPath);
            } catch {
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

    arcNameOf(id: string): string | undefined {
        const entry = this.agents.get(id);
        return entry?.agent.closed === false ? entry.identity?.name : undefined;
    }

    agentIdForArcSession(value: string): string | undefined {
        for (const [id, entry] of this.agents) {
            if (entry.agent.closed) {
                continue;
            }
            const identity = entry.identity;
            if (identity === undefined) {
                continue;
            }
            if (value === identity.name || value === identity.key) {
                return id;
            }
            const incoming = this.options.sessionIdentity?.keyOf?.(value);
            if (incoming != null && incoming === identity.key) {
                return id;
            }
        }
        return this.find(value)?.id;
    }

    private readonly identityKeyOwners = new Map<string, string>();
    private readonly unavailableIdentityKeys = new Set<string>();

    private identityKeyTaken(key: string): boolean {
        if (
            this.identityKeyOwners.has(key)
            || this.unavailableIdentityKeys.has(key)
        ) {
            return true;
        }
        for (const entry of this.agents.values()) {
            if (entry.identity?.key === key) {
                return true;
            }
        }
        return false;
    }

    private async bindSessionIdentity(
        store: SessionStore,
    ): Promise<BoundSessionIdentity | undefined> {
        const stored = store.identity();
        if (stored !== undefined) {
            const claimed = await this.claimSessionIdentityKey(
                store.header.id,
                stored.key,
            );
            if (!claimed) {
                throw new Error(
                    `Session identity ${stored.name} is already owned by another session`,
                );
            }
            return materializeSessionIdentity(stored.name, stored.key);
        }
        if (store.agentFailure() !== undefined) {
            return undefined;
        }
        const provider = this.options.sessionIdentity;
        if (provider === undefined) {
            return undefined;
        }
        let minted: SessionIdentity | undefined;
        for (let attempt = 0; attempt < 1_024; attempt += 1) {
            minted = provider.mint({
                taken: (key) => this.identityKeyTaken(key),
            });
            if (!isSessionIdentity(minted)) {
                throw new Error(
                    "Session identity provider returned an invalid identity",
                );
            }
            if (await this.claimSessionIdentityKey(store.header.id, minted.key)) {
                break;
            }
            minted = undefined;
        }
        if (minted === undefined) {
            throw new Error("Session identity provider exhausted its name space");
        }
        await store.appendIdentity({
            name: minted.name,
            key: minted.key,
        });
        return materializeSessionIdentity(minted.name, minted.key);
    }

    private async claimSessionIdentityKey(
        sessionId: string,
        key: string,
    ): Promise<boolean> {
        const owner = this.identityKeyOwners.get(key);
        if (owner !== undefined) {
            return owner === sessionId;
        }
        if (this.unavailableIdentityKeys.has(key)) {
            return false;
        }
        // Reserve locally before awaiting the durable claim. Concurrent creates in this host must not both offer the same candidate.
        this.identityKeyOwners.set(key, sessionId);
        const reserve = this.options.reserveSessionIdentity;
        if (reserve === undefined) {
            return true;
        }
        try {
            const outcome = await reserve(sessionId, key);
            if (outcome === "reserved" || outcome === "owned") {
                return true;
            }
            this.identityKeyOwners.delete(key);
            this.unavailableIdentityKeys.add(key);
            return false;
        } catch (error) {
            this.identityKeyOwners.delete(key);
            throw error;
        }
    }

    readHostModelSettings(workspace?: string): ModelTurnSettings {
        return settingsForClient(
            {
                provider: this.defaultProvider,
                model: this.defaultModel,
                ...(this.defaultReasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: this.defaultReasoningEffort }),
            },
            this.defaultProvider,
            this.catalog,
            this.modelsForClient(),
            this.options.readPool?.(workspace),
            this.options.subagentModel,
            undefined,
            this.reviewerDefault(),
            this.options.contextLimit?.(),
            this.options.developerSettings?.(),
            workspace,
            this.options.refreshableProviders?.(),
        );
    }

    private reviewerDefault(): ReviewerModelDefault {
        return reviewerDefaultOf(this.readReviewer());
    }

    readReviewer(): ToolReviewerSettings | undefined {
        return this.options.readReviewer === undefined
            ? this.reviewerSettings
            : this.options.readReviewer();
    }

    private applyReviewerPatch(patch: ReviewerSettingsPatch | null): boolean {
        if (patch === null) {
            this.reviewerSettings = undefined;
            this.options.writeReviewer?.(null);
            return true;
        }
        const carried = this.readReviewer();
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
                this.options.refreshableProviders?.(),
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
                    this.options.refreshableProviders?.(),
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
                    this.options.refreshableProviders?.(),
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
            this.options.refreshableProviders?.(),
        );
    }

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

    private originFor(
        entry: RegisteredAgentEntry,
        settings: ModelTurnSettings,
    ): SessionSettingOrigin {
        return samePair(settings, this.effectiveDefaultPair(entry))
            ? "agent-default"
            : "user";
    }

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
                this.options.refreshableProviders?.(),
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

    private wornAgentPosture(
        entry: RegisteredAgentEntry,
    ): ApprovalMode | undefined {
        const named = entry.agentWear?.posture;
        return named !== undefined && isApprovalMode(named)
            ? named
            : this.defaultApprovalMode;
    }

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

    async listSkillsFor(id: string): Promise<SkillCommandCatalog> {
        const entry = this.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return { skills: [], warnings: ["Skill commands are unavailable."] };
        }
        return loadSkillCommandCatalog({
            projectRoot: resolveInstructionRoot(entry.store.header.cwd).path,
            ...(entry.agentWear?.skills === undefined
                ? {}
                : { allowedSkills: entry.agentWear.skills }),
        });
    }

    async decideSkillInvocationFor(
        id: string,
        name: string,
    ): Promise<SkillInvocationDecision> {
        const entry = this.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return { allowed: false, reason: `/${name} is unavailable.` };
        }
        return decideSkillInvocation({
            projectRoot: resolveInstructionRoot(entry.store.header.cwd).path,
            name,
            ...(entry.agentWear?.skills === undefined
                ? {}
                : { allowedSkills: entry.agentWear.skills }),
            isSubagent: sessionIsSubagent(entry.store.header),
        });
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
        }
    }

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
                this.options.refreshableProviders?.(),
            ),
        };
    }

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
                    name: entry.identity?.name,
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
            this.options.refreshableProviders?.(),
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
            this.options.refreshableProviders?.(),
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
            this.options.refreshableProviders?.(),
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
            this.options.refreshableProviders?.(),
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

    approvalModeOf(agentId: string): ApprovalMode | undefined {
        return this.agents.get(agentId)?.approvalMode;
    }

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
                    name: entry.identity?.name,
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

    scheduleWorkFacts(
        runs: readonly EmittedScheduleRun[],
        agents: readonly WorkAgentFacts[],
    ): readonly WorkScheduleFacts[] {
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

    private async start(
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
    ): Promise<ResidentAgent> {
        const identity = await this.bindSessionIdentity(store);
        const startupProfile = store.header.contextAssemblyMode ?? "default";
        const projectExtensionConfigs = startupProfile === "default"
            ? discoverProjectExtensionConfigs(store.header.cwd)
            : [];
        const projectExtensions = projectExtensionConfigs.length === 0
            ? undefined
            : await startExtensionRegistry({
                extensions: projectExtensionConfigs,
            });
        const extensionTools = startupProfile === "default"
            ? [
                ...(this.options.extensionTools ?? []),
                ...(projectExtensions?.tools() ?? []),
            ]
            : [];
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
            ...(identity === undefined ? {} : { identity }),
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
            ...(store.agentWear() === undefined
                ? {}
                : { agentWear: store.agentWear()!.snapshot }),
            run: Promise.resolve(),
            ...(projectExtensions === undefined
                ? {}
                : { projectExtensions }),
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
        try {
            await this.options.acquireWorkspaceSidecars?.(store.header.cwd);
        } catch (error) {
            this.agents.delete(agent.id);
            await projectExtensions?.close();
            throw error;
        }
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
                    interactive: false,
                    ...(this.options.registeredAgents === undefined
                        ? {}
                        : { registered: this.options.registeredAgents }),
                });
                return findCatalogAgent(catalog, name)?.definition;
            },
            workspace: store.header.cwd,
            parentSessionId: store.header.id,
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
            ...(store.header.contextAssemblyMode === undefined
                ? {}
                : {
                    sessionMetadata: {
                        contextAssemblyMode: store.header.contextAssemblyMode,
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
        const boundCompaction = (): ReturnType<typeof bindCompaction> =>
            bindCompaction(
                this.options.compaction,
                adapter,
                {
                    ...(entry.modelSettings.provider === undefined
                        ? {}
                        : { provider: entry.modelSettings.provider }),
                    model: entry.modelSettings.model,
                },
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
            if (effect.type === "close_subagent") {
                return this.closeSubagent(agent.id, effect);
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
                toolEnv: entry.identity?.env ?? {},
                instructionRoot,
                enabledToolEffects: kind === "interactive"
                    ? [
                        "spawn_subagent",
                        "spawn_async_subagent",
                        "message_subagent",
                        "close_subagent",
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
                get compaction() {
                    return boundCompaction();
                },
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
                readPolicy: () => {
                    const reviewer = this.readReviewer();
                    return {
                        ...(store.header.delegation !== undefined
                                || registry.options.modelFallback === undefined
                            ? {}
                            : {
                            modelFallback: registry.options.modelFallback,
                        }),
                        ...(registry.options.permissionModes === undefined
                            ? {}
                            : {
                                permissionModes:
                                    registry.options.permissionModes,
                            }),
                        ...(reviewer === undefined ? {} : { reviewer }),
                        ...(registry.options.reviewers === undefined ? {} : {
                            reviewers: registry.options.reviewers,
                        }),
                        disabledPromptContributions:
                            disabledPromptContributions(),
                        subagentPolicy: delegatedSubagentPolicy(
                            this.options.readPolicy === undefined
                                ? { allowSelf: true }
                                : this.options.readPolicy(store.header.cwd),
                            store.header.delegation,
                        ),
                    };
                },
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
                    this.options.refreshableProviders?.(),
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
                    listSkills: () => this.listSkillsFor(agent.id),
                    invokeSkill: (name) =>
                        this.decideSkillInvocationFor(agent.id, name),
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
                        oneshot: (request, signal) => {
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
                                    oneshotModelMessage(message)
                                ),
                                ...(request.maxTokens === undefined
                                    ? {}
                                    : { maxTokens: request.maxTokens }),
                            }, signal);
                        },
                    }),
                    sendOneshotReply: (ownerId, reply) =>
                        agent.sendOneshotReply(ownerId, reply),
                    readApprovalModeOrigin: () =>
                        entry.store.approvalModeOrigin(),
                    ...(this.options.permissionPreferences === undefined
                        ? {}
                        : {
                            addPermissionPreference: async (when) => {
                                const added = await this.options
                                    .permissionPreferences!.add(when);
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
                const detail = error instanceof WorkerCapReachedError
                    ? error.message
                    : "Resident agent stopped unexpectedly";
                try {
                    await store.appendAgentFailure(failureId, detail);
                } catch {
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
                session: entry.identity?.name ?? agent.id,
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

    private workerAdapterSpecFor(
        store: SessionStore,
        entry: RegisteredAgentEntry,
    ): WorkerAdapterSpec | undefined {
        if (this.options.workerAdapterSpec === undefined) {
            return undefined;
        }
        return this.options.workerAdapterSpec({
            provider: entry.modelSettings.provider ?? this.defaultProvider,
            projectRoot: store.header.cwd,
            sessionId: store.header.id,
        });
    }

    private workerExtensions(
        workspace: string,
    ): readonly VeraExtensionConfig[] | undefined {
        if ((process.env[WORKER_EXTENSIONS_ENV] ?? "") !== "1") {
            return undefined;
        }
        const configured = this.options.workerExtensions?.(workspace)
            ?? discoverProjectExtensionConfigs(workspace);
        return configured.length === 0 ? undefined : configured;
    }

    private pushWorkerState(id: string): void {
        const entry = this.agents.get(id);
        const worker = entry?.worker;
        if (worker === undefined || entry?.loopServices === undefined) return;
        worker.pushState(loopStateOf(entry.loopServices));
    }

    private pushWorkerStateEverywhere(): void {
        for (const id of this.agents.keys()) this.pushWorkerState(id);
    }

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
        const workerExtensions = this.workerExtensions(store.header.cwd);
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

    private async closeSubagent(
        callerId: string,
        effect: CloseSubagentEffect,
    ): Promise<ToolOutput> {
        try {
            const result = await this.closeDescendantTree(
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
            child,
            attachment,
            child.completionSequence,
        );
    }

    private monitorAsyncSubagent(
        parentStore: SessionStore,
        childEntry: RegisteredAgentEntry,
        attachment: AgentAttachment,
        completionSequence: number,
    ): void {
        const childId = childEntry.agent.id;
        const deliveryTask = this.deliverBackgroundResult(
            parentStore,
            childEntry,
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
        childEntry: RegisteredAgentEntry,
        attachment: AgentAttachment,
        completionSequence: number,
    ): Promise<void> {
        const childId = childEntry.agent.id;
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
        } finally {
            attachment.detach();
        }
        if (
            this.suppressedCompletionDeliveries.has(childEntry)
            || this.closingCompletionRecipients.has(parentStore)
        ) {
            childEntry.pendingAsyncTurns = 0;
            childEntry.pendingCompletionDeliveries = 0;
            return;
        }
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
    refreshableProviders?: readonly string[],
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
    const { reasoningEffort, ...rest } = settings;
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
    const listed = withListedFacts(
        availableModelsWithLevels(models, {
            ...catalog,
            ...(projectRoot === undefined ? {} : { projectRoot }),
        }),
        pooled,
        { snapshot: readWebDevArenaSnapshot(catalog.cacheDir) },
    );
    return {
        ...rest,
        ...(served ? { reasoningEffort } : {}),
        ...(served
                && requestedReasoningEffort !== undefined
                && requestedReasoningEffort !== reasoningEffort
            ? { requestedReasoningEffort }
            : {}),
        availableReasoningEfforts: admitted,
        availableModels: listed.available,
        refreshableProviders: refreshableProviders
            ?? [...new Set(models.flatMap((model) =>
                model.refreshable === true ? [model.provider] : []
            ))],
        pooled: listed.pooled,
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
        ...(listed.webdevArenaSnapshot === undefined
            ? {}
            : { webdevArenaSnapshot: listed.webdevArenaSnapshot }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(modelContextWindow === undefined
            ? {}
            : { modelContextWindow }),
        ...(contextLimit === undefined ? {} : { contextLimit }),
        ...(developer === undefined ? {} : { developer }),
    };
}

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

function oneshotModelMessage(message: OneshotMessage): ModelMessage {
    const content = [{ type: "text" as const, text: message.content }];
    if (message.role === "user") {
        return { role: "user", content };
    }
    return {
        role: "assistant",
        content,
        source: { provider: "oneshot", api: "oneshot", model: "oneshot" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

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

function loopStateOf(services: RunHeadlessLoopServices): LoopState {
    const compaction = loopCompactionState(services.compaction?.diagnostics);
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
        ...(compaction === undefined ? {} : { compaction }),
    };
}

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
    "oneshot",
    "owned_oneshot_command",
    "update_model_settings",
    "update_session_model_settings",
    "update_session_permission_mode",
    "add_permission_preference",
    "remove_permission_preference",
]);

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

function isSessionIdentity(value: unknown): value is SessionIdentity {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const identity = value as SessionIdentity;
    if (
        !isValidSessionIdentityField(identity.name)
        || !isValidSessionIdentityField(identity.key)
    ) {
        return false;
    }
    return true;
}

function isValidSessionIdentityField(value: unknown): value is string {
    return typeof value === "string"
        && value.trim().length > 0
        && !value.includes("\0")
        && Buffer.byteLength(value, "utf8") <= 200;
}

function materializeSessionIdentity(
    name: string,
    key: string,
): BoundSessionIdentity {
    return {
        name,
        key,
        env: {
            ARC_SESSION: name,
            COORD_SESSION: name,
        },
    };
}
