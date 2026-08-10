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
