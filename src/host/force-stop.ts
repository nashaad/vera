import { unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { selectedVeraHome } from "../profile-paths.ts";
import { listLiveProcessesIn } from "../live-process.ts";
import { assertRecordedWorkersStopped, readRecordedWorkers, removeStoppedPoolLock } from "./pool/worker-records.ts";
import type { HostStartupClaim } from "./startup-claim.ts";
import { acquireStopStartupClaim } from "./stop-claim.ts";
import { removeSocketFile, removeUnusedSocketFile, socketFileIdentity, type SocketFileIdentity } from "./socket-file.ts";

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
    type HostLockInspection,
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
        | "unsupported"
        | "timed_out";
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
    // Cut the waited sessions at once. Without an answer, a refusal from an older build, or a stop
    // not reported within cutDeadlineMs, the caller falls back to a signal.
    readonly force?: boolean;
    readonly cutDeadlineMs?: number;
}

const DEFAULT_STOPPED_GRACE_MS = 5_000;
export const DEFAULT_CUT_DEADLINE_MS = 10_000;

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
    readonly home?: string;
    readonly startupClaim?: HostStartupClaim;
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
    readonly firstSignal?: "SIGTERM" | "SIGKILL";
}

export const DEFAULT_SIGTERM_GRACE_MS = 3_000;
const DEFAULT_SIGKILL_GRACE_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

interface StopTarget {
    readonly record: Pick<HostLockRecord, "pid" | "started_at">;
    readonly damaged: boolean;
    readonly socketPath?: string;
}

// A damaged lock has no trusted start time: a Vera-looking live PID stays
// unverified, and only a dead or non-Vera PID lets the lock be cleared.
// Throws HostLockUnreadableError when no PID can be read from it.
async function readStopTarget(
    lockPath: string,
    options: ForceStopOptions,
): Promise<StopTarget | undefined> {
    const inspection = await inspectHostForStop(lockPath, stopHome(options, lockPath), options.startupClaim);
    if (inspection.state === "absent") return undefined;
    if (inspection.state === "valid") {
        return { record: inspection.record, damaged: false, socketPath: inspection.record.socket_path };
    }
    if (inspection.pid === undefined) {
        throw new HostLockUnreadableError(lockPath);
    }
    return { record: { pid: inspection.pid, started_at: "" }, damaged: true };
}

function stopHome(options: ForceStopOptions, lockPath: string): string {
    if (options.home !== undefined) return options.home;
    if (options.lockPath !== undefined && basename(dirname(lockPath)) === "runtime") return dirname(dirname(lockPath));
    return selectedVeraHome();
}

async function withStopClaim<T>(
    lockPath: string, run: (claim: HostStartupClaim) => Promise<T>, socketPath?: string,
): Promise<T> {
    const path = socketPath === undefined ? join(dirname(lockPath), "host.sock.starting") : `${socketPath}.starting`;
    const claim = await acquireStopStartupClaim(path);
    try { return await run(claim); }
    finally { await claim.release(); }
}

async function clearExitedHost(
    home: string,
    lockPath: string,
    record: HostLockRecord,
    socket: SocketFileIdentity | undefined,
    claim?: HostStartupClaim,
): Promise<void> {
    const clear = async (): Promise<void> => {
        await assertRecordedWorkersStopped(home);
        const current = await inspectHostLockFile(lockPath);
        if (current.state === "absent") {
            await removeSocketFile(record.socket_path, socket);
        } else if (current.state === "valid"
            && current.record.pid === record.pid && current.record.started_at === record.started_at) {
            await removeSocketFile(record.socket_path, socket);
            await removeStoppedPoolLock(home, lockPath, record);
        }
        listLiveProcessesIn(home);
    };
    if (claim === undefined) await withStopClaim(lockPath, clear);
    else await clear();
}

async function inspectHostForStop(
    lockPath: string, home: string, ownedClaim?: HostStartupClaim,
): Promise<HostLockInspection> {
    const initial = await inspectHostLockFile(lockPath);
    if (initial.state !== "absent") return initial;
    const inspect = async (): Promise<HostLockInspection> => {
        const inspection = await inspectHostLockFile(lockPath);
        await readRecordedWorkers(home);
        if (inspection.state === "absent") await assertRecordedWorkersStopped(home);
        return inspection;
    };
    return ownedClaim === undefined ? await withStopClaim(lockPath, inspect) : await inspect();
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
    const target = await readStopTarget(lockPath, options);
    if (target === undefined) {
        listLiveProcessesIn(stopHome(options, lockPath));
        return undefined;
    }
    const { record } = target;
    const socket = target.socketPath === undefined ? undefined : await socketFileIdentity(target.socketPath);
    const outcome = markDamaged(
        await forceStopHostProcess(record, options),
        target.damaged,
    );
    if (options.startupClaim === undefined && (outcome.endedBy === "already_dead" || outcome.endedBy === "not_ours")) {
        return await withStopClaim(lockPath, (startupClaim) => forceStopResidentHost({ ...options, lockPath, startupClaim }));
    }
    const clearable = outcome.endedBy !== "unverified"
        && (outcome.endedBy === "not_ours"
            || !(options.isProcessAlive ?? processIsAlive)(record.pid));
    if (clearable) {
        const clear = async (): Promise<void> => {
            const home = stopHome(options, lockPath);
            await assertRecordedWorkersStopped(home);
            const current = await inspectHostLockFile(lockPath);
            if (target.damaged) {
                if (current.state === "damaged" && current.pid === record.pid) await removeFile(lockPath);
            } else if (current.state === "valid"
                && current.record.pid === record.pid && current.record.started_at === record.started_at) {
                if ((outcome.endedBy === "sigterm" || outcome.endedBy === "sigkill") && target.socketPath !== undefined) {
                    await removeSocketFile(target.socketPath, socket);
                } else if (target.socketPath !== undefined) {
                    await removeUnusedSocketFile(target.socketPath, socket);
                }
                await removeStoppedPoolLock(home, lockPath, record);
            }
            listLiveProcessesIn(home);
        };
        if (options.startupClaim === undefined) await withStopClaim(lockPath, clear);
        else await clear();
    }
    return outcome;
}

export async function gracefulStopResidentHost(
    options: ForceStopOptions = {},
): Promise<ForceStopOutcome | undefined> {
    return await forceStopResidentHost({ ...options, escalateToKill: false });
}

// Asks a live, verified host to stop once its turns end. A plain stop falls
// back to the graceful path. An update never does: an unverified or silent
// host is left running and reported, because a signal would stop it without
// moving current.
export async function stopResidentHostWhenIdle(
    options: StopWhenIdleOptions = {},
): Promise<StopWhenIdleOutcome | undefined> {
    const lockPath = options.lockPath ?? defaultHostLockPath();
    const home = stopHome(options, lockPath);
    const inspection = await inspectHostForStop(lockPath, home, options.startupClaim);
    if (options.force === true && options.targetBuildId === undefined) {
        return cutResidentHostForStop({ ...options, lockPath }, inspection);
    }
    const isAlive = options.isProcessAlive ?? processIsAlive;
    const isUpdate = options.targetBuildId !== undefined;
    if (inspection.state !== "valid") {
        if (!isUpdate) {
            if (inspection.state === "absent") {
                listLiveProcessesIn(home);
                return undefined;
            }
            await assertRecordedWorkersStopped(home);
            return gracefulStopResidentHost({ ...options, lockPath });
        }
        if (inspection.state === "absent") return undefined;
        return {
            pid: inspection.pid,
            endedBy: "refused",
            refusal: "identity_mismatch",
            message: "Could not confirm the running Vera host from its lockfile, so it was left running and current was not moved.",
        };
    }
    const record = inspection.record;
    const pool = record.role === "host" && record.worker_count !== undefined;
    if (pool && !isUpdate && options.startupClaim === undefined) {
        return await withStopClaim(lockPath, (startupClaim) => stopResidentHostWhenIdle({ ...options, lockPath, startupClaim }), record.socket_path);
    }
    const identity = options.matchesRecord === undefined
        ? checkRecordIdentity(record, options.readStartedAt, options.readCommand)
        : options.matchesRecord(record) ? "match" : "mismatch";
    if (identity !== "match" || !isAlive(record.pid)) {
        if (options.startupClaim === undefined) {
            return await withStopClaim(lockPath, (startupClaim) => stopResidentHostWhenIdle({ ...options, lockPath, startupClaim }));
        }
        await assertRecordedWorkersStopped(home);
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
    const socket = isUpdate ? undefined : await socketFileIdentity(record.socket_path);
    const result = await requestStop(
        record.socket_path,
        record,
        (waiting) => {
            if (!pool || waiting.length > 0) options.onWaiting?.(waiting);
        },
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
    await clearExitedHost(home, lockPath, record, socket, options.startupClaim);
    if (pool) {
        const remaining = await inspectHostLockFile(lockPath);
        if (remaining.state !== "absent") {
            throw new HostLockUnreadableError(lockPath, remaining.state === "valid" ? remaining.record.pid : remaining.pid);
        }
    }
    return { pid: record.pid, endedBy: "stopped" };
}

// Never signals. Every case that cannot be answered returns no_answer, so the caller's signal
// path does its own identity checks.
async function cutResidentHostForStop(
    options: StopWhenIdleOptions & { readonly lockPath: string },
    inspection: HostLockInspection,
): Promise<StopWhenIdleOutcome | undefined> {
    if (inspection.state === "absent") {
        listLiveProcessesIn(stopHome(options, options.lockPath));
        return undefined;
    }
    if (inspection.state !== "valid") {
        if (options.startupClaim === undefined) {
            return await withStopClaim(options.lockPath, async (startupClaim) => cutResidentHostForStop(
                { ...options, startupClaim },
                await inspectHostForStop(options.lockPath, stopHome(options, options.lockPath), startupClaim),
            ));
        }
        await readRecordedWorkers(stopHome(options, options.lockPath));
        return inspection.pid === undefined
            ? { endedBy: "no_answer" }
            : { pid: inspection.pid, endedBy: "no_answer" };
    }
    const record = inspection.record;
    const isAlive = options.isProcessAlive ?? processIsAlive;
    const identity = options.matchesRecord === undefined
        ? checkRecordIdentity(record, options.readStartedAt, options.readCommand)
        : options.matchesRecord(record) ? "match" : "mismatch";
    if (identity !== "match" || !isAlive(record.pid)) {
        if (options.startupClaim === undefined) {
            return await withStopClaim(options.lockPath, async (startupClaim) => cutResidentHostForStop(
                { ...options, startupClaim },
                await inspectHostForStop(options.lockPath, stopHome(options, options.lockPath), startupClaim),
            ));
        }
        await readRecordedWorkers(stopHome(options, options.lockPath));
        return { pid: record.pid, endedBy: "no_answer" };
    }
    const requestStop = options.requestStop ?? requestHostStop;
    const socket = await socketFileIdentity(record.socket_path);
    const result = await requestStop(
        record.socket_path,
        record,
        options.onWaiting ?? (() => undefined),
        {
            force: true,
            deadlineMs: options.cutDeadlineMs ?? DEFAULT_CUT_DEADLINE_MS,
        },
    );
    if (result.type === "no_answer") return { pid: record.pid, endedBy: "no_answer" };
    if (result.type === "timed_out") return { pid: record.pid, endedBy: "timed_out" };
    if (result.type === "unsupported") return { pid: record.pid, endedBy: "unsupported" };
    if (result.type === "abandoned") {
        return { pid: record.pid, endedBy: "abandoned", message: result.message };
    }
    if (result.type === "refused") {
        return result.reason === "unavailable"
            ? { pid: record.pid, endedBy: "unsupported" }
            : { pid: record.pid, endedBy: "refused", refusal: result.reason, message: result.message };
    }
    if (result.type === "accepted") return { pid: record.pid, endedBy: "accepted" };
    const wait = options.wait ?? waitFor;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + (options.stoppedGraceMs ?? DEFAULT_STOPPED_GRACE_MS);
    while (isAlive(record.pid)) {
        if (Date.now() >= deadline) return { pid: record.pid, endedBy: "still_running" };
        await wait(pollIntervalMs);
    }
    await clearExitedHost(stopHome(options, options.lockPath), options.lockPath, record, socket, options.startupClaim);
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
    const firstSignal = options.firstSignal ?? "SIGTERM";
    kill(record.pid, firstSignal);
    if (firstSignal === "SIGKILL") {
        const dead = await waitUntilDead(options.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS);
        return { pid: record.pid, endedBy: dead ? "sigkill" : "survived" };
    }
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
