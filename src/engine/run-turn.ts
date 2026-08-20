import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    emptyUsage,
    type AssistantMessage,
    type ImageContent,
    type ModelAdapter,
    type ModelMessage,
    type ModelReasoningEffort,
    type ModelSubstitution,
    type ToolCallContent,
    type ToolResultMessage,
    type UserMessage,
} from "../model/types.ts";
import { ProviderFailureError } from "../model/provider-failure.ts";
import {
    agentAllowsTool,
    type AgentWearSnapshot,
} from "../agents/wear.ts";
import type { SessionModelSettingsResult } from "./inbound-command-router.ts";
import type { SessionSettingOrigin } from "../store/session-store.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import { sanitizeDiagnosticText } from "../model/diagnostic-text.ts";
import {
    hydrateImageAttachments,
    readSessionImageContent,
    sessionAttachmentName,
} from "../attachments/service.ts";
import type { JsonObject } from "../sdk/hooks.ts";
import type {
    HookToolCall,
    HookToolResult,
    PreToolUseHookResult,
} from "../sdk/hooks.ts";
import type { MessageChannel } from "./message-channel.ts";
import type {
    AgentUpdate,
    SessionNameReplyUpdate,
    TimelineReplyUpdate,
} from "./protocol.ts";
import { createProtocolEncoder } from "./protocol.ts";
import {
    TimelineController,
    type EngineCommand,
} from "./timeline-control.ts";
import {
    EngineEventBus,
    createJsonlEventLogger,
} from "./events.ts";
import type { PoolAdmissionVerdict } from "./events.ts";
import { createModelFailureRecorder } from "./model-failure-recorder.ts";
import type { ModelFailureLedger } from "../store/model-failures.ts";
import type { ReviewLog } from "./review-log.ts";
import {
    boundToolResult,
    executeToolHandler,
    toolDefinitionsForCapabilities,
    toolMayRunInParallel,
} from "../tools/execute.ts";
import { initBashParser } from "../tools/bash-parser.ts";
import { ToolRuntime } from "../tools/runtime.ts";
import { newStashingToolRuntime } from "./preimage.ts";
import { resolveFileToolPermissionContext } from "../tools/files.ts";
import type {
    ApplyCommittedToolEffect,
    ApplyToolEffect,
    CommitEffect,
    RegisteredTool,
    ToolExecutionResult,
    ToolEffect,
    ToolEffectContext,
    ToolOutput,
} from "../tools/types.ts";
import { loadMemory, type InstructionRoot } from "./memory.ts";
import { loadProjectInstructions } from "./project-instructions.ts";
import {
    promptContributionMetadata,
    type PromptContribution,
} from "./prompt-contributions.ts";
import { PromptPrefixTracker } from "./prompt-prefix-drift.ts";
import { projectModelRequest } from "./model-request.ts";
import { loadScratchState } from "./scratch-state.ts";
import { createToolResultSpill } from "./tool-result-spill.ts";
import type {
    ToolResultSpill,
    ToolResultTruncation,
} from "../tools/tool-result-limit.ts";
import {
    measureMessages,
    measureProjectedRequest,
    measureToolResultBytes,
    type ContextMeasurement,
} from "./context-measurement.ts";
import type { CompactionStrategyDefinition } from "./compaction.ts";
import type { CompleteText } from "./completion-service.ts";
import {
    compactionBudgetWarning,
    compactSession,
    shouldCompact,
    type CompactionTrigger,
} from "./compaction-scheduler.ts";
import {
    availableModels,
    contextWindowForModel,
    effectiveContextWindow,
} from "./model-settings.ts";
import { ToolHooks, type PreToolUseOutcome } from "./hooks.ts";
import { InboundCommandRouter } from "./inbound-command-router.ts";
import type { InboundCommandRouterOptions } from "./inbound-command-router.ts";
import { createSubagentEffectApplier } from "./subagent.ts";
import {
    decideToolPermission,
    stricterToolPermission,
    inspectPermissions,
    permissionGrantProposals,
    type ApprovalMode,
    type PermissionGrant,
    type PermissionGrantProposal,
    type PermissionMode,
    type PermissionPredicate,
    type PermissionPreference,
    type ToolPermissionDecision,
} from "./permissions.ts";
import {
    createRoutedToolReviewer,
    type ReviewToolCall,
    type ToolReviewerSettings,
} from "./reviewer.ts";
import { collectReviewerPathFacts } from "./reviewer-path-facts.ts";
import {
    createReviewCircuitBreaker,
    type ReviewCircuitBreaker,
} from "./review-circuit-breaker.ts";
import {
    DEFAULT_MODEL_MAX_TOKENS,
    nextLengthContinuation,
    requestModelWithRecovery,
    type ModelFallbackPolicy,
    type WaitForModelRetry,
} from "./recovery.ts";
import type { EffortPool } from "../model/effort-pool.ts";
import { preflightEffort } from "./effort-coarsening.ts";
import {
    defaultSessionPath,
    SessionStore,
    type SessionCompactionDiagnostics,
    type SessionDeliveryEntry,
    type SessionDeliveryInbox,
    type SessionMessageStore,
} from "../store/session-store.ts";
import {
    reasoningEffortForModel,
    type ModelSettingsPatch,
    type ModelTurnSettings,
} from "./model-settings.ts";

const PRE_TOOL_HOOK_TIMEOUT_MS = 60_000;
const POST_TOOL_HOOK_TIMEOUT_MS = 5_000;
const TOOL_APPROVAL_TIMEOUT_MS = 60_000;

/**
 * The last measurement taken, held so the next turn can decide whether to
 * compact before it starts. Deliberately the previous turn's reading: a turn
 * that has already been compacted must not be judged by the number that
 * triggered the compaction, which is the stale-trigger loop.
 */
export interface ContextWatch {
    measurement?: ContextMeasurement;
    /**
     * The messages' own share of `measurement.tokens`, kept so the fixed
     * overhead (system prompt, tools, instructions) can be read back out as
     * the difference. The transcript grows between requests; the overhead is
     * the part of the reading that stays true.
     */
    messageTokens?: number;
}

/** The model and window a turn's next request will use for compaction. */
export interface CompactionContext {
    readonly model: string;
    readonly capacity?: number;
}

export interface RunTurnState {
    readonly sessionId?: string;
    readonly messages: ModelMessage[];
    readonly store: SessionMessageStore;
    /**
     * What to send the model, which compaction replaces. Absent means the
     * transcript itself, which is what a session without compaction sends.
     */
    readonly modelContext?: () => readonly ModelMessage[];
    readonly contextWatch?: ContextWatch;
    readonly compact?: (
        signal: AbortSignal,
        pendingMessages?: readonly ModelMessage[],
        context?: CompactionContext,
    ) => Promise<void>;
    readonly deliveryInbox?: SessionDeliveryInbox;
    readonly toolRuntime: ToolRuntime;
    /**
     * Where project-scoped memory is keyed. Absent falls back to the
     * workspace, which is what a caller with no repository to resolve gets.
     */
    readonly instructionRoot?: InstructionRoot;
    readonly inbound: InboundCommandRouter;
    readonly events: EngineEventBus;
    readonly hooks: ToolHooks;
    readonly approvalMode: ApprovalMode;
    readonly applyToolEffect?: ApplyToolEffect;
    readonly applyCommittedToolEffect?: ApplyCommittedToolEffect;
    readonly enabledToolEffects?: readonly ToolEffect["type"][];
    readonly enableUserInteraction?: boolean;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly modelFallback?: ModelFallbackPolicy;
    /**
     * Supplies the effort levels a model is known to accept and takes the
     * refusals back. Absent leaves a refused level on the terminal path.
     */
    readonly effortPool?: EffortPool;
    readonly waitForModelRetry?: WaitForModelRetry;
    readonly readModelSettings?: () => ModelTurnSettings;
    /**
     * The worn agent as it resolved when it went on. Absent is the `default`
     * agent: every tool, every skill, the host's own posture.
     */
    readonly readAgentWear?: () => AgentWearSnapshot | undefined;
    /**
     * The parent's effective mode, on a delegated turn. Every action is
     * evaluated under both modes and the stricter outcome wins, so delegation
     * can only narrow what is allowed.
     */
    readonly clampPermissionMode?: ApprovalMode;
    /**
     * Nudges already shown this user turn, so one does not repeat itself
     * inside a single stretch of work. Cleared when the user speaks again.
     */
    readonly firedNudges?: Set<string>;
    readonly readApprovalMode?: () => ApprovalMode;
    readonly readPermissionGrants?: () => readonly PermissionGrant[];
    readonly readPermissionPreferences?: () => readonly PermissionPreference[];
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    /** Automatic approval reviewer used by `auto`. */
    readonly reviewToolCall?: ReviewToolCall;
    readonly reviewToolCallForProfile?: (
        profile: string,
        request: Parameters<ReviewToolCall>[0],
        signal: AbortSignal,
    ) => ReturnType<ReviewToolCall>;
    readonly promptPrefixTracker?: PromptPrefixTracker;
    readonly readImageContent?: (attachmentId: string) => Promise<ImageContent>;
    readonly scratchDir?: string;
    /** Where a truncated tool result's full output goes. */
    readonly toolResultSpill?: ToolResultSpill;
    readonly disabledPromptContributions?: readonly string[];
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
        /** The skills the worn agent may see. Absent means all of them. */
        allowedSkills?: readonly string[],
    ) => Promise<readonly PromptContribution[]>;
    readonly offerTools?: boolean;
    readonly loadOptionalContext?: boolean;
}

export interface SessionCompactionOptions {
    readonly strategy: CompactionStrategyDefinition;
    readonly models: Readonly<Record<string, CompleteText>>;
    readonly diagnostics?: SessionCompactionDiagnostics;
    /** Defaults apply for anything left unset. */
    readonly trigger?: CompactionTrigger;
    /** Token target for a session whose window is unknown. */
    readonly targetTokens?: number;
    /** Complete user turns preferred verbatim after compaction. */
    readonly retainedUserTurns?: number;
}

export interface RunHeadlessLoopOptions {
    /** Overrides the model the automatic approval reviewer runs on. */
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly reviewLog?: ReviewLog;
    /**
     * The reviewer route as it stands now, read at each review. A reviewer
     * chosen mid-session has to reach the session that chose it, so the
     * option below is only the starting point.
     */
    readonly readReviewer?: () => ToolReviewerSettings | undefined;
    readonly sessionStore?: SessionStore;
    readonly sessionId?: string;
    readonly sessionPath?: string;
    readonly resumeSessionPath?: string;
    readonly eventLogPath?: string;
    /**
     * Owner-supplied, like the event log path: a caller that names no ledger
     * records nothing, so the engine cannot reach the home directory by
     * omission.
     */
    readonly modelFailureLedger?: ModelFailureLedger;
    readonly eventBus?: EngineEventBus;
    readonly approvalMode?: ApprovalMode;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    readonly modelFallback?: ModelFallbackPolicy;
    /** Owner-supplied; the engine never opens the pool file itself. */
    readonly effortPool?: EffortPool;
    /**
     * Strategy and bound models. Absent means the session never compacts and
     * always sends its whole transcript, which is what every session did
     * before compaction existed.
     */
    readonly compaction?: SessionCompactionOptions;
    readonly applyToolEffect?: ApplyToolEffect;
    readonly applyCommittedToolEffect?: ApplyCommittedToolEffect;
    readonly enabledToolEffects?: readonly ToolEffect["type"][];
    readonly enableUserInteraction?: boolean;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly offerTools?: boolean;
    readonly loadOptionalContext?: boolean;
    readonly onInboundReady?: (inbound: InboundCommandRouter) => void;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly updateModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly updateSessionModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<SessionModelSettingsResult | undefined>;
    readonly readSessionModelSettingsHistory?: () => readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: SessionSettingOrigin;
        readonly timestamp: string;
    }[];
    readonly updateSessionPermissionMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    readonly wearAgent?: InboundCommandRouterOptions["wearAgent"];
    readonly listAgents?: InboundCommandRouterOptions["listAgents"];
    readonly updateAgentDefaultPair?:
        InboundCommandRouterOptions["updateAgentDefaultPair"];
    readonly readAgentWear?: () => AgentWearSnapshot | undefined;
    readonly poolAdd?: (
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
        readonly settings?: ModelTurnSettings;
    }>;
    readonly poolRemove?: (
        entry: { readonly provider: string; readonly model: string },
    ) => Promise<ModelTurnSettings | undefined>;
    readonly refreshCatalog?: (
        provider: string,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly poolName?: (
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly poolMove?: (
        entry: { readonly provider: string; readonly model: string },
        delta: number,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly readApprovalMode?: () => ApprovalMode;
    readonly readApprovalModeOrigin?: () => SessionSettingOrigin | undefined;
    readonly updateApprovalMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    /**
     * Durable preferences, read on every decision rather than captured once,
     * so an add/remove through the router takes effect on the next tool call
     * without restarting the loop.
     */
    readonly readPermissionPreferences?: () => readonly PermissionPreference[];
    readonly addPermissionPreference?: (
        when: PermissionPredicate,
    ) => Promise<PermissionPreference | undefined>;
    readonly removePermissionPreference?: (id: string) => Promise<boolean>;
    readonly updateSessionName?: (
        name: string | null,
    ) => Promise<string | null | undefined>;
    readonly sendTimelineReply?: (
        ownerId: string,
        reply: TimelineReplyUpdate,
    ) => void;
    readonly sendSessionNameReply?: (
        ownerId: string,
        reply: SessionNameReplyUpdate,
    ) => void;
    readonly consult?: InboundCommandRouterOptions["consult"];
    readonly sendConsultReply?: InboundCommandRouterOptions["sendConsultReply"];
    readonly reviewToolCall?: ReviewToolCall;
    readonly disabledPromptContributions?: readonly string[];
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
        /** The skills the worn agent may see. Absent means all of them. */
        allowedSkills?: readonly string[],
    ) => Promise<readonly PromptContribution[]>;
    /** Hooks for the session's turns; absent means none registered. */
    readonly hooks?: ToolHooks;
    /**
     * Variables layered over the inherited environment in the shells this
     * session's tools spawn. The owner chooses the variables; the engine
     * passes them through opaquely.
     */
    readonly toolEnv?: Readonly<Record<string, string>>;
    /**
     * The directory this session's project-scoped memory is keyed on,
     * resolved by the owner once per agent. Absent means the workspace.
     */
    readonly instructionRoot?: InstructionRoot;
}

/**
 * Creates the session's scratch directory and returns its canonical path.
 * Canonical because permission checks compare realpath-resolved tool paths
 * against it, and macOS spells the temp dir through a symlink. Synchronous
 * so session startup keeps its event order: an extra await lets a client's
 * first prompt race the initial history checkpoint.
 */
export function sessionScratchDir(sessionId: string): string {
    const dir = join(tmpdir(), "vera", sessionId);
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
}

function compactionContextForSettings(
    settings: ModelTurnSettings,
    model = settings.model,
): CompactionContext {
    const declared = model === settings.model
        ? settings.contextWindow
        : contextWindowForModel(
            settings.provider,
            model,
            settings.availableModels,
        );
    const capacity = effectiveContextWindow(declared, settings.contextLimit);
    return {
        model,
        ...(capacity === undefined ? {} : { capacity }),
    };
}

function latestCompactionContext(
    store: SessionStore,
    current?: CompactionContext,
): ContextMeasurement | undefined {
    const compaction = store.latestCompaction();
    if (compaction === undefined) {
        return undefined;
    }
    if (
        current !== undefined
        && (
            (compaction.measured.model !== undefined
                && compaction.measured.model !== current.model)
            || (
                compaction.measured.contextWindow !== undefined
                && current.capacity !== undefined
                && compaction.measured.contextWindow !== current.capacity
            )
        )
    ) {
        return undefined;
    }
    // A later provider response is a newer, authoritative measurement. Let
    // the protocol reconstruct it from the transcript rather than replacing
    // it with this older compaction baseline.
    if (store.activeEntries().some((entry) =>
        entry.timestamp > compaction.timestamp
        && entry.message.role === "assistant"
        && entry.message.usage.inputTokens > 0
    )) {
        return undefined;
    }
    return {
        tokens: compaction.measured.inputTokens,
        ...(compaction.measured.contextWindow === undefined
            ? {}
            : { capacity: compaction.measured.contextWindow }),
        ...(current?.capacity !== undefined
            && compaction.measured.contextWindow === undefined
            ? { capacity: current.capacity }
            : {}),
        estimated: compaction.measured.estimated,
    };
}

export async function runHeadlessLoop(
    endpoint: MessageChannel<AgentUpdate, EngineCommand>,
    adapter: ModelAdapter,
    model: string,
    reasoningEffort?: ModelReasoningEffort,
    options: RunHeadlessLoopOptions = {},
): Promise<void> {
    if (
        options.sessionStore !== undefined
        && (
            options.sessionId !== undefined
            || options.sessionPath !== undefined
            || options.resumeSessionPath !== undefined
        )
    ) {
        throw new Error(
            "An open session store cannot be combined with session paths",
        );
    }
    if (
        options.resumeSessionPath !== undefined
        && (options.sessionId !== undefined || options.sessionPath !== undefined)
    ) {
        throw new Error(
            "A resumed session cannot also specify a new session ID or path",
        );
    }
    const newSessionId = options.sessionId ?? randomUUID();
    const store = options.sessionStore ?? (
        options.resumeSessionPath === undefined
            ? await SessionStore.create(
                options.sessionPath ?? defaultSessionPath(newSessionId),
                { sessionId: newSessionId, cwd: process.cwd() },
            )
            : await SessionStore.open(options.resumeSessionPath)
    );
    const sessionId = store.header.id;
    const scratchDir = sessionScratchDir(sessionId);
    if (
        (options.readApprovalMode === undefined)
        !== (options.updateApprovalMode === undefined)
    ) {
        throw new Error(
            "Approval mode reads and updates must use the same owner",
        );
    }
    let localApprovalMode = store.approvalMode()
        ?? options.approvalMode
        ?? "auto";
    const readApprovalMode = options.readApprovalMode
        ?? (() => localApprovalMode);
    const updateApprovalMode = options.updateApprovalMode
        ?? (async (mode: ApprovalMode): Promise<ApprovalMode> => {
            await store.appendApprovalMode(mode);
            localApprovalMode = mode;
            return localApprovalMode;
        });
    const readPermissionGrants = () => store.permissionGrants();
    const readPermissionPreferences = () =>
        options.readPermissionPreferences?.() ?? [];
    const readPermissionInspection = () =>
        inspectPermissions(
            readApprovalMode(),
            options.permissionModes,
            readPermissionGrants(),
            readPermissionPreferences(),
        );
    const addPermissionGrants = async (
        grants: readonly PermissionGrantProposal[],
    ): Promise<void> => {
        await store.appendPermissionGrants(grants);
    };
    const removePermissionGrant = (id: string): Promise<boolean> =>
        store.revokePermissionGrant(id);
    const events = options.eventBus ?? new EngineEventBus();
    const protocol = createProtocolEncoder(
        endpoint,
        sessionAttachmentName(store),
        () => store.projectedHarnessMessages(),
        (provider, replayModel) => {
            const settings = options.readModelSettings?.();
            const declared = settings?.provider === provider
                    && settings.model === replayModel
                ? settings.contextWindow
                : contextWindowForModel(provider, replayModel);
            return effectiveContextWindow(declared, settings?.contextLimit);
        },
    );
    // Before the wire encoder: the ledger writes synchronously, so a client
    // reading it when the failure reaches the screen already sees this turn.
    if (options.modelFailureLedger !== undefined) {
        events.subscribe(createModelFailureRecorder({
            ledger: options.modelFailureLedger,
            sessionId,
        }));
    }
    events.subscribe(protocol);
    // A caller that names no path gets no log. The host names one for every
    // agent it starts, so only direct engine callers opt out, and they cannot
    // reach the home directory by omission.
    if (options.eventLogPath !== undefined) {
        events.subscribe(createJsonlEventLogger({
            path: options.eventLogPath,
            sessionId,
        }));
    }
    const messages = [...store.messages()];
    let inbound: InboundCommandRouter;
    // Assigned once the compaction closure exists, further down. Undefined
    // while the session has no strategy bound, which makes an asked-for
    // compaction a no-op rather than an error.
    let compactOnRequest: ((turnActive: boolean) => Promise<void>) | undefined;
    const timeline = new TimelineController({
        state: { messages, store },
        protocol,
        isBlocked: () => inbound.timelineBlocked(),
        sendReply: options.sendTimelineReply
            ?? ((_ownerId, reply): void => endpoint.send(reply)),
    });
    inbound = new InboundCommandRouter(endpoint, events, {
        appendHarnessMessage: async (text, tone) => {
            await store.appendHarnessMessage(text, tone);
            protocol.checkpoint(messages);
        },
        appendContext: async (contextMessages, harnessMessage) => {
            for (const message of contextMessages) {
                const hidden = { ...message, internal: true } as ModelMessage;
                await store.appendMessage(hidden);
                messages.push(hidden);
            }
            await store.appendHarnessMessage(
                harnessMessage.text,
                harnessMessage.tone,
            );
            protocol.checkpoint(messages);
        },
        compactNow: async (turnActive) => {
            await compactOnRequest?.(turnActive);
        },
        hasPendingDeliveryTurn: () =>
            store.pendingDeliveries().length > 0
            || store.hasUnansweredDeliveryTurn(),
        ...(options.readModelSettings === undefined
            ? {}
            : { readModelSettings: options.readModelSettings }),
        ...(options.updateModelSettings === undefined
            ? {}
            : { updateModelSettings: options.updateModelSettings }),
        ...(options.updateSessionModelSettings === undefined
            ? {}
            : {
                updateSessionModelSettings: options.updateSessionModelSettings,
            }),
        ...(options.readSessionModelSettingsHistory === undefined
            ? {}
            : {
                readSessionModelSettingsHistory:
                    options.readSessionModelSettingsHistory,
            }),
        ...(options.updateSessionPermissionMode === undefined
            ? {}
            : {
                updateSessionPermissionMode:
                    options.updateSessionPermissionMode,
            }),
        ...(options.wearAgent === undefined
            ? {}
            : { wearAgent: options.wearAgent }),
        ...(options.listAgents === undefined
            ? {}
            : { listAgents: options.listAgents }),
        ...(options.updateAgentDefaultPair === undefined
            ? {}
            : { updateAgentDefaultPair: options.updateAgentDefaultPair }),
        ...(options.readApprovalModeOrigin === undefined
            ? {}
            : { readApprovalModeOrigin: options.readApprovalModeOrigin }),
        ...(options.poolAdd === undefined
            ? {}
            : { poolAdd: options.poolAdd }),
        ...(options.poolRemove === undefined
            ? {}
            : { poolRemove: options.poolRemove }),
        ...(options.refreshCatalog === undefined
            ? {}
            : { refreshCatalog: options.refreshCatalog }),
        ...(options.poolName === undefined
            ? {}
            : { poolName: options.poolName }),
        ...(options.poolMove === undefined
            ? {}
            : { poolMove: options.poolMove }),
        readApprovalMode,
        readPermissionInspection,
        updateApprovalMode,
        ...(options.addPermissionPreference === undefined
            ? {}
            : { addPermissionPreference: options.addPermissionPreference }),
        ...(options.removePermissionPreference === undefined
            ? {}
            : {
                removePermissionPreference: options.removePermissionPreference,
            }),
        ...(options.updateSessionName === undefined
            ? {}
            : { updateSessionName: options.updateSessionName }),
        sendSessionNameReply: options.sendSessionNameReply
            ?? ((_ownerId, reply): void => endpoint.send(reply)),
        ...(options.consult === undefined ? {} : { consult: options.consult }),
        ...(options.sendConsultReply === undefined
            ? {}
            : { sendConsultReply: options.sendConsultReply }),
        addPermissionGrants,
        removePermissionGrant,
        handleTimelineCommand: (ownerId, command) =>
            timeline.handle(ownerId, command),
        detachTimelineOwner: (ownerId) => timeline.detachOwner(ownerId),
    });
    options.onInboundReady?.(inbound);
    const instructionRoot: InstructionRoot = options.instructionRoot
        ?? { path: store.header.cwd, source: "workspace" };
    const applyToolEffect = options.applyToolEffect
        ?? createSubagentEffectApplier({
            adapter,
            workspace: store.header.cwd,
            instructionRoot,
            scratchDir,
            // Settings the host may rewrite while this session runs are read
            // here rather than copied, so a subagent spawned later is given
            // what the settings say now, not what they said at start.
            get disabledPromptContributions() {
                return options.disabledPromptContributions;
            },
            get modelFallback() { return options.modelFallback; },
            get reviewer() { return options.reviewer; },
            get reviewers() { return options.reviewers; },
            get permissionModes() { return options.permissionModes; },
        });
    // A configured reviewer wins, because the point of configuring one is to
    // pay for a cheaper model than the agent. Without it the reviewer reads the
    // agent's model settings at review time, not the model this loop started
    // with, and it does not follow a fallback model the turn may have switched
    // to.
    //
    // The reviewer instance is kept across reviews so it can send transcript
    // deltas instead of the whole turn every time. Its conversation belongs to
    // the model that answered it, so changed settings start a new one rather
    // than continuing someone else's session.
    let activeReviewer: { key: string; review: ReviewToolCall } | undefined;
    const reviewToolCall: ReviewToolCall = options.reviewToolCall
        ?? ((request, signal) => {
            const configured = options.readReviewer?.() ?? options.reviewer;
            const current = options.readModelSettings?.()
                ?? {
                    model,
                    ...(reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort }),
                };
            const models = configured?.models ?? [current];
            const key = JSON.stringify([
                models,
                configured?.policy,
                configured?.timeoutMs,
                configured?.twoTier,
                configured?.escalationModel,
            ]);
            if (activeReviewer?.key !== key) {
                activeReviewer = {
                    key,
                    review: createRoutedToolReviewer(adapter, {
                        ...configured,
                        models,
                        ...(options.reviewLog === undefined
                            ? {}
                            : { log: options.reviewLog }),
                    }),
                };
            }
            return activeReviewer.review(request, signal);
        });
    const contextWatch: ContextWatch = {};
    const compaction = options.compaction;
    // Read at each compaction rather than once: the user can switch models
    // between turns, and the window that matters is the one the next request
    // will be sent into. The settings carry a window the catalog may not
    // have: a locally served model's was measured at discovery.
    const compactionCapacity = (
        context?: CompactionContext,
    ): number | undefined => {
        if (context?.capacity !== undefined) {
            return context.capacity;
        }
        const settings = options.readModelSettings?.();
        return settings?.contextWindow
            ?? contextWindowForModel(
                settings?.provider,
                settings?.model ?? model,
            );
    };
    // A fresh reading over the next context, including a user prompt that has
    // passed attachment validation but is not durable yet. Without that
    // pending message, one large prompt can jump from below the trigger to
    // beyond the provider's window. The last request's fixed overhead (system
    // prompt, tools, instructions) is carried over because it remains true.
    const measureContextNow = (
        pendingMessages: readonly ModelMessage[] = [],
        context?: CompactionContext,
    ): ContextMeasurement => {
        const watched = contextWatch.measurement;
        const overhead = watched === undefined
            ? 0
            : Math.max(
                0,
                watched.tokens
                    - (contextWatch.messageTokens ?? watched.tokens),
            );
        const capacity = compactionCapacity(context);
        return {
            tokens: measureMessages([
                ...store.modelContext(),
                ...pendingMessages,
            ]) + overhead,
            ...(capacity === undefined ? {} : { capacity }),
            estimated: true,
        };
    };
    // Reported once. The mismatch is a fact about the configuration, not news
    // on every turn that hits it.
    let budgetWarned = false;
    const budgetWarning = (
        measurement: ContextMeasurement,
        options: SessionCompactionOptions,
    ): { readonly warning: string } | undefined => {
        if (budgetWarned) {
            return undefined;
        }
        const warning = compactionBudgetWarning(measurement, options);
        if (warning === undefined) {
            return undefined;
        }
        budgetWarned = true;
        return { warning };
    };
    const runCompaction = compaction === undefined
        ? undefined
        : async (
            signal: AbortSignal,
            force = false,
            pendingMessages: readonly ModelMessage[] = [],
            context?: CompactionContext,
        ): Promise<void> => {
            const measurement = measureContextNow(pendingMessages, context);
            const compactionModel = context?.model
                ?? options.readModelSettings?.().model
                ?? model;
            // Forced only when a user asked. Compacting early is the whole
            // point of asking, so the trigger fraction does not apply, but
            // every other rule still does.
            if (!force && !shouldCompact(measurement, compaction.trigger)) {
                return;
            }
            events.emit({
                type: "compaction_started",
                strategy: compaction.strategy.id,
                ...(budgetWarning(measurement, compaction) ?? {}),
            });
            const result = await compactSession({
                store,
                strategy: compaction.strategy,
                models: compaction.models,
                model: compactionModel,
                ...(compaction.diagnostics === undefined
                    ? {}
                    : { diagnostics: compaction.diagnostics }),
                ...(compaction.trigger === undefined
                    ? {}
                    : { trigger: compaction.trigger }),
                ...(compaction.targetTokens === undefined
                    ? {}
                    : { targetTokens: compaction.targetTokens }),
                ...(compaction.retainedUserTurns === undefined
                    ? {}
                    : { retainedUserTurns: compaction.retainedUserTurns }),
            }, measurement, signal);
            events.emit({
                type: "compaction_finished",
                strategy: compaction.strategy.id,
                outcome: result.outcome,
                ...("reason" in result ? { reason: result.reason } : {}),
                ...(result.outcome === "compacted"
                    ? { before: result.before, after: result.after }
                    : {}),
            });
            if (result.outcome === "compacted") {
                // The compaction result already measured the next request,
                // including the fixed prompt overhead. Publish it now so a
                // client does not keep showing the pre-compaction estimate
                // until another model request happens.
                const refreshedMeasurement: ContextMeasurement = {
                    tokens: result.after,
                    ...(measurement.capacity === undefined
                        ? {}
                        : { capacity: measurement.capacity }),
                    estimated: measurement.estimated,
                };
                events.emit({
                    type: "context_measured",
                    model: compactionModel,
                    measurement: refreshedMeasurement,
                });
                // The measurement that triggered this described the request
                // that no longer exists. Leaving it in place is the stale
                // trigger that makes a session compact every turn.
                contextWatch.measurement = undefined;
                contextWatch.messageTokens = undefined;
            }
        };
    if (compaction !== undefined && runCompaction !== undefined) {
        compactOnRequest = async (turnActive) => {
            if (turnActive) {
                events.emit({
                    type: "compaction_finished",
                    strategy: compaction.strategy.id,
                    outcome: "busy",
                });
                return;
            }
            await runCompaction(new AbortController().signal, true);
        };
    }
    const state: RunTurnState = {
        sessionId,
        messages,
        store,
        modelContext: () => store.modelContext(),
        contextWatch,
        ...(runCompaction === undefined
            ? {}
            : {
                compact: (
                    signal: AbortSignal,
                    pendingMessages: readonly ModelMessage[] = [],
                    context?: CompactionContext,
                ) => runCompaction(
                    signal,
                    false,
                    pendingMessages,
                    context,
                ),
            }),
        deliveryInbox: store,
        toolRuntime: newStashingToolRuntime(
            store.header.cwd,
            store.header.id,
            options.toolEnv,
            instructionRoot.path,
        ),
        instructionRoot,
        inbound,
        events,
        hooks: options.hooks ?? new ToolHooks(),
        approvalMode: localApprovalMode,
        applyToolEffect,
        ...(options.applyCommittedToolEffect === undefined
            ? {}
            : { applyCommittedToolEffect: options.applyCommittedToolEffect }),
        enabledToolEffects: options.enabledToolEffects ?? ["spawn_subagent"],
        enableUserInteraction: options.enableUserInteraction ?? true,
        extensionTools: options.extensionTools ?? [],
        offerTools: options.offerTools ?? true,
        loadOptionalContext: options.loadOptionalContext ?? true,
        // Asked at each turn, not captured for the session: a setting the
        // user changes mid-session reaches the next turn with no restart.
        get modelFallback() { return options.modelFallback; },
        ...(options.effortPool === undefined
            ? {}
            : { effortPool: options.effortPool }),
        ...(options.readModelSettings === undefined
            ? {}
            : { readModelSettings: options.readModelSettings }),
        // Read rather than captured: a wear applied between turns has to
        // reach the next turn without rebuilding the loop.
        ...(options.readAgentWear === undefined
            ? {}
            : { readAgentWear: options.readAgentWear }),
        firedNudges: new Set<string>(),
        readApprovalMode,
        readPermissionGrants,
        readPermissionPreferences,
        get permissionModes() { return options.permissionModes; },
        reviewToolCall,
        reviewToolCallForProfile: createReviewerProfileRouter(
            reviewToolCall,
            adapter,
            () => options.reviewers,
            options.reviewLog,
        ),
        promptPrefixTracker: new PromptPrefixTracker(),
        readImageContent: (attachmentId) =>
            readSessionImageContent(store, attachmentId),
        scratchDir,
        toolResultSpill: createToolResultSpill(scratchDir),
        get disabledPromptContributions() {
            return options.disabledPromptContributions;
        },
        ...(options.loadContextualContributions === undefined ? {} : {
            loadContextualContributions: options.loadContextualContributions,
        }),
    };
    const startupSettings = options.readModelSettings?.();
    const startupContext = startupSettings === undefined
        ? { model }
        : compactionContextForSettings(startupSettings);
    protocol.checkpoint(
        state.messages,
        store.activeMessageIds(),
        latestCompactionContext(store, startupContext),
    );

    while (true) {
        const checkpointMessages = [...state.messages];
        await runTurn(adapter, model, state, reasoningEffort);
        if (
            state.messages.length !== checkpointMessages.length
            || state.messages.some((message, index) =>
                message !== checkpointMessages[index]
            )
        ) {
            protocol.checkpoint(state.messages, store.activeMessageIds());
        }
    }
}

/**
 * `readProfiles` is asked at each review rather than read once, so a profile
 * the user repoints between turns reaches the next review in this session. The
 * reviewer instance is still kept, keyed by the settings it was built from:
 * changed settings start a new conversation instead of continuing one that
 * belongs to a model no longer in use.
 */
export function createReviewerProfileRouter(
    defaultReviewer: ReviewToolCall,
    adapter: ModelAdapter,
    readProfiles: () => Readonly<Record<string, ToolReviewerSettings>> | undefined,
    log?: ReviewLog,
): NonNullable<RunTurnState["reviewToolCallForProfile"]> {
    const reviewers = new Map<string, { key: string; review: ReviewToolCall }>();
    return (profile, request, signal) => {
        if (profile === "default") {
            return defaultReviewer(request, signal);
        }
        const settings = readProfiles()?.[profile];
        if (settings === undefined) {
            return Promise.resolve({
                decision: "unavailable",
                reason: `Reviewer profile ${profile} is unavailable.`,
                riskLevel: "high",
                userAuthorization: "unknown",
            });
        }
        const key = JSON.stringify(settings);
        let reviewer = reviewers.get(profile);
        if (reviewer?.key !== key) {
            reviewer = {
                key,
                review: createRoutedToolReviewer(adapter, {
                    ...settings,
                    ...(log === undefined ? {} : { log }),
                }),
            };
            reviewers.set(profile, reviewer);
        }
        return reviewer.review(request, signal);
    };
}

/**
 * One read of a setting the host may rewrite between turns, so the test and the
 * value passed on cannot come from two different answers.
 */
function fallbackFor(
    fallback: RunTurnState["modelFallback"],
    provider: string | undefined,
): { fallback?: NonNullable<RunTurnState["modelFallback"]> } {
    if (
        fallback === undefined
        || (fallback.provider !== undefined && fallback.provider !== provider)
    ) {
        return {};
    }
    return { fallback };
}

export async function runTurn(
    adapter: ModelAdapter,
    model: string,
    state: RunTurnState,
    reasoningEffort?: ModelReasoningEffort,
): Promise<AssistantMessage> {
    // The permission classifier is synchronous but the bash parser it uses
    // loads a wasm grammar asynchronously. Awaiting it here means no client
    // has a boot-order dependency to remember; the work happens once.
    await initBashParser();
    const turn = await state.inbound.startTurn();
    let assistantMessage: AssistantMessage;

    try {
        const modelSettings = turn.modelSettings
            ?? state.readModelSettings?.()
            ?? {
                provider: "unknown",
                model,
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            };
        let activeModel = modelSettings.model;
        // A fallback can land on a model with no reasoning effort at all, and
        // it stays active for the rest of the turn. The effort has to follow
        // the model, or the next request in the tool loop would restore an
        // effort the fallback model cannot be asked for.
        let turnReasoningEffort = modelSettings.reasoningEffort;
        const turnApprovalMode = turn.approvalMode
            ?? state.readApprovalMode?.()
            ?? state.approvalMode;
        // Substitutions settled before the round's message exists. They are
        // drained into that message once it does.
        const pendingSubstitutions: ModelSubstitution[] = [];
        let maxTokens = DEFAULT_MODEL_MAX_TOKENS;
        let lengthContinuations = 0;
        const reviewBreaker = createReviewCircuitBreaker();
        // Fixed here, with the rest of the agent's snapshot, so the turn runs
        // under exactly one agent from the tools it is offered to the skills
        // its scripts can reach.
        const wear = state.readAgentWear?.();
        state.firedNudges?.clear();
        state.toolRuntime.allowedTools = wear?.tools;
        state.toolRuntime.allowedSkills = wear?.skills;
        const offered = state.offerTools === false
            ? []
            : toolDefinitionsForCapabilities(
                state.applyToolEffect === undefined
                    ? []
                    : state.enabledToolEffects ?? [],
                state.enableUserInteraction === true,
                state.extensionTools,
            );
        // A tool the agent does not offer is not described to the model, so
        // the ordinary case is that it is never called. Gate A is what makes
        // the extraordinary case safe.
        const tools = wear?.tools === undefined
            ? offered
            : offered.filter((tool) => wear.tools!.includes(tool.name));
        const userMessage: UserMessage | undefined = turn.triggeredByDelivery
            ? undefined
            : {
                role: "user",
                content: [
                    { type: "text", text: turn.prompt.content },
                    ...(turn.prompt.attachmentIds ?? []).map((attachmentId) => ({
                        type: "image_attachment" as const,
                        attachmentId,
                    })),
                ],
            };
        const imageCache = new Map<string, ImageContent>();
        const hasImageAttachments = userMessage?.content.some(
            (block) => block.type === "image_attachment",
        ) === true;
        if (
            hasImageAttachments
            && !acceptsImageInput(
                adapter,
                modelSettings.provider,
                activeModel,
            )
        ) {
            // Keep the user's prompt in the session even when this model
            // cannot run it. The attachment is already durable, and a model
            // switch can then retry the same turn instead of losing it during
            // the capability preflight.
            if (userMessage !== undefined) {
                await commitMessage(state, userMessage);
                state.events.emit({ type: "turn_started", message: userMessage });
            }
            assistantMessage = attachmentErrorMessage(
                activeModel,
                "the selected model provider does not support image input",
            );
            // Committed so the refusal survives a rebuild or resume: an
            // emitted-only reply leaves the session showing a user message
            // with no answer at all.
            await commitMessage(state, assistantMessage);
            state.events.emit({ type: "turn_finished", message: assistantMessage });
            return assistantMessage;
        }
        try {
            await hydrateImageAttachments(
                userMessage === undefined
                    ? state.messages
                    : [...state.messages, userMessage],
                requireImageReader(state),
                imageCache,
            );
        } catch (error) {
            assistantMessage = attachmentErrorMessage(
                activeModel,
                errorMessage(error),
            );
            state.events.emit({ type: "turn_finished", message: assistantMessage });
            return assistantMessage;
        }
        await drainPendingDeliveries(state);
        // Before the prompt is accepted, so a compaction that fails cannot
        // strand a message the user has already sent, and after the deliveries
        // are drained, so nothing pending disappears into a projection that
        // was assembled without it.
        if (state.compact !== undefined) {
            await state.compact(
                turn.signal,
                userMessage === undefined ? [] : [userMessage],
                compactionContextForSettings(modelSettings, activeModel),
            );
        }
        if (userMessage === undefined) {
            state.events.emit({ type: "delivery_turn_started" });
        } else {
            await commitMessage(state, userMessage);
            state.events.emit({ type: "turn_started", message: userMessage });
        }

        // Read once for the turn rather than per model round: the catalog is
        // parsed from disk on every call, and a long tool loop would pay for
        // it on each pass to answer a question whose only moving part is which
        // model a fallback landed on.
        const catalogModels = availableModels();
        // The settings carry a window neither list always has: the configured
        // model's was measured at discovery when it is served locally. The
        // discovered list covers the models a fallback can land on, and the
        // shipped catalog covers the rest.
        const capacityForModel = (model: string): number | undefined => {
            const declared = (model === modelSettings.model
                ? modelSettings.contextWindow
                : undefined)
            ?? contextWindowForModel(
                modelSettings.provider,
                model,
                modelSettings.availableModels,
                catalogModels,
            );
            return effectiveContextWindow(declared, modelSettings.contextLimit);
        };

        while (true) {
            // Before the request, not after a refusal: a level the pool
            // already knows this model rejects would otherwise be sent again
            // every single turn, buying the same refusal each time.
            const preflight = state.effortPool === undefined
                    || turnReasoningEffort === undefined
                ? undefined
                : preflightEffort(
                    state.effortPool,
                    {
                        provider: modelSettings.provider ?? "",
                        model: activeModel,
                    },
                    turnReasoningEffort,
                );
            if (preflight !== undefined) {
                turnReasoningEffort = preflight.using;
                pendingSubstitutions.push({
                    model: activeModel,
                    requested: preflight.requested,
                    ...(preflight.using === undefined
                        ? {}
                        : { using: preflight.using }),
                    reason: preflight.reason,
                    scope: "effort",
                });
                state.events.emit({
                    type: "model_effort_coarsened",
                    model: activeModel,
                    requested: preflight.requested,
                    ...(preflight.using === undefined
                        ? {}
                        : { using: preflight.using }),
                    reason: preflight.reason,
                });
            }
            const projectInstructions = state.loadOptionalContext !== false
                ? await loadProjectInstructions(state.toolRuntime.workspace)
                : { files: [], warnings: [] };
            const memory = state.loadOptionalContext !== false
                ? await loadMemory(
                    state.instructionRoot
                        ?? {
                            path: state.toolRuntime.workspace,
                            source: "workspace",
                        },
                    undefined,
                    userMessage === undefined
                        ? {}
                        : {
                            query: userMessage.content
                                .filter((block) => block.type === "text")
                                .map((block) => block.text)
                                .join("\n"),
                        },
                )
                : undefined;
            const scratchState = state.loadOptionalContext === false
                    || state.scratchDir === undefined
                ? undefined
                : await loadScratchState(state.scratchDir);
            const requestDate = new Date();
            const additionalContextualContributions =
                state.loadOptionalContext === false
                    || state.loadContextualContributions === undefined
                    ? undefined
                    : await state.loadContextualContributions(
                        state.instructionRoot
                            ?? {
                                path: state.toolRuntime.workspace,
                                source: "workspace",
                            },
                        state.readAgentWear?.()?.skills,
                    );
            const projection = projectModelRequest({
                ...(modelSettings.provider === undefined
                    ? {}
                    : { provider: modelSettings.provider }),
                model: activeModel,
                maxTokens,
                ...(turnReasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: turnReasoningEffort }),
                messages: state.modelContext?.() ?? state.messages,
                tools,
                workspace: state.toolRuntime.workspace,
                ...(state.scratchDir === undefined
                    ? {}
                    : { scratchDir: state.scratchDir }),
                date: requestDate,
                projectInstructions,
                memory,
                ...(scratchState === undefined ? {} : { scratchState }),
                ...(state.disabledPromptContributions === undefined ? {} : {
                    disabledPromptContributions:
                        state.disabledPromptContributions,
                }),
                ...(additionalContextualContributions === undefined ? {} : {
                    additionalContextualContributions,
                }),
                // Fixed at turn start with the rest of the agent's snapshot,
                // so a turn always runs under one complete agent.
                ...(state.readAgentWear?.()?.instructions === undefined
                        || state.readAgentWear()!.instructions.length === 0
                    ? {}
                    : { agentInstructions: state.readAgentWear()!.instructions }),
                signal: turn.signal,
            });
            const request = projection.request;
            const promptContributions = promptContributionMetadata(
                projection.promptContributions,
            );
            const prefixDrift = state.promptPrefixTracker?.observe(
                promptContributions,
            );
            if (prefixDrift !== undefined) {
                state.events.emit({
                    type: "prompt_prefix_drift",
                    ...prefixDrift,
                });
            }
            state.events.emit({
                type: "model_request",
                model: request.model,
                maxTokens: request.maxTokens,
                ...(request.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: request.reasoningEffort }),
                systemPrompt: request.systemPrompt,
                messages: request.messages,
                tools: request.tools,
                promptContributions,
                toolResultBytes: measureToolResultBytes(request.messages),
            });
            const measurement = measureProjectedRequest(
                request,
                capacityForModel(activeModel),
            );
            state.events.emit({
                type: "context_measured",
                model: activeModel,
                measurement,
            });
            if (state.contextWatch !== undefined) {
                state.contextWatch.measurement = measurement;
                state.contextWatch.messageTokens = measureMessages(
                    request.messages,
                );
            }
            // Reset per model round: they ride on the message that round
            // produced, which is where a replayed transcript reads them from.
            // Anything decided before the request was built is carried in.
            const substitutions: ModelSubstitution[] = pendingSubstitutions
                .splice(0, pendingSubstitutions.length);
            // Asking whether the model reads images can reach the provider, so
            // it is only asked when the request carries one.
            const carriesImage = request.messages.some((message) =>
                message.role === "user"
                && message.content.some(
                    (block) => block.type === "image_attachment",
                )
            );
            let modelRequest;
            try {
                modelRequest = {
                    ...request,
                    messages: await hydrateImageAttachments(
                        request.messages,
                        requireImageReader(state),
                        imageCache,
                        carriesImage && !acceptsImageInput(
                            adapter,
                            modelSettings.provider,
                            activeModel,
                        ),
                    ),
                };
            } catch (error) {
                assistantMessage = attachmentErrorMessage(
                    activeModel,
                    errorMessage(error),
                );
                await commitMessage(state, assistantMessage);
                state.events.emit({ type: "turn_finished", message: assistantMessage });
                return assistantMessage;
            }
            const modelRequestStarted = performance.now();
            assistantMessage = await requestModelWithRecovery(
                adapter,
                modelRequest,
                {
                    onEvent(event): void {
                        if (event.type === "error") {
                            const cause = event.error.cause instanceof Error
                                ? event.error.cause
                                : undefined;
                            state.events.emit({
                                type: "model_stream_error",
                                error: sanitizeDiagnosticText(event.error.message),
                                errorName: sanitizeDiagnosticText(event.error.name),
                                ...(event.error.stack === undefined
                                    ? {}
                                    : {
                                        stack: sanitizeDiagnosticText(
                                            event.error.stack,
                                        ),
                                    }),
                                ...(cause === undefined
                                    ? {}
                                    : {
                                        cause: {
                                            name: sanitizeDiagnosticText(cause.name),
                                            message: sanitizeDiagnosticText(
                                                cause.message,
                                            ),
                                            ...(cause.stack === undefined
                                                ? {}
                                                : {
                                                    stack: sanitizeDiagnosticText(
                                                        cause.stack,
                                                    ),
                                                }),
                                        },
                                    }),
                                ...(event.error instanceof ProviderFailureError
                                    ? {
                                        failure: sanitizedProviderFailure(
                                            event.error.failure,
                                        ),
                                    }
                                    : {}),
                                message: sanitizedErrorMessage(event.message),
                            });
                            return;
                        }
                        state.events.emit({ type: "model_stream", event });
                    },
                    onRetry(retry): void {
                        state.events.emit({
                            type: "model_retry_scheduled",
                            ...retry,
                            failure: sanitizedProviderFailure(retry.failure),
                        });
                    },
                    onCoarsened(coarsened): void {
                        turnReasoningEffort = coarsened.using;
                        substitutions.push({
                            model: coarsened.model,
                            requested: coarsened.requested,
                            using: coarsened.using,
                            reason: coarsened.reason,
                            scope: "effort",
                        });
                        state.events.emit({
                            type: "model_effort_coarsened",
                            ...coarsened,
                        });
                    },
                    onEffortSubstituted(substituted): void {
                        substitutions.push({
                            model: substituted.model,
                            requested: substituted.requested,
                            ...(substituted.using === undefined
                                ? {}
                                : { using: substituted.using }),
                            reason: substituted.reason,
                            scope: "effort",
                        });
                        state.events.emit({
                            type: "model_effort_coarsened",
                            ...substituted,
                        });
                    },
                    onFallback(fallback): void {
                        activeModel = fallback.toModel;
                        substitutions.push({
                            model: fallback.fromModel,
                            requested: fallback.fromModel,
                            using: fallback.toModel,
                            reason: fallback.failure.message,
                            scope: "model",
                        });
                        turnReasoningEffort = reasoningEffortForModel(
                            modelSettings.provider,
                            fallback.toModel,
                            turnReasoningEffort,
                        );
                        state.events.emit({
                            type: "model_fallback_selected",
                            ...fallback,
                            failure: sanitizedProviderFailure(fallback.failure),
                        });
                        // The same request is sent again to a model with its
                        // own window, so the share of it that is filled moves
                        // even though nothing was added to the request.
                        const remeasured = remeasuredAgainst(
                            measurement,
                            capacityForModel(activeModel),
                        );
                        state.events.emit({
                            type: "context_measured",
                            model: activeModel,
                            measurement: remeasured,
                        });
                        if (state.contextWatch !== undefined) {
                            state.contextWatch.measurement = remeasured;
                        }
                    },
                    ...fallbackFor(
                        state.modelFallback,
                        modelSettings.provider,
                    ),
                    ...(state.effortPool === undefined
                        ? {}
                        : { coarsening: { pool: state.effortPool } }),
                    ...(state.waitForModelRetry === undefined
                        ? {}
                        : { wait: state.waitForModelRetry }),
                },
            );
            assistantMessage = {
                ...assistantMessage,
                durationMs: performance.now() - modelRequestStarted,
            };
            assistantMessage = sanitizedErrorMessage(assistantMessage);
            assistantMessage = requireVisibleTerminalResponse(assistantMessage);
            if (
                state.offerTools === false
                && assistantMessage.stopReason === "tool_use"
            ) {
                assistantMessage = rejectUnavailableToolCalls(assistantMessage);
            }
            if (substitutions.length > 0) {
                assistantMessage = { ...assistantMessage, substitutions };
            }
            let preparedToolCalls: readonly PreparedToolCall[] = [];
            if (assistantMessage.stopReason === "tool_use") {
                const prepared = await prepareAssistantToolCalls(
                    state,
                    assistantMessage,
                );
                assistantMessage = prepared.message;
                preparedToolCalls = prepared.toolCalls;
            }
            await commitMessage(state, assistantMessage);

            if (assistantMessage.stopReason === "length") {
                const continuation = nextLengthContinuation(
                    maxTokens,
                    lengthContinuations,
                );
                if (continuation === undefined) {
                    break;
                }
                state.events.emit({
                    type: "model_length_continuation",
                    model: activeModel,
                    previousMaxTokens: continuation.previousMaxTokens,
                    nextMaxTokens: continuation.nextMaxTokens,
                    continuation: continuation.continuation,
                    maxContinuations: continuation.maxContinuations,
                });
                const continuationMessage: UserMessage = {
                    role: "user",
                    content: [{ type: "text", text: continuation.prompt }],
                    internal: true,
                };
                await commitMessage(state, continuationMessage);
                maxTokens = continuation.nextMaxTokens;
                lengthContinuations = continuation.continuation;
                continue;
            }

            if (assistantMessage.stopReason !== "tool_use") {
                break;
            }

            let toolIndex = 0;
            let interrupt: string | undefined;
            while (toolIndex < preparedToolCalls.length) {
                const first = preparedToolCalls[toolIndex]!;
                if (!toolMayRunInParallel(
                    first.toolCall.name,
                    state.extensionTools,
                )) {
                    interrupt = await finishToolCalls(state, [
                        executePreparedTool(
                            state,
                            first,
                            turn.signal,
                            turnApprovalMode,
                            {
                                model: activeModel,
                                ...(turnReasoningEffort === undefined
                                    ? {}
                                    : {
                                        reasoningEffort: turnReasoningEffort,
                                    }),
                            },
                            reviewBreaker,
                        ),
                    ]);
                    if (interrupt !== undefined) {
                        break;
                    }
                    toolIndex += 1;
                    continue;
                }

                const parallelCalls: PreparedToolCall[] = [];
                while (
                    toolIndex < preparedToolCalls.length
                    && toolMayRunInParallel(
                        preparedToolCalls[toolIndex]!.toolCall.name,
                        state.extensionTools,
                    )
                ) {
                    parallelCalls.push(preparedToolCalls[toolIndex]!);
                    toolIndex += 1;
                }
                interrupt = await finishToolCalls(
                    state,
                    parallelCalls.map((prepared) =>
                        executePreparedTool(
                            state,
                            prepared,
                            turn.signal,
                            turnApprovalMode,
                            {
                                model: activeModel,
                                ...(turnReasoningEffort === undefined
                                    ? {}
                                    : {
                                        reasoningEffort: turnReasoningEffort,
                                    }),
                            },
                            reviewBreaker,
                        )
                    ),
                );
                if (interrupt !== undefined) {
                    break;
                }
            }
            if (interrupt !== undefined) {
                // The results are already committed, so the transcript shows
                // what was denied. The turn stops here rather than handing the
                // model another chance to work around the reviewer.
                assistantMessage = reviewInterruptedMessage(
                    activeModel,
                    interrupt,
                );
                await commitMessage(state, assistantMessage);
                break;
            }
            // Every call and result is now durable. This is the only safe
            // boundary inside a tool turn: compacting any earlier could put a
            // call in the summary while its result was still being produced.
            const capacity = capacityForModel(activeModel);
            await state.compact?.(turn.signal, [], {
                model: activeModel,
                ...(capacity === undefined ? {} : { capacity }),
            });
        }
    } finally {
        state.inbound.finishTurn();
    }

    state.events.emit({ type: "turn_finished", message: assistantMessage });
    return assistantMessage;
}

function requireImageReader(
    state: RunTurnState,
): (attachmentId: string) => Promise<ImageContent> {
    return state.readImageContent ?? (async (attachmentId) => {
        throw new Error(`Image attachment ${attachmentId} cannot be read`);
    });
}

function sanitizedProviderFailure(failure: ProviderFailure): ProviderFailure {
    return {
        ...failure,
        message: sanitizeDiagnosticText(failure.message),
        ...(failure.providerErrorType === undefined
            ? {}
            : {
                providerErrorType: sanitizeDiagnosticText(
                    failure.providerErrorType,
                ),
            }),
        ...(failure.providerCode === undefined
            ? {}
            : {
                providerCode: sanitizeDiagnosticText(failure.providerCode),
            }),
        ...(failure.providerName === undefined
            ? {}
            : {
                providerName: sanitizeDiagnosticText(failure.providerName),
            }),
        ...(failure.providerMessage === undefined
            ? {}
            : {
                providerMessage: sanitizeDiagnosticText(
                    failure.providerMessage,
                ),
            }),
    };
}

function sanitizedErrorMessage(message: AssistantMessage): AssistantMessage {
    return message.errorMessage === undefined
        ? message
        : {
            ...message,
            errorMessage: sanitizeDiagnosticText(message.errorMessage),
        };
}

function reviewInterruptedMessage(
    model: string,
    detail: string,
): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        source: { provider: "vera", api: "review", model },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: detail,
    };
}

function attachmentErrorMessage(model: string, detail: string): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        source: { provider: "vera", api: "attachment", model },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: `Image attachment unavailable: ${detail}`,
    };
}

async function drainPendingDeliveries(state: RunTurnState): Promise<void> {
    const inbox = state.deliveryInbox;
    if (inbox === undefined) {
        return;
    }
    for (const delivery of inbox.pendingDeliveries()) {
        const message = deliveryMessage(delivery);
        const entry = await inbox.appendDeliveryMessage(delivery.id, message);
        state.messages.push(entry.message);
    }
}

function deliveryMessage(delivery: SessionDeliveryEntry): UserMessage {
    const kind = delivery.kind ?? "completion";
    const body = kind === "attention" || kind === "peer"
        ? [
            "<agent_message>",
            `  <delivery_id>${escapeXml(delivery.id)}</delivery_id>`,
            `  <agent_id>${escapeXml(delivery.sourceAgentId)}</agent_id>`,
            "  <status>attention</status>",
            `  <message>${escapeXml(delivery.content)}</message>`,
            "</agent_message>",
        ]
        : [
            "<task_notification>",
            `  <delivery_id>${escapeXml(delivery.id)}</delivery_id>`,
            `  <agent_id>${escapeXml(delivery.sourceAgentId)}</agent_id>`,
            "  <status>completed</status>",
            `  <summary>${escapeXml(delivery.content)}</summary>`,
            "</task_notification>",
        ];
    return {
        role: "user",
        internal: true,
        content: [{
            type: "text",
            text: body.join("\n"),
        }],
    };
}

function escapeXml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

const REVIEW_REJECTION_INSTRUCTIONS =
    "Do not attempt to achieve the same outcome via workaround, indirect"
    + " execution, or policy circumvention. Proceed only with a materially safer"
    + " alternative, or if the user explicitly approves the action after being"
    + " informed of the risk. Otherwise, stop and request user input.";

const REVIEW_TIMEOUT_INSTRUCTIONS =
    "The automatic permission approval review did not finish. Do not assume the"
    + " action is unsafe on that basis. You may retry once, or ask the user for"
    + " guidance or explicit approval.";

interface CompletedToolCall {
    readonly result: ToolResultMessage;
    readonly afterCommit?: CommitEffect;
    /** Set when the turn must stop after this result is committed. */
    readonly interrupt?: string;
}

interface PreparedToolCall {
    readonly toolCall: ToolCallContent;
    readonly hookResult: PreToolUseHookResult;
    /**
     * Why the worn agent does not offer this tool.
     *
     * Set before the hooks run, and the hooks do not run when it is set: a
     * tool the agent does not have is not a tool call to be rewritten, it is
     * one that never happens.
     */
    readonly scopeDenial?: string;
}

interface PreparedAssistantToolCalls {
    readonly message: AssistantMessage;
    readonly toolCalls: readonly PreparedToolCall[];
}

async function prepareAssistantToolCalls(
    state: RunTurnState,
    message: AssistantMessage,
): Promise<PreparedAssistantToolCalls> {
    const preparedById = new Map<string, PreparedToolCall>();
    for (const block of message.content) {
        if (block.type !== "tool_call") {
            continue;
        }
        const original = hookToolCall(block);
        // Gate A, on the name, before anything else touches the call. A
        // pre-tool hook cannot rename a call, so the name checked here is the
        // name that would execute.
        if (!agentAllowsTool(state.readAgentWear?.(), block.name)) {
            preparedById.set(block.id, {
                toolCall: block,
                hookResult: { power: "observe" },
                scopeDenial:
                    `The agent you are wearing does not offer the ${block.name} tool.`,
            });
            continue;
        }
        let outcome: PreToolUseOutcome;
        try {
            outcome = await state.hooks.runPreToolUse({
                type: "pre_tool_use",
                toolCall: original,
                ...(state.sessionId === undefined
                    ? {}
                    : { sessionId: state.sessionId }),
                workspace: state.toolRuntime.workspace,
            }, { timeoutMs: PRE_TOOL_HOOK_TIMEOUT_MS });
        } catch (error) {
            const message = errorMessage(error);
            state.events.emit({
                type: "tool_hook_failed",
                phase: "pre_tool_use",
                toolCall: original,
                error: message,
            });
            outcome = {
                toolCall: original,
                result: {
                    power: "block",
                    reason: `pre_tool_use hook failed: ${message}`,
                },
            };
        }
        const inputChanged = !sameJson(original.input, outcome.toolCall.input);
        const effective: ToolCallContent = {
            type: "tool_call",
            id: outcome.toolCall.id,
            name: outcome.toolCall.name,
            input: outcome.toolCall.input,
            ...(inputChanged
                ? {}
                : block.signature === undefined
                    ? {}
                    : { signature: block.signature }),
        };
        const prepared = {
            toolCall: effective,
            hookResult: outcome.result,
        };
        preparedById.set(block.id, prepared);
        if (inputChanged) {
            state.events.emit({
                type: "tool_input_changed",
                original,
                effective: outcome.toolCall,
            });
        }
    }
    return {
        message: {
            ...message,
            content: message.content.map((block) =>
                block.type === "tool_call"
                    ? preparedById.get(block.id)!.toolCall
                    : block
            ),
        },
        toolCalls: message.content.flatMap((block) =>
            block.type === "tool_call"
                ? [preparedById.get(block.id)!]
                : []
        ),
    };
}

async function executePreparedTool(
    state: RunTurnState,
    prepared: PreparedToolCall,
    signal: AbortSignal,
    approvalMode: ApprovalMode,
    modelSettings: ModelTurnSettings,
    breaker: ReviewCircuitBreaker,
): Promise<CompletedToolCall> {
    const toolCall = prepared.toolCall;
    const hookCall = hookToolCall(toolCall);
    if (prepared.scopeDenial !== undefined) {
        return {
            result: deniedByPolicy(
                state,
                toolCall,
                prepared.scopeDenial,
                undefined,
                "agent-scope",
            ),
        };
    }
    if (prepared.hookResult.power === "block") {
        return {
            result: deniedToolResult(toolCall, prepared.hookResult.reason),
        };
    }
    if (prepared.hookResult.power === "replace") {
        const replacement = hookResultMessage(
            toolCall,
            prepared.hookResult.result,
        );
        state.events.emit({ type: "tool_execution_started", toolCall });
        state.events.emit({
            type: "tool_execution_replaced",
            toolCall: hookCall,
            result: replacement,
        });
        return finishExecutedTool(state, toolCall, hookCall, replacement, 0);
    }

    const permissionContext = await resolvePermissionToolCall(
        state.toolRuntime.workspace,
        hookCall,
    );
    const permissionOptions = {
        permissionModes: state.permissionModes,
        permissionPreferences: state.readPermissionPreferences?.() ?? [],
        extensionTools: state.extensionTools,
        ...(state.scratchDir === undefined
            ? {}
            : { scratchDir: state.scratchDir }),
    };
    const ownPermission = decideToolPermission(
        approvalMode,
        permissionContext.toolCall,
        permissionContext.workspace,
        state.readPermissionGrants?.() ?? [],
        permissionOptions,
    );
    // A delegated turn is clamped by the parent's mode, per action. The
    // parent's grants and preferences are deliberately absent: a grant the
    // user gave one session is not a grant to everything it spawns.
    const permission = state.clampPermissionMode === undefined
        ? ownPermission
        : stricterToolPermission(
            ownPermission,
            decideToolPermission(
                state.clampPermissionMode,
                permissionContext.toolCall,
                permissionContext.workspace,
                [],
                { ...permissionOptions, permissionPreferences: [] },
            ),
        );
    const scratchNote = scratchAlternativeNote(permission, state.scratchDir);
    if (permission.behavior === "deny") {
        return {
            result: deniedByPolicy(
                state,
                toolCall,
                permission.reason,
                scratchNote,
                "permission-mode",
            ),
        };
    }
    const grantProposals = permissionGrantProposals(permission);
    if (permission.behavior === "review") {
        const reviewCall = state.reviewToolCallForProfile === undefined
            ? state.reviewToolCall
            : (
                request: Parameters<ReviewToolCall>[0],
                nextSignal: AbortSignal,
            ) =>
                state.reviewToolCallForProfile!(
                    permission.reviewerProfile,
                    request,
                    nextSignal,
                );
        if (reviewCall === undefined) {
            const reason =
                "The automatic reviewer is unavailable, so the action did not run.";
            state.events.emit({
                type: "tool_review_decided",
                toolCall: hookCall,
                decision: "unavailable",
                reason,
                riskLevel: "high",
                userAuthorization: "unknown",
            });
            return { result: deniedToolResult(toolCall, reason) };
        } else {
            const review = await reviewCall(
                {
                    toolCall: hookCall,
                    workspace: state.toolRuntime.workspace,
                    reason: permission.reason,
                    pathFacts: await collectReviewerPathFacts(
                        permissionContext.workspace,
                        hookCall,
                        permission.actions,
                        signal,
                    ),
                    transcript: state.messages,
                },
                signal,
            );
            state.events.emit({
                type: "tool_review_decided",
                toolCall: hookCall,
                decision: review.decision,
                reason: review.reason,
                riskLevel: review.riskLevel,
                userAuthorization: review.userAuthorization,
            });
            if (review.decision === "deny") {
                const interrupt = breaker.record("deny");
                return {
                    result: deniedByPolicy(
                        state,
                        toolCall,
                        `${review.reason}\n\n${REVIEW_REJECTION_INSTRUCTIONS}`,
                        undefined,
                        "reviewer",
                    ),
                    ...(interrupt === undefined ? {} : { interrupt }),
                };
            }
            if (review.decision === "unavailable") {
                return {
                    result: deniedToolResult(toolCall, review.reason),
                };
            } else {
                breaker.record("allow");
            }
        }
    }
    if (permission.behavior === "ask") {
        const askReason = permission.reason;
        const approval = await state.inbound.requestToolApproval(
            hookCall,
            askReason,
            {
                timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
                signal,
                ...(grantProposals.length === 0
                    ? {}
                    : { permissionGrants: grantProposals }),
            },
        );
        if (approval.behavior === "deny") {
            return {
                result: deniedToolResult(toolCall, approval.reason, scratchNote),
            };
        }
    }

    state.events.emit({ type: "tool_execution_started", toolCall });
    const startedAt = performance.now();
    const execution = await executeToolHandler(
        toolCall,
        state.toolRuntime,
        signal,
        state.extensionTools,
    );
    const applied = execution.kind === "interaction"
        ? { output: await resolveToolInteraction(state, execution.interaction, signal) }
        : await applyToolExecution(
            execution,
            state.applyToolEffect,
            signal,
            {
                approvalMode,
                ...(modelSettings.provider === undefined
                    ? {}
                    : { provider: modelSettings.provider }),
                model: modelSettings.model,
                ...(modelSettings.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: modelSettings.reasoningEffort }),
                ...(state.readAgentWear?.() === undefined
                    ? {}
                    : { agentWear: state.readAgentWear() }),
            },
        );
    // Emitted from here rather than from either spawn path, so both the
    // in-process subagent and the host registry report a substitution the
    // same way.
    for (const substitution of applied.output.substitutions ?? []) {
        state.events.emit({ type: "model_substituted", substitution });
    }
    const bound = await boundToolResult(
        toolCall,
        applied.output,
        state.toolResultSpill,
    );
    const durationMs = performance.now() - startedAt;
    return finishExecutedTool(
        state,
        toolCall,
        hookCall,
        bound.result,
        durationMs,
        bound.truncation,
        bound.truncation === undefined ? applied.afterCommit : undefined,
    );
}

/**
 * A model that reasoned and then said nothing has failed the turn, and the
 * reasoning is where a fake tool call hides. A model that produced nothing at
 * all has answered a prompt that asked for nothing, so the turn ends quietly.
 */
function requireVisibleTerminalResponse(
    message: AssistantMessage,
): AssistantMessage {
    if (
        message.stopReason !== "stop"
        || message.content.some((block) =>
            block.type === "tool_call"
            || (block.type === "text" && block.text.length > 0)
        )
    ) {
        return message;
    }
    const reasoned = message.content.some((block) =>
        block.type === "thinking" && block.text.length > 0
    );
    if (!reasoned) {
        return message;
    }
    return {
        ...message,
        stopReason: "error",
        errorMessage: "Model returned no visible response or structured tool call.",
    };
}

function rejectUnavailableToolCalls(
    message: AssistantMessage,
): AssistantMessage {
    return {
        ...message,
        content: message.content.filter((block) => block.type !== "tool_call"),
        stopReason: "error",
        errorMessage: "Model returned a tool call when no tools were offered.",
    };
}

async function resolvePermissionToolCall(
    workspace: string,
    toolCall: HookToolCall,
): Promise<{ readonly workspace: string; readonly toolCall: HookToolCall }> {
    try {
        return await resolveFileToolPermissionContext(workspace, toolCall);
    } catch {
        return { workspace, toolCall };
    }
}

async function finishExecutedTool(
    state: RunTurnState,
    toolCall: ToolCallContent,
    hookCall: HookToolCall,
    result: ToolResultMessage,
    durationMs: number,
    truncation?: ToolResultTruncation,
    afterCommit?: CommitEffect,
): Promise<CompletedToolCall> {
    const truncated = truncation === undefined ? {} : { truncation };
    try {
        const effective = await state.hooks.runPostToolUse({
            type: "post_tool_use",
            toolCall: hookCall,
            result: hookResult(result),
            ...(state.sessionId === undefined
                ? {}
                : { sessionId: state.sessionId }),
            workspace: state.toolRuntime.workspace,
            durationMs,
        }, { timeoutMs: POST_TOOL_HOOK_TIMEOUT_MS });
        const toolResultChanged = !sameHookToolResult(
            hookResult(result),
            effective,
        );
        const finalResult = hookResultMessage(
            toolCall,
            effective,
            toolResultChanged ? undefined : result.presentation,
            toolResultChanged ? undefined : result.toolResultSource,
        );
        if (!sameToolResult(result, finalResult)) {
            state.events.emit({
                type: "tool_result_changed",
                original: withoutPresentation(result),
                effective: finalResult,
            });
        }
        state.events.emit({
            type: "tool_execution_finished",
            toolCall,
            result: finalResult,
            durationMs,
            ...truncated,
        });
        return {
            result: finalResult,
            ...(
                afterCommit === undefined || !sameToolResult(result, finalResult)
                    ? {}
                    : { afterCommit }
            ),
        };
    } catch (postHookError) {
        state.events.emit({
            type: "tool_hook_failed",
            phase: "post_tool_use",
            toolCall: hookCall,
            error: errorMessage(postHookError),
        });
        state.events.emit({
            type: "tool_execution_finished",
            toolCall,
            result,
            durationMs,
            ...truncated,
        });
        return {
            result,
            ...(afterCommit === undefined ? {} : { afterCommit }),
        };
    }
}

function withoutPresentation(result: ToolResultMessage): ToolResultMessage {
    return {
        role: result.role,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: result.content,
        isError: result.isError,
        ...(result.toolResultSource === undefined
            ? {}
            : { toolResultSource: result.toolResultSource }),
    };
}

function hookToolCall(toolCall: ToolCallContent): HookToolCall {
    return {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input as JsonObject,
    };
}

function hookResult(result: ToolResultMessage): HookToolResult {
    return {
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: result.content,
        isError: result.isError,
    };
}

function hookResultMessage(
    toolCall: ToolCallContent,
    result: Pick<HookToolResult, "content" | "isError">,
    presentation?: ToolResultMessage["presentation"],
    toolResultSource?: ToolResultMessage["toolResultSource"],
): ToolResultMessage {
    return {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        isError: result.isError,
        ...(presentation === undefined ? {} : { presentation }),
        ...(toolResultSource === undefined ? {} : { toolResultSource }),
    };
}

function sameToolResult(
    left: ToolResultMessage,
    right: ToolResultMessage,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns the interrupt reason when one of the calls asked the turn to stop. */
async function finishToolCalls(
    state: RunTurnState,
    pending: readonly Promise<CompletedToolCall>[],
): Promise<string | undefined> {
    const settled = await Promise.allSettled(pending);
    const completed = settled.flatMap((toolCall) =>
        toolCall.status === "fulfilled" ? [toolCall.value] : []
    );
    for (const toolCall of completed) {
        await commitMessage(state, toolCall.result);
        if (toolCall.afterCommit !== undefined) {
            if (state.applyCommittedToolEffect === undefined) {
                throw new Error("No owner can apply the committed tool effect");
            }
            await state.applyCommittedToolEffect(toolCall.afterCommit);
        }
        if (toolCall.result.presentation !== undefined) {
            state.events.emit({
                type: "tool_presentation_ready",
                tool: toolCall.result.toolName,
                presentation: toolCall.result.presentation,
            });
        }
    }
    const rejected = settled.find(
        (toolCall) => toolCall.status === "rejected",
    );
    if (rejected?.status === "rejected") {
        throw rejected.reason;
    }
    return completed.find((toolCall) => toolCall.interrupt !== undefined)
        ?.interrupt;
}

function sameHookToolResult(
    left: Pick<HookToolResult, "content" | "isError">,
    right: Pick<HookToolResult, "content" | "isError">,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function applyToolExecution(
    execution: Exclude<ToolExecutionResult, { readonly kind: "interaction" }>,
    applyEffect: ApplyToolEffect | undefined,
    signal: AbortSignal,
    context: ToolEffectContext,
): Promise<{
    readonly output: ToolOutput;
    readonly afterCommit?: CommitEffect;
}> {
    if (execution.kind === "output") {
        return { output: execution };
    }
    if (applyEffect === undefined) {
        return { output: {
            kind: "output",
            output: "Tool effects are not enabled in this agent",
            isError: true,
        } };
    }
    try {
        signal.throwIfAborted();
        const applied = await applyEffect(execution.effect, signal, context);
        return {
            output: applied,
            ...(applied.afterCommit === undefined
                ? {}
                : { afterCommit: applied.afterCommit }),
        };
    } catch (error) {
        return { output: {
            kind: "output",
            output: error instanceof Error ? error.message : String(error),
            isError: true,
        } };
    }
}

async function resolveToolInteraction(
    state: RunTurnState,
    interaction: Extract<
        ToolExecutionResult,
        { readonly kind: "interaction" }
    >["interaction"],
    signal: AbortSignal,
): Promise<ToolOutput> {
    if (interaction.type !== "ask_user") {
        return {
            kind: "output",
            output: `Unsupported tool interaction: ${interaction.type}`,
            isError: true,
        };
    }
    const result = await state.inbound.requestUserQuestion({
        question: interaction.question,
        choices: interaction.choices,
    }, { signal });
    if (result.outcome === "cancelled") {
        return {
            kind: "output",
            output: JSON.stringify({ cancelled: true }),
            isError: false,
        };
    }
    if (result.outcome === "custom") {
        return {
            kind: "output",
            output: JSON.stringify({ custom: true, text: result.text }),
            isError: false,
        };
    }
    return {
        kind: "output",
        output: JSON.stringify({
            choice_id: result.choice.id,
            label: result.choice.label,
            ...(result.notes === undefined ? {} : { notes: result.notes }),
        }),
        isError: false,
    };
}

async function commitMessage(
    state: RunTurnState,
    message: ModelMessage,
): Promise<void> {
    const entry = await state.store.appendMessage(message);
    // The store persists a snapshot, so the in-memory line tracks that snapshot
    // rather than the caller's object. A resumed session already holds the
    // stored copies, and transcript IDs are keyed off them.
    state.messages.push(entry.message);
}

/**
 * A denial the harness decided, with the worn agent's nudge on the end.
 *
 * Three classes fire a nudge: the agent's own scope, the permission mode, and
 * the reviewer. A denial the user typed does not, because the user knows why;
 * a pre-tool hook's block does not, because the hook wrote its own message and
 * a second voice under it would be Vera talking over an extension.
 *
 * The nudge is appended, never substituted: the original denial is what the
 * model has to act on, and the nudge is the sentence that says what to do
 * about it.
 */
function deniedByPolicy(
    state: RunTurnState,
    toolCall: ToolCallContent,
    reason: string,
    note: string | undefined,
    denialClass: "agent-scope" | "permission-mode" | "reviewer",
): ToolResultMessage {
    state.events.emit({
        type: "tool_denied",
        toolCall: hookToolCall(toolCall),
        denialClass,
        reason,
    });
    const nudge = nudgeFor(state, toolCall.name);
    return deniedToolResult(
        toolCall,
        nudge === undefined ? reason : `${reason}\n\n${nudge}`,
        note,
    );
}

/**
 * The agent's nudge for this tool, once per user turn.
 *
 * Matching is by exact tool name or `*`. The cooldown is the user's next
 * message: a model that keeps trying the same denied tool inside one stretch
 * of work hears the sentence once, not once per attempt.
 */
function nudgeFor(
    state: RunTurnState,
    toolName: string,
): string | undefined {
    const nudges = state.readAgentWear?.()?.nudges ?? [];
    const nudge = nudges.find((candidate) =>
        candidate.on === toolName || candidate.on === "*"
    );
    if (nudge === undefined) return undefined;
    const key = `${nudge.on}\u0000${nudge.text}\u0000${toolName}`;
    if (state.firedNudges?.has(key) === true) return undefined;
    state.firedNudges?.add(key);
    return nudge.text;
}

function deniedToolResult(
    toolCall: ToolCallContent,
    reason: string,
    note?: string,
): ToolResultMessage {
    return {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{
            type: "text",
            text: note === undefined ? reason : `${reason} ${note}`,
        }],
        isError: true,
    };
}

/**
 * A refused write outside the workspace has an unrefused neighbour, and the
 * model only needs to hear about it when it hits the wall. Naming the scratch
 * directory in the result keeps the alternative out of the standing prompt,
 * where it would cost context on every turn that never sees a denial.
 *
 * Only for paths that are actually blocked and actually elsewhere: a refusal
 * inside the scratch directory has no scratch alternative to offer.
 */
function scratchAlternativeNote(
    decision: ToolPermissionDecision,
    scratchDir: string | undefined,
): string | undefined {
    if (scratchDir === undefined) {
        return undefined;
    }
    const blocked = decision.actions.some(({ action, outcome }) =>
        outcome !== "allow"
        && action.verb === "write"
        && action.scope === "outside_workspace"
        && action.path !== undefined
    );
    return blocked
        ? "Write the finished file somewhere you can reach and offer it rather "
            + "than stopping. The working directory is the first choice; if it "
            + "is not a fit either, writes inside the session scratch "
            + `directory (${scratchDir}) need no approval.`
        : undefined;
}

/**
 * The same measured request, against a different model's window. Dropping the
 * capacity when the new model has none keeps a percentage from being drawn
 * against the window of a model that is no longer running.
 */
function remeasuredAgainst(
    measurement: ContextMeasurement,
    capacity: number | undefined,
): ContextMeasurement {
    return {
        tokens: measurement.tokens,
        estimated: measurement.estimated,
        ...(capacity === undefined ? {} : { capacity }),
    };
}

/**
 * Routed providers answer per model and per provider at once; a single-provider
 * adapter answers per model, then falls back to its blanket flag. An adapter
 * with nothing to say lets the request through, so an unstated model fails with
 * the provider's own reason rather than being turned away here.
 */
function acceptsImageInput(
    adapter: ModelAdapter,
    provider: string | undefined,
    model: string,
): boolean {
    if (provider !== undefined && adapter.supportsImageInputFor !== undefined) {
        return adapter.supportsImageInputFor(provider, model);
    }
    return adapter.imageInputSupport?.(model)
        ?? adapter.supportsImageInput !== false;
}
