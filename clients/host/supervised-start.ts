import { HostSocketHeldError } from "../../src/host/server.ts";
import { HostStartupInProgressError } from "../../src/host/startup-claim.ts";
import { SUPERVISED_HOST_ENV } from "../../src/host/supervision.ts";

const RETRY_INTERVAL_MS = 5_000;

export function isSupervisedHost(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[SUPERVISED_HOST_ENV] !== undefined;
}

export function anotherHostIsServing(error: unknown): boolean {
    return error instanceof HostStartupInProgressError
        || error instanceof HostSocketHeldError;
}

export interface WaitOutRivalsOptions {
    readonly intervalMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onWait?: (error: Error) => void;
    readonly maxAttempts?: number;
}

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
