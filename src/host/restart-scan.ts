import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
    appendRestartRecord,
    listRestartRecords,
} from "../store/restart-records.ts";
import { openSessionForRecovery, readSessionTurnState } from "../store/session-store.ts";
import { inspectHostLockFile } from "./lockfile.ts";
import {
    checkRecordIdentity,
    processIsAlive,
    type RecordIdentity,
} from "./process-identity.ts";

export interface RecoverCrashedTurnsOptions {
    readonly lockPath: string;
    readonly sessionDirectory: string;
    readonly recordPath: string;
    readonly now?: () => Date;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly recordIdentity?: (record: {
        readonly pid: number;
        readonly started_at: string;
    }) => RecordIdentity;
    readonly withSession?: (path: string, run: () => Promise<void>) => Promise<void>;
}

export interface RecoverCrashedTurnsResult {
    readonly scanned: number;
    readonly recorded: readonly string[];
}

const NO_RECOVERY: RecoverCrashedTurnsResult = { scanned: 0, recorded: [] };

// Runs before the new host publishes its lock, so only one host scans at a time.
export async function recoverCrashedTurns(
    options: RecoverCrashedTurnsOptions,
): Promise<RecoverCrashedTurnsResult> {
    const inspection = await inspectHostLockFile(options.lockPath);
    if (inspection.state !== "valid") return NO_RECOVERY;
    const stale = inspection.record;
    // A live pid whose start time does not match the lock belongs to a reused pid.
    if ((options.isProcessAlive ?? processIsAlive)(stale.pid)) {
        const identity = (options.recordIdentity ?? checkRecordIdentity)(stale);
        if (identity !== "mismatch") return NO_RECOVERY;
    }

    const since = Date.parse(stale.started_at);
    if (Number.isNaN(since)) return NO_RECOVERY;
    const alreadyRecorded = new Set(
        listRestartRecords(options.recordPath)
            .filter((record) =>
                record.cause === "crash" && Date.parse(record.at) >= since
            )
            .map((record) => record.session_id),
    );
    const now = (options.now ?? (() => new Date()))().toISOString();
    const files = await sessionFilesSince(options.sessionDirectory, since);
    const recorded: string[] = [];
    for (const path of files) {
        const recover = async (): Promise<void> => {
            const state = await readSessionTurnState(path).catch(() => undefined);
            if (state === undefined || (!state.turnOpen && !state.hasQueuedPrompts)) return;
            if (!alreadyRecorded.has(state.sessionId)) {
                appendRestartRecord(
                    { session_id: state.sessionId, cause: "crash", at: now },
                    options.recordPath,
                );
                alreadyRecorded.add(state.sessionId);
                recorded.push(state.sessionId);
            }
            await openSessionForRecovery(path);
        };
        try {
            if (options.withSession === undefined) await recover();
            else await options.withSession(path, recover);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    return { scanned: files.length, recorded };
}

async function sessionFilesSince(
    directory: string,
    since: number,
): Promise<string[]> {
    let names: string[];
    try {
        names = await readdir(directory);
    } catch {
        return [];
    }
    const candidates = names.filter((name) => name.endsWith(".jsonl")).sort();
    const modified = await Promise.all(candidates.map(async (name) => {
        const path = join(directory, name);
        try {
            const info = await stat(path);
            return info.isFile() && info.mtimeMs >= since ? path : undefined;
        } catch {
            return undefined;
        }
    }));
    return modified.filter((path): path is string => path !== undefined);
}
