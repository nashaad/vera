import { randomUUID } from "node:crypto";
import { lstatSync, renameSync } from "node:fs";
import { lstat, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VeraConfig } from "../config.ts";

export const DEFAULT_SCRATCH_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;
export const SCRATCH_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function scratchMaxAgeMs(config: VeraConfig): number {
    const days = config.scratch_max_age_days;
    return days === undefined ? DEFAULT_SCRATCH_MAX_AGE_MS : days * 24 * 60 * 60 * 1000;
}

export type GuardedScratchDetach = (stillUnowned: () => boolean) => Promise<boolean>;

export interface ScratchPruneOptions {
    readonly now?: Date;
    readonly maxAgeMs?: number;
    readonly isStopped?: () => boolean;
    readonly removeIfUnowned: (id: string, detach: GuardedScratchDetach) => boolean | Promise<boolean>;
    readonly removeDirectory?: (path: string) => Promise<void>;
    // Measures a folder that is about to be removed, so the caller can report the bytes freed.
    readonly measureRemoved?: (path: string) => Promise<number>;
    // Reports eligible folders instead of removing them; used for a cleanup preview.
    readonly collect?: (id: string, path: string) => void | Promise<void>;
}

export interface ScratchPruneResult {
    readonly removedDirectories: number;
    readonly removedBytes: number;
}

interface ScratchAge {
    readonly device: number;
    readonly inode: number;
    readonly mtimeMs: number;
    readonly missingSession: boolean;
}

export async function pruneScratch(
    scratchRoot: string,
    sessionDirectory: string,
    options: ScratchPruneOptions,
): Promise<ScratchPruneResult> {
    const cutoff = (options.now ?? new Date()).getTime()
        - (options.maxAgeMs ?? DEFAULT_SCRATCH_MAX_AGE_MS);
    const sweepId = randomUUID();
    let directory;
    try {
        directory = await opendir(scratchRoot);
    } catch {
        return { removedDirectories: 0, removedBytes: 0 };
    }
    let removedDirectories = 0;
    let removedBytes = 0;
    try {
        for await (const item of directory) {
            if (options.isStopped?.() === true) break;
            const id = item.name;
            if (id.endsWith(`-${sweepId}`)) continue;
            const scratchPath = join(scratchRoot, id);
            const sessionPath = join(sessionDirectory, `${id}.jsonl`);
            let detachedPath: string | undefined;
            try {
                const leftover = id.startsWith(".removing-") && await sessionMissing(sessionPath);
                if (!leftover && await scratchAge(scratchPath, sessionPath, cutoff) === undefined) continue;
                if (options.isStopped?.() === true) break;
                if (options.collect !== undefined) {
                    if (await options.removeIfUnowned(id, async () => true)) {
                        await options.collect(id, scratchPath);
                    }
                    continue;
                }
                const detached = await options.removeIfUnowned(id, async (stillUnowned) => {
                    const age = leftover
                        ? await leftoverAge(scratchPath, sessionPath)
                        : await scratchAge(scratchPath, sessionPath, cutoff);
                    if (age === undefined || options.isStopped?.() === true || !stillUnowned()) return false;
                    if (!sameScratch(scratchPath, sessionPath, age, cutoff, leftover)) return false;
                    const name = leftover ? randomUUID() : id;
                    const destination = join(scratchRoot, `.removing-${name}-${sweepId}`);
                    renameSync(scratchPath, destination);
                    detachedPath = destination;
                    return true;
                });
                if (!detached || detachedPath === undefined) continue;
                const bytes = options.measureRemoved === undefined
                    ? 0
                    : await options.measureRemoved(detachedPath).catch(() => 0);
                await (options.removeDirectory ?? ((path) => rm(path, { recursive: true, force: true })))(detachedPath);
                removedDirectories += 1;
                removedBytes += bytes;
            } catch {
            }
        }
    } catch {
    }
    return { removedDirectories, removedBytes };
}

async function scratchAge(scratchPath: string, sessionPath: string, cutoff: number): Promise<ScratchAge | undefined> {
    const scratch = await lstat(scratchPath);
    if (!scratch.isDirectory()) return undefined;
    let missingSession = false;
    try {
        const session = await lstat(sessionPath);
        if (!session.isFile() || session.mtimeMs >= cutoff) return undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missingSession = true;
    }
    if (missingSession) {
        if (scratch.mtimeMs >= cutoff) return undefined;
        const entries = await opendir(scratchPath);
        for await (const entry of entries) {
            if ((await lstat(join(scratchPath, entry.name))).mtimeMs >= cutoff) return undefined;
        }
        const after = await lstat(scratchPath);
        if (after.dev !== scratch.dev || after.ino !== scratch.ino || after.mtimeMs !== scratch.mtimeMs) return undefined;
    }
    return { device: scratch.dev, inode: scratch.ino, mtimeMs: scratch.mtimeMs, missingSession };
}

async function leftoverAge(scratchPath: string, sessionPath: string): Promise<ScratchAge | undefined> {
    const scratch = await lstat(scratchPath);
    if (!scratch.isDirectory() || !await sessionMissing(sessionPath)) return undefined;
    return { device: scratch.dev, inode: scratch.ino, mtimeMs: scratch.mtimeMs, missingSession: true };
}

async function sessionMissing(sessionPath: string): Promise<boolean> {
    try {
        await lstat(sessionPath);
        return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return true;
    }
}

function sameScratch(scratchPath: string, sessionPath: string, age: ScratchAge, cutoff: number, leftover: boolean): boolean {
    const scratch = lstatSync(scratchPath);
    if (!scratch.isDirectory() || scratch.dev !== age.device || scratch.ino !== age.inode) return false;
    if (!leftover && age.missingSession && scratch.mtimeMs !== age.mtimeMs) return false;
    try {
        const session = lstatSync(sessionPath);
        return !age.missingSession && session.isFile() && session.mtimeMs < cutoff;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return age.missingSession;
    }
}
