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

export type ClientFrame = PromptFrame | AbortFrame;

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

export type AgentFrame =
    | HistoryFrame
    | AssistantDeltaFrame
    | ToolStartedFrame
    | ToolFinishedFrame
    | TurnFinishedFrame
    | StatusFrame;
