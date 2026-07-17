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
import { availableTools, executeToolCall } from "../tools/execute.ts";
import { ToolRuntime } from "../tools/runtime.ts";
import { assembleSystemPrompt } from "./assemble.ts";
import { ToolHooks } from "./hooks.ts";
import { InboundCommandRouter } from "./inbound-command-router.ts";
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
    type SessionMessageStore,
} from "../store/session-store.ts";

const PRE_TOOL_HOOK_TIMEOUT_MS = 60_000;
const POST_TOOL_HOOK_TIMEOUT_MS = 5_000;
const TOOL_APPROVAL_TIMEOUT_MS = 60_000;

export interface RunTurnState {
    readonly messages: ModelMessage[];
    readonly store: SessionMessageStore;
    readonly toolRuntime: ToolRuntime;
    readonly inbound: InboundCommandRouter;
    readonly events: EngineEventBus;
    readonly hooks: ToolHooks;
    readonly approvalMode: ApprovalMode;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly waitForModelRetry?: WaitForModelRetry;
}

export interface RunHeadlessLoopOptions {
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
        options.resumeSessionPath !== undefined
        && (options.sessionId !== undefined || options.sessionPath !== undefined)
    ) {
        throw new Error(
            "A resumed session cannot also specify a new session ID or path",
        );
    }
    const newSessionId = options.sessionId ?? randomUUID();
    const store = options.resumeSessionPath === undefined
        ? await SessionStore.create(
            options.sessionPath ?? defaultSessionPath(newSessionId),
            { sessionId: newSessionId, cwd: process.cwd() },
        )
        : await SessionStore.open(options.resumeSessionPath);
    const sessionId = store.header.id;
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(endpoint));
    events.subscribe(createJsonlEventLogger({
        path: options.eventLogPath ?? defaultEventLogPath(sessionId),
        sessionId,
    }));
    const inbound = new InboundCommandRouter(endpoint, events);
    const state: RunTurnState = {
        messages: [...store.messages()],
        store,
        toolRuntime: new ToolRuntime(store.header.cwd),
        inbound,
        events,
        hooks: new ToolHooks(),
        approvalMode: options.approvalMode ?? "approve_for_me",
        ...(options.modelFallback === undefined
            ? {}
            : { modelFallback: options.modelFallback }),
    };

    while (true) {
        await runTurn(adapter, model, state, reasoningEffort);
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

    try {
        const userMessage: UserMessage = {
            role: "user",
            content: [{ type: "text", text: turn.prompt.content }],
        };
        await commitMessage(state, userMessage);
        state.events.emit({ type: "turn_started", message: userMessage });

        while (true) {
            const systemPrompt = assembleSystemPrompt({
                tools: availableTools,
                workspace: state.toolRuntime.workspace,
                date: new Date(),
            });
            const request = {
                model: activeModel,
                maxTokens,
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                systemPrompt,
                messages: state.messages.slice(),
                tools: availableTools,
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
                };
                await commitMessage(state, continuationMessage);
                maxTokens = continuation.nextMaxTokens;
                lengthContinuations = continuation.continuation;
                continue;
            }

            if (assistantMessage.stopReason !== "tool_use") {
                break;
            }

            for (const block of assistantMessage.content) {
                if (block.type === "tool_call") {
                    const hookToolCall = {
                        id: block.id,
                        name: block.name,
                        input: block.input as JsonObject,
                    };
                    const permission = decideToolPermission(
                        state.approvalMode,
                        hookToolCall,
                        state.toolRuntime.workspace,
                    );
                    if (permission.behavior === "deny") {
                        await commitMessage(state, deniedToolResult(
                            block,
                            permission.reason,
                        ));
                        continue;
                    }
                    if (permission.behavior === "ask") {
                        const approval = await state.inbound.requestToolApproval(
                            hookToolCall,
                            permission.reason,
                            {
                                timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
                                signal: turn.signal,
                            },
                        );
                        if (approval.behavior === "deny") {
                            await commitMessage(state, deniedToolResult(
                                block,
                                approval.reason,
                            ));
                            continue;
                        }
                    }

                    const decision = await state.hooks.runPreToolUse({
                        type: "pre_tool_use",
                        toolCall: hookToolCall,
                        workspace: state.toolRuntime.workspace,
                    }, { timeoutMs: PRE_TOOL_HOOK_TIMEOUT_MS });
                    if (decision.behavior === "deny") {
                        await commitMessage(state, deniedToolResult(
                            block,
                            decision.reason,
                        ));
                        continue;
                    }

                    state.events.emit({
                        type: "tool_execution_started",
                        toolCall: block,
                    });
                    const startedAt = performance.now();

                    const result = await executeToolCall(
                        block,
                        state.toolRuntime,
                        turn.signal,
                    );
                    const durationMs = performance.now() - startedAt;

                    state.events.emit({
                        type: "tool_execution_finished",
                        toolCall: block,
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
                    } finally {
                        await commitMessage(state, result);
                    }
                }
            }
        }
    } finally {
        state.inbound.finishTurn();
    }

    state.events.emit({ type: "turn_finished", message: assistantMessage });
    return assistantMessage;
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
