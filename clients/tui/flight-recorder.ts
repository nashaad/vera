import {
    appendFileSync,
    chmodSync,
    closeSync,
    fchmodSync,
    mkdirSync,
    openSync,
    readdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { veraRuntimeDirectory } from "../../src/profile-paths.ts";

export interface TuiFlightEvent extends Record<string, unknown> {
    readonly type: string;
}

export interface TuiFlightRecorder {
    readonly instanceId: string;
    readonly logPath: string;
    record(event: TuiFlightEvent): void;
    sessionEntered(sessionId: string): void;
    close(reason: string): void;
}

export interface TuiFlightRecorderOptions {
    readonly runtimeDirectory?: string;
    readonly now?: () => Date;
    readonly pid?: number;
    readonly spawnWatchdog?: boolean;
}

const HEARTBEAT_INTERVAL_MS = 1_000;
const FLUSH_INTERVAL_MS = 250;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export function createTuiFlightRecorder(
    options: TuiFlightRecorderOptions = {},
): TuiFlightRecorder {
    const instanceId = randomUUID();
    const directory = join(
        options.runtimeDirectory ?? veraRuntimeDirectory(),
        "logs",
        "clients",
    );
    const logPath = join(directory, `${instanceId}.jsonl`);
    const heartbeatPath = join(directory, `${instanceId}.heartbeat`);
    const now = options.now ?? (() => new Date());
    const pid = options.pid ?? process.pid;
    let sessionId: string | undefined;
    let closed = false;
    let prepared = false;
    let queuedLines: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    sweepOldClientDiagnostics(directory, now().getTime());

    const flush = (): void => {
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
        if (queuedLines.length === 0) return;
        const lines = queuedLines;
        queuedLines = [];
        try {
            if (!prepared) {
                prepareLog(logPath);
                prepared = true;
            }
            appendFileSync(logPath, lines.join(""), {
                encoding: "utf8",
                mode: 0o600,
            });
        } catch {
            // Diagnostics must never become a new reason for the client to fail.
        }
    };

    const record = (event: TuiFlightEvent): void => {
        if (closed) return;
        queuedLines.push(`${JSON.stringify({
            timestamp: now().toISOString(),
            level: "debug",
            instanceId,
            pid,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...event,
        })}\n`);
        flushTimer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
        flushTimer.unref();
    };

    record({ type: "client_started" });
    flush();
    const writeHeartbeat = (): void => {
        try {
            writeFileSync(heartbeatPath, now().toISOString(), {
                encoding: "utf8",
                mode: 0o600,
            });
        } catch {
            // The lifecycle log remains useful when the heartbeat file cannot write.
        }
    };
    writeHeartbeat();
    const heartbeat = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    const watchdog = options.spawnWatchdog === false
        ? undefined
        : Bun.spawn([
            process.execPath,
            join(import.meta.dir, "flight-watchdog.ts"),
            String(pid),
            heartbeatPath,
            logPath,
            instanceId,
        ], {
            argv0: "vera-watchdog",
            stdin: "inherit",
            stdout: "inherit",
            stderr: "ignore",
        });
    watchdog?.unref();

    const onUncaught = (error: Error): void => {
        record({ type: "uncaught_exception", error: serializeError(error) });
        flush();
    };
    const onUnhandled = (reason: unknown): void => {
        record({ type: "unhandled_rejection", error: serializeError(reason) });
        flush();
        queueMicrotask(() => {
            throw reason instanceof Error ? reason : new Error(String(reason));
        });
    };
    process.on("uncaughtExceptionMonitor", onUncaught);
    process.on("unhandledRejection", onUnhandled);

    return {
        instanceId,
        logPath,
        record,
        sessionEntered(nextSessionId) {
            if (sessionId === nextSessionId) return;
            sessionId = nextSessionId;
            record({ type: "session_attached" });
        },
        close(reason) {
            if (closed) return;
            record({ type: "client_exited", reason });
            flush();
            closed = true;
            clearInterval(heartbeat);
            process.off("uncaughtExceptionMonitor", onUncaught);
            process.off("unhandledRejection", onUnhandled);
            watchdog?.kill();
        },
    };
}

function prepareLog(path: string): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = openSync(path, "a", 0o600);
    try {
        fchmodSync(file, 0o600);
    } finally {
        closeSync(file);
    }
}

function serializeError(error: unknown): Record<string, string> {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: sanitizeErrorMessage(error.message),
        };
    }
    return { name: "UnknownError", message: sanitizeErrorMessage(String(error)) };
}

function sanitizeErrorMessage(message: string): string {
    return message.replaceAll(/\s+/g, " ").slice(0, 500);
}

function sweepOldClientDiagnostics(directory: string, nowMs: number): void {
    try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (nowMs - statSync(path).mtimeMs <= RETENTION_MS) continue;
            unlinkSync(path);
        }
    } catch {
        // Retention is best-effort for the same reason diagnostic writes are.
    }
}
