import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { decodeJsonLine, LineReader, MAX_STDERR_LINE_CHARS } from "./lines.ts";
import { logMessage } from "./messages.ts";
import type { TaskProcess } from "./runner.ts";

// A child that has exited can leave stdout open through a grandchild; this is how long the last output gets.
const DRAIN_AFTER_EXIT_MS = 250;
const KILL_GRACE_MS = 2000;

export interface StdioTaskOptions {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    // Time between the polite stop (stdin closed, SIGTERM) and SIGKILL.
    readonly killGraceMs?: number;
}

// For any executable: JSON lines on stdin and stdout. The task must exit when stdin reaches end-of-file,
// which is how it dies with the desktop even after SIGKILL. stderr is drained and surfaced as `error` log lines.
export function startStdioTaskProcess<Task>(command: string, args: readonly string[], options: StdioTaskOptions = {}): TaskProcess<Task> {
    const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    const messages: Array<(message: unknown) => void> = [];
    const exits: Array<() => void> = [];
    let stopped = false;
    let closed = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const deliver = (message: unknown): void => {
        for (const listener of messages) listener(message);
    };
    const close = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(exitTimer);
        clearTimeout(killTimer);
        flushStderr();
        for (const listener of exits) listener();
    };

    const unreadable = (): void => {
        stopped = true;
        deliver(undefined);
    };
    const reader = new LineReader();
    child.stdout.on("data", (chunk: Buffer) => {
        if (stopped) return;
        const { lines, overflow } = reader.push(chunk);
        for (const line of lines) {
            const message = decodeJsonLine(line);
            if (message === undefined) return unreadable();
            deliver(message);
            if (stopped) return;
        }
        if (overflow) unreadable();
    });

    const decoder = new StringDecoder("utf8");
    let stderrTail = "";
    const logError = (text: string): void => {
        const line = text.endsWith("\r") ? text.slice(0, -1) : text;
        if (!stopped && line.length > 0) deliver(logMessage({ level: "error", text: line }));
    };
    child.stderr.on("data", (chunk: Buffer) => {
        const parts = (stderrTail + decoder.write(chunk)).split("\n");
        stderrTail = parts.pop() ?? "";
        for (const part of parts) logError(part);
        while (stderrTail.length > MAX_STDERR_LINE_CHARS) {
            logError(stderrTail.slice(0, MAX_STDERR_LINE_CHARS));
            stderrTail = stderrTail.slice(MAX_STDERR_LINE_CHARS);
        }
    });
    function flushStderr(): void {
        const rest = stderrTail + decoder.end();
        stderrTail = "";
        logError(rest);
    }

    // A write after the child is gone fails with EPIPE; the exit already reports that.
    child.stdin.on("error", () => {});
    child.on("error", () => {
        stopped = true;
        close();
    });
    child.on("exit", () => {
        exitTimer = setTimeout(close, DRAIN_AFTER_EXIT_MS);
        exitTimer.unref();
    });
    child.on("close", close);

    return {
        post: (message) => {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        onMessage: (listener) => {
            messages.push(listener);
        },
        onExit: (listener) => {
            exits.push(listener);
        },
        kill: () => {
            stopped = true;
            if (closed || killTimer !== undefined) return;
            child.stdin.end();
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? KILL_GRACE_MS);
            killTimer.unref();
        },
    };
}
