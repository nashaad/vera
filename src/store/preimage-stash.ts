import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_PREIMAGE_BYTES = 50 * 1024 * 1024;
const MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

interface PreimageSidecar {
    readonly path: string;
    readonly sessionId: string;
    readonly capturedAt: string;
    readonly bytes: number;
}

/**
 * Session-scoped store of file contents captured before the first mutation
 * of each file. Write-only during normal operation; recovery is a manual
 * read of the stash directory. The first capture for a path wins: later
 * mutations of the same file in the same session never replace it.
 */
export class PreimageStash {
    readonly directory: string;
    private readonly sessionId: string;
    private readonly captured = new Set<string>();
    private prepared: Promise<void> | undefined;

    constructor(sessionId: string, root: string = defaultStashRoot()) {
        this.sessionId = sessionId;
        this.directory = join(root, sessionId);
    }

    async capture(path: string, content: string): Promise<void> {
        const key = stashKey(path);
        if (this.captured.has(key)) {
            return;
        }
        const bytes = Buffer.byteLength(content);
        if (bytes > MAX_PREIMAGE_BYTES) {
            return;
        }
        this.captured.add(key);
        this.prepared ??= mkdir(this.directory, { recursive: true })
            .then(() => undefined);
        await this.prepared;
        const sidecar: PreimageSidecar = {
            path,
            sessionId: this.sessionId,
            capturedAt: new Date().toISOString(),
            bytes,
        };
        await Bun.write(join(this.directory, key), content);
        await Bun.write(
            join(this.directory, `${key}.json`),
            `${JSON.stringify(sidecar, null, 4)}\n`,
        );
    }
}

export function stashKey(path: string): string {
    return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export function defaultStashRoot(): string {
    return join(homedir(), ".vera", "stash");
}

export interface StashEntry {
    readonly path: string;
    readonly sessionId: string;
    readonly capturedAt: string;
    readonly bytes: number;
}

export interface StashSummary {
    readonly sessions: number;
    readonly preimages: number;
    readonly bytes: number;
    readonly oldestCapturedAt: string | undefined;
    /** Newest captures first. */
    readonly entries: readonly StashEntry[];
}

/** Sizes up the stash for diagnostics. Synchronous: the stash stays small. */
export function summarizeStash(
    root: string = defaultStashRoot(),
): StashSummary | undefined {
    let sessionDirs: string[];
    try {
        sessionDirs = readdirSync(root);
    } catch {
        return undefined;
    }
    let sessions = 0;
    let bytes = 0;
    const entries: StashEntry[] = [];
    for (const entry of sessionDirs) {
        const directory = join(root, entry);
        let files: string[];
        try {
            if (!statSync(directory).isDirectory()) {
                continue;
            }
            files = readdirSync(directory);
        } catch {
            continue;
        }
        let sessionBlobs = 0;
        for (const file of files) {
            if (!file.endsWith(".json")) {
                continue;
            }
            const sidecar = readSidecar(join(directory, file));
            if (sidecar === undefined) {
                continue;
            }
            sessionBlobs += 1;
            bytes += sidecar.bytes;
            entries.push(sidecar);
        }
        if (sessionBlobs > 0) {
            sessions += 1;
        }
    }
    if (sessions === 0) {
        return undefined;
    }
    entries.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return {
        sessions,
        preimages: entries.length,
        bytes,
        oldestCapturedAt: entries[entries.length - 1]?.capturedAt,
        entries,
    };
}

function readSidecar(path: string): StashEntry | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }
        const record = parsed as Record<string, unknown>;
        if (
            typeof record.path !== "string"
            || typeof record.sessionId !== "string"
            || typeof record.capturedAt !== "string"
            || typeof record.bytes !== "number"
        ) {
            return undefined;
        }
        return {
            path: record.path,
            sessionId: record.sessionId,
            capturedAt: record.capturedAt,
            bytes: record.bytes,
        };
    } catch {
        return undefined;
    }
}

/** Removes session stash directories whose newest entry is older than the cap. */
export async function sweepStaleStashes(
    root: string = defaultStashRoot(),
    maxAgeDays: number = MAX_AGE_DAYS,
    now: number = Date.now(),
): Promise<void> {
    const cutoff = now - maxAgeDays * DAY_MS;
    let entries: string[];
    try {
        entries = await readdir(root);
    } catch {
        return;
    }
    for (const entry of entries) {
        const directory = join(root, entry);
        try {
            const info = await stat(directory);
            if (!info.isDirectory() || info.mtimeMs >= cutoff) {
                continue;
            }
            await rm(directory, { recursive: true, force: true });
        } catch {
            continue;
        }
    }
}
