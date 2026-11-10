import { HostLockUnreadableError } from "../../src/host/lockfile.ts";
import { HostSocketHeldError } from "../../src/host/server.ts";
import { HostStartupInProgressError } from "../../src/host/startup-claim.ts";
import { SUPERVISED_HOST_ENV } from "../../src/host/supervision.ts";

const RETRY_INTERVAL_MS = 5_000;
// Each retry is a full start that writes to the host log, so a lockfile that
// waits on a person is retried less often.
const LOCK_RETRY_INTERVAL_MS = 30_000;

export function isSupervisedHost(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[SUPERVISED_HOST_ENV] !== undefined;
}

export function anotherHostIsServing(error: unknown): error is HostStartupInProgressError | HostSocketHeldError {
    return error instanceof HostStartupInProgressError
        || error instanceof HostSocketHeldError;
}

export interface WaitOutRivalsOptions {
    readonly intervalMs?: number;
    readonly lockIntervalMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onWait?: (error: Error) => void;
    readonly maxAttempts?: number;
}

export async function startWaitingOutRivals<T>(
    start: () => Promise<T>,
    options: WaitOutRivalsOptions = {},
): Promise<T> {
    const intervalMs = options.intervalMs ?? RETRY_INTERVAL_MS;
    const lockIntervalMs = options.lockIntervalMs ?? LOCK_RETRY_INTERVAL_MS;
    const sleep = options.sleep
        ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let lockReported = false;
    for (let attempt = 1;; attempt += 1) {
        try {
            return await start();
        } catch (error) {
            // A damaged lockfile is waited out too: exiting would have launchd
            // restart this host every throttle interval until the file is fixed.
            const lockUnreadable = error instanceof HostLockUnreadableError;
            if (!lockUnreadable && !anotherHostIsServing(error)) throw error;
            if (
                options.maxAttempts !== undefined
                && attempt >= options.maxAttempts
            ) {
                throw error;
            }
            // The same lockfile message every retry would flood the log.
            if (!lockUnreadable || !lockReported) {
                options.onWait?.(error as Error);
            }
            lockReported = lockUnreadable;
            await sleep(lockUnreadable ? lockIntervalMs : intervalMs);
        }
    }
}
