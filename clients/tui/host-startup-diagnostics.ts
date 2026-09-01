import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { defaultHostLogPath } from "../../src/host/host-log.ts";

const MAX_LOG_BYTES = 256 * 1024;

export interface HostStartupTimingRow {
    readonly label: string;
    readonly durationMs: number;
    readonly outcome: "completed" | "failed" | "loaded";
}

export interface HostStartupTimingSnapshot {
    readonly totalMs: number;
    readonly rows: readonly HostStartupTimingRow[];
}

interface StartupLogEntry {
    readonly type?: unknown;
    readonly phase?: unknown;
    readonly extension_id?: unknown;
    readonly outcome?: unknown;
    readonly duration_ms?: unknown;
}

export function readLatestHostStartupTiming(
    path = defaultHostLogPath(),
): HostStartupTimingSnapshot | undefined {
    const entries = readLogTail(path);
    const completedAt = entries.findLastIndex((entry) =>
        entry.type === "host_startup_complete"
        && duration(entry.duration_ms) !== undefined
    );
    if (completedAt < 0) return undefined;

    const previousComplete = entries.findLastIndex((entry, index) =>
        index < completedAt && entry.type === "host_startup_complete"
    );
    const startup = entries.slice(previousComplete + 1, completedAt + 1);
    const totalMs = duration(entries[completedAt]?.duration_ms);
    if (totalMs === undefined) return undefined;

    const rows = startup.flatMap((entry): readonly HostStartupTimingRow[] => {
        const durationMs = duration(entry.duration_ms);
        if (durationMs === undefined) return [];
        if (
            entry.type === "host_startup_phase"
            && typeof entry.phase === "string"
            && (entry.outcome === "completed" || entry.outcome === "failed")
        ) {
            return [{
                label: entry.phase,
                durationMs,
                outcome: entry.outcome,
            }];
        }
        if (
            entry.type === "host_startup_extension"
            && typeof entry.extension_id === "string"
            && (entry.outcome === "loaded" || entry.outcome === "failed")
        ) {
            return [{
                label: `extension · ${entry.extension_id}`,
                durationMs,
                outcome: entry.outcome,
            }];
        }
        return [];
    });
    return { totalMs, rows };
}

function readLogTail(path: string): readonly StartupLogEntry[] {
    let file: number | undefined;
    try {
        file = openSync(path, "r");
        const size = fstatSync(file).size;
        const length = Math.min(size, MAX_LOG_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(file, buffer, 0, length, size - length);
        return buffer.toString("utf8")
            .split("\n")
            .slice(size > length ? 1 : 0)
            .flatMap((line): readonly StartupLogEntry[] => {
                if (line.length === 0) return [];
                try {
                    const value: unknown = JSON.parse(line);
                    return typeof value === "object" && value !== null
                        ? [value as StartupLogEntry]
                        : [];
                } catch {
                    return [];
                }
            });
    } catch {
        return [];
    } finally {
        if (file !== undefined) closeSync(file);
    }
}

function duration(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}
