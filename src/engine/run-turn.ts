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
import type { FrameEndpoint } from "./in-process-channel.ts";
import type { AgentFrame, ClientFrame } from "./frames.ts";
import { createFrameProjector } from "./frames.ts";
import {
    EngineEventBus,
    createJsonlEventLogger,
    defaultEventLogPath,
} from "./events.ts";
import { availableTools, executeToolCall } from "../tools/execute.ts";
import { ToolRuntime } from "../tools/runtime.ts";
import { assembleSystemPrompt } from "./assemble.ts";
import { ToolHooks } from "./hooks.ts";
import { InboundFrameRouter } from "./inbound-frame-router.ts";
import {
    decideToolPermission,
    type ApprovalMode,
} from "./permissions.ts";
import {
    requestModelWithRecovery,
    type WaitForModelRetry,
} from "./recovery.ts";

const PRE_TOOL_HOOK_TIMEOUT_MS = 60_000;
const POST_TOOL_HOOK_TIMEOUT_MS = 5_000;
const TOOL_APPROVAL_TIMEOUT_MS = 60_000;

export interface RunTurnState {
    readonly messages: ModelMessage[];
    readonly toolRuntime: ToolRuntime;
    readonly inbound: InboundFrameRouter;
    readonly events: EngineEventBus;
    readonly hooks: ToolHooks;
    readonly approvalMode: ApprovalMode;
    readonly waitForModelRetry?: WaitForModelRetry;
}

export interface RunHeadlessLoopOptions {
    readonly sessionId?: string;
    readonly eventLogPath?: string;
    readonly approvalMode?: ApprovalMode;
}

export async function runHeadlessLoop(
    endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    adapter: ModelAdapter,
    model: string,
    reasoningEffort?: ModelReasoningEffort,
    options: RunHeadlessLoopOptions = {},
): Promise<void> {
    const sessionId = options.sessionId ?? randomUUID();
    const events = new EngineEventBus();
    events.subscribe(createFrameProjector(endpoint));
    events.subscribe(createJsonlEventLogger({
        path: options.eventLogPath ?? defaultEventLogPath(sessionId),
        sessionId,
    }));
    const inbound = new InboundFrameRouter(endpoint, events);
    const state: RunTurnState = {
        messages: [],
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound,
        events,
        hooks: new ToolHooks(),
        approvalMode: options.approvalMode ?? "approve_for_me",
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

    const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: turn.prompt.content }],
    };
    state.messages.push(userMessage);
    state.events.emit({ type: "turn_started", message: userMessage });
    let assistantMessage: AssistantMessage;

    try {
        while (true) {
            const systemPrompt = assembleSystemPrompt({
                tools: availableTools,
                workspace: state.toolRuntime.workspace,
                date: new Date(),
            });
            const request = {
                model,
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                systemPrompt,
                messages: state.messages.slice(),
                tools: availableTools,
                signal: turn.signal,
            };
            state.events.emit({
                type: "model_request",
                model: request.model,
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
                    ...(state.waitForModelRetry === undefined
                        ? {}
                        : { wait: state.waitForModelRetry }),
                },
            );
            state.messages.push(assistantMessage);

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
                        state.messages.push(deniedToolResult(
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
                            state.messages.push(deniedToolResult(
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
                        state.messages.push(deniedToolResult(
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

                    state.messages.push(result);
                    state.events.emit({
                        type: "tool_execution_finished",
                        toolCall: block,
                        result,
                        durationMs,
                    });

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
                }
            }
        }
    } finally {
        state.inbound.finishTurn();
    }

    state.events.emit({ type: "turn_finished", message: assistantMessage });
    return assistantMessage;
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
