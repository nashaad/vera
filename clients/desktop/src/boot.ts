import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { DesktopEvent } from "../../ui/src/protocol/bridge.ts";
import { resolveBootCommand } from "./vera-command.ts";

const IDLE_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 4_096;

export class BootSession {
    private child: ChildProcessWithoutNullStreams | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private questionId: string | undefined;
    private stderrTail = "";
    private started = false;
    private finished = false;
    private cancelled = false;

    constructor(
        private readonly home: string,
        private readonly emit: (event: DesktopEvent) => void,
    ) {}

    start(): void {
        if (this.started) throw new Error("A boot session runs once; create another to reconnect.");
        this.started = true;
        this.emit({ type: "phase", phase: "starting" });

        const resolution = resolveBootCommand();
        if ("missing" in resolution) {
            this.finished = true;
            this.emit({
                type: "missing_cli",
                message: resolution.missing.message,
                checked: resolution.missing.checked,
            });
            return;
        }

        const { command, args } = resolution.command;
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(command, [...args], {
                env: process.env,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            this.finished = true;
            this.emit({ type: "failed", message: messageOf(error) });
            return;
        }
        this.child = child;
        // A write to a child that already exited reports EPIPE as an event, not a throw.
        child.stdin.on("error", () => {});
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_BYTES);
        });
        child.once("error", (error) => {
            if (this.finished) return;
            this.finished = true;
            this.clearTimer();
            this.emit({ type: "failed", message: messageOf(error) });
        });
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => this.handleLine(line));
        child.once("exit", (code) => {
            if (this.finished || this.cancelled) return;
            this.finished = true;
            this.clearTimer();
            this.emit({ type: "failed", message: this.exitMessage(code) });
        });
        this.armTimer();
    }

    answer(id: string, yes: boolean): void {
        if (this.child === undefined || this.questionId !== id) return;
        this.questionId = undefined;
        const stdin = this.child.stdin;
        if (stdin.writable) {
            stdin.write(`${JSON.stringify({ answer: yes })}\n`);
        }
        this.armTimer();
    }

    cancel(): void {
        this.cancelled = true;
        this.finished = true;
        this.clearTimer();
        this.questionId = undefined;
        this.shutdownChild();
    }

    private handleLine(line: string): void {
        if (this.finished || this.cancelled) return;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            return;
        }
        if (typeof value !== "object" || value === null) return;
        const message = value as Record<string, unknown>;
        if (message.type === "question") {
            const id = typeof message.id === "string" ? message.id : undefined;
            const text = typeof message.text === "string" ? message.text : "";
            if (id === undefined) return;
            this.questionId = id;
            this.clearTimer();
            this.emit({ type: "question", id, text });
            return;
        }
        if (message.type === "waiting") {
            this.armTimer();
            this.emit({ type: "phase", phase: "waiting" });
            return;
        }
        if (message.type === "ready") {
            const pid = message.pid;
            const socketPath = message.socket_path;
            if (typeof pid !== "number" || typeof socketPath !== "string") return;
            this.finished = true;
            this.clearTimer();
            this.releaseChild();
            this.emit({
                type: "ready",
                pid,
                socketPath,
                buildId: typeof message.build_id === "string" ? message.build_id : null,
                home: this.home,
            });
            return;
        }
        if (message.type === "failed") {
            this.finished = true;
            this.clearTimer();
            this.releaseChild();
            const reason = typeof message.message === "string" && message.message.length > 0
                ? message.message
                : "The Vera boot check failed.";
            this.emit({ type: "failed", message: reason });
            return;
        }
        this.armTimer();
    }

    private armTimer(): void {
        this.clearTimer();
        if (this.questionId !== undefined) return;
        this.timer = setTimeout(() => {
            if (this.finished || this.cancelled) return;
            this.cancelled = true;
            this.finished = true;
            this.shutdownChild();
            this.emit({
                type: "failed",
                message: "Vera did not answer within 60 seconds. Choose Reconnect to try again.",
            });
        }, IDLE_TIMEOUT_MS);
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private exitMessage(code: number | null): string {
        const tail = this.stderrTail.trim();
        if (tail.length > 0) return tail;
        return code === null
            ? "The Vera command ended before the host was ready."
            : `The Vera command ended with code ${code} before the host was ready.`;
    }

    // A question left unanswered must read as no before stdin closes; a closed
    // stdin means yes to the boot check.
    private shutdownChild(): void {
        const child = this.child;
        if (child === undefined) return;
        this.child = undefined;
        this.endInput(child, true);
    }

    // After ready or failed the child asks nothing more. It stays alive while stdin
    // is open, so close it and leave the answer unwritten.
    private releaseChild(): void {
        const child = this.child;
        if (child === undefined) return;
        this.child = undefined;
        this.endInput(child, false);
    }

    private endInput(child: ChildProcessWithoutNullStreams, writeNo: boolean): void {
        if (child.exitCode !== null || child.killed) return;
        try {
            if (writeNo && child.stdin.writable) {
                child.stdin.write(`${JSON.stringify({ answer: false })}\n`);
            }
            child.stdin.end();
        } catch {
            // The pipe may already be gone.
        }
        const timer = setTimeout(() => {
            if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
        }, KILL_GRACE_MS);
        timer.unref();
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
