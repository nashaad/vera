import { spawn } from "node:child_process";

import type {
    SessionStartHook,
    SessionStartHookPayload,
    SessionStartHookResult,
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
// JSON escaping can expand each context byte to six bytes.
const MAX_SESSION_START_OUTPUT_BYTES = 6 * 128 * 1024 + 4096;

export interface CommandHookSpec {
    readonly phase: "pre_tool_use" | "post_tool_use" | "session_start";
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
): PreToolUseHook | PostToolUseHook | SessionStartHook {
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const protocol = spec.protocol ?? "vera";
    validateCommandHookSpec(spec);
    if (spec.phase === "session_start") {
        return async (payload: SessionStartHookPayload): Promise<SessionStartHookResult> => {
            const result = await invokeCommand(
                spec.argv,
                timeoutMs,
                protocol === "vera" ? payload : sessionStartCommandPayload(payload),
                "vera",
                MAX_SESSION_START_OUTPUT_BYTES,
                true,
                protocol !== "vera",
            );
            return protocol === "vera"
                ? result as SessionStartHookResult
                : sessionStartCommandResult(result);
        };
    }
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
    if (spec.phase !== "pre_tool_use" && spec.phase !== "post_tool_use" && spec.phase !== "session_start"
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
    if (spec.protocol === "claude" && spec.phase === "post_tool_use") {
        throw new Error("This command hook protocol does not support post_tool_use");
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
    maxOutputBytes = MAX_OUTPUT_BYTES,
    waitForExit = false,
    allowEmpty = false,
): Promise<unknown> {
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
        throw new Error("Command hook input exceeded its byte bound");
    }
    return await new Promise<unknown>((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), {
            shell: false,
            detached: waitForExit && process.platform !== "win32",
            stdio: ["pipe", "pipe", "ignore"],
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        let terminationError: Error | undefined;
        const terminate = (error: Error): void => {
            if (waitForExit) {
                terminationError ??= error;
                if (process.platform !== "win32" && child.pid !== undefined) {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                            child.kill("SIGKILL");
                        }
                    }
                } else {
                    child.kill("SIGKILL");
                }
            } else {
                child.kill("SIGTERM");
                finish(error);
            }
        };
        const timer = setTimeout(() => {
            terminate(new Error(`Command hook timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const finish = (error: Error | undefined, value?: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error === undefined ? resolve(value) : reject(error);
        };
        child.once("error", (error) => finish(error));
        child.stdin.once("error", (error) => {
            if (waitForExit) terminate(error);
            else finish(error);
        });
        child.stdout.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > maxOutputBytes) {
                terminate(new Error("Command hook output exceeded its byte bound"));
                return;
            }
            chunks.push(chunk);
        });
        child.once("close", (code) => {
            if (settled) return;
            if (terminationError !== undefined) {
                finish(terminationError);
                return;
            }
            if (code !== 0) {
                finish(new Error(`Command hook exited with status ${code ?? "unknown"}`));
                return;
            }
            try {
                const output = Buffer.concat(chunks).toString("utf8").trim();
                if ((allowEmpty || protocol === "claude") && output.length === 0) {
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

function sessionStartCommandPayload(payload: SessionStartHookPayload): Record<string, string> {
    return {
        session_id: payload.sessionId,
        cwd: payload.workspace,
        hook_event_name: "SessionStart",
        source: payload.reason === "start"
            ? "startup"
            : payload.reason === "compacted" ? "compact" : "resume",
    };
}

function sessionStartCommandResult(value: unknown): SessionStartHookResult {
    if (!isPlainObject(value)) throw new Error("Invalid session-start result");
    const output = value.hookSpecificOutput;
    if (output === undefined) return { power: "observe" };
    if (!isPlainObject(output) || output.hookEventName !== "SessionStart") {
        throw new Error("Invalid session-start output");
    }
    if (output.additionalContext === undefined) return { power: "observe" };
    if (typeof output.additionalContext !== "string") {
        throw new Error("Session-start additionalContext must be a string");
    }
    return { power: "mutate", context: output.additionalContext };
}
