import { lstat, opendir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { readSessionIndexMetadata } from "../store/session-store.ts";
import { pruneLogs } from "./log-retention.ts";
import {
    createStorageWalk,
    STORAGE_MEASURE_ENTRY_LIMIT,
    safeSessionName,
    type StoragePathSize,
} from "./storage-measure.ts";
import { pruneScratch, type GuardedScratchDetach } from "./scratch-retention.ts";
import type {
    StorageCleanupArea,
    StorageCleanupPreview,
    StorageCleanupResult,
} from "./storage-protocol.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const PREVIEW_NAMES = 20;

export interface StorageCleanupOptions {
    readonly sessionDirectory: string;
    // Undefined when the home refuses scratch paths.
    readonly scratchDirectory: string | undefined;
    readonly logDirectory: string;
    readonly tempRoot?: string;
    readonly now?: Date;
    readonly removeIfUnowned: (id: string, detach: GuardedScratchDetach) => boolean | Promise<boolean>;
    // Keeps the running host's log, live sessions' logs and open sidecar logs.
    readonly keepLog?: (path: string) => boolean | Promise<boolean>;
    readonly entryLimit?: number;
}

interface PreviewAccumulator {
    count: number;
    bytes: number;
    readonly names: string[];
    more: number;
}

function accumulator(): PreviewAccumulator {
    return { count: 0, bytes: 0, names: [], more: 0 };
}

function remember(acc: PreviewAccumulator, name: string, size: StoragePathSize): void {
    acc.count += 1;
    acc.bytes += size.bytes;
    if (acc.names.length < PREVIEW_NAMES) acc.names.push(name);
    else acc.more += 1;
}

function preview(area: StorageCleanupArea, maxAgeDays: number, acc: PreviewAccumulator, partial: boolean): StorageCleanupPreview {
    return {
        area,
        max_age_days: maxAgeDays,
        count: acc.count,
        bytes: acc.bytes,
        names: [...acc.names],
        more: acc.more,
        partial,
    };
}

async function titleFor(sessionDirectory: string, id: string): Promise<string | undefined> {
    try {
        const title = (await readSessionIndexMetadata(join(sessionDirectory, `${id}.jsonl`))).title?.trim();
        return title === undefined || title.length === 0 ? undefined : title;
    } catch {
        return undefined;
    }
}

function displayPath(from: string, path: string): string {
    return relative(from, path).split(sep).join("/");
}

function tempRoot(options: StorageCleanupOptions): string {
    return options.tempRoot ?? join(tmpdir(), "vera");
}

function ageCutoff(options: StorageCleanupOptions, maxAgeDays: number): number {
    return (options.now ?? new Date()).getTime() - maxAgeDays * DAY_MS;
}

async function previewScratch(maxAgeDays: number, options: StorageCleanupOptions): Promise<StorageCleanupPreview> {
    const acc = accumulator();
    if (options.scratchDirectory === undefined) return preview("scratch", maxAgeDays, acc, false);
    const walk = createStorageWalk(options.entryLimit);
    await pruneScratch(options.scratchDirectory, options.sessionDirectory, {
        now: options.now,
        maxAgeMs: maxAgeDays * DAY_MS,
        removeIfUnowned: options.removeIfUnowned,
        collect: async (id, path) => {
            const size = await walk.measure(path);
            const title = await titleFor(options.sessionDirectory, id);
            remember(acc, title ?? id, size);
        },
    });
    return preview("scratch", maxAgeDays, acc, walk.partial);
}

async function previewLogs(maxAgeDays: number, options: StorageCleanupOptions): Promise<StorageCleanupPreview> {
    const acc = accumulator();
    await pruneLogs(options.logDirectory, {
        now: options.now,
        maxAgeMs: maxAgeDays * DAY_MS,
        keep: options.keepLog,
        dryRun: true,
        onStale: (path, bytes) => {
            remember(acc, displayPath(options.logDirectory, path), { bytes, items: 1 });
        },
    });
    return preview("logs", maxAgeDays, acc, false);
}

async function previewOldScratch(maxAgeDays: number, options: StorageCleanupOptions): Promise<StorageCleanupPreview> {
    const acc = accumulator();
    const cutoff = ageCutoff(options, maxAgeDays);
    const limit = options.entryLimit ?? STORAGE_MEASURE_ENTRY_LIMIT;
    const walk = createStorageWalk(limit);
    const root = tempRoot(options);
    let remaining = limit;
    let directory;
    try {
        directory = await opendir(root);
    } catch {
        return preview("old_scratch", maxAgeDays, acc, false);
    }
    let partial = false;
    try {
        for await (const entry of directory) {
            if (remaining <= 0) {
                partial = true;
                break;
            }
            remaining -= 1;
            const candidate = await oldScratchCandidate(root, entry.name, cutoff, options);
            if (candidate === undefined) continue;
            if (!await options.removeIfUnowned(candidate.id, async () => true)) continue;
            const size = await walk.measure(candidate.path);
            const title = await titleFor(options.sessionDirectory, candidate.id);
            remember(acc, title ?? candidate.id, size);
        }
    } catch {
    }
    return preview("old_scratch", maxAgeDays, acc, partial || walk.partial);
}

interface OldScratchCandidate {
    readonly id: string;
    readonly path: string;
}

async function oldScratchCandidate(
    root: string,
    id: string,
    cutoff: number,
    options: StorageCleanupOptions,
): Promise<OldScratchCandidate | undefined> {
    if (!safeSessionName(id)) return undefined;
    const sessionPath = join(options.sessionDirectory, `${id}.jsonl`);
    const session = await lstat(sessionPath).catch(() => undefined);
    if (session?.isFile() !== true || session.mtimeMs >= cutoff) return undefined;
    const path = join(root, id);
    const scratch = await lstat(path).catch(() => undefined);
    // lstat: a symlink is never a scratch directory.
    if (scratch?.isDirectory() !== true) return undefined;
    return { id, path };
}

async function removeOldScratch(maxAgeDays: number, options: StorageCleanupOptions): Promise<StorageCleanupResult> {
    const cutoff = ageCutoff(options, maxAgeDays);
    const limit = options.entryLimit ?? STORAGE_MEASURE_ENTRY_LIMIT;
    const walk = createStorageWalk(limit);
    const root = tempRoot(options);
    let removed = 0;
    let removedBytes = 0;
    let directory;
    try {
        directory = await opendir(root);
    } catch {
        return { area: "old_scratch", max_age_days: maxAgeDays, removed: 0, removed_bytes: 0 };
    }
    try {
        for await (const entry of directory) {
            const candidate = await oldScratchCandidate(root, entry.name, cutoff, options);
            if (candidate === undefined) continue;
            // Re-checked here: a preview never authorizes a delete.
            if (!await options.removeIfUnowned(candidate.id, async () => true)) continue;
            const scratch = await lstat(candidate.path).catch(() => undefined);
            if (scratch?.isDirectory() !== true) continue;
            const size = await walk.measure(candidate.path).catch(() => ({ bytes: 0, items: 0 }));
            try {
                await rm(candidate.path, { recursive: true, force: true });
                removed += 1;
                removedBytes += size.bytes;
            } catch {
            }
        }
    } catch {
    }
    return { area: "old_scratch", max_age_days: maxAgeDays, removed, removed_bytes: removedBytes };
}

export async function previewStorageCleanup(
    area: StorageCleanupArea,
    maxAgeDays: number,
    options: StorageCleanupOptions,
): Promise<StorageCleanupPreview> {
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) {
        throw new Error("The age must be a whole number of days.");
    }
    if (area === "scratch") return previewScratch(maxAgeDays, options);
    if (area === "logs") return previewLogs(maxAgeDays, options);
    return previewOldScratch(maxAgeDays, options);
}

export async function runStorageCleanup(
    area: StorageCleanupArea,
    maxAgeDays: number,
    options: StorageCleanupOptions,
): Promise<StorageCleanupResult> {
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) {
        throw new Error("The age must be a whole number of days.");
    }
    if (area === "old_scratch") return removeOldScratch(maxAgeDays, options);
    if (area === "logs") {
        const result = await pruneLogs(options.logDirectory, {
            now: options.now,
            maxAgeMs: maxAgeDays * DAY_MS,
            keep: options.keepLog,
        });
        return {
            area,
            max_age_days: maxAgeDays,
            removed: result.removedFiles,
            removed_bytes: result.removedBytes,
        };
    }
    if (options.scratchDirectory === undefined) {
        return { area, max_age_days: maxAgeDays, removed: 0, removed_bytes: 0 };
    }
    const walk = createStorageWalk(options.entryLimit);
    const result = await pruneScratch(options.scratchDirectory, options.sessionDirectory, {
        now: options.now,
        maxAgeMs: maxAgeDays * DAY_MS,
        removeIfUnowned: options.removeIfUnowned,
        measureRemoved: async (path) => (await walk.measure(path)).bytes,
    });
    return {
        area,
        max_age_days: maxAgeDays,
        removed: result.removedDirectories,
        removed_bytes: result.removedBytes,
    };
}
