/**
 * Where a truncated tool result's full output goes.
 *
 * The session scratch directory already exists and is already described to the
 * model as disposable, so spilled output lands in a subdirectory of it rather
 * than in a place of its own. The subdirectory keeps the scratch listing the
 * model reads from filling up with engine-written files: it is one entry
 * however many results spilled.
 *
 * Every failure here is silent and returns no path. A spill is what makes
 * truncation humane, not what makes the turn work, and a full disk must not
 * turn a successful tool call into a failed one.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ToolResultSpill } from "../tools/tool-result-limit.ts";

export const SPILL_DIRECTORY_NAME = "tool-results";
export const SPILL_QUOTA_BYTES = 256 * 1024 * 1024;

/** Owner-only: a tool result can carry anything the session touched. */
const SPILL_DIRECTORY_MODE = 0o700;
const SPILL_FILE_MODE = 0o600;

export interface ToolResultSpillOptions {
    readonly quotaBytes?: number;
}

export function createToolResultSpill(
    scratchDir: string,
    options: ToolResultSpillOptions = {},
): ToolResultSpill {
    const directory = join(scratchDir, SPILL_DIRECTORY_NAME);
    const quotaBytes = options.quotaBytes ?? SPILL_QUOTA_BYTES;
    // Two spills inside one millisecond get the same timestamp, and eviction
    // order has to be the order they were written.
    let sequence = 0;

    return {
        async write(toolName, text) {
            const bytes = Buffer.from(text, "utf8");
            if (bytes.length > quotaBytes) {
                // Writing it would evict everything else and still not fit.
                return undefined;
            }
            try {
                await mkdir(directory, {
                    recursive: true,
                    mode: SPILL_DIRECTORY_MODE,
                });
                await evictUntilRoom(directory, quotaBytes - bytes.length);
                sequence += 1;
                const path = join(directory, spillName(toolName, sequence));
                await writeFile(path, bytes, { mode: SPILL_FILE_MODE });
                return path;
            } catch {
                return undefined;
            }
        },
    };
}

/**
 * Oldest artifact first, by the time it was written. The newest results are
 * the ones a turn in progress is still reading back, and an eviction order
 * that took those would spend the quota on files nobody asks for.
 */
async function evictUntilRoom(
    directory: string,
    allowedBytes: number,
): Promise<void> {
    const names = await readdir(directory);
    const files: { path: string; bytes: number; writtenAt: number }[] = [];
    for (const name of names) {
        const path = join(directory, name);
        try {
            const info = await stat(path);
            if (info.isFile()) {
                files.push({
                    path,
                    bytes: info.size,
                    writtenAt: info.mtimeMs,
                });
            }
        } catch {
            // Removed underneath us, which is the state eviction wanted.
        }
    }
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    if (total <= allowedBytes) {
        return;
    }
    // Names lead with the millisecond they were written, so they order two
    // files a filesystem timestamps identically.
    files.sort((left, right) =>
        left.writtenAt - right.writtenAt
        || left.path.localeCompare(right.path)
    );
    for (const file of files) {
        if (total <= allowedBytes) {
            return;
        }
        try {
            await rm(file.path, { force: true });
            total -= file.bytes;
        } catch {
            // Leave it counted: pretending it went would overrun the quota.
        }
    }
}

/**
 * Engine-named, so a spill file cannot collide with something the model wrote
 * and cannot be mistaken for one. The tool name is in it because the first
 * question about an artifact is which call produced it.
 */
function spillName(toolName: string, sequence: number): string {
    const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
    const ordinal = String(sequence).padStart(6, "0");
    return `${Date.now()}-${ordinal}-${safeTool}-${randomUUID().slice(0, 8)}.txt`;
}
