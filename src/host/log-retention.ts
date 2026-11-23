import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { VeraConfig } from "../config.ts";
import type { SidecarStatus } from "./sidecar-runtime.ts";

export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// The host's own stdout and stderr under launchd: unlinking them drops later output.
const HELD_OPEN_LOGS = new Set(["launchd.out.log", "launchd.err.log"]);

// A sidecar holds its log open from launch until its child exits.
export function openSidecarLogPaths(
    statuses: readonly SidecarStatus[],
): ReadonlySet<string> {
    return new Set(
        statuses
            .filter((status) => status.state === "starting" || status.state === "running")
            .map((status) => resolve(status.logPath)),
    );
}

export function logMaxAgeMs(config: VeraConfig): number {
    const days = config.log_max_age_days;
    return days === undefined ? LOG_RETENTION_MS : days * 24 * 60 * 60 * 1000;
}

export interface LogPruneResult {
    readonly removedFiles: number;
    readonly removedBytes: number;
}

export interface LogPruneOptions {
    readonly now?: Date;
    readonly maxAgeMs?: number;
    // Asked just before each unlink, so a writer that opened the file mid-walk is still seen.
    readonly keep?: (path: string) => boolean | Promise<boolean>;
    // Counts what would be removed without unlinking it; used for a cleanup preview.
    readonly dryRun?: boolean;
    readonly onStale?: (path: string, bytes: number) => void;
}

export async function pruneLogs(
    root: string,
    options: LogPruneOptions = {},
): Promise<LogPruneResult> {
    const cutoff = (options.now ?? new Date()).getTime()
        - (options.maxAgeMs ?? LOG_RETENTION_MS);
    const totals = { removedFiles: 0, removedBytes: 0 };
    await pruneDirectory(root, cutoff, options, totals);
    return totals;
}

async function pruneDirectory(
    directory: string,
    cutoff: number,
    options: LogPruneOptions,
    totals: { removedFiles: number; removedBytes: number },
): Promise<void> {
    let names: string[];
    try {
        names = await readdir(directory);
    } catch {
        return;
    }
    for (const name of names) {
        const path = join(directory, name);
        let stats;
        try {
            stats = await lstat(path);
        } catch {
            continue;
        }
        if (stats.isDirectory()) {
            // Read before pruning: removing children bumps the directory's mtime.
            const staleBefore = stats.mtimeMs < cutoff;
            await pruneDirectory(path, cutoff, options, totals);
            if (staleBefore && options.dryRun !== true) {
                await rmdir(path).catch(() => {});
            }
            continue;
        }
        if (!stats.isFile() || HELD_OPEN_LOGS.has(name)) continue;
        if (stats.mtimeMs >= cutoff || await options.keep?.(path) === true) continue;
        options.onStale?.(path, stats.size);
        if (options.dryRun === true) {
            totals.removedFiles += 1;
            totals.removedBytes += stats.size;
            continue;
        }
        try {
            await unlink(path);
            totals.removedFiles += 1;
            totals.removedBytes += stats.size;
        } catch {
            // A file removed concurrently was a stale file all the same.
        }
    }
}
