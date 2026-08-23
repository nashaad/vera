import { appendFileSync, readFileSync } from "node:fs";
import { restoreTerminalNow } from "./terminal-restore.ts";

const STALL_AFTER_MS = 5_000;
const CHECK_INTERVAL_MS = 1_000;

export function heartbeatAge(
    heartbeat: string,
    now = Date.now(),
): number | undefined {
    const timestamp = Date.parse(heartbeat);
    return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : undefined;
}

if (import.meta.main) {
    const [pidText, heartbeatPath, logPath, instanceId] = process.argv.slice(2);
    const pid = Number(pidText);
    if (
        !Number.isInteger(pid)
        || heartbeatPath === undefined
        || logPath === undefined
        || instanceId === undefined
    ) process.exit(2);

    let stalled = false;
    let heartbeatUnavailable = false;
    const startedAt = Date.now();
    setInterval(() => {
        if (!processExists(pid)) {
            append(logPath, { type: "client_process_lost", instanceId, pid });
            restoreTerminalNow();
            process.exit(0);
        }
        const ageMs = readHeartbeatAge(heartbeatPath);
        if (ageMs === undefined) {
            if (
                !heartbeatUnavailable
                && Date.now() - startedAt > STALL_AFTER_MS
            ) {
                append(logPath, {
                    type: "client_heartbeat_unavailable",
                    instanceId,
                    pid,
                });
                heartbeatUnavailable = true;
            }
            return;
        }
        if (ageMs <= STALL_AFTER_MS) {
            if (heartbeatUnavailable) {
                append(logPath, {
                    type: "client_heartbeat_recovered",
                    instanceId,
                    pid,
                    ageMs,
                });
                heartbeatUnavailable = false;
            }
            if (stalled) {
                append(logPath, {
                    type: "client_heartbeat_recovered",
                    instanceId,
                    pid,
                    ageMs,
                });
                stalled = false;
            }
            return;
        }
        if (!stalled) {
            append(logPath, {
                type: "client_heartbeat_stalled",
                instanceId,
                pid,
                ageMs,
            });
            stalled = true;
        }
    }, CHECK_INTERVAL_MS);
}

function readHeartbeatAge(path: string): number | undefined {
    try {
        return heartbeatAge(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function append(path: string, entry: Record<string, unknown>): void {
    try {
        appendFileSync(path, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "debug",
            ...entry,
        })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
        // The observer has nowhere else safe to report a failed diagnostic write.
    }
}
