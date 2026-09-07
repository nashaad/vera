import type { HostModelCatalogSettings } from "../model-catalog-settings.ts";
import type { ProviderCatalogState } from "../../providers/catalog-state.ts";
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
    type ModelSettingsPatch,
    type ModelTurnSettings,
    type OverrideSettingsPatch,
} from "../../engine/model-settings.ts";
import { inferReasoningSelection } from "../../model/reasoning-effort.ts";
import type { EffectiveCatalogOptions } from "../../model/catalog.ts";
import type {
    RunHeadlessLoopData,
    RunHeadlessLoopServices,
} from "../../engine/loop-services.ts";
import { createRoutedCompletionService } from "../../engine/completion-service.ts";
import type { ToolResultLimits } from "../../engine/tool-result-history.ts";
import type { ConfiguredOverrides } from "../../engine/override-rows.ts";
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
    type AgentSnapshot,
} from "../../agents/snapshot.ts";
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

export const MAX_PEER_HOP = 3;

export const MAX_PEER_WAKES_PER_WINDOW = 6;

export const PEER_WAKE_WINDOW_MS = 60_000;

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
    readonly toolResults?: ToolResultLimits;
    readonly permissionPreferences?: PermissionPreferenceStore;
    readonly availableModels?: readonly SuggestedModel[];
    readonly refreshAvailableModels?: () => readonly SuggestedModel[];
    readonly refreshableProviders?: () => readonly string[];
    readonly providerCatalogs?: () => readonly ProviderCatalogState[];
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
    readonly configuredOverrides?: () => ConfiguredOverrides;
    readonly updateOverrides?: (patch: OverrideSettingsPatch) => void;
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
    /** The mode this agent starts in, when it must not be the host default. It is written to the session like any other approval-mode change, so a client that resumes the session later… */
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

export function samePair(
    left: ModelTurnSettings,
    right: ModelTurnSettings,
): boolean {
    return left.model === right.model
        && (left.provider ?? "") === (right.provider ?? "")
        && left.reasoningEffort === right.reasoningEffort;
}

export const RESUME_SELECT_REQUEST_ID = "resume";

export interface BoundSessionIdentity extends SessionIdentity {
    readonly env: Readonly<Record<string, string>>;
}

export interface RegisteredAgentEntry {
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
    modelSettings: HostModelCatalogSettings;
    /** The level the last settings change asked for when it had to be coerced. Held beside the settings rather than inside them because it describes the request, not the choice, and mu… */
    requestedReasoningEffort?: ModelReasoningEffort;
    approvalMode: ApprovalMode;
    selectedAgent?: AgentSnapshot;
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
