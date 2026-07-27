export interface ModelSource {
    readonly provider: string;
    readonly api: string;
    readonly model: string;
    readonly responseModel?: string;
}

export interface TextContent {
    readonly type: "text";
    readonly text: string;
}

export type ModelImageMediaType =
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp";

export interface ImageContent {
    readonly type: "image";
    readonly mediaType: ModelImageMediaType;
    readonly data: Uint8Array;
}

export interface ImageAttachmentContent {
    readonly type: "image_attachment";
    readonly attachmentId: string;
}

export type UserContent = TextContent | ImageAttachmentContent;

export interface ThinkingContent {
    readonly type: "thinking";
    readonly text: string;
    readonly signature?: string;
}

export interface ToolCallContent {
    readonly type: "tool_call";
    readonly id: string;
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly signature?: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
    readonly role: "user";
    readonly content: readonly UserContent[];
    readonly internal?: boolean;
}

export interface ModelInputUserMessage {
    readonly role: "user";
    readonly content: readonly (UserContent | ImageContent)[];
    readonly internal?: boolean;
}

export interface AssistantMessage {
    readonly role: "assistant";
    readonly content: readonly AssistantContent[];
    readonly source: ModelSource;
    readonly usage: ModelUsage;
    readonly stopReason: ModelStopReason;
    readonly errorMessage?: string;
}

export interface ToolResultMessage {
    readonly role: "tool_result";
    readonly toolCallId: string;
    readonly toolName: string;
    readonly content: readonly TextContent[];
    readonly isError: boolean;
    readonly presentation?: ToolPresentation;
}

export interface UnifiedDiffPresentation {
    readonly kind: "unified_diff";
    readonly path: string;
    readonly patch: string;
}

export interface ToolNoticePresentation {
    readonly kind: "tool_notice";
    readonly text: string;
}

export type ToolPresentation =
    | UnifiedDiffPresentation
    | ToolNoticePresentation;

export type ModelMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type ModelInputToolResultMessage =
    Omit<ToolResultMessage, "presentation">;

export type ModelInputMessage =
    | ModelInputUserMessage
    | AssistantMessage
    | ModelInputToolResultMessage;

export interface ModelUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly reasoningTokens: number;
    readonly totalTokens: number;
    readonly cost?: number;
}

export type ModelStopReason =
    | "stop"
    | "length"
    | "tool_use"
    | "content_filter"
    | "aborted"
    | "error";

export interface ModelTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * A reasoning level, as the provider names it (e.g. "off", "low", "xhigh",
 * "ultra"). Vera does not police this against a fixed word list: what a
 * level is called, and how many a model offers, is a fact about that model,
 * not a property of this type. Whether a given string is valid for a
 * specific (provider, model) is decided against that model's own level
 * list, not here.
 */
export type ModelReasoningEffort = string;

export interface ModelRequest {
    readonly provider?: string;
    readonly model: string;
    readonly maxTokens?: number;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly systemPrompt?: string;
    readonly messages: readonly ModelInputMessage[];
    readonly tools?: readonly ModelTool[];
    readonly signal?: AbortSignal;
}

export interface StreamStartEvent {
    readonly type: "start";
}

export interface TextStartEvent {
    readonly type: "text_start";
    readonly contentIndex: number;
}

export interface TextDeltaEvent {
    readonly type: "text_delta";
    readonly contentIndex: number;
    readonly text: string;
}

export interface TextEndEvent {
    readonly type: "text_end";
    readonly contentIndex: number;
}

export interface ThinkingStartEvent {
    readonly type: "thinking_start";
    readonly contentIndex: number;
}

export interface ThinkingDeltaEvent {
    readonly type: "thinking_delta";
    readonly contentIndex: number;
    readonly text: string;
}

export interface ThinkingEndEvent {
    readonly type: "thinking_end";
    readonly contentIndex: number;
}

export interface ToolCallStartEvent {
    readonly type: "tool_call_start";
    readonly contentIndex: number;
}

export interface ToolCallDeltaEvent {
    readonly type: "tool_call_delta";
    readonly contentIndex: number;
    readonly argumentsDelta: string;
}

export interface ToolCallEndEvent {
    readonly type: "tool_call_end";
    readonly contentIndex: number;
    readonly toolCall: ToolCallContent;
}

export interface StreamDoneEvent {
    readonly type: "done";
    readonly message: AssistantMessage;
}

export interface StreamErrorEvent {
    /** Terminal event. Any content blocks without an end event are incomplete. */
    readonly type: "error";
    readonly error: Error;
    readonly message: AssistantMessage;
}

export type ModelStreamEvent =
    | StreamStartEvent
    | TextStartEvent
    | TextDeltaEvent
    | TextEndEvent
    | ThinkingStartEvent
    | ThinkingDeltaEvent
    | ThinkingEndEvent
    | ToolCallStartEvent
    | ToolCallDeltaEvent
    | ToolCallEndEvent
    | StreamDoneEvent
    | StreamErrorEvent;

export interface ModelStream extends AsyncIterable<ModelStreamEvent> {
    result(): Promise<AssistantMessage>;
}

export interface ModelAdapter {
    readonly supportsImageInput?: boolean;
    supportsImageInputFor?(provider: string): boolean;
    /**
     * Return a stream immediately. Provider failures belong in its terminal
     * error event so the engine can apply recovery without provider knowledge.
     */
    stream(request: ModelRequest): ModelStream;
}

export function emptyUsage(): ModelUsage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
    };
}
