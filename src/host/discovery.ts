import {
    createHostLockfile,
    HostProtocolMismatchError,
    type HostLockfile,
    type HostLockRecord,
} from "./lockfile.ts";
import {
    HOST_PROTOCOL_VERSION,
    requestHostShutdownIfIdle,
    type HostIdentity,
    type ShutdownIfIdleResponse,
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

    const shutdownIfIdle = options.shutdownIfIdle ?? requestHostShutdownIfIdle;
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
        const response = await shutdownIfIdle(error.socketPath, {
            pid: error.pid,
            started_at: error.startedAt,
            ...(error.actualVersion === undefined
                ? {}
                : { protocol_version: error.actualVersion }),
        });
        if (
            response?.type !== "shutdown_if_idle_accepted"
            || response.pid !== error.pid
            || response.started_at !== error.startedAt
        ) {
            const approved = await options.confirmBusyUpgrade?.(error) ?? false;
            if (!approved) throw error;
            await (options.terminateHost ?? terminateHost)(error.pid);
        }
        const shutdownDeadline = now() + startupTimeoutMs;
        while (true) {
            try {
                const replacement = await lockfile.read();
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
            const remainingMs = shutdownDeadline - now();
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

    await options.startHost();
    const deadline = now() + startupTimeoutMs;
    while (true) {
        const started = await lockfile.read();
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
