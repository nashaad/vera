import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defaultHostSocketPath } from "../lockfile.ts";
import { checkRecordIdentity, processIsAlive } from "../process-identity.ts";
import { forceStopHostProcess } from "../force-stop.ts";
import { requestHostIdentity, type HostIdentity } from "../protocol.ts";
import type { WorkerHello } from "./worker-control.ts";
import type { WorkerSocket } from "./worker-sockets.ts";
import { recordedWorkerState } from "./worker-records.ts";

export interface WorkerRecord {
    readonly id: string;
    readonly index: number;
    readonly pid: number;
    readonly started_at: string;
    readonly socket_path: string;
    readonly control_path: string;
    readonly build_id: string;
    readonly host_pid: number;
    readonly count?: number;
}

export interface RecoverableWorker {
    readonly record: WorkerRecord;
    readonly identity: HostIdentity;
    readonly unrecorded?: true;
}

export interface PendingWorkerRecord {
    readonly record: WorkerRecord;
    readonly path: string;
    readonly source: string;
    readonly identity?: HostIdentity;
}

export interface WorkerRecordScan {
    readonly recoverable: readonly RecoverableWorker[];
    readonly stopped: readonly WorkerRecord[];
    readonly pending: readonly PendingWorkerRecord[];
    readonly unrecorded: readonly WorkerSocket[];
    readonly stale: readonly WorkerRecord[];
    readonly count?: number;
}

export interface WorkerRecordHandle {
    remove(): Promise<void>;
}

export async function publishWorkerRecord(home: string, hello: WorkerHello, controlPath: string): Promise<WorkerRecordHandle> {
    const directory = join(dirname(defaultHostSocketPath(home)), "workers");
    const path = join(directory, `${hello.id}.json`);
    const record: WorkerRecord = {
        id: hello.id, index: hello.index, pid: hello.pid, started_at: hello.started_at,
        socket_path: hello.socket, control_path: controlPath, build_id: hello.build_id, host_pid: process.pid,
        count: hello.count,
    };
    const contents = `${JSON.stringify(record)}\n`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let file;
    try {
        file = await open(path, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = await readFile(path, "utf8");
        const identity = parseIdentity(previous);
        if (identity === undefined || (processIsAlive(identity.pid) && checkRecordIdentity(identity) !== "mismatch")) {
            throw new Error(`Session process record is still in use: ${path}`);
        }
        if (await readFile(path, "utf8") !== previous) throw new Error(`Session process record changed: ${path}`);
        await unlink(path);
        file = await open(path, "wx", 0o600);
    }
    try {
        await file.writeFile(contents, "utf8");
        await file.sync();
    } catch (error) {
        await file.close();
        await unlink(path).catch(() => {});
        throw error;
    }
    await file.close();
    return {
        async remove() {
            const current = await readFile(path, "utf8").catch(() => undefined);
            if (current === contents) await unlink(path).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
        },
    };
}

export async function inspectWorkerRecords(
    home: string,
    buildId: string,
): Promise<WorkerRecordScan> {
    const directory = join(dirname(defaultHostSocketPath(home)), "workers");
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    const recoverable: RecoverableWorker[] = [];
    const stopped: WorkerRecord[] = [];
    const pending: PendingWorkerRecord[] = [];
    const stale: WorkerRecord[] = [];
    let count: number | undefined;
    const inspections = await Promise.allSettled(names.filter((entry) => entry.endsWith(".json")).sort().map(async (name) => {
        const path = join(directory, name);
        const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        });
        if (source === undefined) return;
        const record = parseWorkerRecord(source);
        if (record === undefined || name !== `${record.id}.json`) throw new Error(`Invalid session process record: ${path}`);
        const runtime = dirname(defaultHostSocketPath(home));
        if (record.socket_path !== join(runtime, `${record.id}.sock`) || record.control_path !== join(runtime, "control.sock")) {
            throw new Error(`Invalid session process record: ${path}`);
        }
        const matching = processIsAlive(record.pid) ? checkRecordIdentity(record) : "mismatch";
        if (matching === "mismatch") {
            stale.push(record);
            await removeUnchanged(path, source);
            return;
        }
        if (matching !== "match") throw new Error(`Could not verify session process PID ${record.pid}`);
        const identity = await requestHostIdentity(record.socket_path);
        if (identity === undefined) {
            pending.push({ record, path, source });
            if (record.count !== undefined) count = mergeCount(count, record.count);
            return;
        }
        assertWorkerIdentity(record, identity);
        if (record.count !== undefined) count = mergeCount(count, record.count);
        if (record.build_id !== buildId) {
            pending.push({ record, path, source, identity });
            return;
        }
        recoverable.push({ record, identity });
    }));
    const failure = inspections.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (recoverable.length > 0 || pending.length > 0) stopped.push(...stale);
    return { recoverable, stopped, pending, unrecorded: [], stale, ...(count === undefined ? {} : { count }) };
}

export async function settleWorkerRecords(
    scan: WorkerRecordScan,
    buildId: string,
    deadlineMs: number,
    onUnresponsive?: (pid: number) => void,
): Promise<WorkerRecordScan> {
    const recoverable = [...scan.recoverable];
    const stopped = [...scan.stopped];
    let count = scan.count;
    const inspections = await Promise.allSettled(scan.pending.map(async ({ record, path, source, identity: initial }) => {
        let identity = initial;
        if (identity === undefined) {
            onUnresponsive?.(record.pid);
            const deadline = performance.now() + deadlineMs;
            while (identity === undefined && performance.now() < deadline && processIsAlive(record.pid)
                && checkRecordIdentity(record) === "match") {
                await Bun.sleep(Math.min(100, Math.max(1, deadline - performance.now())));
                identity = await requestHostIdentity(record.socket_path);
            }
            if (identity === undefined) {
                const state = recordedWorkerState(record);
                if (state !== "stopped") {
                    if (state !== "match") throw new Error(`Could not verify session process PID ${record.pid}`);
                    try { process.kill(record.pid, "SIGKILL"); }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
                    const until = performance.now() + 3_000;
                    while (processIsAlive(record.pid) && checkRecordIdentity(record) === "match" && performance.now() < until) await Bun.sleep(20);
                    const after = recordedWorkerState(record);
                    if (after === "match" || after === "unknown") {
                        throw new Error(`Could not stop session process PID ${record.pid}`);
                    }
                }
                stopped.push(record);
                await removeUnchanged(path, source);
                return;
            }
        }
        assertWorkerIdentity(record, identity);
        if (record.count !== undefined) count = mergeCount(count, record.count);
        if (record.build_id === buildId) {
            recoverable.push({ record, identity });
            return;
        }
        const outcome = await forceStopHostProcess(record, { sigtermGraceMs: 1_500, sigkillGraceMs: 1_500 });
        if (outcome.endedBy === "unverified" || outcome.endedBy === "survived") {
            throw new Error(`Could not stop session process PID ${record.pid}`);
        }
        stopped.push(record);
        await removeUnchanged(path, source);
    }));
    const failure = inspections.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return { recoverable, stopped, pending: [], unrecorded: scan.unrecorded, stale: scan.stale,
        ...(count === undefined ? {} : { count }) };
}

function assertWorkerIdentity(record: WorkerRecord, identity: HostIdentity): void {
    if (identity.pid !== record.pid || identity.started_at !== record.started_at || identity.role !== "worker"
        || identity.worker_id !== record.id || identity.worker_index !== record.index
        || identity.build_id !== record.build_id || !Number.isSafeInteger(identity.worker_count)
        || !Number.isSafeInteger(identity.worker_generation) || identity.worker_count! <= record.index
        || identity.worker_generation! <= 0 || (record.count !== undefined && record.count !== identity.worker_count)) {
        throw new Error(`worker_socket_busy: ${record.socket_path}`);
    }
}

function mergeCount(current: number | undefined, next: number): number {
    if (current !== undefined && current !== next) throw new Error("Session processes disagree on the pool size");
    return next;
}

export async function removeOwnWorkerRecord(home: string, hello: WorkerHello): Promise<void> {
    const path = join(dirname(defaultHostSocketPath(home)), "workers", `${hello.id}.json`);
    const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
    if (source === undefined) return;
    const record = parseWorkerRecord(source);
    if (record?.pid === hello.pid && record.started_at === hello.started_at) await removeUnchanged(path, source);
}

export async function adoptWorkerRecord(home: string, previous: WorkerRecord, hello: WorkerHello, controlPath: string): Promise<WorkerRecordHandle> {
    const path = join(dirname(defaultHostSocketPath(home)), "workers", `${previous.id}.json`);
    const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
    if (source === undefined) return await publishWorkerRecord(home, hello, controlPath);
    const current = parseWorkerRecord(source);
    if (current === undefined || current.pid !== previous.pid || current.started_at !== previous.started_at
        || current.build_id !== previous.build_id || current.socket_path !== previous.socket_path) {
        throw new Error(`Session process record changed: ${path}`);
    }
    const updated: WorkerRecord = {
        ...current, host_pid: process.pid, control_path: controlPath, count: hello.count,
    };
    const contents = `${JSON.stringify(updated)}\n`;
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
        await file.writeFile(contents, "utf8");
        await file.sync();
    } finally { await file.close(); }
    try {
        if (await readFile(path, "utf8") !== source) throw new Error(`Session process record changed: ${path}`);
        await rename(temporary, path);
    } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
    }
    return { remove: () => removeUnchanged(path, contents) };
}

async function removeUnchanged(path: string, source: string): Promise<void> {
    const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
    if (current === source) await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
    });
}

function parseWorkerRecord(source: string): WorkerRecord | undefined {
    try {
        const value: unknown = JSON.parse(source);
        if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
        const item = value as Record<string, unknown>;
        if (!Number.isSafeInteger(item.index) || (item.index as number) < 0 || item.id !== `w${item.index}`
            || !Number.isSafeInteger(item.pid) || (item.pid as number) <= 0
            || typeof item.started_at !== "string" || !Number.isFinite(Date.parse(item.started_at))
            || typeof item.socket_path !== "string" || typeof item.control_path !== "string"
            || typeof item.build_id !== "string" || item.build_id.length === 0
            || !Number.isSafeInteger(item.host_pid) || (item.host_pid as number) <= 0
            || (item.count !== undefined && (!Number.isSafeInteger(item.count) || (item.count as number) <= (item.index as number)))) {
            return undefined;
        }
        return item as unknown as WorkerRecord;
    } catch { return undefined; }
}

function parseIdentity(contents: string): { readonly pid: number; readonly started_at: string } | undefined {
    try {
        const value: unknown = JSON.parse(contents);
        if (typeof value !== "object" || value === null) return undefined;
        const record = value as Record<string, unknown>;
        return typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0
            && typeof record.started_at === "string" && Number.isFinite(Date.parse(record.started_at))
            ? { pid: record.pid, started_at: record.started_at } : undefined;
    } catch {
        return undefined;
    }
}
