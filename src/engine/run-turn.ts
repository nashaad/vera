import { randomUUID } from "node:crypto";

import {
    emptyUsage,
    type AssistantMessage,
    type ImageContent,
    type ModelAdapter,
    type ModelMessage,
    type ModelReasoningEffort,
    type ToolCallContent,
    type ToolResultMessage,
    type UserMessage,
} from "../model/types.ts";
import {
    hydrateImageAttachments,
    readSessionImageContent,
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
import {
    executeToolHandler,
    toolDefinitionsForCapabilities,
    toolMayRunInParallel,
    toolResultMessage,
} from "../tools/execute.ts";
import { ToolRuntime } from "../tools/runtime.ts";
import { resolveFileToolPermissionContext } from "../tools/files.ts";
import type {
    ApplyToolEffect,
    ToolExecutionResult,
    ToolEffect,
    ToolEffectContext,
    ToolOutput,
} from "../tools/types.ts";
import { loadProjectInstructions } from "./project-instructions.ts";
import { promptContributionMetadata } from "./prompt-contributions.ts";
import { PromptPrefixTracker } from "./prompt-prefix-drift.ts";
import { projectModelRequest } from "./model-request.ts";
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
    type PermissionProfile,
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
import {
    defaultSessionPath,
    SessionStore,
    type SessionDeliveryEntry,
    type SessionDeliveryInbox,
    type SessionMessageStore,
} from "../store/session-store.ts";
import type {
    ModelSettingsPatch,
    ModelTurnSettings,
} from "./model-settings.ts";

const PRE_TOOL_HOOK_TIMEOUT_MS = 60_000;
const POST_TOOL_HOOK_TIMEOUT_MS = 5_000;
const TOOL_APPROVAL_TIMEOUT_MS = 60_000;

export interface RunTurnState {
    readonly messages: ModelMessage[];
    readonly store: SessionMessageStore;
    readonly deliveryInbox?: SessionDeliveryInbox;
    readonly toolRuntime: ToolRuntime;
    readonly inbound: InboundCommandRouter;
    readonly events: EngineEventBus;
    readonly hooks: ToolHooks;
    readonly approvalMode: ApprovalMode;
    readonly applyToolEffect?: ApplyToolEffect;
    readonly enabledToolEffects?: readonly ToolEffect["type"][];
    readonly enableUserInteraction?: boolean;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly waitForModelRetry?: WaitForModelRetry;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly readApprovalMode?: () => ApprovalMode;
    readonly readPermissionGrants?: () => readonly PermissionGrant[];
    readonly permissionProfiles?: Readonly<Record<string, PermissionProfile>>;
    /** Automatic approval reviewer used by `auto`. */
    readonly reviewToolCall?: ReviewToolCall;
    readonly reviewToolCallForProfile?: (
        profile: string,
        request: Parameters<ReviewToolCall>[0],
        signal: AbortSignal,
    ) => ReturnType<ReviewToolCall>;
    readonly promptPrefixTracker?: PromptPrefixTracker;
    readonly readImageContent?: (attachmentId: string) => Promise<ImageContent>;
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
    readonly permissionProfiles?: Readonly<Record<string, PermissionProfile>>;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly applyToolEffect?: ApplyToolEffect;
    readonly enabledToolEffects?: readonly ToolEffect["type"][];
    readonly enableUserInteraction?: boolean;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly updateModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly readApprovalMode?: () => ApprovalMode;
    readonly updateApprovalMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
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
    const readPermissionInspection = () =>
        inspectPermissions(
            readApprovalMode(),
            options.permissionProfiles,
            readPermissionGrants(),
        );
    const addPermissionGrants = async (
        grants: readonly PermissionGrantProposal[],
    ): Promise<void> => {
        await store.appendPermissionGrants(grants);
    };
    const events = options.eventBus ?? new EngineEventBus();
    const protocol = createProtocolEncoder(endpoint);
    events.subscribe(protocol);
    events.subscribe(createJsonlEventLogger({
        path: options.eventLogPath ?? defaultEventLogPath(sessionId),
        sessionId,
    }));
    const messages = [...store.messages()];
    let inbound: InboundCommandRouter;
    const timeline = new TimelineController({
        state: { messages, store },
        protocol,
        isBlocked: () => inbound.timelineBlocked(),
        sendReply: options.sendTimelineReply
            ?? ((_ownerId, reply): void => endpoint.send(reply)),
    });
    inbound = new InboundCommandRouter(endpoint, events, {
        ...(options.readModelSettings === undefined
            ? {}
            : { readModelSettings: options.readModelSettings }),
        ...(options.updateModelSettings === undefined
            ? {}
            : { updateModelSettings: options.updateModelSettings }),
        readApprovalMode,
        readPermissionInspection,
        updateApprovalMode,
        ...(options.updateSessionName === undefined
            ? {}
            : { updateSessionName: options.updateSessionName }),
        sendSessionNameReply: options.sendSessionNameReply
            ?? ((_ownerId, reply): void => endpoint.send(reply)),
        addPermissionGrants,
        handleTimelineCommand: (ownerId, command) =>
            timeline.handle(ownerId, command),
        detachTimelineOwner: (ownerId) => timeline.detachOwner(ownerId),
    });
    const applyToolEffect = options.applyToolEffect
        ?? createSubagentEffectApplier({
            adapter,
            workspace: store.header.cwd,
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
    const state: RunTurnState = {
        messages,
        store,
        deliveryInbox: store,
        toolRuntime: new ToolRuntime(store.header.cwd),
        inbound,
        events,
        hooks: new ToolHooks(),
        approvalMode: localApprovalMode,
        applyToolEffect,
        enabledToolEffects: options.enabledToolEffects ?? ["spawn_subagent"],
        enableUserInteraction: options.enableUserInteraction ?? true,
        ...(options.modelFallback === undefined
            ? {}
            : { modelFallback: options.modelFallback }),
        ...(options.readModelSettings === undefined
            ? {}
            : { readModelSettings: options.readModelSettings }),
        readApprovalMode,
        readPermissionGrants,
        ...(options.permissionProfiles === undefined
            ? {}
            : { permissionProfiles: options.permissionProfiles }),
        reviewToolCall,
        reviewToolCallForProfile: createReviewerProfileRouter(
            reviewToolCall,
            adapter,
            options.reviewers,
        ),
        promptPrefixTracker: new PromptPrefixTracker(),
        readImageContent: (attachmentId) =>
            readSessionImageContent(store, attachmentId),
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
        const turnReasoningEffort = modelSettings.reasoningEffort;
        const turnApprovalMode = turn.approvalMode
            ?? state.readApprovalMode?.()
            ?? state.approvalMode;
        let maxTokens = DEFAULT_MODEL_MAX_TOKENS;
        let lengthContinuations = 0;
        const reviewBreaker = createReviewCircuitBreaker();
        const tools = toolDefinitionsForCapabilities(
            state.applyToolEffect === undefined
                ? []
                : state.enabledToolEffects ?? [],
            state.enableUserInteraction === true,
        );
        const userMessage: UserMessage = {
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
                && userMessage.content.some((block) => block.type === "image_attachment")
            ) {
                throw new Error("the selected model provider does not support image input");
            }
            await hydrateImageAttachments(
                [...state.messages, userMessage],
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
        await commitMessage(state, userMessage);
        state.events.emit({ type: "turn_started", message: userMessage });

        while (true) {
            const projectInstructions = await loadProjectInstructions(
                state.toolRuntime.workspace,
            );
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
                messages: state.messages,
                tools,
                workspace: state.toolRuntime.workspace,
                date: requestDate,
                projectInstructions,
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
            });
            let modelRequest;
            try {
                modelRequest = {
                    ...request,
                    messages: await hydrateImageAttachments(
                        state.messages,
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
                            state.events.emit({
                                type: "model_stream_error",
                                error: event.error.message,
                                message: event.message,
                            });
                            return;
                        }
                        state.events.emit({ type: "model_stream", event });
                    },
                    onRetry(retry): void {
                        state.events.emit({
                            type: "model_retry_scheduled",
                            ...retry,
                        });
                    },
                    onFallback(fallback): void {
                        activeModel = fallback.toModel;
                        state.events.emit({
                            type: "model_fallback_selected",
                            ...fallback,
                        });
                    },
                    ...(state.modelFallback === undefined
                        || (state.modelFallback.provider !== undefined
                            && state.modelFallback.provider
                                !== modelSettings.provider)
                        ? {}
                        : { fallback: state.modelFallback }),
                    ...(state.waitForModelRetry === undefined
                        ? {}
                        : { wait: state.waitForModelRetry }),
                },
            );
            assistantMessage = requireVisibleTerminalResponse(assistantMessage);
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
                if (!toolMayRunInParallel(first.toolCall.name)) {
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
    return {
        role: "user",
        internal: true,
        content: [{
            type: "text",
            text: [
                "<task_notification>",
                `  <delivery_id>${escapeXml(delivery.id)}</delivery_id>`,
                `  <agent_id>${escapeXml(delivery.sourceAgentId)}</agent_id>`,
                "  <status>completed</status>",
                `  <summary>${escapeXml(delivery.content)}</summary>`,
                "</task_notification>",
            ].join("\n"),
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
        { permissionProfiles: state.permissionProfiles },
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
    const result = toolResultMessage(toolCall, output);
    const durationMs = performance.now() - startedAt;
    return finishExecutedTool(state, toolCall, hookCall, result, durationMs);
}

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
): Promise<CompletedToolCall> {
    try {
        const effective = await state.hooks.runPostToolUse({
            type: "post_tool_use",
            toolCall: hookCall,
            result: hookResult(result),
            workspace: state.toolRuntime.workspace,
            durationMs,
        }, { timeoutMs: POST_TOOL_HOOK_TIMEOUT_MS });
        const finalResult = hookResultMessage(toolCall, effective);
        if (!sameToolResult(result, finalResult)) {
            state.events.emit({
                type: "tool_result_changed",
                original: result,
                effective: finalResult,
            });
        }
        state.events.emit({
            type: "tool_execution_finished",
            toolCall,
            result: finalResult,
            durationMs,
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
        });
        return { result };
    }
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
): ToolResultMessage {
    return {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        isError: result.isError,
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
