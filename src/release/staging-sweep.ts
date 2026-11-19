import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { processIsAlive } from "../host/process-identity.ts";
import {
    desktopPackagesDirectory,
    launcherPath,
    releasesDirectory,
    veraShareRoot,
} from "./layout.ts";

const STALE_TEMPORARY_MS = 60_000;

// Removes what a killed update left behind. Every name carries the PID of the run that made it, so
// a live run's files are never touched. Call it while holding the update lock.
export function sweepStaleStaging(prefix: string): void {
    const releases = releasesDirectory(prefix);
    for (const name of namesIn(releases)) {
        const match = /^\.staging-(\d+)-/.exec(name);
        if (match !== null && !processIsAlive(Number(match[1]))) {
            rmSync(join(releases, name), { recursive: true, force: true });
        }
    }
    const desktop = desktopPackagesDirectory(prefix);
    for (const host of namesIn(desktop)) {
        if (host.startsWith(".")) continue;
        const directory = join(desktop, host);
        for (const name of namesIn(directory)) {
            const match = /^\.tmp-(\d+)-/.exec(name);
            if (match !== null && !processIsAlive(Number(match[1]))) {
                rmSync(join(directory, name), { recursive: true, force: true });
            }
        }
    }
    const share = veraShareRoot(prefix);
    for (const name of namesIn(share)) {
        const link = /^\.(?:current|rollback)\.(\d+)$/.exec(name);
        const lock = /^\.update\.lock\..+\.tmp$/.test(name);
        if (link !== null && !processIsAlive(Number(link[1]))) {
            rmSync(join(share, name), { force: true });
        } else if (lock && olderThan(join(share, name), STALE_TEMPORARY_MS)) {
            rmSync(join(share, name), { force: true });
        }
    }
    const launcherDirectory = dirname(launcherPath(prefix));
    for (const name of namesIn(launcherDirectory)) {
        const match = /^vera\.(\d+)\.tmp$/.exec(name);
        if (match !== null && !processIsAlive(Number(match[1]))) {
            rmSync(join(launcherDirectory, name), { force: true });
        }
    }
}

function namesIn(directory: string): string[] {
    if (!existsSync(directory)) return [];
    try {
        return readdirSync(directory);
    } catch {
        return [];
    }
}

function olderThan(path: string, ms: number): boolean {
    try {
        return Date.now() - statSync(path).mtimeMs > ms;
    } catch {
        return false;
    }
}
