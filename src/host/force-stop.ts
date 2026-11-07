import { unlink } from "node:fs/promises";

import {
    checkRecordIdentity,
    processIsAlive,
    type RecordIdentity,
} from "./process-identity.ts";
import {
    requestHostStop,
    type HostStopOptions,
    type HostStopResult,
} from "./protocol.ts";
import type { StopRefusalReason, StopWaitTarget } from "./stop-when-idle.ts";

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

// The host answers a stop request by waiting for its turns; it never gets a signal here.
export interface WaitStopOutcome {
    readonly pid?: number;
    readonly endedBy:
        | "stopped"
        | "accepted"
        | "still_running"
        | "no_answer"
        | "refused"
        | "abandoned"
        | "unsupported";
    readonly refusal?: StopRefusalReason;
    readonly message?: string;
}

export type StopWhenIdleOutcome = WaitStopOutcome | ForceStopOutcome;

export interface StopWhenIdleOptions extends ForceStopOptions {
    readonly onWaiting?: (waiting: readonly StopWaitTarget[]) => void;
    readonly requestStop?: (
        socketPath: string,
        identity: Pick<HostLockRecord, "pid" | "started_at">,
        onWaiting: (waiting: readonly StopWaitTarget[]) => void,
        options: HostStopOptions,
    ) => Promise<HostStopResult>;
    readonly stoppedGraceMs?: number;
    // Set for an update: the host moves to this build once it stops. An update
    // never signals the host, and never waits for it to exit.
    readonly targetBuildId?: string;
    // Resolve at the first answer instead of waiting for the stop to finish.
    readonly detach?: boolean;
}

const DEFAULT_STOPPED_GRACE_MS = 5_000;

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

// Asks a live, verified host to stop once its turns end. A plain stop falls
// back to the graceful path. An update never does: an unverified or silent
// host is left running and reported, because a signal would stop it without
// moving current.
export async function stopResidentHostWhenIdle(
    options: StopWhenIdleOptions = {},
): Promise<StopWhenIdleOutcome | undefined> {
    const lockPath = options.lockPath ?? defaultHostLockPath();
    const inspection = await inspectHostLockFile(lockPath);
    const isAlive = options.isProcessAlive ?? processIsAlive;
    const isUpdate = options.targetBuildId !== undefined;
    if (inspection.state !== "valid") {
        if (!isUpdate) return gracefulStopResidentHost({ ...options, lockPath });
        if (inspection.state === "absent") return undefined;
        return {
            pid: inspection.pid,
            endedBy: "refused",
            refusal: "identity_mismatch",
            message: "Could not confirm the running Vera host from its lockfile, so it was left running and current was not moved.",
        };
    }
    const record = inspection.record;
    const identity = options.matchesRecord === undefined
        ? checkRecordIdentity(record, options.readStartedAt, options.readCommand)
        : options.matchesRecord(record) ? "match" : "mismatch";
    if (identity !== "match" || !isAlive(record.pid)) {
        if (!isUpdate) return gracefulStopResidentHost({ ...options, lockPath });
        if (identity === "match") return undefined;
        return {
            pid: record.pid,
            endedBy: "refused",
            refusal: "identity_mismatch",
            message: `Could not confirm PID ${record.pid} is the Vera host, so it was left running and current was not moved.`,
        };
    }
    const requestStop = options.requestStop ?? requestHostStop;
    const result = await requestStop(
        record.socket_path,
        record,
        options.onWaiting ?? (() => undefined),
        { targetBuildId: options.targetBuildId, detach: options.detach === true },
    );
    if (result.type === "no_answer") return { pid: record.pid, endedBy: "no_answer" };
    if (result.type === "unsupported") return { pid: record.pid, endedBy: "unsupported" };
    if (result.type === "accepted") return { pid: record.pid, endedBy: "accepted" };
    if (result.type === "abandoned") {
        return { pid: record.pid, endedBy: "abandoned", message: result.message };
    }
    if (result.type === "refused") {
        return { pid: record.pid, endedBy: "refused", refusal: result.reason, message: result.message };
    }
    if (isUpdate) return { pid: record.pid, endedBy: "stopped" };
    const wait = options.wait ?? waitFor;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + (options.stoppedGraceMs ?? DEFAULT_STOPPED_GRACE_MS);
    while (isAlive(record.pid)) {
        if (Date.now() >= deadline) return { pid: record.pid, endedBy: "still_running" };
        await wait(pollIntervalMs);
    }
    return { pid: record.pid, endedBy: "stopped" };
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

export function defaultKill(pid: number, signal: NodeJS.Signals): void {
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
