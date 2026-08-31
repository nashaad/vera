import { spawn } from "node:child_process";
import {
    mkdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { activateRelease } from "./activate.ts";
import {
    currentReleaseBuildId,
    defaultInstallPrefix,
    launcherPath,
    packedReleaseRoot,
    RELEASE_HOST_NAME,
    releaseDirectory,
    upgradeJournalPath,
} from "./layout.ts";
import type { ReleaseManifest } from "./manifest.ts";
import { verifyPackedRelease } from "./verify.ts";
import {
    defaultHostLockPath,
    readHostLockRecordFile,
} from "../host/lockfile.ts";
import { gracefulStopResidentHost } from "../host/force-stop.ts";

export type UpgradePhase = "draining" | "activating" | "starting";

export interface UpgradeJournal {
    readonly phase: UpgradePhase;
    readonly from_build_id: string | null;
    readonly to_build_id: string;
    readonly host_was_running: boolean;
}

export interface UpgradeLocalOptions {
    readonly prefix?: string;
    readonly pack: () => Promise<{
        readonly prefix: string;
        readonly releaseRoot: string;
        readonly manifest: ReleaseManifest;
    }>;
    readonly verify?: (releaseRoot: string) => void;
    readonly drainHost?: () => Promise<"stopped" | "absent">;
    readonly startHost?: (releaseRoot: string) => Promise<void>;
}

export interface UpgradedLocal {
    readonly prefix: string;
    readonly releaseRoot: string;
    readonly launcher: string;
    readonly current: string;
    readonly fromBuildId: string | null;
    readonly manifest: ReleaseManifest;
}

const PHASES = new Set<UpgradePhase>(["draining", "activating", "starting"]);

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function readUpgradeJournal(
    prefix = defaultInstallPrefix(),
): Promise<UpgradeJournal | undefined> {
    const path = upgradeJournalPath(prefix);
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error(
            `Upgrade journal at ${path} is unreadable: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (error) {
        throw new Error(
            `Upgrade journal at ${path} is not JSON: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Upgrade journal at ${path} must be an object`);
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.phase !== "string" || !PHASES.has(record.phase as UpgradePhase)) {
        throw new Error(`Upgrade journal at ${path} has an unknown phase`);
    }
    if (record.from_build_id !== null && typeof record.from_build_id !== "string") {
        throw new Error(`Upgrade journal at ${path} has a bad from_build_id`);
    }
    if (typeof record.to_build_id !== "string" || record.to_build_id.length === 0) {
        throw new Error(`Upgrade journal at ${path} has a bad to_build_id`);
    }
    if (typeof record.host_was_running !== "boolean") {
        throw new Error(`Upgrade journal at ${path} has a bad host_was_running`);
    }
    return {
        phase: record.phase as UpgradePhase,
        from_build_id: record.from_build_id,
        to_build_id: record.to_build_id,
        host_was_running: record.host_was_running,
    };
}

export function writeUpgradeJournal(
    journal: UpgradeJournal,
    prefix = defaultInstallPrefix(),
): void {
    const path = upgradeJournalPath(prefix);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(
        temporary,
        `${JSON.stringify({
            phase: journal.phase,
            from_build_id: journal.from_build_id,
            to_build_id: journal.to_build_id,
            host_was_running: journal.host_was_running,
        }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o644 },
    );
    renameSync(temporary, path);
}

export async function clearUpgradeJournal(
    prefix = defaultInstallPrefix(),
): Promise<void> {
    try {
        await unlink(upgradeJournalPath(prefix));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

export async function defaultDrainHost(): Promise<"stopped" | "absent"> {
    const outcome = await gracefulStopResidentHost();
    if (outcome === undefined) return "absent";
    if (outcome.endedBy === "survived") {
        throw new Error(
            `Resident Vera host PID ${outcome.pid} is still running. `
                + "Stop it with 'vera host stop --force' and run "
                + "'bun run install:local' again. The previous release is still active.",
        );
    }
    return "stopped";
}

export async function defaultEnsureHost(releaseRoot: string): Promise<void> {
    const lockPath = defaultHostLockPath();
    const existing = await readHostLockRecordFile(lockPath);
    if (existing !== undefined && processIsAlive(existing.pid)) {
        return;
    }
    const child = spawn(join(releaseRoot, RELEASE_HOST_NAME), [], {
        argv0: "vera-host",
        detached: true,
        stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const record = await readHostLockRecordFile(lockPath);
        if (record !== undefined && processIsAlive(record.pid)) {
            return;
        }
        await waitFor(50);
    }
    throw new Error(
        `The host from ${releaseRoot} did not publish ${lockPath} in time.`,
    );
}

/**
 * After a crash, start the host that matches the activated `current`.
 * Pack and verify do not write this journal, so a crash there leaves the
 * previous release active with no extra work.
 */
export async function recoverInterruptedUpgrade(
    options: {
        readonly prefix?: string;
        readonly startHost?: (releaseRoot: string) => Promise<void>;
    } = {},
): Promise<{ readonly recovered: boolean; readonly buildId: string | undefined }> {
    const prefix = options.prefix ?? defaultInstallPrefix();
    const journal = await readUpgradeJournal(prefix);
    if (journal === undefined) {
        return { recovered: false, buildId: currentReleaseBuildId(prefix) };
    }
    const current = currentReleaseBuildId(prefix)
        ?? (journal.phase === "starting" ? journal.to_build_id : journal.from_build_id)
        ?? undefined;
    const startHost = options.startHost ?? defaultEnsureHost;
    if (journal.host_was_running && current !== undefined) {
        await startHost(releaseDirectory(current, prefix));
    }
    await clearUpgradeJournal(prefix);
    return { recovered: true, buildId: current };
}

async function restorePreviousRelease(
    prefix: string,
    fromBuildId: string | null,
    hostWasRunning: boolean,
    startHost: (releaseRoot: string) => Promise<void>,
): Promise<void> {
    const current = currentReleaseBuildId(prefix);
    if (fromBuildId !== null && current !== fromBuildId) {
        activateRelease(releaseDirectory(fromBuildId, prefix), prefix);
    }
    if (hostWasRunning && fromBuildId !== null) {
        await startHost(releaseDirectory(fromBuildId, prefix));
    }
    await clearUpgradeJournal(prefix);
}

/**
 * Verify, drain, activate, and restart as one transaction. `pack` must already
 * be able to write `releases/<build-id>` without touching `current`. A failure
 * after `current` moves restores the previous target. Does not migrate ~/.vera.
 */
export async function upgradeLocalInstall(
    options: UpgradeLocalOptions,
): Promise<UpgradedLocal> {
    const prefix = options.prefix ?? defaultInstallPrefix();
    const startHost = options.startHost ?? defaultEnsureHost;
    const drainHost = options.drainHost ?? defaultDrainHost;
    const verify = options.verify
        ?? ((releaseRoot: string) => verifyPackedRelease(releaseRoot, prefix));

    await recoverInterruptedUpgrade({ prefix, startHost });
    const fromBuildId = currentReleaseBuildId(prefix) ?? null;

    const packed = await options.pack();
    verify(packed.releaseRoot);

    let hostWasRunning = false;
    try {
        const existing = await readHostLockRecordFile();
        if (existing !== undefined && processIsAlive(existing.pid)) {
            writeUpgradeJournal({
                phase: "draining",
                from_build_id: fromBuildId,
                to_build_id: packed.manifest.build_id,
                host_was_running: true,
            }, prefix);
        }
        const drained = await drainHost();
        hostWasRunning = drained === "stopped";
        writeUpgradeJournal({
            phase: "activating",
            from_build_id: fromBuildId,
            to_build_id: packed.manifest.build_id,
            host_was_running: hostWasRunning,
        }, prefix);
        activateRelease(packed.releaseRoot, prefix);
        writeUpgradeJournal({
            phase: "starting",
            from_build_id: fromBuildId,
            to_build_id: packed.manifest.build_id,
            host_was_running: hostWasRunning,
        }, prefix);
        if (hostWasRunning) {
            await startHost(packed.releaseRoot);
        }
        await clearUpgradeJournal(prefix);
        return {
            prefix,
            releaseRoot: packed.releaseRoot,
            launcher: launcherPath(prefix),
            current: packedReleaseRoot(prefix),
            fromBuildId,
            manifest: packed.manifest,
        };
    } catch (error) {
        try {
            await restorePreviousRelease(
                prefix,
                fromBuildId,
                hostWasRunning,
                startHost,
            );
        } catch (restoreError) {
            const first = error instanceof Error ? error.message : String(error);
            const second = restoreError instanceof Error
                ? restoreError.message
                : String(restoreError);
            throw new Error(
                `${first} Restore of the previous release also failed: ${second}`,
            );
        }
        throw error;
    }
}
