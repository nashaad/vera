import { spawn } from "node:child_process";
import {
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ensureResidentHost,
    type EnsureResidentHostOptions,
} from "../../src/host/discovery.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";
import { veraRuntimeDirectory } from "../../src/profile-paths.ts";

export type FindOrStartHostOptions = Omit<
    EnsureResidentHostOptions,
    "startHost"
>;

export function findOrStartResidentHost(
    options: FindOrStartHostOptions = {},
): Promise<HostLockRecord> {
    return ensureResidentHost({
        ...options,
        startHost: spawnDetachedResidentHost,
    });
}

/**
 * The host entrypoint this checkout would spawn. Comparing it against the
 * `entrypoint` a running host stamped into `host.json` is how a client
 * notices it attached to a host started from a different checkout.
 */
export function residentHostEntrypoint(): string {
    return fileURLToPath(new URL("./main.ts", import.meta.url));
}

/**
 * The warning a client shows when it attached to a host started from another
 * checkout. Undefined when the paths match or the record predates the stamp:
 * an unknown entrypoint is not evidence of a mismatch.
 */
export function hostEntrypointMismatchNotice(
    record: HostLockRecord,
    expected = residentHostEntrypoint(),
): string | undefined {
    if (record.entrypoint === undefined || record.entrypoint === expected) {
        return undefined;
    }
    return `attached to a resident host running ${record.entrypoint}; `
        + `this checkout would start ${expected}. `
        + "Stop the host to pick up this checkout's code.";
}

/**
 * How recently and how often a spawned host may die before spawning stops.
 * A host that exits during boot would otherwise be respawned by every retry
 * and every next `vera`, forever; two fast deaths mean the build is broken
 * and the fix is a human, not another attempt.
 */
const BOOT_FAILURE_WINDOW_MS = 30_000;
const BOOT_FAILURE_LIMIT = 2;

/**
 * What a spawned host exits with when another host won the startup claim.
 * Nothing is broken in that case, so it is the one non-zero exit the backoff
 * does not count.
 */
export const HOST_STARTUP_RACE_EXIT_CODE = 75;

export class HostBootLoopError extends Error {
    constructor(count: number) {
        super(
            `The resident host exited during startup ${count} times in a row;`
                + " not respawning it. Fix the host build, then retry."
                + " 'vera rescue' gives a working Vera in the meantime.",
        );
        this.name = "HostBootLoopError";
    }
}

/**
 * Whether a spawned host's exit is evidence the build cannot start. A clean
 * exit is not, a lost startup race is not (another host is now serving), and
 * neither is a death long after boot, which is a host that ran and then fell
 * over rather than one that never came up.
 */
export function countsAsBootFailure(
    code: number | null,
    elapsedMs: number,
): boolean {
    if (code === 0 || code === HOST_STARTUP_RACE_EXIT_CODE) return false;
    return elapsedMs <= BOOT_FAILURE_WINDOW_MS;
}

function bootFailuresPath(): string {
    return join(veraRuntimeDirectory(), "host-boot-failures.json");
}

export function recentBootFailures(nowMs: number): number[] {
    let timestamps: unknown;
    try {
        timestamps = JSON.parse(readFileSync(bootFailuresPath(), "utf8"));
    } catch {
        return [];
    }
    if (!Array.isArray(timestamps)) return [];
    return timestamps.filter((value): value is number =>
        typeof value === "number" && nowMs - value <= BOOT_FAILURE_WINDOW_MS
    );
}

function recordBootFailure(nowMs: number): void {
    try {
        const path = bootFailuresPath();
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        // Two clients can each be recording a death at once, so the file is
        // swapped in whole rather than truncated and rewritten in place.
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(
            temporary,
            `${JSON.stringify([...recentBootFailures(nowMs), nowMs])}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        renameSync(temporary, path);
    } catch {
        // Failure accounting must not become a new way for launch to fail.
    }
}

/** A host that booted cleanly resets the count; the next crash starts fresh. */
export function clearBootFailures(): void {
    try {
        unlinkSync(bootFailuresPath());
    } catch {
        // Nothing recorded is the state this wants.
    }
}

function spawnDetachedResidentHost(): Promise<void> {
    const failures = recentBootFailures(Date.now());
    if (failures.length >= BOOT_FAILURE_LIMIT) {
        return Promise.reject(new HostBootLoopError(failures.length));
    }
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [residentHostEntrypoint()], {
        detached: true,
        stdio: "ignore",
    });
    // Fires only while this client is still alive, which is exactly the case
    // that retries: a death within the window is a boot that never came up.
    child.once("exit", (code) => {
        if (countsAsBootFailure(code, Date.now() - spawnedAt)) {
            recordBootFailure(Date.now());
        }
    });

    return new Promise((resolve, reject) => {
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}
