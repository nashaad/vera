import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { inspectHostLockFile, type HostLockRecord } from "../lockfile.ts";
import { checkRecordIdentity, processIsAlive } from "../process-identity.ts";
import type { PoolCrashScanOptions, PoolCrashScanResult } from "./in-process.ts";
import type { CrashSessionPath } from "./worker-crash-scan.ts";
import type { WorkerRecordScan } from "./worker-record.ts";
import type { RestartLedger } from "./restart-ledger.ts";

export interface CrashScanCandidates {
    readonly since: number;
    readonly paths: readonly string[];
}

export async function crashScanCandidates(
    lockPath: string,
    sessionDirectory: string,
): Promise<CrashScanCandidates | undefined> {
    const stale = await staleHostLock(lockPath);
    if (stale === undefined) return undefined;
    const since = Date.parse(stale.started_at);
    if (Number.isNaN(since)) return undefined;

    const names = await readdir(sessionDirectory).catch(() => []);
    const paths = await Promise.all(names.filter((name) => name.endsWith(".jsonl")).sort().map(async (name) => {
        const path = join(sessionDirectory, name);
        const info = await stat(path).catch(() => undefined);
        return info?.isFile() === true && info.mtimeMs >= since ? path : undefined;
    }));
    return { since, paths: paths.filter((path): path is string => path !== undefined) };
}

async function staleHostLock(lockPath: string): Promise<HostLockRecord | undefined> {
    const inspection = await inspectHostLockFile(lockPath);
    if (inspection.state !== "valid") return undefined;
    const stale = inspection.record;
    if (processIsAlive(stale.pid) && checkRecordIdentity(stale) !== "mismatch") return undefined;
    return stale;
}

export async function hasInterruptedPoolScan(lockPath: string, workers: WorkerRecordScan): Promise<boolean> {
    const stale = await staleHostLock(lockPath);
    if (stale === undefined) return false;
    return [
        ...workers.recoverable.map((worker) => worker.record),
        ...workers.pending.map((worker) => worker.record),
        ...workers.stopped,
        ...workers.stale,
    ].some((record) => record.host_pid !== stale.pid);
}

export interface CrashScanWorker {
    readonly id: string;
    ready(): boolean;
    discover(paths: readonly string[], signal: AbortSignal): Promise<readonly CrashSessionPath[]>;
    recover(session: CrashSessionPath, signal: AbortSignal): Promise<"done" | "changed">;
}

export async function recoverPoolCrashedTurns(options: PoolCrashScanOptions & {
    readonly workers: readonly CrashScanWorker[];
    readonly owner: (id: string) => string;
    readonly ledger: RestartLedger;
    readonly setRecorder: (record: ((id: string) => Promise<void>) | undefined) => void;
    readonly timeoutMs: number;
}): Promise<PoolCrashScanResult> {
    const deadline = performance.now() + options.timeoutMs;
    const candidates = await beforeDeadline(
        crashScanCandidates(options.lockPath, options.sessionDirectory), deadline,
    );
    if (candidates === undefined) return { recorded: [], failures: [] };
    const alreadyRecorded = new Set((await beforeDeadline(options.ledger.list(), deadline))
        .filter((record) => record.cause === "crash" && Date.parse(record.at) >= candidates.since)
        .map((record) => record.session_id));
    const recorded: string[] = [];
    const pending = new Map<string, Promise<void>>();
    const failures: string[] = [];
    const now = new Date().toISOString();
    const record = (id: string): Promise<void> => {
        if (alreadyRecorded.has(id)) return Promise.resolve();
        const existing = pending.get(id);
        if (existing !== undefined) return existing;
        const writing = options.ledger.append({ session_id: id, cause: "crash", at: now }).then(() => {
            alreadyRecorded.add(id);
            recorded.push(id);
        });
        pending.set(id, writing);
        void writing.finally(() => pending.delete(id)).catch(() => {});
        return writing;
    };
    const signal = (): AbortSignal => AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
    const ready = options.workers.filter((worker) => worker.ready());
    for (const worker of options.workers) {
        if (!worker.ready()) failures.push(`Session process ${worker.id} is unavailable.`);
    }
    if (ready.length === 0) return { recorded, failures };
    const batches = ready.map(() => [] as string[]);
    for (const [index, path] of candidates.paths.entries()) batches[index % ready.length]!.push(path);
    options.setRecorder(record);
    try {
        const discovered = await Promise.allSettled(ready.map(async (worker, index) => {
            const paths = batches[index]!;
            const sessions = await worker.discover(paths, signal());
            const allowed = new Set(paths);
            if (!Array.isArray(sessions) || !sessions.every((session) =>
                typeof session === "object" && session !== null && typeof session.id === "string"
                && session.id.length > 0 && typeof session.path === "string" && allowed.has(session.path))
                || new Set(sessions.map((session) => session.path)).size !== sessions.length) {
                throw new Error(`Session process ${worker.id} returned invalid crash sessions.`);
            }
            return sessions;
        }));
        const sessions: CrashSessionPath[] = [];
        for (const result of discovered) {
            if (result.status === "fulfilled") sessions.push(...result.value);
            else failures.push(errorMessage(result.reason));
        }
        const queues = new Map(ready.map((worker) => [worker.id, [] as CrashSessionPath[]]));
        for (const session of sessions) {
            const owner = options.owner(session.id);
            if (owner === "host") continue;
            const queue = queues.get(owner);
            if (queue === undefined) failures.push(`Session process ${owner} is unavailable.`);
            else queue.push(session);
        }
        await Promise.all(ready.map(async (initial) => {
            for (const session of queues.get(initial.id)!) {
                try {
                    let completed = false;
                    let current = session;
                    for (let attempt = 0; attempt < 3; attempt += 1) {
                        const owner = options.owner(current.id);
                        if (owner === "host") { completed = true; break; }
                        const worker = options.workers.find((candidate) => candidate.id === owner && candidate.ready());
                        if (worker === undefined) throw new Error(`Session process ${owner} is unavailable.`);
                        if (performance.now() >= deadline) throw new Error("Session crash scan exceeded its deadline.");
                        if (await worker.recover(current, signal()) === "done") { completed = true; break; }
                        const rediscovered = await worker.discover([current.path], signal());
                        if (rediscovered.length === 0) { completed = true; break; }
                        if (rediscovered.length !== 1 || rediscovered[0]?.path !== current.path
                            || typeof rediscovered[0].id !== "string" || rediscovered[0].id.length === 0) {
                            throw new Error("Session process returned an invalid crash session.");
                        }
                        current = rediscovered[0];
                    }
                    if (!completed) throw new Error("Session ownership changed during crash recovery.");
                } catch (error) {
                    failures.push(errorMessage(error));
                }
            }
        }));
    } finally {
        options.setRecorder(undefined);
    }
    return { recorded, failures };
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Session crash scan exceeded its deadline.")),
                    Math.max(1, Math.ceil(deadline - performance.now())));
                timer.unref();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
