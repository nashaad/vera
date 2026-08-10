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
const MAX_OUTPUT_BYTES = 64 * 1_024;

export interface CommandHookSpec {
    readonly phase: "pre_tool_use" | "post_tool_use";
    readonly argv: readonly string[];
    readonly timeoutMs?: number;
}

export function createCommandHook(
    spec: CommandHookSpec,
): PreToolUseHook | PostToolUseHook {
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    validateCommandHookSpec(spec);
    return spec.phase === "pre_tool_use"
        ? (payload: PreToolUseHookPayload): Promise<PreToolUseHookResult> =>
            invokeCommand(spec.argv, timeoutMs, payload) as Promise<PreToolUseHookResult>
        : (payload: PostToolUseHookPayload): Promise<PostToolUseHookResult> =>
            invokeCommand(spec.argv, timeoutMs, payload) as Promise<PostToolUseHookResult>;
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
): Promise<unknown> {
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
                finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                finish(new Error("Command hook returned invalid JSON"));
            }
        });
        child.stdin.end(JSON.stringify(payload));
    });
}
