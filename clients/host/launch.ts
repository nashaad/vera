import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
    ensureResidentHost,
    type EnsureResidentHostOptions,
} from "../../src/host/discovery.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";

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

function spawnDetachedResidentHost(): Promise<void> {
    const child = spawn(process.execPath, [residentHostEntrypoint()], {
        detached: true,
        stdio: "ignore",
    });

    return new Promise((resolve, reject) => {
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}
