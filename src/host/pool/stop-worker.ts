import { defaultKill, forceStopHostProcess } from "../force-stop.ts";
import { checkRecordIdentity, processIsAlive } from "../process-identity.ts";
import { assertRecordedWorkersStopped, readRecordedWorkers } from "./worker-records.ts";
import type { WorkerStopIdentity } from "./worker-records.ts";

export type { WorkerStopIdentity } from "./worker-records.ts";

export const WORKER_SIGTERM_GRACE_MS = 400;
export const WORKER_SIGKILL_GRACE_MS = 1_000;

export async function stopRecordedWorkers(
    home: string,
    onStopped?: (pid: number) => void,
): Promise<readonly number[]> {
    const records = await readRecordedWorkers(home);
    const outcomes = await Promise.allSettled(records.map(async (record) => {
        const stopped = await stopVerifiedWorker(record);
        if (stopped) onStopped?.(record.pid);
        return { pid: record.pid, stopped };
    }));
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    await assertRecordedWorkersStopped(home);
    return outcomes.flatMap((outcome) => outcome.status === "fulfilled" && outcome.value.stopped ? [outcome.value.pid] : []);
}

export async function stopWorkerProcess(record: WorkerStopIdentity): Promise<void> {
    await stopVerifiedWorker(record);
}

async function stopVerifiedWorker(record: WorkerStopIdentity): Promise<boolean> {
    const outcome = await forceStopHostProcess(record, {
        sigtermGraceMs: WORKER_SIGTERM_GRACE_MS,
        sigkillGraceMs: WORKER_SIGKILL_GRACE_MS,
        pollIntervalMs: 25,
    });
    if (outcome.endedBy === "unverified") {
        throw new Error(`Could not confirm session process PID ${record.pid} stopped.`);
    }
    if (outcome.endedBy === "survived") {
        throw new Error(`Session process PID ${record.pid} is still running.`);
    }
    return outcome.endedBy === "sigterm" || outcome.endedBy === "sigkill";
}

export function killWorkerProcess(record: WorkerStopIdentity): void {
    if (!processIsAlive(record.pid)) return;
    if (checkRecordIdentity(record) !== "match") {
        throw new Error(`Could not confirm session process PID ${record.pid}.`);
    }
    defaultKill(record.pid, "SIGKILL");
}
