import { readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defaultHostSocketPath, readHostLockRecordFile } from "../lockfile.ts";
import { checkRecordIdentity, processIsAlive, type RecordIdentity } from "../process-identity.ts";

export interface WorkerStopIdentity {
    readonly pid: number;
    readonly started_at: string;
}

export interface RecordedWorker extends WorkerStopIdentity {
    readonly id: string;
    readonly path: string;
    readonly hostPid?: number;
}

export async function readRecordedWorkers(home: string): Promise<readonly RecordedWorker[]> {
    const directory = join(dirname(defaultHostSocketPath(home)), "workers");
    let names: string[];
    try {
        names = await readdir(directory);
    } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
        throw error;
    }
    const records: RecordedWorker[] = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
        const path = join(directory, name);
        let value: unknown;
        try {
            value = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw new Error(`Could not read session process record ${path}.`);
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error(`Could not read session process record ${path}.`);
        }
        const record = value as Record<string, unknown>;
        if (typeof record.id !== "string" || record.id.length === 0
            || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0
            || typeof record.started_at !== "string" || Number.isNaN(Date.parse(record.started_at))) {
            throw new Error(`Could not read session process record ${path}.`);
        }
        records.push({
            id: record.id, pid: record.pid, started_at: record.started_at, path,
            ...(typeof record.host_pid === "number" && Number.isSafeInteger(record.host_pid) && record.host_pid > 0
                ? { hostPid: record.host_pid } : {}),
        });
    }
    return records;
}

export type RecordedWorkerState = RecordIdentity | "stopped";

export function recordedWorkerState(record: WorkerStopIdentity): RecordedWorkerState {
    if (!processIsAlive(record.pid)) return "stopped";
    const identity = checkRecordIdentity(record);
    // ps cannot read a process that exits after the liveness check.
    return identity === "unknown" && !processIsAlive(record.pid) ? "stopped" : identity;
}

export function assertWorkerStopped(record: WorkerStopIdentity): void {
    const state = recordedWorkerState(record);
    if (state === "match") throw new Error(`Session process PID ${record.pid} is still running.`);
    if (state === "unknown") throw new Error(`Could not confirm session process PID ${record.pid} stopped.`);
}

export async function assertRecordedWorkersStopped(home: string): Promise<void> {
    for (const record of await readRecordedWorkers(home)) assertWorkerStopped(record);
}

export async function removeStoppedPoolLock(
    home: string,
    path: string,
    host: WorkerStopIdentity,
): Promise<void> {
    await assertRecordedWorkersStopped(home);
    const record = await readHostLockRecordFile(path);
    if (record === undefined || record.pid !== host.pid || record.started_at !== host.started_at) return;
    try {
        await unlink(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}
