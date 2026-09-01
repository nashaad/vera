import { spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
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
    veraRuntimeDirectory,
} from "../../src/profile-paths.ts";
import { dispatchToHostRelease } from "../../src/release/dispatch.ts";
import {
    RELEASE_HOST_NAME,
    releaseBinaryPath,
} from "../../src/release/layout.ts";

export type FindOrStartHostOptions = Omit<
    EnsureResidentHostOptions,
    "startHost"
>;

export async function findOrStartResidentHost(
    options: FindOrStartHostOptions = {},
): Promise<HostLockRecord> {
    const lockfile = options.lockfile ?? createHostLockfile();
    const dispatched = await dispatchToHostRelease({
        inspectHost: async () => (await lockfile.read())?.build_id,
    });
    if (dispatched !== undefined) {
        process.exit(dispatched);
    }
    return ensureResidentHost({
        ...options,
        lockfile,
        startHost: spawnDetachedResidentHost,
    });
}

export function residentHostEntrypoint(): string {
    return fileURLToPath(new URL("./main.ts", import.meta.url));
}

export function residentHostSpawnSpec(
    releaseRoot?: string,
): { readonly command: string; readonly args: readonly string[] } {
    const packed = releaseRoot === undefined
        ? releaseBinaryPath(RELEASE_HOST_NAME)
        : releaseBinaryPath(RELEASE_HOST_NAME, releaseRoot);
    if (existsSync(packed)) {
        return { command: packed, args: [] };
    }
    return { command: process.execPath, args: [residentHostEntrypoint()] };
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

/** How recently and how often a spawned host may die before spawning stops. A host that exits during boot would otherwise be respawned by every retry and every next `vera`. */
const BOOT_FAILURE_WINDOW_MS = 30_000;
const BOOT_FAILURE_LIMIT = 2;

export const HOST_STARTUP_RACE_EXIT_CODE = 75;

export class HostBootLoopError extends Error {
    constructor(count: number) {
        super(
            `The resident host exited during startup ${count} times in a row;`
                + " not respawning it. Fix the host build, then retry."
                + " Run 'vera host stop --force' after you fix the build.",
        );
        this.name = "HostBootLoopError";
    }
}

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

export function clearBootFailures(): void {
    try {
        unlinkSync(bootFailuresPath());
    } catch {
    }
}

function spawnDetachedResidentHost(): Promise<void> {
    const failures = recentBootFailures(Date.now());
    if (failures.length >= BOOT_FAILURE_LIMIT) {
        return Promise.reject(new HostBootLoopError(failures.length));
    }
    const spawnedAt = Date.now();
    const spec = residentHostSpawnSpec();
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
