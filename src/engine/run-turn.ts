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
    defaultEventLogPath,
} from "./events.ts";
import type { PoolAdmissionVerdict } from "./events.ts";
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
    ApplyToolEffect,
    RegisteredTool,
    ToolExecutionResult,
    ToolEffect,
    ToolEffectContext,
    ToolOutput,
} from "../tools/types.ts";
import { loadProjectInstructions } from "./project-instructions.ts";
import { promptContributionMetadata } from "./prompt-contributions.ts";
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
    compactSession,
    shouldCompact,
} from "./compaction-scheduler.ts";
import { availableModels, contextWindowForModel } from "./model-settings.ts";
import { ToolHooks, type PreToolUseOutcome } from "./hooks.ts";
import { InboundCommandRouter } from "./inbound-command-router.ts";
import { createSubagentEffectApplier } from "./subagent.ts";
import {
    decideToolPermission,
    inspectPermissions,
    permissionGrantProposals,
    type ApprovalMode,
    type PermissionGrant,
    type PermissionGrantProposal,
    type PermissionMode,
    type PermissionPredicate,
    type PermissionPreference,
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

export interface RunTurnState {
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
    ) => Promise<void>;
    readonly deliveryInbox?: SessionDeliveryInbox;
    readonly toolRuntime: ToolRuntime;
    readonly inbound: InboundCommandRouter;
    readonly events: EngineEventBus;
    readonly hooks: ToolHooks;
    readonly approvalMode: ApprovalMode;
    readonly applyToolEffect?: ApplyToolEffect;
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
}

export interface SessionCompactionOptions {
    readonly strategy: CompactionStrategyDefinition;
    readonly models: Readonly<Record<string, CompleteText>>;
    readonly diagnostics?: SessionCompactionDiagnostics;
}

export interface RunHeadlessLoopOptions {
    /** Overrides the model the automatic approval reviewer runs on. */
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly sessionStore?: SessionStore;
    readonly sessionId?: string;
    readonly sessionPath?: string;
    readonly resumeSessionPath?: string;
    readonly eventLogPath?: string;
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
    readonly enabledToolEffects?: readonly ToolEffect["type"][];
    readonly enableUserInteraction?: boolean;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly onInboundReady?: (inbound: InboundCommandRouter) => void;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly updateModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<ModelTurnSettings | undefined>;
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
    readonly poolName?: (
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly readApprovalMode?: () => ApprovalMode;
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
    readonly reviewToolCall?: ReviewToolCall;
    readonly disabledPromptContributions?: readonly string[];
    /** Hooks for the session's turns; absent means none registered. */
    readonly hooks?: ToolHooks;
    /**
     * Variables layered over the inherited environment in the shells this
     * session's tools spawn. The owner chooses the variables; the engine
     * passes them through opaquely.
     */
    readonly toolEnv?: Readonly<Record<string, string>>;
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
    );
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
        ...(options.poolAdd === undefined
            ? {}
            : { poolAdd: options.poolAdd }),
        ...(options.poolRemove === undefined
            ? {}
            : { poolRemove: options.poolRemove }),
        ...(options.poolName === undefined
            ? {}
            : { poolName: options.poolName }),
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
        addPermissionGrants,
        removePermissionGrant,
        handleTimelineCommand: (ownerId, command) =>
            timeline.handle(ownerId, command),
        detachTimelineOwner: (ownerId) => timeline.detachOwner(ownerId),
    });
    options.onInboundReady?.(inbound);
    const applyToolEffect = options.applyToolEffect
        ?? createSubagentEffectApplier({
            adapter,
            workspace: store.header.cwd,
            scratchDir,
            ...(options.disabledPromptContributions === undefined ? {} : {
                disabledPromptContributions:
                    options.disabledPromptContributions,
            }),
            ...(options.modelFallback === undefined
                ? {}
                : { modelFallback: options.modelFallback }),
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
            const configured = options.reviewer;
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
            ]);
            if (activeReviewer?.key !== key) {
                activeReviewer = {
                    key,
                    review: createRoutedToolReviewer(adapter, {
                        models,
                        ...(configured?.policy === undefined
                            ? {}
                            : { policy: configured.policy }),
                        ...(configured?.timeoutMs === undefined
                            ? {}
                            : { timeoutMs: configured.timeoutMs }),
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
    const compactionCapacity = (): number | undefined => {
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
    ): ContextMeasurement => {
        const watched = contextWatch.measurement;
        const overhead = watched === undefined
            ? 0
            : Math.max(
                0,
                watched.tokens
                    - (contextWatch.messageTokens ?? watched.tokens),
            );
        const capacity = compactionCapacity();
        return {
            tokens: measureMessages([
                ...store.modelContext(),
                ...pendingMessages,
            ]) + overhead,
            ...(capacity === undefined ? {} : { capacity }),
            estimated: true,
        };
    };
    const runCompaction = compaction === undefined
        ? undefined
        : async (
            signal: AbortSignal,
            force = false,
            pendingMessages: readonly ModelMessage[] = [],
        ): Promise<void> => {
            const measurement = measureContextNow(pendingMessages);
            // Forced only when a user asked. Compacting early is the whole
            // point of asking, so the trigger fraction does not apply, but
            // every other rule still does.
            if (!force && !shouldCompact(measurement)) {
                return;
            }
            events.emit({
                type: "compaction_started",
                strategy: compaction.strategy.id,
            });
            const result = await compactSession({
                store,
                strategy: compaction.strategy,
                models: compaction.models,
                ...(compaction.diagnostics === undefined
                    ? {}
                    : { diagnostics: compaction.diagnostics }),
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
                ) => runCompaction(signal, false, pendingMessages),
            }),
        deliveryInbox: store,
        toolRuntime: newStashingToolRuntime(
            store.header.cwd,
            store.header.id,
            options.toolEnv,
        ),
        inbound,
        events,
        hooks: options.hooks ?? new ToolHooks(),
        approvalMode: localApprovalMode,
        applyToolEffect,
        enabledToolEffects: options.enabledToolEffects ?? ["spawn_subagent"],
        enableUserInteraction: options.enableUserInteraction ?? true,
        extensionTools: options.extensionTools ?? [],
        ...(options.modelFallback === undefined
            ? {}
            : { modelFallback: options.modelFallback }),
        ...(options.effortPool === undefined
            ? {}
            : { effortPool: options.effortPool }),
        ...(options.readModelSettings === undefined
            ? {}
            : { readModelSettings: options.readModelSettings }),
        readApprovalMode,
        readPermissionGrants,
        readPermissionPreferences,
        ...(options.permissionModes === undefined
            ? {}
            : { permissionModes: options.permissionModes }),
        reviewToolCall,
        reviewToolCallForProfile: createReviewerProfileRouter(
            reviewToolCall,
            adapter,
            options.reviewers,
        ),
        promptPrefixTracker: new PromptPrefixTracker(),
        readImageContent: (attachmentId) =>
            readSessionImageContent(store, attachmentId),
        scratchDir,
        toolResultSpill: createToolResultSpill(scratchDir),
        ...(options.disabledPromptContributions === undefined ? {} : {
            disabledPromptContributions: options.disabledPromptContributions,
        }),
    };
    protocol.checkpoint(state.messages);

    while (true) {
        const checkpointMessages = [...state.messages];
        await runTurn(adapter, model, state, reasoningEffort);
        if (
            state.messages.length !== checkpointMessages.length
            || state.messages.some((message, index) =>
                message !== checkpointMessages[index]
            )
        ) {
            protocol.checkpoint(state.messages);
        }
    }
}

function createReviewerProfileRouter(
    defaultReviewer: ReviewToolCall,
    adapter: ModelAdapter,
    profiles: Readonly<Record<string, ToolReviewerSettings>> | undefined,
): NonNullable<RunTurnState["reviewToolCallForProfile"]> {
    const reviewers = new Map<string, ReviewToolCall>();
    return (profile, request, signal) => {
        if (profile === "default") {
            return defaultReviewer(request, signal);
        }
        let reviewer = reviewers.get(profile);
        if (reviewer === undefined) {
            const settings = profiles?.[profile];
            if (settings === undefined) {
                return Promise.resolve({
                    decision: "unavailable",
                    reason: `Reviewer profile ${profile} is unavailable.`,
                    riskLevel: "high",
                    userAuthorization: "unknown",
                });
            }
            reviewer = createRoutedToolReviewer(adapter, settings);
            reviewers.set(profile, reviewer);
        }
        return reviewer(request, signal);
    };
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
        const tools = toolDefinitionsForCapabilities(
            state.applyToolEffect === undefined
                ? []
                : state.enabledToolEffects ?? [],
            state.enableUserInteraction === true,
            state.extensionTools,
        );
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
        try {
            if (
                (modelSettings.provider !== undefined
                    && adapter.supportsImageInputFor !== undefined
                    ? !adapter.supportsImageInputFor(modelSettings.provider)
                    : adapter.supportsImageInput === false)
                && userMessage?.content.some(
                    (block) => block.type === "image_attachment"
                )
            ) {
                throw new Error("the selected model provider does not support image input");
            }
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
        const capacityForModel = (model: string): number | undefined =>
            (model === modelSettings.model
                ? modelSettings.contextWindow
                : undefined)
            ?? contextWindowForModel(
                modelSettings.provider,
                model,
                modelSettings.availableModels,
                catalogModels,
            );

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
            const projectInstructions = await loadProjectInstructions(
                state.toolRuntime.workspace,
            );
            const scratchState = state.scratchDir === undefined
                ? undefined
                : await loadScratchState(state.scratchDir);
            const requestDate = new Date();
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
                ...(scratchState === undefined ? {} : { scratchState }),
                ...(state.disabledPromptContributions === undefined ? {} : {
                    disabledPromptContributions:
                        state.disabledPromptContributions,
                }),
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
            let modelRequest;
            try {
                modelRequest = {
                    ...request,
                    messages: await hydrateImageAttachments(
                        request.messages,
                        requireImageReader(state),
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
                    ...(state.modelFallback === undefined
                        || (state.modelFallback.provider !== undefined
                            && state.modelFallback.provider
                                !== modelSettings.provider)
                        ? {}
                        : { fallback: state.modelFallback }),
                    ...(state.effortPool === undefined
                        ? {}
                        : { coarsening: { pool: state.effortPool } }),
                    ...(state.waitForModelRetry === undefined
                        ? {}
                        : { wait: state.waitForModelRetry }),
                },
            );
            assistantMessage = sanitizedErrorMessage(assistantMessage);
            assistantMessage = requireVisibleTerminalResponse(assistantMessage);
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
        await inbox.appendDeliveryMessage(delivery.id, message);
        state.messages.push(message);
    }
}

function deliveryMessage(delivery: SessionDeliveryEntry): UserMessage {
    const kind = delivery.kind ?? "completion";
    const body = kind === "attention"
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
    /** Set when the turn must stop after this result is committed. */
    readonly interrupt?: string;
}

interface PreparedToolCall {
    readonly toolCall: ToolCallContent;
    readonly hookResult: PreToolUseHookResult;
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
        let outcome: PreToolUseOutcome;
        try {
            outcome = await state.hooks.runPreToolUse({
                type: "pre_tool_use",
                toolCall: original,
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
    const permission = decideToolPermission(
        approvalMode,
        permissionContext.toolCall,
        permissionContext.workspace,
        state.readPermissionGrants?.() ?? [],
        {
            permissionModes: state.permissionModes,
            permissionPreferences: state.readPermissionPreferences?.() ?? [],
            extensionTools: state.extensionTools,
            ...(state.scratchDir === undefined
                ? {}
                : { scratchDir: state.scratchDir }),
        },
    );
    if (permission.behavior === "deny") {
        return { result: deniedToolResult(toolCall, permission.reason) };
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
            const approval = await state.inbound.requestToolApproval(
                hookCall,
                `${permission.reason} The automatic reviewer is unavailable.`,
                { timeoutMs: TOOL_APPROVAL_TIMEOUT_MS, signal },
            );
            if (approval.behavior === "deny") {
                return { result: deniedToolResult(toolCall, approval.reason) };
            }
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
                    result: deniedToolResult(
                        toolCall,
                        `${review.reason}\n\n${REVIEW_REJECTION_INSTRUCTIONS}`,
                    ),
                    ...(interrupt === undefined ? {} : { interrupt }),
                };
            }
            if (review.decision === "unavailable") {
                const approval = await state.inbound.requestToolApproval(
                    hookCall,
                    `${permission.reason} ${review.reason}`,
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
                        result: deniedToolResult(toolCall, approval.reason),
                    };
                }
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
            return { result: deniedToolResult(toolCall, approval.reason) };
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
    const output = execution.kind === "interaction"
        ? await resolveToolInteraction(state, execution.interaction, signal)
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
            },
        );
    // Emitted from here rather than from either spawn path, so both the
    // in-process subagent and the host registry report a substitution the
    // same way.
    for (const substitution of output.substitutions ?? []) {
        state.events.emit({ type: "model_substituted", substitution });
    }
    const bound = await boundToolResult(
        toolCall,
        output,
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
): Promise<CompletedToolCall> {
    const truncated = truncation === undefined ? {} : { truncation };
    try {
        const effective = await state.hooks.runPostToolUse({
            type: "post_tool_use",
            toolCall: hookCall,
            result: hookResult(result),
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
        return { result: finalResult };
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
        return { result };
    }
}

function withoutPresentation(result: ToolResultMessage): ToolResultMessage {
    return {
        role: result.role,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: result.content,
        isError: result.isError,
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
): ToolResultMessage {
    return {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        isError: result.isError,
        ...(presentation === undefined ? {} : { presentation }),
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
): Promise<ToolOutput> {
    if (execution.kind === "output") {
        return execution;
    }
    if (applyEffect === undefined) {
        return {
            kind: "output",
            output: "Tool effects are not enabled in this agent",
            isError: true,
        };
    }
    try {
        signal.throwIfAborted();
        return await applyEffect(execution.effect, signal, context);
    } catch (error) {
        return {
            kind: "output",
            output: error instanceof Error ? error.message : String(error),
            isError: true,
        };
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
    await state.store.appendMessage(message);
    state.messages.push(message);
}

function deniedToolResult(
    toolCall: ToolCallContent,
    reason: string,
): ToolResultMessage {
    return {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: reason }],
        isError: true,
    };
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
