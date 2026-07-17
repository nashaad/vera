import {
    appendFileSync,
    chmodSync,
    closeSync,
    fchmodSync,
    mkdirSync,
    openSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
    AssistantMessage,
    ModelMessage,
    ModelReasoningEffort,
    ModelStreamEvent,
    ModelTool,
    StreamErrorEvent,
    ToolCallContent,
    ToolResultMessage,
    UserMessage,
} from "../model/types.ts";
import type { HookToolCall } from "../sdk/hooks.ts";

export interface TurnStartedEvent {
    readonly type: "turn_started";
    readonly message: UserMessage;
}

export interface PromptQueuedEvent {
    readonly type: "prompt_queued";
    readonly content: string;
}

export interface AbortRequestedEvent {
    readonly type: "abort_requested";
}

export interface ToolApprovalUiRequest {
    readonly type: "tool_approval";
    readonly toolCall: HookToolCall;
    readonly reason: string;
    readonly warning: string;
}

export interface ToolApprovalUiResponse {
    readonly type: "tool_approval";
    readonly decision: "allow" | "deny";
}

export interface UiRequestEvent {
    readonly type: "ui_request";
    readonly requestId: string;
    readonly request: ToolApprovalUiRequest;
}

export interface UiResponseEvent {
    readonly type: "ui_response";
    readonly requestId: string;
    readonly response: ToolApprovalUiResponse;
}

export interface ModelRequestEvent {
    readonly type: "model_request";
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly systemPrompt: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
}

export type ObservableModelStreamEvent = Exclude<
    ModelStreamEvent,
    StreamErrorEvent
>;

export interface ModelStreamObservedEvent {
    readonly type: "model_stream";
    readonly event: ObservableModelStreamEvent;
}

export interface ModelStreamErrorEvent {
    readonly type: "model_stream_error";
    readonly error: string;
    readonly message: AssistantMessage;
}

export interface ToolExecutionStartedEvent {
    readonly type: "tool_execution_started";
    readonly toolCall: ToolCallContent;
}

export interface ToolExecutionFinishedEvent {
    readonly type: "tool_execution_finished";
    readonly toolCall: ToolCallContent;
    readonly result: ToolResultMessage;
    readonly durationMs: number;
}

export interface TurnFinishedEvent {
    readonly type: "turn_finished";
    readonly message: AssistantMessage;
}

export type EngineEvent =
    | TurnStartedEvent
    | PromptQueuedEvent
    | AbortRequestedEvent
    | UiRequestEvent
    | UiResponseEvent
    | ModelRequestEvent
    | ModelStreamObservedEvent
    | ModelStreamErrorEvent
    | ToolExecutionStartedEvent
    | ToolExecutionFinishedEvent
    | TurnFinishedEvent;

export type EngineEventSubscriber = (
    event: EngineEvent,
) => void;

export class EngineEventBus {
    private readonly subscribers = new Set<EngineEventSubscriber>();

    subscribe(subscriber: EngineEventSubscriber): () => void {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }

    emit(event: EngineEvent): void {
        // Subscribers are synchronous so every observer sees the same order.
        for (const subscriber of this.subscribers) {
            try {
                subscriber(event);
            } catch {
                // Observation must never change the turn outcome.
            }
        }
    }
}

export interface JsonlEventLoggerOptions {
    readonly path: string;
    readonly sessionId: string;
    readonly now?: () => Date;
}

export function defaultEventLogPath(sessionId: string): string {
    return join(homedir(), ".vera", "logs", `${sessionId}.jsonl`);
}

export function createJsonlEventLogger(
    options: JsonlEventLoggerOptions,
): EngineEventSubscriber {
    const now = options.now ?? (() => new Date());
    let logPrepared = false;

    return (event): void => {
        if (!logPrepared) {
            prepareEventLog(options.path);
            logPrepared = true;
        }

        appendFileSync(
            options.path,
            `${JSON.stringify({
                timestamp: now().toISOString(),
                level: event.type === "model_stream_error" ? "error" : "debug",
                sessionId: options.sessionId,
                ...event,
            })}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
    };
}

function prepareEventLog(path: string): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);

    const file = openSync(path, "a", 0o600);
    try {
        fchmodSync(file, 0o600);
    } finally {
        closeSync(file);
    }
}
