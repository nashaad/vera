export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
    readonly [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface HookToolCall {
    readonly id: string;
    readonly name: string;
    readonly input: JsonObject;
}

export interface HookTextContent {
    readonly type: "text";
    readonly text: string;
}

export interface HookToolResult {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly content: readonly HookTextContent[];
    readonly isError: boolean;
}

export type HookPower = "observe" | "mutate" | "block" | "replace" | "continue";

export interface ObserveHookResult {
    readonly power: "observe";
}

export interface MutateToolInputHookResult {
    readonly power: "mutate";
    readonly input: JsonObject;
}

export interface BlockHookResult {
    readonly power: "block";
    readonly reason: string;
}

export interface HookToolResultValue {
    readonly content: readonly HookTextContent[];
    readonly isError: boolean;
}

export interface ReplaceToolExecutionHookResult {
    readonly power: "replace";
    readonly result: HookToolResultValue;
}

export interface HookToolResultPatch {
    readonly content?: readonly HookTextContent[];
    readonly isError?: boolean;
}

export interface MutateToolResultHookResult {
    readonly power: "mutate";
    readonly patch: HookToolResultPatch;
}

export interface PreToolUseHookPayload {
    readonly type: "pre_tool_use";
    readonly toolCall: HookToolCall;
    /** Present for host-run sessions; direct engine fixtures may omit it. */
    readonly sessionId?: string;
    readonly workspace: string;
}

export type PreToolUseHookResult =
    | ObserveHookResult
    | MutateToolInputHookResult
    | BlockHookResult
    | ReplaceToolExecutionHookResult;

export interface PostToolUseHookPayload {
    readonly type: "post_tool_use";
    readonly toolCall: HookToolCall;
    readonly result: HookToolResult;
    /** Present for host-run sessions; direct engine fixtures may omit it. */
    readonly sessionId?: string;
    readonly workspace: string;
    readonly durationMs: number;
}

export type PostToolUseHookResult =
    | ObserveHookResult
    | MutateToolResultHookResult;

export type PreToolUseHook = (
    payload: PreToolUseHookPayload,
) => PreToolUseHookResult | Promise<PreToolUseHookResult>;

export type PostToolUseHook = (
    payload: PostToolUseHookPayload,
) => PostToolUseHookResult | Promise<PostToolUseHookResult>;

export interface PreTurnHookPayload {
    readonly type: "pre_turn";
    /** Present for host-run sessions; direct engine fixtures may omit it. */
    readonly sessionId?: string;
    readonly workspace: string;
    readonly prompt: string;
    readonly model: string;
    /** Tool names this turn would offer before the hook runs. */
    readonly tools: readonly string[];
    readonly reasoningEffort?: string;
    /** True for a queued prompt that joined a running turn at a tool boundary. */
    readonly arrivedDuringTurn: boolean;
}

export interface MutatePreTurnHookResult {
    readonly power: "mutate";
    /** Restrict to a subset of `payload.tools`. An empty list offers none. */
    readonly tools?: readonly string[];
    readonly model?: string;
    readonly reasoningEffort?: string;
    /** Stored after the prompt as its own message. Empty text adds nothing. */
    readonly context?: string;
    /** One line shown in the transcript instead of the default row. Up to 200 characters, no newlines. */
    readonly display?: string;
}

export type PreTurnHookResult =
    | ObserveHookResult
    | MutatePreTurnHookResult
    | BlockHookResult;

export type PreTurnHook = (
    payload: PreTurnHookPayload,
) => PreTurnHookResult | Promise<PreTurnHookResult>;

export interface TurnEndingHookPayload {
    readonly type: "turn_ending";
    /** Present for host-run sessions; direct engine fixtures may omit it. */
    readonly sessionId?: string;
    readonly workspace: string;
    /** The user's text for this turn, prompts that joined it included. Empty for a turn with no prompt. */
    readonly prompt: string;
    /** The text of the reply that would end the turn. */
    readonly reply: string;
    /** True when another agent started this session. */
    readonly spawned: boolean;
    /** Continuations this turn has used. A turn gets one; after that `continue` is ignored. */
    readonly continuations: number;
}

export interface ContinueTurnHookResult {
    readonly power: "continue";
    /** Stored after the reply as its own message, then the model runs again. Must not be empty. */
    readonly context: string;
    /** One line shown in the transcript instead of the default row. Up to 200 characters, no newlines. */
    readonly display?: string;
}

export type TurnEndingHookResult = ObserveHookResult | ContinueTurnHookResult;

export type TurnEndingHook = (
    payload: TurnEndingHookPayload,
) => TurnEndingHookResult | Promise<TurnEndingHookResult>;

export interface ModelRequestHookPayload {
    readonly type: "model_request";
    readonly provider: string;
    readonly model: string;
    readonly sessionId: string;
    readonly workspace: string;
    readonly signal?: AbortSignal;
}

/**
 * A contribution is placed under the namespace chosen at registration. The
 * hook never receives or rewrites Vera's messages, tools, or system prompt.
 */
export type ModelRequestHook = (
    payload: ModelRequestHookPayload,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface RegisteredModelRequestHook {
    readonly namespace: string;
    readonly run: ModelRequestHook;
}

export interface SessionStartHookPayload {
    readonly type: "session_start";
    readonly sessionId: string;
    readonly workspace: string;
    readonly reason: "start" | "resume" | "compacted";
}

export interface MutateSessionStartHookResult {
    readonly power: "mutate";
    readonly context: string;
}

export type SessionStartHookResult = ObserveHookResult | MutateSessionStartHookResult;

export type SessionStartHook = (
    payload: SessionStartHookPayload,
) => SessionStartHookResult | Promise<SessionStartHookResult>;

export interface TurnFinishedHookPayload {
    readonly type: "turn_finished";
    readonly sessionId: string;
    readonly workspace: string;
    readonly outcome: "completed" | "error" | "aborted";
    /** User prompts in the session so far, this turn's included. */
    readonly turns: number;
    /** True when another agent started this session. */
    readonly spawned: boolean;
    /** The user's text for this turn. Empty for turns with no user prompt. */
    readonly prompt: string;
    /** The assistant's text for this turn. Empty when it only used tools or failed. */
    readonly reply: string;
}

/** Observe only. Runs after clients have the update and never delays the next turn. */
export type TurnFinishedHook = (
    payload: TurnFinishedHookPayload,
) => void | Promise<void>;

export interface PreCompactHookPayload {
    readonly type: "pre_compact";
    readonly sessionId: string;
    readonly workspace: string;
    readonly reason: "manual" | "automatic";
    /** Estimated context size when compaction began. */
    readonly tokens: number;
    /** The context window, when Vera knows it. */
    readonly capacity?: number;
    /** True when another agent started this session. */
    readonly spawned: boolean;
}

/** Observe only. Compaction does not wait for it; the session file keeps the full history. */
export type PreCompactHook = (
    payload: PreCompactHookPayload,
) => void | Promise<void>;
