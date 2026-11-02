import { unlink } from "node:fs/promises";

import {
    checkRecordIdentity,
    type RecordIdentity,
} from "./process-identity.ts";

import {
    defaultHostLockPath,
    HostLockUnreadableError,
    inspectHostLockFile,
    type HostLockRecord,
} from "./lockfile.ts";

export interface ForceStopOutcome {
    readonly pid: number;
    readonly endedBy:
        | "sigterm"
        | "sigkill"
        | "already_dead"
        | "survived"
        | "not_ours"
        | "unverified";
    // Set with "unverified" when the lockfile's own start time is not a time.
    readonly lockStartTimeInvalid?: boolean;
    // Set when the lockfile did not parse as a whole and only its PID was read.
    readonly lockDamaged?: boolean;
}

export function unverifiedHostMessage(
    outcome: Pick<
        ForceStopOutcome,
        "pid" | "lockStartTimeInvalid" | "lockDamaged"
    >,
    lockPath: string = defaultHostLockPath(),
): string {
    const pid = outcome.pid;
    if (outcome.lockDamaged === true) {
        return `Could not confirm PID ${pid} is the Vera host (its lockfile is`
            + " damaged); left it running and kept its lockfile."
            + ` Check that PID ${pid} is a Vera host before you stop it. If it`
            + ` is not, deleting ${lockPath} is safe.`;
    }
    if (outcome.lockStartTimeInvalid === true) {
        return `Could not confirm PID ${pid} is the Vera host (its lockfile has`
            + " no valid start time); left it running and kept its lockfile."
            + ` Check that PID ${pid} is a Vera host before you stop it. If it`
            + ` is not, deleting ${lockPath} is safe.`;
    }
    return `Could not confirm PID ${pid} is the Vera host (process start time`
        + " unreadable); left it running and kept its lockfile. Try again.";
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
    readonly sigtermGraceMs?: number;
    readonly sigkillGraceMs?: number;
    readonly pollIntervalMs?: number;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly wait?: (delayMs: number) => Promise<void>;
    readonly matchesRecord?: (
        record: Pick<HostLockRecord, "pid" | "started_at">,
    ) => boolean;
    readonly readStartedAt?: (pid: number) => number | undefined;
    readonly readCommand?: (pid: number) => string | undefined;
    readonly escalateToKill?: boolean;
}

export const DEFAULT_SIGTERM_GRACE_MS = 3_000;
const DEFAULT_SIGKILL_GRACE_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

interface StopTarget {
    readonly record: Pick<HostLockRecord, "pid" | "started_at">;
    readonly damaged: boolean;
}

// A damaged lock has no trusted start time: a Vera-looking live PID stays
// unverified, and only a dead or non-Vera PID lets the lock be cleared.
// Throws HostLockUnreadableError when no PID can be read from it.
async function readStopTarget(
    lockPath: string,
): Promise<StopTarget | undefined> {
    const inspection = await inspectHostLockFile(lockPath);
    if (inspection.state === "absent") return undefined;
    if (inspection.state === "valid") {
        return { record: inspection.record, damaged: false };
    }
    if (inspection.pid === undefined) {
        throw new HostLockUnreadableError(lockPath);
    }
    return { record: { pid: inspection.pid, started_at: "" }, damaged: true };
}

function markDamaged(
    outcome: ForceStopOutcome,
    damaged: boolean,
): ForceStopOutcome {
    if (!damaged) return outcome;
    const { lockStartTimeInvalid: _ignored, ...rest } = outcome;
    return { ...rest, lockDamaged: true };
}

export async function forceStopResidentHost(
    options: ForceStopOptions = {},
): Promise<ForceStopOutcome | undefined> {
    const lockPath = options.lockPath ?? defaultHostLockPath();
    const target = await readStopTarget(lockPath);
    if (target === undefined) return undefined;
    const { record } = target;
    const outcome = markDamaged(
        await forceStopHostProcess(record, options),
        target.damaged,
    );
    const clearable = outcome.endedBy !== "unverified"
        && (outcome.endedBy === "not_ours"
            || !(options.isProcessAlive ?? processIsAlive)(record.pid));
    if (clearable) {
        await removeFile(lockPath);
    }
    return outcome;
}

export async function gracefulStopResidentHost(
    options: ForceStopOptions = {},
): Promise<ForceStopOutcome | undefined> {
    const lockPath = options.lockPath ?? defaultHostLockPath();
    const target = await readStopTarget(lockPath);
    if (target === undefined) return undefined;
    const { record } = target;
    const outcome = markDamaged(
        await forceStopHostProcess(record, {
            ...options,
            escalateToKill: false,
        }),
        target.damaged,
    );
    const stillOurs = outcome.endedBy === "unverified"
        || (outcome.endedBy !== "not_ours"
            && (options.isProcessAlive ?? processIsAlive)(record.pid));
    if (!stillOurs) {
        await removeFile(lockPath);
    }
    return outcome;
}

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
    const identityNow = (): RecordIdentity =>
        options.matchesRecord === undefined
            ? checkRecordIdentity(
                record,
                options.readStartedAt,
                options.readCommand,
            )
            : options.matchesRecord(record) ? "match" : "mismatch";
    const identity = identityNow();
    if (identity === "mismatch") {
        return { pid: record.pid, endedBy: "not_ours" };
    }
    if (identity === "unknown") {
        return Number.isNaN(Date.parse(record.started_at))
            ? { pid: record.pid, endedBy: "unverified", lockStartTimeInvalid: true }
            : { pid: record.pid, endedBy: "unverified" };
    }
    kill(record.pid, "SIGTERM");
    if (await waitUntilDead(options.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS)) {
        return { pid: record.pid, endedBy: "sigterm" };
    }
    if (options.escalateToKill === false) {
        return { pid: record.pid, endedBy: "survived" };
    }
    // The host may have exited during the wait and its PID been reused.
    if (!isProcessAlive(record.pid)) {
        return { pid: record.pid, endedBy: "sigterm" };
    }
    const beforeKill = identityNow();
    if (beforeKill === "mismatch") {
        return { pid: record.pid, endedBy: "not_ours" };
    }
    if (beforeKill === "unknown") {
        return { pid: record.pid, endedBy: "unverified" };
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
