import { resolve } from "node:path";

import {
    createHostLockfile,
    HostProtocolMismatchError,
    HostUnresponsiveError,
    type HostLockDiagnosis,
    type HostLockfile,
    type HostLockRecord,
} from "./lockfile.ts";
import { forceStopHostProcess } from "./force-stop.ts";
import {
    HOST_PROTOCOL_VERSION,
    requestHostShutdownForReplacement,
    requestHostShutdownIfIdle,
    type HostIdentity,
    type ShutdownIfIdleResponse,
    type ShutdownForReplacementResponse,
} from "./protocol.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

export class HostProjectMismatchError extends Error {
    readonly pid: number;
    readonly startedAt: string;
    readonly socketPath: string;
    readonly expectedProjectRoot: string;
    readonly actualProjectRoot?: string;

    constructor(record: HostLockRecord, expectedProjectRoot: string) {
        const actual = record.project_root
            ?? "an older host with no project identity";
        super(
            `Resident host is bound to ${actual}, not ${expectedProjectRoot}. `
                + "Replace the resident host before using project-scoped extensions here.",
        );
        this.name = "HostProjectMismatchError";
        this.pid = record.pid;
        this.startedAt = record.started_at;
        this.socketPath = record.socket_path;
        this.expectedProjectRoot = expectedProjectRoot;
        this.actualProjectRoot = record.project_root;
    }
}

export interface EnsureResidentHostOptions {
    readonly startHost: () => void | Promise<void>;
    /** Project identity expected by a client attaching to the host. */
    readonly projectRoot?: string;
    readonly lockfile?: HostLockfile;
    readonly startupTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly now?: () => number;
    readonly wait?: (delayMs: number) => Promise<void>;
    readonly shutdownIfIdle?: (
        socketPath: string,
        identity: HostIdentity,
    ) => Promise<ShutdownIfIdleResponse | undefined>;
    readonly shutdownForReplacement?: (
        socketPath: string,
        identity: HostIdentity,
        requesterProtocolVersion: number,
    ) => Promise<ShutdownForReplacementResponse | undefined>;
    readonly confirmBusyUpgrade?: (
        error:
            | HostProtocolMismatchError
            | HostProjectMismatchError
            | HostUnresponsiveError,
    ) => boolean | Promise<boolean>;
    readonly terminateHost?: (pid: number) => void | Promise<void>;
    readonly terminateWedgedHost?: (
        record: HostLockRecord,
    ) => void | Promise<void>;
}

export async function ensureResidentHost(
    options: EnsureResidentHostOptions,
): Promise<HostLockRecord> {
    const startupTimeoutMs = positiveFinite(
        options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        "host startup timeout",
    );
    const pollIntervalMs = positiveFinite(
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        "host polling interval",
    );
    const lockfile = options.lockfile ?? createHostLockfile();
    const now = options.now ?? Date.now;
    const wait = options.wait ?? waitFor;
    let deadline = now() + startupTimeoutMs;
    /**
     * Runs an operation the deadline must not apply to, and pushes the deadline
     * out by however long it took. The deadline bounds how long Vera waits on
     * machines; a question put to a person is answered in human time, and
     * racing it both abandons a prompt that still owns stdin and reports the
     * timeout as a startup failure.
     */
    const withoutDeadline = async <T>(
        operation: () => Promise<T> | T,
    ): Promise<T> => {
        const startedAt = now();
        try {
            return await operation();
        } finally {
            deadline += now() - startedAt;
        }
    };
    const beforeDeadline = async <T>(
        operation: () => Promise<T> | T,
        message: string,
    ): Promise<T> => {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) throw new Error(message);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                Promise.resolve().then(operation),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error(message)), remainingMs);
                }),
            ]);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    };
    const rediscover = (): Promise<HostLockRecord> => {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) {
            return Promise.reject(new Error(
                "Resident host replacement exceeded its deadline",
            ));
        }
        return ensureResidentHost({
            ...options,
            startupTimeoutMs: remainingMs,
        });
    };
    const sameHost = (
        record: Pick<HostLockRecord, "pid" | "started_at">,
        expected: Pick<HostLockRecord, "pid" | "started_at">,
    ): boolean => record.pid === expected.pid
        && record.started_at === expected.started_at;
    const waitForHostDeparture = async (
        expected: Pick<HostLockRecord, "pid" | "started_at">,
    ): Promise<void> => {
        while (true) {
            let current: HostLockRecord | undefined;
            try {
                current = await beforeDeadline(
                    () => lockfile.read(),
                    "Resident host did not stop before its deadline",
                );
            } catch (error) {
                if (
                    !(error instanceof HostProtocolMismatchError)
                    || error.startedAt === undefined
                    || error.pid !== expected.pid
                    || error.startedAt !== expected.started_at
                ) {
                    return;
                }
            }
            if (current !== undefined) {
                if (!sameHost(current, expected)) return;
            } else if (lockfile.diagnose !== undefined) {
                try {
                    const diagnosis = await beforeDeadline(
                        () => lockfile.diagnose!(),
                        "Resident host did not stop before its deadline",
                    );
                    if (
                        diagnosis.record === undefined
                        || !sameHost(diagnosis.record, expected)
                    ) {
                        return;
                    }
                } catch (error) {
                    if (
                        !(error instanceof HostProtocolMismatchError)
                        || error.startedAt === undefined
                        || error.pid !== expected.pid
                        || error.startedAt !== expected.started_at
                    ) {
                        return;
                    }
                }
            } else {
                return;
            }
            const remainingMs = deadline - now();
            if (remainingMs <= 0) {
                throw new Error(
                    "Resident host did not stop before its deadline",
                );
            }
            await wait(Math.min(pollIntervalMs, remainingMs));
        }
    };

    const shutdownIfIdle = options.shutdownIfIdle ?? requestHostShutdownIfIdle;
    const shutdownForReplacement = options.shutdownForReplacement
        ?? requestHostShutdownForReplacement;
    let running: HostLockRecord | undefined;
    try {
        running = await lockfile.read();
    } catch (error) {
        if (
            !(error instanceof HostProtocolMismatchError)
            || error.startedAt === undefined
            || error.socketPath === undefined
            || error.actualVersion === undefined
            || error.actualVersion >= HOST_PROTOCOL_VERSION
        ) {
            throw error;
        }
        const socketPath = error.socketPath;
        const startedAt = error.startedAt;
        const identity = {
            pid: error.pid,
            started_at: startedAt,
            ...(error.actualVersion === undefined
                ? {}
                : { protocol_version: error.actualVersion }),
        };
        const replacement = await beforeDeadline(
            () => shutdownForReplacement(
                socketPath,
                identity,
                HOST_PROTOCOL_VERSION,
            ),
            "Resident host replacement exceeded its deadline",
        );
        if (
            replacement?.type === "shutdown_for_replacement_refused"
            && replacement.reason === "identity_mismatch"
        ) {
            try {
                const current = await beforeDeadline(
                    () => lockfile.read(),
                    "Resident host replacement exceeded its deadline",
                );
                if (current !== undefined) return rediscover();
            } catch (currentError) {
                if (!(currentError instanceof HostProtocolMismatchError)) {
                    throw currentError;
                }
            }
            throw error;
        }
        const response = replacement?.type
                === "shutdown_for_replacement_accepted"
            ? replacement
            : await beforeDeadline(
                () => shutdownIfIdle(socketPath, identity),
                "Resident host replacement exceeded its deadline",
            );
        if (
            response?.type !== "shutdown_if_idle_accepted"
            && response?.type !== "shutdown_for_replacement_accepted"
            || response.pid !== error.pid
            || response.started_at !== error.startedAt
        ) {
            const approved = await withoutDeadline(
                () => options.confirmBusyUpgrade?.(error) ?? false,
            );
            if (!approved) throw error;
            let sameHostStillRunning = false;
            try {
                const current = await beforeDeadline(
                    () => lockfile.read(),
                    "Resident host replacement exceeded its deadline",
                );
                if (current !== undefined) return rediscover();
            } catch (currentError) {
                if (
                    !(currentError instanceof HostProtocolMismatchError)
                    || currentError.pid !== error.pid
                    || currentError.startedAt !== error.startedAt
                ) {
                    throw currentError;
                }
                sameHostStillRunning = true;
            }
            if (sameHostStillRunning) {
                await beforeDeadline(
                    () => (options.terminateHost ?? terminateHost)(error.pid),
                    "Resident host replacement exceeded its deadline",
                );
            }
        }
        await waitForHostDeparture({
            pid: error.pid,
            started_at: error.startedAt,
        });
        return rediscover();
    }
    if (
        running !== undefined
        && options.projectRoot !== undefined
        && running.project_root !== resolve(options.projectRoot)
    ) {
        const mismatch = new HostProjectMismatchError(
            running,
            resolve(options.projectRoot),
        );
        const identity: HostIdentity = {
            pid: running.pid,
            started_at: running.started_at,
            protocol_version: HOST_PROTOCOL_VERSION,
        };
        const replacement = await beforeDeadline(
            () => shutdownForReplacement(
                running.socket_path,
                identity,
                HOST_PROTOCOL_VERSION,
            ),
            "Resident host replacement exceeded its deadline",
        );
        if (
            replacement?.type === "shutdown_for_replacement_refused"
            && replacement.reason === "identity_mismatch"
        ) {
            return rediscover();
        }
        const response = replacement?.type
                === "shutdown_for_replacement_accepted"
            ? replacement
            : await beforeDeadline(
                () => shutdownIfIdle(running.socket_path, identity),
                "Resident host replacement exceeded its deadline",
            );
        if (
            response?.type !== "shutdown_if_idle_accepted"
            && response?.type !== "shutdown_for_replacement_accepted"
            || response.pid !== running.pid
            || response.started_at !== running.started_at
        ) {
            const approved = await withoutDeadline(
                () => options.confirmBusyUpgrade?.(mismatch) ?? false,
            );
            if (!approved) throw mismatch;
            let current: HostLockRecord | undefined;
            try {
                current = await beforeDeadline(
                    () => lockfile.read(),
                    "Resident host replacement exceeded its deadline",
                );
            } catch (error) {
                if (error instanceof HostProtocolMismatchError) {
                    return rediscover();
                }
                throw error;
            }
            if (
                current === undefined
                || current.pid !== running.pid
                || current.started_at !== running.started_at
            ) {
                return rediscover();
            }
            await beforeDeadline(
                () => (options.terminateHost ?? terminateHost)(running.pid),
                "Resident host replacement exceeded its deadline",
            );
        }
        await waitForHostDeparture(running);
        return rediscover();
    }
    if (running !== undefined) {
        return running;
    }

    // A recorded host whose pid is alive but whose socket never answers is
    // wedged, not absent. Starting a fresh host over it would leave two hosts
    // fighting for one socket, so replacement is offered instead, through the
    // same confirmation seam a busy protocol upgrade uses.
    const diagnosis = await beforeDeadline<HostLockDiagnosis>(
        () => lockfile.diagnose?.() ?? {},
        "Resident host did not answer before its deadline",
    );
    if (diagnosis.wedged === true && diagnosis.record !== undefined) {
        const record = diagnosis.record;
        const unresponsive = new HostUnresponsiveError(
            record.pid,
            record.started_at,
            record.socket_path,
        );
        const approved = await withoutDeadline(
            () => options.confirmBusyUpgrade?.(unresponsive) ?? false,
        );
        if (!approved) throw unresponsive;
        await beforeDeadline(
            () => (options.terminateWedgedHost ?? terminateWedgedHost)(record),
            "Resident host replacement exceeded its deadline",
        );
    }

    await beforeDeadline(
        () => options.startHost(),
        "Resident host did not start before its deadline",
    );
    while (true) {
        const started = await beforeDeadline(
            () => lockfile.read(),
            "Resident host did not start before its deadline",
        );
        if (started !== undefined) {
            if (
                options.projectRoot !== undefined
                && started.project_root !== resolve(options.projectRoot)
            ) {
                return rediscover();
            }
            return started;
        }
        const remainingMs = deadline - now();
        if (remainingMs <= 0) {
            throw new Error("Resident host did not start before its deadline");
        }
        await wait(Math.min(pollIntervalMs, remainingMs));
    }
}

function terminateHost(pid: number): void {
    process.kill(pid, "SIGTERM");
}

async function terminateWedgedHost(record: HostLockRecord): Promise<void> {
    // Short graces: this runs inside the discovery deadline, and a wedged
    // host was already given its chance to answer.
    const outcome = await forceStopHostProcess(record, {
        sigtermGraceMs: 1_000,
        sigkillGraceMs: 1_000,
    });
    // Starting a fresh host over a live one gives two hosts racing for one
    // socket, so a kill that did not take stops the start rather than
    // being read as a clear runway.
    if (outcome.endedBy === "survived") {
        throw new Error(
            `Resident Vera host PID ${record.pid} did not stop, so a new one`
                + " was not started. It is stuck in the kernel; wait for it or"
                + " reboot.",
        );
    }
}

function waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function positiveFinite(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite number`);
    }
    return value;
}
