import { randomUUID } from "node:crypto";

import type {
    AssistantMessage,
    ModelAdapter,
    ModelMessage,
    ModelReasoningEffort,
    UserMessage,
} from "../model/types.ts";
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
import { InboundFrameRouter } from "./inbound-frame-router.ts";

export interface RunTurnState {
    readonly messages: ModelMessage[];
    readonly toolRuntime: ToolRuntime;
    readonly inbound: InboundFrameRouter;
    readonly events: EngineEventBus;
}

export interface RunHeadlessLoopOptions {
    readonly sessionId?: string;
    readonly eventLogPath?: string;
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
            const stream = adapter.stream(request);

            for await (const event of stream) {
                if (event.type === "error") {
                    state.events.emit({
                        type: "model_stream_error",
                        error: event.error.message,
                        message: event.message,
                    });
                    continue;
                }
                state.events.emit({ type: "model_stream", event });
            }

            assistantMessage = await stream.result();
            state.messages.push(assistantMessage);

            if (assistantMessage.stopReason !== "tool_use") {
                break;
            }

            for (const block of assistantMessage.content) {
                if (block.type === "tool_call") {
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
                    state.messages.push(result);

                    state.events.emit({
                        type: "tool_execution_finished",
                        toolCall: block,
                        result,
                        durationMs: performance.now() - startedAt,
                    });
                }
            }
        }
    } finally {
        state.inbound.finishTurn();
    }

    state.events.emit({ type: "turn_finished", message: assistantMessage });
    return assistantMessage;
}
