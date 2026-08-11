import { spawn } from "node:child_process";

import type {
    PostToolUseHook,
    PostToolUseHookPayload,
    PostToolUseHookResult,
    PreToolUseHook,
    PreToolUseHookPayload,
    PreToolUseHookResult,
} from "../sdk/hooks.ts";

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_ARG_COUNT = 16;
const MAX_ARG_BYTES = 8 * 1_024;
const MAX_INPUT_BYTES = 256 * 1_024;
const MAX_OUTPUT_BYTES = 64 * 1_024;

export interface CommandHookSpec {
    readonly phase: "pre_tool_use" | "post_tool_use";
    readonly argv: readonly string[];
    readonly protocol?: "vera" | "claude";
    readonly timeoutMs?: number;
}

interface ClaudePreToolUsePayload {
    readonly session_id: string;
    readonly hook_event_name: "PreToolUse";
    readonly tool_name: string;
    readonly tool_input: Readonly<Record<string, unknown>>;
    readonly tool_use_id: string;
    readonly cwd: string;
}

export function createCommandHook(
    spec: CommandHookSpec,
): PreToolUseHook | PostToolUseHook {
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const protocol = spec.protocol ?? "vera";
    validateCommandHookSpec(spec);
    return spec.phase === "pre_tool_use"
        ? (payload: PreToolUseHookPayload): Promise<PreToolUseHookResult> =>
            invokeCommand(
                spec.argv,
                timeoutMs,
                protocol === "claude"
                    ? claudePreToolUsePayload(payload)
                    : payload,
                protocol,
            ) as Promise<PreToolUseHookResult>
        : (payload: PostToolUseHookPayload): Promise<PostToolUseHookResult> =>
            invokeCommand(
                spec.argv,
                timeoutMs,
                payload,
                protocol,
            ) as Promise<PostToolUseHookResult>;
}

function validateCommandHookSpec(spec: CommandHookSpec): void {
    if (spec.phase !== "pre_tool_use" && spec.phase !== "post_tool_use"
        || !Array.isArray(spec.argv)
        || spec.argv.length === 0
        || spec.argv.length > MAX_ARG_COUNT
        || spec.argv.some((arg) => typeof arg !== "string" || arg.length === 0)
        || Buffer.byteLength(JSON.stringify(spec.argv), "utf8") > MAX_ARG_BYTES) {
        throw new Error("Command hook argv must be a bounded non-empty array");
    }
    if (spec.protocol !== undefined
        && spec.protocol !== "vera"
        && spec.protocol !== "claude") {
        throw new Error("Command hook protocol must be vera or claude");
    }
    if (spec.protocol === "claude" && spec.phase !== "pre_tool_use") {
        throw new Error("Claude command hooks currently support pre_tool_use only");
    }
    if (!Number.isSafeInteger(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        || (spec.timeoutMs ?? DEFAULT_TIMEOUT_MS) <= 0
        || (spec.timeoutMs ?? DEFAULT_TIMEOUT_MS) > 30_000) {
        throw new Error("Command hook timeout must be between 1 and 30000ms");
    }
}

async function invokeCommand(
    argv: readonly string[],
    timeoutMs: number,
    payload: unknown,
    protocol: "vera" | "claude",
): Promise<unknown> {
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
        throw new Error("Command hook input exceeded its byte bound");
    }
    return await new Promise<unknown>((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), {
            shell: false,
            stdio: ["pipe", "pipe", "ignore"],
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            finish(new Error(`Command hook timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const finish = (error: Error | undefined, value?: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error === undefined ? resolve(value) : reject(error);
        };
        child.once("error", (error) => finish(error));
        child.stdin.once("error", (error) => finish(error));
        child.stdout.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_OUTPUT_BYTES) {
                child.kill("SIGTERM");
                finish(new Error("Command hook output exceeded its byte bound"));
                return;
            }
            chunks.push(chunk);
        });
        child.once("close", (code) => {
            if (settled) return;
            if (code !== 0) {
                finish(new Error(`Command hook exited with status ${code ?? "unknown"}`));
                return;
            }
            try {
                const output = Buffer.concat(chunks).toString("utf8").trim();
                if (protocol === "claude" && output.length === 0) {
                    finish(undefined, { power: "observe" });
                    return;
                }
                const value: unknown = JSON.parse(output);
                finish(
                    undefined,
                    protocol === "claude"
                        ? claudePreToolUseResult(value)
                        : value,
                );
            } catch {
                finish(new Error("Command hook returned invalid JSON"));
            }
        });
        child.stdin.end(input);
    });
}

function claudePreToolUsePayload(
    payload: PreToolUseHookPayload,
): ClaudePreToolUsePayload {
    return {
        session_id: payload.sessionId ?? "",
        hook_event_name: "PreToolUse",
        tool_name: payload.toolCall.name === "bash"
            ? "Bash"
            : payload.toolCall.name,
        tool_input: payload.toolCall.input,
        tool_use_id: payload.toolCall.id,
        cwd: payload.workspace,
    };
}

function claudePreToolUseResult(value: unknown): PreToolUseHookResult {
    if (!isPlainObject(value)) {
        throw new Error("Command hook returned invalid JSON");
    }
    const output = value.hookSpecificOutput;
    if (!isPlainObject(output)) {
        return { power: "observe" };
    }
    if (output.permissionDecision === "deny") {
        if (typeof output.permissionDecisionReason !== "string"
            || output.permissionDecisionReason.length === 0) {
            throw new Error("Command hook returned invalid JSON");
        }
        return {
            power: "block",
            reason: output.permissionDecisionReason,
        };
    }
    if (output.permissionDecision === undefined
        || output.permissionDecision === "allow") {
        return { power: "observe" };
    }
    throw new Error("Command hook returned invalid JSON");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}
