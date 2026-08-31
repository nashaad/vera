import { unlink } from "node:fs/promises";

import { recordMatchesRunningProcess } from "./process-identity.ts";

import {
    defaultHostLockPath,
    readHostLockRecordFile,
    type HostLockRecord,
} from "./lockfile.ts";

export interface ForceStopOutcome {
    readonly pid: number;
    /**
     * How the process ended. "already_dead" means no signal was needed;
     * "survived" means it outlived SIGKILL, which happens to a process wedged
     * in an uninterruptible wait and must never be reported as stopped.
     * "not_ours" means the pid belongs to some other process now.
     */
    readonly endedBy:
        | "sigterm"
        | "sigkill"
        | "already_dead"
        | "survived"
        | "not_ours";
}

export class HostKillNotPermittedError extends Error {
    constructor(readonly pid: number, cause: NodeJS.ErrnoException) {
        super(
            `Vera is not allowed to signal PID ${pid}, so it is not this user's`
                + " resident host. Its lockfile is stale; remove it by hand if"
                + " this persists.",
        );
        this.name = "HostKillNotPermittedError";
        this.cause = cause;
    }
}

export interface ForceStopOptions {
    readonly lockPath?: string;
    /** How long SIGTERM gets before escalating to SIGKILL. */
    readonly sigtermGraceMs?: number;
    /** How long SIGKILL gets before giving up on the wait. */
    readonly sigkillGraceMs?: number;
    readonly pollIntervalMs?: number;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly wait?: (delayMs: number) => Promise<void>;
    /** Whether the live pid is still the process the record describes. */
    readonly matchesRecord?: (
        record: Pick<HostLockRecord, "pid" | "started_at">,
    ) => boolean;
    /**
     * When false, SIGTERM is the last signal. Plain `vera host stop` uses this
     * so a spinning host is not reported Stopped and is not SIGKILLed.
     */
    readonly escalateToKill?: boolean;
}

const DEFAULT_SIGTERM_GRACE_MS = 3_000;
const DEFAULT_SIGKILL_GRACE_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

/**
 * Stops the resident host without asking it anything: plain lockfile read,
 * SIGTERM, bounded wait, SIGKILL, then lockfile removal once the pid is gone.
 * This is the recovery path for a host that is alive but not answering, so
 * every step must work against a process that never responds. A SIGSTOPped
 * process ignores SIGTERM but not SIGKILL, which is why the escalation is
 * unconditional rather than an error path.
 */
export async function forceStopResidentHost(
    options: ForceStopOptions = {},
): Promise<ForceStopOutcome | undefined> {
    const lockPath = options.lockPath ?? defaultHostLockPath();
    const record = await readHostLockRecordFile(lockPath);
    if (record === undefined) return undefined;
    const outcome = await forceStopHostProcess(record, options);
    // A record whose pid now belongs to a stranger describes a host that is
    // gone, so the record goes; a host that outlived SIGKILL is still running
    // and keeps its record, because removing it would let a second host start.
    const clearable = outcome.endedBy === "not_ours"
        || !(options.isProcessAlive ?? processIsAlive)(record.pid);
    if (clearable) {
        await removeFile(lockPath);
    }
    return outcome;
}

/**
 * SIGTERM and wait. Does not SIGKILL. Leaves the lockfile if the same recorded
 * host is still alive, so the next `--force` still knows whom to kill.
 */
export async function gracefulStopResidentHost(
    options: ForceStopOptions = {},
): Promise<ForceStopOutcome | undefined> {
    const lockPath = options.lockPath ?? defaultHostLockPath();
    const record = await readHostLockRecordFile(lockPath);
    if (record === undefined) return undefined;
    const outcome = await forceStopHostProcess(record, {
        ...options,
        escalateToKill: false,
    });
    const stillOurs = outcome.endedBy !== "not_ours"
        && (options.isProcessAlive ?? processIsAlive)(record.pid);
    if (!stillOurs) {
        await removeFile(lockPath);
    }
    return outcome;
}

/** The kill half of the force stop, for callers that already hold a record. */
export async function forceStopHostProcess(
    record: Pick<HostLockRecord, "pid" | "started_at">,
    options: ForceStopOptions = {},
): Promise<ForceStopOutcome> {
    const kill = options.kill ?? defaultKill;
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    const wait = options.wait ?? waitFor;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const waitUntilDead = async (graceMs: number): Promise<boolean> => {
        const deadline = Date.now() + graceMs;
        while (isProcessAlive(record.pid)) {
            if (Date.now() >= deadline) return false;
            await wait(pollIntervalMs);
        }
        return true;
    };

    if (!isProcessAlive(record.pid)) {
        return { pid: record.pid, endedBy: "already_dead" };
    }
    const matchesRecord = options.matchesRecord ?? recordMatchesRunningProcess;
    if (!matchesRecord(record)) {
        return { pid: record.pid, endedBy: "not_ours" };
    }
    kill(record.pid, "SIGTERM");
    if (await waitUntilDead(options.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS)) {
        return { pid: record.pid, endedBy: "sigterm" };
    }
    if (options.escalateToKill === false) {
        return { pid: record.pid, endedBy: "survived" };
    }
    kill(record.pid, "SIGKILL");
    const dead = await waitUntilDead(
        options.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS,
    );
    return { pid: record.pid, endedBy: dead ? "sigkill" : "survived" };
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A process that died between the liveness check and the signal is
        // the outcome this function wants, not a failure.
        if (code === "ESRCH") return;
        if (code === "EPERM") {
            throw new HostKillNotPermittedError(
                pid,
                error as NodeJS.ErrnoException,
            );
        }
        throw error;
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}


async function removeFile(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
