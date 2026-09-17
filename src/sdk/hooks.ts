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

export type HookPower = "observe" | "mutate" | "block" | "replace";

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
}

export interface MutatePreTurnHookResult {
    readonly power: "mutate";
    /** Restrict to a subset of `payload.tools`. An empty list offers none. */
    readonly tools?: readonly string[];
    readonly model?: string;
    readonly reasoningEffort?: string;
}

export type PreTurnHookResult =
    | ObserveHookResult
    | MutatePreTurnHookResult
    | BlockHookResult;

export type PreTurnHook = (
    payload: PreTurnHookPayload,
) => PreTurnHookResult | Promise<PreTurnHookResult>;

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
