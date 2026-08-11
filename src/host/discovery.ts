import {
    createHostLockfile,
    HostProtocolMismatchError,
    type HostLockfile,
    type HostLockRecord,
} from "./lockfile.ts";
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

export interface EnsureResidentHostOptions {
    readonly startHost: () => void | Promise<void>;
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
        error: HostProtocolMismatchError,
    ) => boolean | Promise<boolean>;
    readonly terminateHost?: (pid: number) => void | Promise<void>;
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
    const deadline = now() + startupTimeoutMs;
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
                if (current !== undefined) return current;
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
            const approved = await beforeDeadline(
                () => options.confirmBusyUpgrade?.(error) ?? false,
                "Resident host replacement exceeded its deadline",
            );
            if (!approved) throw error;
            let sameHostStillRunning = false;
            try {
                const current = await beforeDeadline(
                    () => lockfile.read(),
                    "Resident host replacement exceeded its deadline",
                );
                if (current !== undefined) return current;
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
        while (true) {
            try {
                const replacement = await beforeDeadline(
                    () => lockfile.read(),
                    "Resident host did not stop before its deadline",
                );
                if (replacement === undefined) {
                    break;
                }
                return replacement;
            } catch (nextError) {
                if (
                    !(nextError instanceof HostProtocolMismatchError)
                    || nextError.pid !== error.pid
                    || nextError.startedAt !== error.startedAt
                ) {
                    throw nextError;
                }
            }
            const remainingMs = deadline - now();
            if (remainingMs <= 0) {
                throw new Error(
                    "Resident host did not stop before its deadline",
                );
            }
            await wait(Math.min(pollIntervalMs, remainingMs));
        }
    }
    if (running !== undefined) {
        return running;
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

function waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function positiveFinite(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite number`);
    }
    return value;
}
