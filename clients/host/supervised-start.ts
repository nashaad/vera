import { HostSocketHeldError } from "../../src/host/server.ts";
import { HostStartupInProgressError } from "../../src/host/startup-claim.ts";
import { SUPERVISED_HOST_ENV } from "../../src/host/supervision.ts";

/** How long a supervised host waits before looking for the rival again. */
const RETRY_INTERVAL_MS = 5_000;

export function isSupervisedHost(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[SUPERVISED_HOST_ENV] !== undefined;
}

/** Whether a start failed because another host is already serving. */
export function anotherHostIsServing(error: unknown): boolean {
    return error instanceof HostStartupInProgressError
        || error instanceof HostSocketHeldError;
}

export interface WaitOutRivalsOptions {
    readonly intervalMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onWait?: (error: Error) => void;
    /** Bounds the wait in tests; unset means wait as long as the rival lives. */
    readonly maxAttempts?: number;
}

/**
 * Starts the host, and when another host is already serving, waits for it to
 * go away instead of exiting. A launchd-supervised host that exited here
 * would be started again into the same race for as long as the rival lives,
 * so waiting is what keeps supervision from becoming a restart loop. Every
 * other failure is thrown, because it is the build, not a rival.
 */
export async function startWaitingOutRivals<T>(
    start: () => Promise<T>,
    options: WaitOutRivalsOptions = {},
): Promise<T> {
    const intervalMs = options.intervalMs ?? RETRY_INTERVAL_MS;
    const sleep = options.sleep
        ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1;; attempt += 1) {
        try {
            return await start();
        } catch (error) {
            if (!anotherHostIsServing(error)) throw error;
            if (
                options.maxAttempts !== undefined
                && attempt >= options.maxAttempts
            ) {
                throw error;
            }
            options.onWait?.(error as Error);
            await sleep(intervalMs);
        }
    }
}
