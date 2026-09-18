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
    budgetContextWindow,
    contextWindowForModel,
    effectiveContextWindow,
    isModelReasoningEffort,
    publishedReasoningLevels,
    reasoningEffortForModel,
    type ModelSettingsPatch,
    type ModelTurnSettings,
} from "../../engine/model-settings.ts";
import {
    overrideRows,
    type ConfiguredOverrides,
} from "../../engine/override-rows.ts";
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

import type {
    AgentRegistryOptions,
    BoundSessionIdentity,
} from "./support.ts";

export interface PublishedBranchAttachments {
    readonly path: string;
    readonly names: readonly string[];
}

export async function publishBranchAttachments(
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

export async function removePublishedBranchAttachments(
    publication: PublishedBranchAttachments,
): Promise<void> {
    for (const name of publication.names) {
        await unlink(join(publication.path, name)).catch(() => {});
    }
    await rmdir(publication.path).catch(() => {});
}

export function supportedModelSettings(
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

export function settingsForClient(
    settings: ModelTurnSettings,
    provider: string,
    catalog: EffectiveCatalogOptions = {},
    models: readonly SuggestedModel[] = availableModels(),
    pooled: readonly PooledModel[] = [],
    subagentModel?: SpawnModelDefault,
    requestedReasoningEffort?: ModelReasoningEffort,
    reviewerDefault?: ReviewerModelDefault,
    contextLimit?: number,
    configured?: ConfiguredOverrides,
    projectRoot?: string,
    refreshableProviders?: readonly string[],
    providerCatalogs?: readonly ProviderCatalogState[],
): HostModelCatalogSettings {
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
        ...(providerCatalogs === undefined ? {} : { providerCatalogs }),
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
        overrides: {
            rows: overrideRows(
                configured ?? {},
                budgetContextWindow(modelContextWindow, contextLimit),
            ),
        },
    };
}

export function reviewerDefaultOf(
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

export function oneshotModelMessage(message: OneshotMessage): ModelMessage {
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

export const WORKER_EXTENSIONS_ENV = "VERA_WORKER_EXTENSIONS";

export function cancelledSubagentConfiguration(): SpawnModelResolution {
    return {
        ok: false,
        reason: "cancelled",
        error: "The waiting subagent launches were cancelled; no child started.",
    };
}

export function unavailableSubagentConfiguration(): SpawnModelResolution {
    return {
        ok: false,
        reason: "unavailable",
        error: "Subagent configuration requires an attached interactive client; no child started.",
    };
}

export function requestedSubagentLabel(
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

export function subagentResolutionLabel(
    resolution: Extract<SpawnModelResolution, { readonly ok: true }>,
): string {
    const model = resolution.provider === undefined
        ? resolution.model
        : `${resolution.provider}/${resolution.model}`;
    return resolution.reasoningEffort === undefined
        ? model
        : `${model} (${resolution.reasoningEffort})`;
}

export function loopStateOf(services: RunHeadlessLoopServices): LoopState {
    const compaction = loopCompactionState(services.compaction?.diagnostics);
    return {
        policy: services.readPolicy?.() ?? {},
        ...(services.readModelSettings === undefined ? {} : {
            modelSettings: services.readModelSettings(),
        }),
        ...(services.readSelectedAgent === undefined ? {} : {
            selectedAgent: services.readSelectedAgent(),
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

export function delegatedSubagentPolicy(
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
        ...(current.assignments === undefined ? {} : {
            assignments: Object.fromEntries(
                Object.entries(current.assignments).map(([name, models]) => [
                    name,
                    models.filter((entry) =>
                        boundary.has(`${entry.provider ?? ""}/${entry.model}`)),
                ]),
            ),
        }),
        allowSelf: false,
    };
}

export function delegationAllows(
    delegation: SessionDelegation,
    settings: Pick<ModelTurnSettings, "provider" | "model">,
): boolean {
    const providerKey = (provider: string | undefined): string =>
        provider === undefined || provider === "unknown" ? "" : provider;
    return delegation.models.some((allowed) =>
        allowed.model === settings.model
        && providerKey(allowed.provider) === providerKey(settings.provider));
}

export const HOST_OWNED_COMMANDS: ReadonlySet<string> = new Set([
    "get_model_settings",
    "get_session_model_settings_history",
    "list_agents",
    "list_customization_sources",
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

export const WORKER_FOOTPRINT_BYTES = 320 * 1024 * 1024;

export const MIN_WORKER_CAP = 2;

export const MAX_WORKER_CAP = 16;

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

export async function readSessionSeed(path: string): Promise<WorkerSessionSeed> {
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

export function workerOutcomeDetail(outcome: WorkerOutcome): string {
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

export function isSessionIdentity(value: unknown): value is SessionIdentity {
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

export function isValidSessionIdentityField(value: unknown): value is string {
    return typeof value === "string"
        && value.trim().length > 0
        && !value.includes("\0")
        && Buffer.byteLength(value, "utf8") <= 200;
}

export function materializeSessionIdentity(
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
