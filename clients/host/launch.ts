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

function spawnDetachedResidentHost(): Promise<void> {
    const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
    const child = spawn(process.execPath, [entrypoint], {
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
