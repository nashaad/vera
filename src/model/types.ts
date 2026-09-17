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
    readonly contextSource?: "session_start";
    /** Compaction may summarize history before this message, never across it. */
    readonly compactionBarrier?: boolean;
}

export interface ModelInputUserMessage {
    readonly role: "user";
    readonly content: readonly (UserContent | ImageContent)[];
    readonly internal?: boolean;
    readonly compactionBarrier?: boolean;
}

/**
 * A request that ran on something other than what was asked for, either a
 * coarser reasoning effort or a different model.
 */
export interface ModelSubstitution {
    /** The model the request was aimed at when the substitution happened. */
    readonly model: string;
    /** What was asked for: an effort level, or a model reference. */
    readonly requested: string;
    /**
     * What the retry actually ran on. Absent on an effort substitution means
     * no reasoning level was sent at all, so the provider default applied.
     */
    readonly using?: string;
    /** The provider's own wording for the refusal, or the failure that forced it. */
    readonly reason: string;
    readonly scope: "effort" | "model";
}

/**
 * One wording for every surface. The same sentence is what a client shows
 * live, what an exported transcript keeps, and what a subagent notice carries,
 * so a substitution reads the same way wherever it is found again.
 *
 * Each sentence names three things and nothing else: what was asked for, what
 * ran instead, and why. `using` absent means nothing ran in its place, so the
 * sentence says that rather than naming a level or model that never existed.
 */
export function formatModelSubstitution(
    substitution: ModelSubstitution,
): string {
    const { model, requested, using, reason } = substitution;
    if (substitution.scope === "model") {
        return using === undefined
            ? `Requested model ${requested}, and nothing ran in its place,`
                + ` because ${reason}.`
            : `Requested model ${requested}, ran ${using} instead,`
                + ` because ${reason}.`;
    }
    const on = model.length === 0 ? "" : ` on ${model}`;
    return using === undefined
        ? `Requested reasoning effort "${requested}"${on}, ran with no`
            + ` reasoning level at all, because ${reason}.`
        : `Requested reasoning effort "${requested}"${on}, ran at`
            + ` "${using}" instead, because ${reason}.`;
}

export interface TurnTiming {
    readonly durationMs: number;
    readonly finishedAt: number;
}

export function isTurnTiming(value: unknown): value is TurnTiming {
    if (typeof value !== "object" || value === null) return false;
    const timing = value as Record<string, unknown>;
    return typeof timing.durationMs === "number"
        && Number.isFinite(timing.durationMs)
        && timing.durationMs >= 0
        && typeof timing.finishedAt === "number"
        && Number.isFinite(timing.finishedAt)
        && Math.abs(timing.finishedAt) <= 8.64e15;
}

export interface AssistantMessage {
    readonly role: "assistant";
    /** Model-visible context that clients must not render as local transcript. */
    readonly internal?: boolean;
    readonly content: readonly AssistantContent[];
    readonly source: ModelSource;
    readonly usage: ModelUsage;
    /** Wall time spent obtaining this response, including its recovery path. */
    readonly durationMs?: number;
    // Present only on the final response of a whole turn.
    readonly turnTiming?: TurnTiming;
    readonly stopReason: ModelStopReason;
    readonly errorMessage?: string;
    /**
     * Carried on the message so a substitution survives replay: the transcript
     * is projected from stored messages, not from the update stream.
     */
    readonly substitutions?: readonly ModelSubstitution[];
}

export interface ToolResultMessage {
    readonly role: "tool_result";
    /** Model-visible context that clients must not render as local transcript. */
    readonly internal?: boolean;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly content: readonly TextContent[];
    readonly isError: boolean;
    /** Host-runtime process identity; omitted from provider request projection. */
    readonly processId?: string;
    readonly presentation?: ToolPresentation;
    /**
     * Durable pointer to the original output. The engine uses it only when
     * assembling an aged model context; providers never receive it.
     */
    readonly toolResultSource?: ToolResultSource;
}

export interface ToolResultSource {
    /** Byte length of the complete output before any per-result ceiling. */
    readonly originalBytes: number;
    /** The owner-only spill file containing the complete output. */
    readonly spillPath?: string;
}

/** Results at or below this size remain verbatim for the life of a session. */
export const TOOL_RESULT_VERBATIM_FLOOR_BYTES = 2 * 1024;

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
    Omit<ToolResultMessage, "presentation" | "processId" | "toolResultSource">;

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
    /** Namespaced provider-body fields contributed outside the engine. */
    readonly bodyExtensions?: Readonly<Record<string, import("../sdk/hooks.ts").JsonValue>>;
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

/**
 * The request went out asking for a reasoning level other than the one the
 * caller named, because the model's own level list does not contain it.
 *
 * Emitted rather than folded silently: a level the user chose and a level the
 * adapter settled on are different facts, and the second one is the one that
 * cost them money. Carries no model name; recovery names the model, which is
 * the only layer that knows which one the request finally went to.
 */
export interface EffortSubstitutedEvent {
    readonly type: "effort_substituted";
    readonly requested: string;
    /** Absent means no level was sent at all. */
    readonly using?: string;
    readonly reason: string;
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
    | EffortSubstitutedEvent
    | StreamDoneEvent
    | StreamErrorEvent;

export interface ModelStream extends AsyncIterable<ModelStreamEvent> {
    result(): Promise<AssistantMessage>;
}

export interface ModelAdapter {
    /** The provider's blanket answer, used only when the model has none. */
    readonly supportsImageInput?: boolean;
    /**
     * Per-model, because image support is a fact about a model and not about
     * the endpoint it is reached through: one OpenRouter key serves models
     * that take images and models that do not. Undefined means unstated, and
     * the caller should let the request through rather than refuse it.
     */
    imageInputSupport?(model: string): boolean | undefined;
    supportsImageInputFor?(provider: string, model: string): boolean;
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
