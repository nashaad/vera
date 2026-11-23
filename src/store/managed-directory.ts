import { createHash } from "node:crypto";
import {
    closeSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

export interface DirectoryLimits {
    readonly max_entries: number;
    readonly max_file_bytes: number;
    readonly max_total_bytes: number;
    readonly max_path_characters?: number;
}

export interface DirectorySnapshot {
    readonly digest: string;
    readonly entries: number;
    readonly total_bytes: number;
    readonly newest_mtime_ms: number;
}

export interface DirectoryTotals {
    readonly entries: number;
    readonly total_bytes: number;
    readonly newest_mtime_ms: number;
}

export type ErrorFactory = (message: string) => Error;

export function unlimitedDirectoryLimits(): DirectoryLimits {
    return {
        max_entries: Number.POSITIVE_INFINITY,
        max_file_bytes: Number.POSITIVE_INFINITY,
        max_total_bytes: Number.POSITIVE_INFINITY,
    };
}

// One sorted walk produces the digest and the counts, so install checks and
// records see the same tree.
export function inspectDirectory(
    directory: string,
    limits: DirectoryLimits,
    createError: ErrorFactory,
): DirectorySnapshot {
    const hash = createHash("sha256");
    const casefolded = new Set<string>();
    let entries = 0;
    let totalBytes = 0;
    let newestMtime = 0;

    const walk = (current: string, relativeDirectory: string): void => {
        const names = readdirSync(current, { withFileTypes: true })
            .toSorted((left, right) => left.name.localeCompare(right.name));
        for (const entry of names) {
            entries += 1;
            if (entries > limits.max_entries) {
                throw createError(
                    `Package has more than ${limits.max_entries} entries`,
                );
            }
            const relativePath = relativeDirectory === ""
                ? entry.name
                : join(relativeDirectory, entry.name);
            if (
                limits.max_path_characters !== undefined
                && relativePath.length > limits.max_path_characters
            ) {
                throw createError(
                    `Package path is longer than ${limits.max_path_characters} characters: ${relativePath}`,
                );
            }
            const folded = relativePath.toLowerCase();
            if (casefolded.has(folded)) {
                throw createError(
                    `Package paths differ only by case: ${relativePath}`,
                );
            }
            casefolded.add(folded);

            const path = join(current, entry.name);
            const details = lstatSync(path);
            newestMtime = Math.max(newestMtime, details.mtimeMs);
            if (details.isSymbolicLink()) {
                throw createError(
                    `Symlinks are not supported in package sources: ${path}`,
                );
            }
            if (details.isDirectory()) {
                hash.update(`dir:${portablePath(relativePath)}\n`);
                walk(path, relativePath);
                continue;
            }
            if (!details.isFile()) {
                throw createError(`Unsupported file in package source: ${path}`);
            }
            if (details.size > limits.max_file_bytes) {
                throw createError(
                    `Package file is larger than ${limits.max_file_bytes} bytes: ${relativePath}`,
                );
            }
            totalBytes += details.size;
            if (totalBytes > limits.max_total_bytes) {
                throw createError(
                    `Package is larger than ${limits.max_total_bytes} bytes`,
                );
            }
            hash.update(`file:${portablePath(relativePath)}\n`);
            hash.update(readFileSync(path));
            hash.update("\n");
        }
    };

    walk(directory, "");
    return {
        digest: `sha256:${hash.digest("hex")}`,
        entries,
        total_bytes: totalBytes,
        newest_mtime_ms: newestMtime,
    };
}

// Stat-only comparison: the registry records totals, and list never hashes.
export function directoryMatchesTotals(
    directory: string,
    totals: DirectoryTotals,
): boolean {
    let entries = 0;
    let totalBytes = 0;
    let newestMtime = 0;
    const walk = (current: string): boolean => {
        let names;
        try {
            names = readdirSync(current, { withFileTypes: true });
        } catch {
            return false;
        }
        for (const entry of names) {
            const path = join(current, entry.name);
            let details;
            try {
                details = lstatSync(path);
            } catch {
                return false;
            }
            entries += 1;
            newestMtime = Math.max(newestMtime, details.mtimeMs);
            if (details.isSymbolicLink()) return false;
            if (details.isDirectory()) {
                if (!walk(path)) return false;
                continue;
            }
            if (!details.isFile()) return false;
            totalBytes += details.size;
        }
        return true;
    };
    return walk(directory)
        && entries === totals.entries
        && totalBytes === totals.total_bytes
        && Math.abs(newestMtime - totals.newest_mtime_ms) <= 0.5;
}

export function directorySize(directory: string): number {
    let total = 0;
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            const details = lstatSync(path);
            if (details.isSymbolicLink()) continue;
            if (details.isDirectory()) walk(path);
            else if (details.isFile()) total += details.size;
        }
    };
    try {
        walk(directory);
    } catch {
        return 0;
    }
    return total;
}

export function withFileLock<T>(
    lockPath: string,
    action: () => T,
    createError: ErrorFactory = (message) => new Error(message),
    busyMessage?: string,
): T {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    let descriptor: number;
    while (true) {
        try {
            descriptor = openSync(lockPath, "wx", 0o600);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            try {
                if (lstatSync(lockPath).isSymbolicLink()) {
                    throw createError(`Lock file is a symlink: ${lockPath}`);
                }
            } catch (inner) {
                if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner;
                continue;
            }
            if (!reclaimDeadLock(lockPath)) {
                throw createError(
                    busyMessage
                        ?? `Another operation is using ${dirname(lockPath)}`,
                );
            }
        }
    }
    try {
        const owner = Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`);
        writeSync(descriptor, owner, 0, owner.byteLength, 0);
        return action();
    } finally {
        closeSync(descriptor);
        rmSync(lockPath, { force: true });
    }
}

function reclaimDeadLock(path: string): boolean {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return false;
    }
    if (
        typeof value !== "object"
        || value === null
        || typeof (value as { pid?: unknown }).pid !== "number"
        || !Number.isInteger((value as { pid: number }).pid)
    ) {
        return false;
    }
    try {
        process.kill((value as { pid: number }).pid, 0);
        return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    rmSync(path, { force: true });
    return true;
}

function portablePath(path: string): string {
    return sep === "/" ? path : path.split(sep).join("/");
}
