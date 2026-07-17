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

export interface PreToolUseHookPayload {
    readonly type: "pre_tool_use";
    readonly toolCall: HookToolCall;
    readonly workspace: string;
}

export interface ContinueToolUse {
    readonly behavior: "continue";
}

export interface DenyToolUse {
    readonly behavior: "deny";
    readonly reason: string;
}

export type PreToolUseHookResult = ContinueToolUse | DenyToolUse;

export interface PostToolUseHookPayload {
    readonly type: "post_tool_use";
    readonly toolCall: HookToolCall;
    readonly result: HookToolResult;
    readonly workspace: string;
    readonly durationMs: number;
}

export type PreToolUseHook = (
    payload: PreToolUseHookPayload,
) => PreToolUseHookResult | Promise<PreToolUseHookResult>;

export type PostToolUseHook = (
    payload: PostToolUseHookPayload,
) => void | Promise<void>;
