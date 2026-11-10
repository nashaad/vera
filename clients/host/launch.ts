import { BOOT_FAILURE_LIMIT, countsAsBootFailure, HostBootLoopError, recentBootFailures, recordBootFailure } from "./boot-failures.ts";

export { clearBootFailures, countsAsBootFailure, HostBootLoopError, recentBootFailures, HOST_STARTUP_RACE_EXIT_CODE } from "./boot-failures.ts";

import { spawn } from "node:child_process";
import {
    existsSync,
    statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ensureResidentHost,
    type EnsureResidentHostOptions,
} from "../../src/host/discovery.ts";
import {
    createHostLockfile,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import {
    VERA_HOME_ENV,
    selectedVeraHome,
} from "../../src/profile-paths.ts";
import { dispatchToHostRelease } from "../../src/release/dispatch.ts";
import {
    childReleaseRoot,
    RELEASE_HOST_NAME,
    releaseBinaryPath,
} from "../../src/release/layout.ts";

export { sessionWorkerSpawnSpec } from "../../src/host/pool/worker-launch.ts";

export type FindOrStartHostOptions = Omit<
    EnsureResidentHostOptions,
    "startHost"
>;

const pooledHomes = new Set<string>();

export async function findOrStartResidentHost(
    options: FindOrStartHostOptions = {},
): Promise<HostLockRecord> {
    const home = selectedVeraHome();
    const baseLockfile = options.lockfile ?? createHostLockfile();
    let pool = pooledHomes.has(home);
    const remember = (record: HostLockRecord | undefined): void => {
        if (record === undefined) return;
        pool = record.worker_count !== undefined;
        if (pool) pooledHomes.add(home);
        else pooledHomes.delete(home);
    };
    const lockfile = {
        publish: () => baseLockfile.publish(),
        read: async () => {
            const record = await baseLockfile.read();
            remember(record);
            return record;
        },
        ...(baseLockfile.diagnose === undefined ? {} : {
            diagnose: async () => {
                const diagnosis = await baseLockfile.diagnose!();
                remember(diagnosis.record);
                return diagnosis;
            },
        }),
    };
    const dispatched = await dispatchToHostRelease({
        inspectHost: async () => (await lockfile.read())?.build_id,
    });
    if (dispatched !== undefined) {
        process.exit(dispatched);
    }
    const host = await ensureResidentHost({
        ...options,
        lockfile,
        startHost: () => spawnDetachedResidentHost(pool),
    });
    remember(host);
    return host;
}

export function residentHostEntrypoint(): string {
    return fileURLToPath(new URL("./main.ts", import.meta.url));
}

export function residentHostSpawnSpec(
    releaseRoot: string | undefined = childReleaseRoot(),
    pool = false,
): { readonly command: string; readonly args: readonly string[] } {
    if (releaseRoot !== undefined) {
        const packed = releaseBinaryPath(RELEASE_HOST_NAME, releaseRoot);
        if (existsSync(packed)) {
            return { command: packed, args: pool ? ["--pool"] : [] };
        }
    }
    return { command: process.execPath, args: [residentHostEntrypoint(), ...(pool ? ["--pool"] : [])] };
}

export function worktreeRuntimeNotice(
    cwd: string = process.cwd(),
    environment: Record<string, string | undefined> = process.env,
): string | undefined {
    const chosen = (environment[VERA_HOME_ENV] ?? "").trim().length > 0;
    if (chosen || !insideLinkedWorktree(cwd)) return undefined;
    return "started inside a Git worktree with no instance of its own, so this"
        + " session is attached to the daily host and does not run"
        + " this worktree's code. Quit and start it with"
        + " 'bun run dev:tui'.";
}

function insideLinkedWorktree(cwd: string): boolean {
    let directory = resolve(cwd);
    for (;;) {
        const marker = statSync(join(directory, ".git"), {
            throwIfNoEntry: false,
        });
        if (marker !== undefined) return marker.isFile();
        const parent = dirname(directory);
        if (parent === directory) return false;
        directory = parent;
    }
}

function spawnDetachedResidentHost(pool = false): Promise<void> {
    const failures = recentBootFailures(Date.now());
    if (failures.length >= BOOT_FAILURE_LIMIT) {
        return Promise.reject(new HostBootLoopError(failures.length));
    }
    const spawnedAt = Date.now();
    const spec = residentHostSpawnSpec(undefined, pool);
    const child = spawn(spec.command, [...spec.args], {
        argv0: "vera-host",
        detached: true,
        stdio: "ignore",
    });
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
