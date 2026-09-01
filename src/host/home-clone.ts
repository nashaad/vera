import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { checkpointOpenStores } from "./store-checkpoint.ts";

const LIVE_RUNTIME_NAMES = ["host.sock", "host.json"] as const;

export interface CloneVeraHomeOptions {
    readonly sourceHome: string;
    readonly destinationHome: string;
    readonly inbox?: { backupTo(path: string): void } | null;
    readonly schedules?: { backupTo(path: string): void } | null;
}

export interface ClonedVeraHome {
    readonly destinationHome: string;
    readonly databases: readonly string[];
}

/**
 * A short instance root so the candidate socket stays under the unix-path
 * ceiling even when the worktree path is long.
 */
export function hashedInstanceRoot(
    identity: string,
    temporaryRoot = join(tmpdir(), "vera-dev"),
): string {
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
    return join(temporaryRoot, hash);
}

/**
 * Copy one Vera home into a private destination, then strip live process
 * identity so the clone cannot attach to the daily host.
 */
export async function cloneVeraHome(
    options: CloneVeraHomeOptions,
): Promise<ClonedVeraHome> {
    const source = resolve(options.sourceHome);
    const destination = resolve(options.destinationHome);
    if (!isAbsolute(source) || !isAbsolute(destination)) {
        throw new Error("Clone paths must be absolute.");
    }
    if (source === destination || destination.startsWith(`${source}/`)) {
        throw new Error("Clone destination cannot sit inside the source home.");
    }
    if (!existsSync(source) || !statSync(source).isDirectory()) {
        throw new Error(`Clone source is not a Vera home: ${source}`);
    }
    if (existsSync(destination)) {
        throw new Error(
            `Clone destination already exists: ${destination}. `
                + "Reuse it, or discard it before taking a fresh snapshot.",
        );
    }

    const staging = `${destination}.staging-${process.pid}-${Date.now()}`;
    try {
        await copyHomeTree(source, staging);
        const databases = overlaySqliteBackups(staging, options);
        scrubLiveIdentity(staging);
        preserveSecretModes(source, staging);
        renameSync(staging, destination);
        return { destinationHome: destination, databases };
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
}

async function copyHomeTree(source: string, destination: string): Promise<void> {
    if (process.platform === "darwin" && cloneOnWrite(source, destination)) {
        return;
    }
    await cp(source, destination, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
    });
}

function cloneOnWrite(source: string, destination: string): boolean {
    const result = Bun.spawnSync(["cp", "-cR", source, destination], {
        stdout: "ignore",
        stderr: "pipe",
    });
    return result.exitCode === 0 && existsSync(destination);
}

function overlaySqliteBackups(
    staging: string,
    options: CloneVeraHomeOptions,
): readonly string[] {
    if (options.inbox == null && options.schedules == null) {
        return [];
    }
    const runtime = join(staging, "runtime");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    return checkpointOpenStores({
        destination: runtime,
        inbox: options.inbox ?? null,
        schedules: options.schedules ?? null,
    }).databases;
}

function scrubLiveIdentity(home: string): void {
    const runtime = join(home, "runtime");
    if (!existsSync(runtime)) return;
    for (const name of LIVE_RUNTIME_NAMES) {
        rmSync(join(runtime, name), { force: true });
    }
}

function preserveSecretModes(source: string, staging: string): void {
    const relative = join("machine", "auth.json");
    const from = join(source, relative);
    const to = join(staging, relative);
    if (!existsSync(from) || !existsSync(to)) return;
    chmodSync(to, statSync(from).mode & 0o777);
}

export function candidateSocketPath(home: string): string {
    return join(home, "runtime", "host.sock");
}

export function assertDistinctSockets(
    candidateHome: string,
    dailyHome: string,
): void {
    const candidate = resolve(candidateSocketPath(candidateHome));
    const daily = resolve(candidateSocketPath(dailyHome));
    if (candidate === daily) {
        throw new Error(
            `Candidate socket ${candidate} is the daily socket. `
                + `Daily home ${dailyHome}; candidate home ${candidateHome}.`,
        );
    }
}
