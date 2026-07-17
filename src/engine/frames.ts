import type {
    EngineEventSubscriber,
    ToolApprovalUiRequest,
    ToolApprovalUiResponse,
} from "./events.ts";

export type AgentStatus = "idle" | "working" | "waiting";

export interface TranscriptEntry {
    readonly kind: string;
    readonly [field: string]: unknown;
}

export interface PromptFrame {
    readonly type: "prompt";
    readonly content: string;
}

export interface AbortFrame {
    readonly type: "abort";
}

export interface UiResponseFrame {
    readonly type: "ui_response";
    readonly requestId: string;
    readonly response: ToolApprovalUiResponse;
}

export type ClientFrame = PromptFrame | AbortFrame | UiResponseFrame;

export interface HistoryFrame {
    readonly type: "history";
    readonly entries: readonly TranscriptEntry[];
    readonly seq: number;
}

export interface AssistantDeltaFrame {
    readonly type: "assistant_delta";
    readonly text: string;
    readonly seq: number;
}

export interface ToolStartedFrame {
    readonly type: "tool_started";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly seq: number;
}

export interface ToolFinishedFrame {
    readonly type: "tool_finished";
    readonly tool: string;
    readonly seq: number;
}

export interface TurnFinishedFrame {
    readonly type: "turn_finished";
    readonly seq: number;
}

export interface StatusFrame {
    readonly type: "status";
    readonly state: AgentStatus;
    readonly seq: number;
}

export interface UiRequestFrame {
    readonly type: "ui_request";
    readonly requestId: string;
    readonly request: ToolApprovalUiRequest;
    readonly seq: number;
}

export interface UiRequestClosedFrame {
    readonly type: "ui_request_closed";
    readonly requestId: string;
    readonly seq: number;
}

export type AgentFrame =
    | HistoryFrame
    | AssistantDeltaFrame
    | ToolStartedFrame
    | ToolFinishedFrame
    | TurnFinishedFrame
    | StatusFrame
    | UiRequestFrame
    | UiRequestClosedFrame;

export interface AgentFrameSender {
    send(frame: AgentFrame): void;
}

export function createFrameProjector(
    sender: AgentFrameSender,
): EngineEventSubscriber {
    let seq = 0;

    return (event): void => {
        if (
            event.type === "model_stream"
            && event.event.type === "text_delta"
        ) {
            seq += 1;
            sender.send({
                type: "assistant_delta",
                text: event.event.text,
                seq,
            });
            return;
        }

        if (event.type === "tool_execution_started") {
            seq += 1;
            sender.send({
                type: "tool_started",
                tool: event.toolCall.name,
                args: event.toolCall.input,
                seq,
            });
            return;
        }

        if (event.type === "tool_execution_finished") {
            seq += 1;
            sender.send({
                type: "tool_finished",
                tool: event.toolCall.name,
                seq,
            });
            return;
        }

        if (event.type === "ui_request") {
            seq += 1;
            sender.send({
                type: "ui_request",
                requestId: event.requestId,
                request: event.request,
                seq,
            });
            return;
        }

        if (event.type === "ui_request_closed") {
            seq += 1;
            sender.send({
                type: "ui_request_closed",
                requestId: event.requestId,
                seq,
            });
            return;
        }

        if (event.type === "turn_finished") {
            seq += 1;
            sender.send({ type: "turn_finished", seq });
        }
    };
}
