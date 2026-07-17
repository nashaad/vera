import type {
    EngineEventSubscriber,
    ToolApprovalUiRequest,
    ToolApprovalUiResponse,
} from "./events.ts";
import type { ModelMessage } from "../model/types.ts";

export type AgentStatus = "idle" | "working" | "waiting";

export interface UserTranscriptEntry {
    readonly kind: "user";
    readonly text: string;
}

export interface AssistantTranscriptEntry {
    readonly kind: "assistant";
    readonly text: string;
}

export interface ToolTranscriptEntry {
    readonly kind: "tool";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
}

export type TranscriptEntry =
    | UserTranscriptEntry
    | AssistantTranscriptEntry
    | ToolTranscriptEntry;

export interface PromptCommand {
    readonly type: "prompt";
    readonly content: string;
}

export interface AbortCommand {
    readonly type: "abort";
}

export interface UiResponseCommand {
    readonly type: "ui_response";
    readonly requestId: string;
    readonly response: ToolApprovalUiResponse;
}

export type ClientCommand = PromptCommand | AbortCommand | UiResponseCommand;

export interface HistoryUpdate {
    readonly type: "history";
    readonly entries: readonly TranscriptEntry[];
    readonly seq: number;
}

export interface UserPromptUpdate {
    readonly type: "user_prompt";
    readonly content: string;
    readonly seq: number;
}

export interface AssistantDeltaUpdate {
    readonly type: "assistant_delta";
    readonly text: string;
    readonly seq: number;
}

export interface ToolStartedUpdate {
    readonly type: "tool_started";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly seq: number;
}

export interface ToolFinishedUpdate {
    readonly type: "tool_finished";
    readonly tool: string;
    readonly seq: number;
}

export interface TurnFinishedUpdate {
    readonly type: "turn_finished";
    readonly seq: number;
}

export interface StatusUpdate {
    readonly type: "status";
    readonly state: AgentStatus;
    readonly seq: number;
}

export interface UiRequestUpdate {
    readonly type: "ui_request";
    readonly requestId: string;
    readonly request: ToolApprovalUiRequest;
    readonly seq: number;
}

export interface UiRequestClosedUpdate {
    readonly type: "ui_request_closed";
    readonly requestId: string;
    readonly seq: number;
}

export type AgentUpdate =
    | HistoryUpdate
    | UserPromptUpdate
    | AssistantDeltaUpdate
    | ToolStartedUpdate
    | ToolFinishedUpdate
    | TurnFinishedUpdate
    | StatusUpdate
    | UiRequestUpdate
    | UiRequestClosedUpdate;

export interface AgentUpdateSender {
    send(update: AgentUpdate): void;
}

export interface ProtocolEncoder extends EngineEventSubscriber {
    checkpoint(messages: readonly ModelMessage[]): void;
}

export function createProtocolEncoder(
    sender: AgentUpdateSender,
): ProtocolEncoder {
    let seq = 0;

    const encode = (event: Parameters<EngineEventSubscriber>[0]): void => {
        if (event.type === "turn_started") {
            seq += 1;
            sender.send({
                type: "user_prompt",
                content: textContent(event.message.content),
                seq,
            });
            return;
        }
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

    return Object.assign(encode, {
        checkpoint(messages: readonly ModelMessage[]): void {
            sender.send({
                type: "history",
                entries: projectTranscript(messages),
                seq,
            });
        },
    });
}

export function projectTranscript(
    messages: readonly ModelMessage[],
): readonly TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];

    for (const message of messages) {
        if (message.role === "user") {
            if (message.internal === true) {
                continue;
            }
            entries.push({
                kind: "user",
                text: textContent(message.content),
            });
            continue;
        }
        if (message.role === "tool_result") {
            continue;
        }
        for (const content of message.content) {
            if (content.type === "text") {
                entries.push({ kind: "assistant", text: content.text });
            }
            if (content.type === "tool_call") {
                entries.push({
                    kind: "tool",
                    tool: content.name,
                    args: structuredClone(content.input),
                });
            }
        }
    }

    return entries;
}

function textContent(
    content: readonly { readonly text: string }[],
): string {
    return content.map((part) => part.text).join("\n");
}
