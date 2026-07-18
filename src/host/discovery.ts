import {
    createHostLockfile,
    type HostLockfile,
    type HostLockRecord,
} from "./lockfile.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

export interface EnsureResidentHostOptions {
    readonly startHost: () => void | Promise<void>;
    readonly lockfile?: HostLockfile;
    readonly startupTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly now?: () => number;
    readonly wait?: (delayMs: number) => Promise<void>;
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

    const running = await lockfile.read();
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

function waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function positiveFinite(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite number`);
    }
    return value;
}
