import { unlink } from "node:fs/promises";

import { recordMatchesRunningProcess } from "./process-identity.ts";

import {
    defaultHostLockPath,
    readHostLockRecordFile,
    type HostLockRecord,
} from "./lockfile.ts";

export interface ForceStopOutcome {
    readonly pid: number;
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
    readonly sigtermGraceMs?: number;
    readonly sigkillGraceMs?: number;
    readonly pollIntervalMs?: number;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly wait?: (delayMs: number) => Promise<void>;
    readonly matchesRecord?: (
        record: Pick<HostLockRecord, "pid" | "started_at">,
    ) => boolean;
    readonly escalateToKill?: boolean;
}

const DEFAULT_SIGTERM_GRACE_MS = 3_000;
const DEFAULT_SIGKILL_GRACE_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export async function forceStopResidentHost(
    options: ForceStopOptions = {},
): Promise<ForceStopOutcome | undefined> {
    const lockPath = options.lockPath ?? defaultHostLockPath();
    const record = await readHostLockRecordFile(lockPath);
    if (record === undefined) return undefined;
    const outcome = await forceStopHostProcess(record, options);
    const clearable = outcome.endedBy === "not_ours"
        || !(options.isProcessAlive ?? processIsAlive)(record.pid);
    if (clearable) {
        await removeFile(lockPath);
    }
    return outcome;
}

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
