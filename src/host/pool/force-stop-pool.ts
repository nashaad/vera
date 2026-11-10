import { forceStopHostProcess, unverifiedHostMessage } from "../force-stop.ts";
import { defaultHostLockPath, defaultHostSocketPath, HostLockUnreadableError, inspectHostLockFile } from "../lockfile.ts";
import { checkRecordIdentity, processIsAlive } from "../process-identity.ts";
import { HostStartupInProgressError, type HostStartupClaim } from "../startup-claim.ts";
import { acquireStopStartupClaim } from "../stop-claim.ts";
import { stopRecordedWorkers } from "./stop-worker.ts";
import { readRecordedWorkers, removeStoppedPoolLock } from "./worker-records.ts";
import { listLiveProcessesIn } from "../../live-process.ts";
import { removeSocketFile, removeUnusedSocketFile, socketFileIdentity } from "../socket-file.ts";

export interface ForcePoolStopResult {
    readonly hostPid?: number;
    readonly workerPids: readonly number[];
}

export interface ForcePoolStopOptions {
    readonly startupClaim?: HostStartupClaim;
    readonly onWorkerStopped?: (pid: number) => void;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export class ForcePoolStartupInProgressError extends HostStartupInProgressError {
    constructor(
        holderPid: number | undefined,
        readonly stoppedHostPid: number | undefined,
        readonly stoppedWorkerPids: readonly number[],
    ) {
        super(holderPid);
    }
}

export async function forceStopPool(home: string, options: ForcePoolStopOptions = {}): Promise<ForcePoolStopResult | undefined> {
    const lockPath = defaultHostLockPath(home);
    const initial = await inspectHostLockFile(lockPath);
    const initialWorkers = await readRecordedWorkers(home);
    if (initialWorkers.length === 0 && initial.state !== "absent"
        && (initial.state !== "valid" || initial.record.worker_count === undefined)) return undefined;

    const claimPath = `${defaultHostSocketPath(home)}.starting`;
    let claim: HostStartupClaim | undefined = options.startupClaim;
    let ownsClaim = false;
    let busy: HostStartupInProgressError | undefined;
    try {
        if (claim === undefined) {
            claim = await acquireStopStartupClaim(claimPath);
            ownsClaim = true;
        }
    } catch (error) {
        if (!(error instanceof HostStartupInProgressError)) throw error;
        const inspection = await inspectHostLockFile(lockPath);
        const workers = await readRecordedWorkers(home);
        if (inspection.state === "valid" && inspection.record.worker_count === undefined && workers.length === 0) {
            return undefined;
        }
        const verifiedWorker = workers.some((worker) =>
            processIsAlive(worker.pid) && checkRecordIdentity(worker) === "match");
        if (inspection.state !== "valid" && !verifiedWorker) throw error;
        busy = error;
    }
    try {
        let hostPid: number | undefined;
        const workerPids = new Set<number>();
        const stopCurrent = async (): Promise<boolean> => {
            const inspection = await inspectHostLockFile(lockPath);
            const records = await readRecordedWorkers(home);
            if (inspection.state === "damaged") {
                for (const pid of await stopRecordedWorkers(home, options.onWorkerStopped, options.kill)) workerPids.add(pid);
                if (inspection.pid === undefined) throw new HostLockUnreadableError(lockPath);
                throw new Error(unverifiedHostMessage({ pid: inspection.pid, lockDamaged: true }, lockPath));
            }
            if (records.length === 0 && (inspection.state !== "valid" || inspection.record.worker_count === undefined)) {
                return false;
            }
            if (inspection.state === "valid") {
                const socket = await socketFileIdentity(inspection.record.socket_path);
                const outcome = await forceStopHostProcess(inspection.record, {
                    firstSignal: "SIGKILL", sigkillGraceMs: 1_000, pollIntervalMs: 25, kill: options.kill,
                });
                if (outcome.endedBy === "unverified") throw new Error(unverifiedHostMessage(outcome, lockPath));
                if (outcome.endedBy === "survived") {
                    throw new Error(`Resident Vera host PID ${outcome.pid} is still running.`);
                }
                if (outcome.endedBy === "sigkill") hostPid = outcome.pid;
                if (outcome.endedBy === "sigkill" || outcome.endedBy === "already_dead" || outcome.endedBy === "not_ours") {
                    const current = await inspectHostLockFile(lockPath);
                    if (current.state === "valid" && current.record.pid === inspection.record.pid
                        && current.record.started_at === inspection.record.started_at) {
                        if (outcome.endedBy === "sigkill") await removeSocketFile(inspection.record.socket_path, socket);
                        else await removeUnusedSocketFile(inspection.record.socket_path, socket);
                    }
                }
            }
            for (const pid of await stopRecordedWorkers(home, options.onWorkerStopped, options.kill)) workerPids.add(pid);
            if (inspection.state === "valid") await removeStoppedPoolLock(home, lockPath, inspection.record);
            return true;
        };
        let stopped = await stopCurrent();
        if (busy !== undefined) {
            try {
                claim = await acquireStopStartupClaim(claimPath);
            } catch (error) {
                if (error instanceof HostStartupInProgressError) {
                    throw new ForcePoolStartupInProgressError(error.holderPid, hostPid, [...workerPids]);
                }
                throw error;
            }
            ownsClaim = true;
            stopped = await stopCurrent() || stopped;
        }
        if (!stopped) return undefined;
        listLiveProcessesIn(home);
        return { ...(hostPid === undefined ? {} : { hostPid }), workerPids: [...workerPids] };
    } finally {
        if (ownsClaim) await claim?.release();
    }
}
