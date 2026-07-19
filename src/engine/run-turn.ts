import { randomUUID } from "node:crypto";

import type {
    AssistantMessage,
    ModelAdapter,
    ModelMessage,
    ModelReasoningEffort,
    ToolCallContent,
    ToolResultMessage,
    UserMessage,
} from "../model/types.ts";
import type { JsonObject } from "../sdk/hooks.ts";
import type {
    HookToolCall,
    HookToolResult,
    PreToolUseHookResult,
} from "../sdk/hooks.ts";
import type { MessageChannel } from "./message-channel.ts";
import type { AgentUpdate, ClientCommand } from "./protocol.ts";
import { createProtocolEncoder } from "./protocol.ts";
import {
    EngineEventBus,
    createJsonlEventLogger,
    defaultEventLogPath,
} from "./events.ts";
import {
    executeToolHandler,
    toolDefinitionsForEffects,
    toolMayRunInParallel,
    toolResultMessage,
} from "../tools/execute.ts";
import { ToolRuntime } from "../tools/runtime.ts";
import type { FileCheckpointCapture } from "../tools/runtime.ts";
import type {
    ApplyToolEffect,
    ToolExecutionResult,
    ToolEffect,
    ToolEffectContext,
    ToolOutput,
} from "../tools/types.ts";
import { assembleSystemPrompt } from "./assemble.ts";
import { ToolHooks, type PreToolUseOutcome } from "./hooks.ts";
import { InboundCommandRouter } from "./inbound-command-router.ts";
import { listCheckpoints, restoreCheckpoint } from "./checkpoints.ts";
import { createSubagentEffectApplier } from "./subagent.ts";
import {
    decideToolPermission,
    type ApprovalMode,
} from "./permissions.ts";
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
import {
    CheckpointStore,
    defaultCheckpointDirectory,
} from "../store/checkpoint-store.ts";
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
    readonly modelFallback?: ModelFallbackPolicy;
    readonly waitForModelRetry?: WaitForModelRetry;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly readApprovalMode?: () => ApprovalMode;
}

export interface RunHeadlessLoopOptions {
    readonly sessionStore?: SessionStore;
    readonly sessionId?: string;
    readonly sessionPath?: string;
    readonly resumeSessionPath?: string;
    readonly eventLogPath?: string;
    readonly eventBus?: EngineEventBus;
    readonly approvalMode?: ApprovalMode;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly applyToolEffect?: ApplyToolEffect;
    readonly enabledToolEffects?: readonly ToolEffect["type"][];
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly updateModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly readApprovalMode?: () => ApprovalMode;
    readonly updateApprovalMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    readonly checkpointStore?: CheckpointStore;
}

export async function runHeadlessLoop(
    endpoint: MessageChannel<AgentUpdate, ClientCommand>,
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
        ?? "approve_for_me";
    const readApprovalMode = options.readApprovalMode
        ?? (() => localApprovalMode);
    const updateApprovalMode = options.updateApprovalMode
        ?? (async (mode: ApprovalMode): Promise<ApprovalMode> => {
            await store.appendApprovalMode(mode);
            localApprovalMode = mode;
            return localApprovalMode;
        });
    const events = options.eventBus ?? new EngineEventBus();
    const protocol = createProtocolEncoder(endpoint);
    events.subscribe(protocol);
    events.subscribe(createJsonlEventLogger({
        path: options.eventLogPath ?? defaultEventLogPath(sessionId),
        sessionId,
    }));
    const checkpointStore = options.checkpointStore
        ?? new CheckpointStore(defaultCheckpointDirectory(sessionId));
    const inbound = new InboundCommandRouter(endpoint, events, {
        ...(options.readModelSettings === undefined
            ? {}
            : { readModelSettings: options.readModelSettings }),
        ...(options.updateModelSettings === undefined
            ? {}
            : { updateModelSettings: options.updateModelSettings }),
        readApprovalMode,
        updateApprovalMode,
        listCheckpoints: () => listCheckpoints(store),
        restoreCheckpoint: async (checkpointId) => {
            const known = listCheckpoints(store).some(
                (entry) => entry.checkpointId === checkpointId,
            );
            if (!known) {
                return { ok: false, reason: "not_found" };
            }
            try {
                return {
                    ok: true,
                    result: await restoreCheckpoint(
                        store,
                        checkpointStore,
                        checkpointId,
                    ),
                };
            } catch {
                return { ok: false, reason: "conflict" };
            }
        },
    });
    const applyToolEffect = options.applyToolEffect
        ?? createSubagentEffectApplier({
            adapter,
            workspace: store.header.cwd,
            ...(options.modelFallback === undefined
                ? {}
                : { modelFallback: options.modelFallback }),
        });
    const recordCheckpoint = async (
        capture: FileCheckpointCapture,
    ): Promise<void> => {
        const checkpointId = randomUUID();
        await checkpointStore.write(checkpointId, {
            existed: capture.existedBefore,
            content: capture.priorContent,
        });
        await store.appendCheckpoint({
            checkpointId,
            path: capture.path,
            existedBefore: capture.existedBefore,
            tool: capture.tool,
        });
    };
    const state: RunTurnState = {
        messages: [...store.messages()],
        store,
        deliveryInbox: store,
        toolRuntime: new ToolRuntime(store.header.cwd, { recordCheckpoint }),
        inbound,
        events,
        hooks: new ToolHooks(),
        approvalMode: localApprovalMode,
        applyToolEffect,
        enabledToolEffects: options.enabledToolEffects ?? ["spawn_subagent"],
        ...(options.modelFallback === undefined
            ? {}
            : { modelFallback: options.modelFallback }),
        ...(options.readModelSettings === undefined
            ? {}
            : { readModelSettings: options.readModelSettings }),
        readApprovalMode,
    };
    protocol.checkpoint(state.messages);

    while (true) {
        await runTurn(adapter, model, state, reasoningEffort);
        protocol.checkpoint(state.messages);
    }
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
        const tools = toolDefinitionsForEffects(
            state.applyToolEffect === undefined
                ? []
                : state.enabledToolEffects ?? [],
        );
        await drainPendingDeliveries(state);
        const userMessage: UserMessage = {
            role: "user",
            content: [{ type: "text", text: turn.prompt.content }],
        };
        await commitMessage(state, userMessage);
        state.events.emit({ type: "turn_started", message: userMessage });

        while (true) {
            const systemPrompt = assembleSystemPrompt({
                tools,
                workspace: state.toolRuntime.workspace,
                date: new Date(),
            });
            const request = {
                model: activeModel,
                maxTokens,
                ...(turnReasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: turnReasoningEffort }),
                systemPrompt,
                messages: state.messages.slice(),
                tools,
                signal: turn.signal,
            };
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
            });
            assistantMessage = await requestModelWithRecovery(
                adapter,
                request,
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
                        ? {}
                        : { fallback: state.modelFallback }),
                    ...(state.waitForModelRetry === undefined
                        ? {}
                        : { wait: state.waitForModelRetry }),
                },
            );
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
            while (toolIndex < preparedToolCalls.length) {
                const first = preparedToolCalls[toolIndex]!;
                if (!toolMayRunInParallel(first.toolCall.name)) {
                    await finishToolCalls(state, [
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
                        ),
                    ]);
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
                await finishToolCalls(
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
                        )
                    ),
                );
            }
        }
    } finally {
        state.inbound.finishTurn();
    }

    state.events.emit({ type: "turn_finished", message: assistantMessage });
    return assistantMessage;
}

async function drainPendingDeliveries(state: RunTurnState): Promise<void> {
    const inbox = state.deliveryInbox;
    if (inbox === undefined) {
        return;
    }
    for (const delivery of inbox.pendingDeliveries()) {
        await commitMessage(state, deliveryMessage(delivery));
        if (!await inbox.acknowledgeDelivery(delivery.id)) {
            throw new Error(`Pending delivery ${delivery.id} was not acknowledged`);
        }
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

interface CompletedToolCall {
    readonly result: ToolResultMessage;
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

    const permission = decideToolPermission(
        approvalMode,
        hookCall,
        state.toolRuntime.workspace,
    );
    if (permission.behavior === "deny") {
        return { result: deniedToolResult(toolCall, permission.reason) };
    }
    if (permission.behavior === "ask") {
        const approval = await state.inbound.requestToolApproval(
            hookCall,
            permission.reason,
            { timeoutMs: TOOL_APPROVAL_TIMEOUT_MS, signal },
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
    const output = await applyToolExecution(
        execution,
        state.applyToolEffect,
        signal,
        {
            approvalMode,
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

async function finishToolCalls(
    state: RunTurnState,
    pending: readonly Promise<CompletedToolCall>[],
): Promise<void> {
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
}

async function applyToolExecution(
    execution: ToolExecutionResult,
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
