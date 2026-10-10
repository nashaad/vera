import { spawn } from "node:child_process";

import type {
    PostToolUseHook,
    PostToolUseHookPayload,
    PostToolUseHookResult,
    PreCompactHook,
    PreCompactHookPayload,
    PreToolUseHook,
    PreToolUseHookPayload,
    PreToolUseHookResult,
    PreTurnHook,
    PreTurnHookPayload,
    PreTurnHookResult,
    SessionEndHook,
    SessionEndHookPayload,
    SessionStartHook,
    SessionStartHookPayload,
    SessionStartHookResult,
    SubagentFinishedHook,
    SubagentFinishedHookPayload,
    TurnEndingHook,
    TurnEndingHookPayload,
    TurnEndingHookResult,
} from "../sdk/hooks.ts";

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_ARG_COUNT = 16;
const MAX_ARG_BYTES = 8 * 1_024;
const MAX_INPUT_BYTES = 256 * 1_024;
const MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_STDERR_BYTES = 64 * 1_024;
// JSON escaping can expand each context byte to six bytes.
const MAX_CONTEXT_OUTPUT_BYTES = 6 * 128 * 1024 + 4096;

export type CommandHookPhase =
    | "pre_tool_use"
    | "post_tool_use"
    | "session_start"
    | "pre_turn"
    | "turn_ending"
    | "pre_compact"
    | "session_end"
    | "subagent_finished";

export type ClaudeHookEvent =
    | "PreToolUse"
    | "SessionStart"
    | "UserPromptSubmit"
    | "Stop"
    | "SubagentStop"
    | "PreCompact"
    | "SessionEnd";

export interface CommandHookSpec {
    /** A Vera phase, or a Claude event name when the protocol is `claude`. */
    readonly phase: CommandHookPhase | ClaudeHookEvent;
    readonly argv: readonly string[];
    readonly protocol?: "vera" | "claude";
    readonly timeoutMs?: number;
}

export type CommandHookFunction =
    | PreToolUseHook
    | PostToolUseHook
    | SessionStartHook
    | PreTurnHook
    | TurnEndingHook
    | PreCompactHook
    | SessionEndHook
    | SubagentFinishedHook;

const COMMAND_HOOK_PHASES: ReadonlySet<string> = new Set<CommandHookPhase>([
    "pre_tool_use",
    "post_tool_use",
    "session_start",
    "pre_turn",
    "turn_ending",
    "pre_compact",
    "session_end",
    "subagent_finished",
]);

const CLAUDE_EVENT_PHASES: Readonly<Record<ClaudeHookEvent, CommandHookPhase>> = {
    PreToolUse: "pre_tool_use",
    SessionStart: "session_start",
    UserPromptSubmit: "pre_turn",
    Stop: "turn_ending",
    SubagentStop: "turn_ending",
    PreCompact: "pre_compact",
    SessionEnd: "session_end",
};

// A Vera phase name under the claude protocol means the top-level Claude event.
const PHASE_CLAUDE_EVENTS: Readonly<Partial<Record<CommandHookPhase, ClaudeHookEvent>>> = {
    pre_tool_use: "PreToolUse",
    session_start: "SessionStart",
    pre_turn: "UserPromptSubmit",
    turn_ending: "Stop",
    pre_compact: "PreCompact",
    session_end: "SessionEnd",
};

interface CommandRun {
    readonly argv: readonly string[];
    readonly timeoutMs: number;
}

interface CommandLimits {
    readonly maxOutputBytes: number;
    readonly waitForExit: boolean;
}

interface CommandOutput {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

type ClaudeReply =
    | { readonly kind: "empty" }
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "json"; readonly value: Record<string, unknown> }
    | { readonly kind: "exit2"; readonly reason: string };

const PLAIN_LIMITS: CommandLimits = { maxOutputBytes: MAX_OUTPUT_BYTES, waitForExit: false };
const CONTEXT_LIMITS: CommandLimits = { maxOutputBytes: MAX_CONTEXT_OUTPUT_BYTES, waitForExit: false };
const SESSION_START_LIMITS: CommandLimits = { maxOutputBytes: MAX_CONTEXT_OUTPUT_BYTES, waitForExit: true };

/** The Vera phase a hook runs in. Throws on an unknown phase or one its protocol cannot carry. */
export function commandHookPhase(phase: unknown, protocol: unknown): CommandHookPhase {
    if (protocol !== undefined && protocol !== "vera" && protocol !== "claude") {
        throw new Error("Command hook protocol must be vera or claude");
    }
    if (typeof phase !== "string") {
        throw new Error("Command hook phase must be a string");
    }
    if (Object.hasOwn(CLAUDE_EVENT_PHASES, phase)) {
        if (protocol !== "claude") {
            throw new Error(`Command hook phase ${phase} needs the claude protocol`);
        }
        return CLAUDE_EVENT_PHASES[phase as ClaudeHookEvent];
    }
    if (!COMMAND_HOOK_PHASES.has(phase)) {
        throw new Error(`Unknown command hook phase: ${phase}`);
    }
    const veraPhase = phase as CommandHookPhase;
    if (protocol === "claude" && PHASE_CLAUDE_EVENTS[veraPhase] === undefined) {
        throw new Error(`This command hook protocol does not support ${veraPhase}`);
    }
    return veraPhase;
}

export function createCommandHook(spec: CommandHookSpec): CommandHookFunction {
    const phase = commandHookPhase(spec.phase, spec.protocol);
    validateCommandHookSpec(spec);
    const command: CommandRun = {
        argv: spec.argv,
        timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    if (spec.protocol === "claude") {
        const event = Object.hasOwn(CLAUDE_EVENT_PHASES, spec.phase)
            ? spec.phase as ClaudeHookEvent
            : PHASE_CLAUDE_EVENTS[phase]!;
        return claudeCommandHook(command, event);
    }
    return veraCommandHook(command, phase);
}

function validateCommandHookSpec(spec: CommandHookSpec): void {
    if (!Array.isArray(spec.argv)
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

function veraCommandHook(command: CommandRun, phase: CommandHookPhase): CommandHookFunction {
    switch (phase) {
        case "pre_tool_use":
            return async (payload: PreToolUseHookPayload): Promise<PreToolUseHookResult> =>
                veraResult(await runCommand(command, payload, PLAIN_LIMITS)) as PreToolUseHookResult;
        case "post_tool_use":
            return async (payload: PostToolUseHookPayload): Promise<PostToolUseHookResult> =>
                veraResult(await runCommand(command, payload, PLAIN_LIMITS)) as PostToolUseHookResult;
        case "session_start":
            return async (payload: SessionStartHookPayload): Promise<SessionStartHookResult> =>
                veraResult(await runCommand(command, payload, SESSION_START_LIMITS)) as SessionStartHookResult;
        case "pre_turn":
            return async (payload: PreTurnHookPayload): Promise<PreTurnHookResult> =>
                veraResult(await runCommand(command, payload, CONTEXT_LIMITS)) as PreTurnHookResult;
        case "turn_ending":
            return async (payload: TurnEndingHookPayload): Promise<TurnEndingHookResult> =>
                veraResult(await runCommand(command, payload, CONTEXT_LIMITS)) as TurnEndingHookResult;
        case "pre_compact":
            return async (payload: PreCompactHookPayload): Promise<void> => {
                requireSuccess(await runCommand(command, payload, PLAIN_LIMITS));
            };
        case "session_end":
            return async (payload: SessionEndHookPayload): Promise<void> => {
                requireSuccess(await runCommand(command, payload, PLAIN_LIMITS));
            };
        case "subagent_finished":
            return async (payload: SubagentFinishedHookPayload): Promise<void> => {
                requireSuccess(await runCommand(command, payload, PLAIN_LIMITS));
            };
    }
}

// Stop, UserPromptSubmit, PreCompact and SessionEnd skip subagents; SubagentStop runs only in one.
function claudeCommandHook(command: CommandRun, event: ClaudeHookEvent): CommandHookFunction {
    switch (event) {
        case "PreToolUse":
            return async (payload: PreToolUseHookPayload): Promise<PreToolUseHookResult> =>
                preToolUseResult(claudeReply(
                    await runCommand(command, preToolUsePayload(payload), PLAIN_LIMITS),
                ));
        case "SessionStart":
            return async (payload: SessionStartHookPayload): Promise<SessionStartHookResult> =>
                sessionStartResult(claudeReply(
                    await runCommand(command, sessionStartPayload(payload), SESSION_START_LIMITS),
                ));
        case "UserPromptSubmit":
            return async (payload: PreTurnHookPayload): Promise<PreTurnHookResult> => {
                if (payload.spawned) return { power: "observe" };
                return userPromptSubmitResult(claudeReply(
                    await runCommand(command, userPromptSubmitPayload(payload), CONTEXT_LIMITS),
                ));
            };
        case "Stop":
        case "SubagentStop":
            return async (payload: TurnEndingHookPayload): Promise<TurnEndingHookResult> => {
                if (payload.spawned !== (event === "SubagentStop")) return { power: "observe" };
                return stopResult(claudeReply(
                    await runCommand(command, stopPayload(payload, event), CONTEXT_LIMITS),
                ));
            };
        case "PreCompact":
            return async (payload: PreCompactHookPayload): Promise<void> => {
                if (payload.spawned) return;
                claudeReply(await runCommand(command, preCompactPayload(payload), PLAIN_LIMITS));
            };
        case "SessionEnd":
            return async (payload: SessionEndHookPayload): Promise<void> => {
                if (payload.spawned) return;
                claudeReply(await runCommand(command, sessionEndPayload(payload), PLAIN_LIMITS));
            };
    }
}

async function runCommand(
    command: CommandRun,
    payload: unknown,
    limits: CommandLimits,
): Promise<CommandOutput> {
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
        throw new Error("Command hook input exceeded its byte bound");
    }
    const { argv, timeoutMs } = command;
    const { maxOutputBytes, waitForExit } = limits;
    return await new Promise<CommandOutput>((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), {
            shell: false,
            detached: waitForExit && process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        const errorChunks: Buffer[] = [];
        let bytes = 0;
        let errorBytes = 0;
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
        const finish = (error: Error | undefined, value?: CommandOutput): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error === undefined ? resolve(value!) : reject(error);
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
        // Stderr past the bound is dropped, not fatal: it only carries an exit-2 reason.
        child.stderr.on("data", (chunk: Buffer) => {
            if (errorBytes >= MAX_STDERR_BYTES) return;
            const kept = chunk.subarray(0, MAX_STDERR_BYTES - errorBytes);
            errorBytes += kept.byteLength;
            errorChunks.push(kept);
        });
        child.once("close", (code) => {
            if (settled) return;
            if (terminationError !== undefined) {
                finish(terminationError);
                return;
            }
            finish(undefined, {
                status: code,
                stdout: Buffer.concat(chunks).toString("utf8").trim(),
                stderr: Buffer.concat(errorChunks).toString("utf8").trim(),
            });
        });
        child.stdin.end(input);
    });
}

function requireSuccess(output: CommandOutput): void {
    if (output.status !== 0) {
        throw new Error(`Command hook exited with status ${output.status ?? "unknown"}`);
    }
}

function veraResult(output: CommandOutput): unknown {
    requireSuccess(output);
    try {
        return JSON.parse(output.stdout);
    } catch {
        throw new Error("Command hook returned invalid JSON");
    }
}

function claudeReply(output: CommandOutput): ClaudeReply {
    if (output.status === 2) return { kind: "exit2", reason: output.stderr };
    requireSuccess(output);
    if (output.stdout.length === 0) return { kind: "empty" };
    let value: unknown;
    try {
        value = JSON.parse(output.stdout);
    } catch {
        return { kind: "text", text: output.stdout };
    }
    return isPlainObject(value)
        ? { kind: "json", value }
        : { kind: "text", text: output.stdout };
}

function exitReason(reply: { readonly reason: string }): string {
    if (reply.reason.length === 0) {
        throw new Error("Command hook exited 2 without a reason on stderr");
    }
    return reply.reason;
}

function decisionReason(value: Record<string, unknown>): string | undefined {
    if (value.decision !== "block") return undefined;
    if (typeof value.reason !== "string" || value.reason.length === 0) {
        throw new Error("Command hook decision block needs a reason");
    }
    return value.reason;
}

// hookSpecificOutput is optional, but when present it must name the event it answers.
function specificOutput(
    value: Record<string, unknown>,
    event: ClaudeHookEvent,
): Record<string, unknown> | undefined {
    const output = value.hookSpecificOutput;
    if (output === undefined) return undefined;
    if (!isPlainObject(output) || output.hookEventName !== event) {
        throw new Error(`Invalid ${event} hookSpecificOutput`);
    }
    return output;
}

function additionalContext(output: Record<string, unknown> | undefined): string | undefined {
    const context = output?.additionalContext;
    if (context === undefined) return undefined;
    if (typeof context !== "string") {
        throw new Error("additionalContext must be a string");
    }
    return context.length === 0 ? undefined : context;
}

function preToolUsePayload(payload: PreToolUseHookPayload): Record<string, unknown> {
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

function preToolUseResult(reply: ClaudeReply): PreToolUseHookResult {
    if (reply.kind === "exit2") return { power: "block", reason: exitReason(reply) };
    if (reply.kind !== "json") return { power: "observe" };
    const output = reply.value.hookSpecificOutput;
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

function sessionStartPayload(payload: SessionStartHookPayload): Record<string, unknown> {
    return {
        session_id: payload.sessionId,
        cwd: payload.workspace,
        hook_event_name: "SessionStart",
        source: payload.reason === "start"
            ? "startup"
            : payload.reason === "compacted" ? "compact" : "resume",
    };
}

function sessionStartResult(reply: ClaudeReply): SessionStartHookResult {
    if (reply.kind === "text") return { power: "mutate", context: reply.text };
    if (reply.kind !== "json") return { power: "observe" };
    const context = additionalContext(specificOutput(reply.value, "SessionStart"));
    return context === undefined ? { power: "observe" } : { power: "mutate", context };
}

function userPromptSubmitPayload(payload: PreTurnHookPayload): Record<string, unknown> {
    return {
        session_id: payload.sessionId ?? "",
        cwd: payload.workspace,
        hook_event_name: "UserPromptSubmit",
        prompt: payload.prompt,
    };
}

function userPromptSubmitResult(reply: ClaudeReply): PreTurnHookResult {
    if (reply.kind === "exit2") return { power: "block", reason: exitReason(reply) };
    if (reply.kind === "text") return { power: "mutate", context: reply.text };
    if (reply.kind === "empty") return { power: "observe" };
    const reason = decisionReason(reply.value);
    if (reason !== undefined) return { power: "block", reason };
    const context = additionalContext(specificOutput(reply.value, "UserPromptSubmit"));
    return context === undefined ? { power: "observe" } : { power: "mutate", context };
}

function stopPayload(
    payload: TurnEndingHookPayload,
    event: "Stop" | "SubagentStop",
): Record<string, unknown> {
    return {
        session_id: payload.sessionId ?? "",
        cwd: payload.workspace,
        hook_event_name: event,
        stop_hook_active: payload.continuations > 0,
        last_assistant_message: payload.reply,
        ...(event === "SubagentStop" ? { agent_id: payload.sessionId ?? "" } : {}),
    };
}

function stopResult(reply: ClaudeReply): TurnEndingHookResult {
    if (reply.kind === "exit2") return { power: "continue", context: exitReason(reply) };
    if (reply.kind !== "json") return { power: "observe" };
    const reason = decisionReason(reply.value);
    return reason === undefined ? { power: "observe" } : { power: "continue", context: reason };
}

function preCompactPayload(payload: PreCompactHookPayload): Record<string, unknown> {
    return {
        session_id: payload.sessionId,
        cwd: payload.workspace,
        hook_event_name: "PreCompact",
        trigger: payload.reason === "manual" ? "manual" : "auto",
        custom_instructions: "",
    };
}

function sessionEndPayload(payload: SessionEndHookPayload): Record<string, unknown> {
    return {
        session_id: payload.sessionId,
        cwd: payload.workspace,
        hook_event_name: "SessionEnd",
        reason: "other",
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}
