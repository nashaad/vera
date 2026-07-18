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
import type {
    ApplyToolEffect,
    ToolExecutionResult,
    ToolEffect,
    ToolOutput,
} from "../tools/types.ts";
import { assembleSystemPrompt } from "./assemble.ts";
import { ToolHooks } from "./hooks.ts";
import { InboundCommandRouter } from "./inbound-command-router.ts";
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
}

export interface RunHeadlessLoopOptions {
    readonly sessionStore?: SessionStore;
    readonly sessionId?: string;
    readonly sessionPath?: string;
    readonly resumeSessionPath?: string;
    readonly eventLogPath?: string;
    readonly approvalMode?: ApprovalMode;
    readonly modelFallback?: ModelFallbackPolicy;
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
    const events = new EngineEventBus();
    const protocol = createProtocolEncoder(endpoint);
    events.subscribe(protocol);
    events.subscribe(createJsonlEventLogger({
        path: options.eventLogPath ?? defaultEventLogPath(sessionId),
        sessionId,
    }));
    const inbound = new InboundCommandRouter(endpoint, events);
    const state: RunTurnState = {
        messages: [...store.messages()],
        store,
        deliveryInbox: store,
        toolRuntime: new ToolRuntime(store.header.cwd),
        inbound,
        events,
        hooks: new ToolHooks(),
        approvalMode: options.approvalMode ?? "approve_for_me",
        applyToolEffect: createSubagentEffectApplier({
            adapter,
            model,
            workspace: store.header.cwd,
            approvalMode: options.approvalMode ?? "approve_for_me",
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            ...(options.modelFallback === undefined
                ? {}
                : { modelFallback: options.modelFallback }),
        }),
        enabledToolEffects: ["spawn_subagent"],
        ...(options.modelFallback === undefined
            ? {}
            : { modelFallback: options.modelFallback }),
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
    let activeModel = model;
    let maxTokens = DEFAULT_MODEL_MAX_TOKENS;
    let lengthContinuations = 0;
    const tools = toolDefinitionsForEffects(
        state.applyToolEffect === undefined
            ? []
            : state.enabledToolEffects ?? [],
    );

    try {
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
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
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

            const toolCalls = assistantMessage.content.filter(
                (block): block is ToolCallContent => block.type === "tool_call",
            );
            let toolIndex = 0;
            while (toolIndex < toolCalls.length) {
                const first = toolCalls[toolIndex]!;
                if (!toolMayRunInParallel(first.name)) {
                    await finishToolCalls(state, [
                        executeTurnTool(state, first, turn.signal),
                    ]);
                    toolIndex += 1;
                    continue;
                }

                const parallelCalls: ToolCallContent[] = [];
                while (
                    toolIndex < toolCalls.length
                    && toolMayRunInParallel(toolCalls[toolIndex]!.name)
                ) {
                    parallelCalls.push(toolCalls[toolIndex]!);
                    toolIndex += 1;
                }
                await finishToolCalls(
                    state,
                    parallelCalls.map((toolCall) =>
                        executeTurnTool(state, toolCall, turn.signal)
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
    readonly postHookFailure?: { readonly error: unknown };
}

async function executeTurnTool(
    state: RunTurnState,
    toolCall: ToolCallContent,
    signal: AbortSignal,
): Promise<CompletedToolCall> {
    const hookToolCall = {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input as JsonObject,
    };
    const permission = decideToolPermission(
        state.approvalMode,
        hookToolCall,
        state.toolRuntime.workspace,
    );
    if (permission.behavior === "deny") {
        return { result: deniedToolResult(toolCall, permission.reason) };
    }
    if (permission.behavior === "ask") {
        const approval = await state.inbound.requestToolApproval(
            hookToolCall,
            permission.reason,
            { timeoutMs: TOOL_APPROVAL_TIMEOUT_MS, signal },
        );
        if (approval.behavior === "deny") {
            return { result: deniedToolResult(toolCall, approval.reason) };
        }
    }

    const decision = await state.hooks.runPreToolUse({
        type: "pre_tool_use",
        toolCall: hookToolCall,
        workspace: state.toolRuntime.workspace,
    }, { timeoutMs: PRE_TOOL_HOOK_TIMEOUT_MS });
    if (decision.behavior === "deny") {
        return { result: deniedToolResult(toolCall, decision.reason) };
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
    );
    const result = toolResultMessage(toolCall, output);
    const durationMs = performance.now() - startedAt;
    state.events.emit({
        type: "tool_execution_finished",
        toolCall,
        result,
        durationMs,
    });

    try {
        await state.hooks.runPostToolUse({
            type: "post_tool_use",
            toolCall: hookToolCall,
            result: {
                toolCallId: result.toolCallId,
                toolName: result.toolName,
                content: result.content,
                isError: result.isError,
            },
            workspace: state.toolRuntime.workspace,
            durationMs,
        }, { timeoutMs: POST_TOOL_HOOK_TIMEOUT_MS });
        return { result };
    } catch (postHookError) {
        return { result, postHookFailure: { error: postHookError } };
    }
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
    const failedHook = completed.find(
        (toolCall) => toolCall.postHookFailure !== undefined,
    );
    if (failedHook?.postHookFailure !== undefined) {
        throw failedHook.postHookFailure.error;
    }
}

async function applyToolExecution(
    execution: ToolExecutionResult,
    applyEffect: ApplyToolEffect | undefined,
    signal: AbortSignal,
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
        return await applyEffect(execution.effect, signal);
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
