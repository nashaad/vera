import { existsSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { processIsAlive } from "../host/process-identity.ts";
import {
    desktopPackageKey,
    readDesktopPackageHolds,
} from "./desktop-package-references.ts";
import { scanDesktopPackages } from "./desktop-packages.ts";
import {
    currentReleaseBuildId,
    defaultInstallPrefix,
    desktopPackageDirectory,
    desktopPackagesDirectory,
    releaseDirectory,
    releasesDirectory,
    rollbackReleaseBuildId,
} from "./layout.ts";
import { readStampedRelease } from "./stamp.ts";
import { compareReleaseVersions } from "./version-order.ts";

export interface DesktopPackageCleanupOptions {
    readonly onHeld?: (reason: string) => void;
}

// Keeps the newest package of the current host build, the rollback host build and any host release that is downloaded but not yet current,
// plus any package a running desktop holds. Everything else goes, including packages of host builds that are gone. Returns "<host build id>/<version>" for each removal.
export function cleanDesktopPackages(
    prefix = defaultInstallPrefix(),
    options: DesktopPackageCleanupOptions = {},
): readonly string[] {
    const root = desktopPackagesDirectory(prefix);
    if (!existsSync(root)) return [];
    const holds = readDesktopPackageHolds(prefix);
    if (holds.unreadable) {
        options.onHeld?.("A running desktop's package record is unreadable. Keeping every desktop package until it exits.");
        return [];
    }
    const keptHostBuilds = new Set<string>();
    for (const buildId of [currentReleaseBuildId(prefix), rollbackReleaseBuildId(prefix)]) {
        if (buildId !== undefined) keptHostBuilds.add(buildId);
    }
    for (const buildId of downloadedHostBuilds(prefix)) keptHostBuilds.add(buildId);
    const removed: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const hostBuildId = entry.name;
        const scan = scanDesktopPackages(hostBuildId, prefix);
        const newest = keptHostBuilds.has(hostBuildId) ? scan.valid[0]?.desktopVersion : undefined;
        const versions = [...scan.valid.map((item) => item.desktopVersion), ...scan.invalid];
        for (const version of versions) {
            if (version === newest || holds.held.has(desktopPackageKey(hostBuildId, version))) continue;
            if (removeUnheld(hostBuildId, version, prefix, options)) removed.push(`${hostBuildId}/${version}`);
        }
        const hostDirectory = join(root, hostBuildId);
        removeAbandonedTemporaries(hostDirectory);
        try {
            rmdirSync(hostDirectory);
        } catch {
            // Not empty: it still holds a package or an install in flight.
        }
    }
    return removed;
}

// A held update leaves its host release unpacked and not current. Its package is installed before the hold, so it is kept for the later activation.
function downloadedHostBuilds(prefix: string): readonly string[] {
    const current = currentReleaseBuildId(prefix);
    if (current === undefined) return [];
    let currentVersion: string;
    try {
        currentVersion = readStampedRelease(releaseDirectory(current, prefix)).product_version;
    } catch {
        return [];
    }
    let names: string[];
    try {
        names = readdirSync(releasesDirectory(prefix), { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== current)
            .map((entry) => entry.name);
    } catch {
        return [];
    }
    return names.filter((name) => {
        try {
            return compareReleaseVersions(readStampedRelease(releaseDirectory(name, prefix)).product_version, currentVersion) > 0;
        } catch {
            return false;
        }
    });
}

// Rename first, then look again: a desktop that recorded the package after the first read gets it back.
function removeUnheld(
    hostBuildId: string,
    version: string,
    prefix: string,
    options: DesktopPackageCleanupOptions,
): boolean {
    const path = desktopPackageDirectory(hostBuildId, version, prefix);
    const aside = join(dirname(path), `.gc-${process.pid}-${version}`);
    try {
        rmSync(aside, { recursive: true, force: true });
        renameSync(path, aside);
    } catch (error) {
        options.onHeld?.(`Could not remove ${path}: ${String(error)}`);
        return false;
    }
    try {
        const holds = readDesktopPackageHolds(prefix);
        if (holds.unreadable || holds.held.has(desktopPackageKey(hostBuildId, version))) {
            if (existsSync(path)) rmSync(aside, { recursive: true, force: true });
            else renameSync(aside, path);
            return false;
        }
        rmSync(aside, { recursive: true, force: false });
        return true;
    } catch (error) {
        options.onHeld?.(`Could not remove ${aside}: ${String(error)}`);
        return false;
    }
}

// Install and collection directories of processes that exited mid-way.
function removeAbandonedTemporaries(hostDirectory: string): void {
    for (const entry of readdirSync(hostDirectory, { withFileTypes: true })) {
        const match = /^\.(?:tmp|gc)-(\d+)-/.exec(entry.name);
        if (!entry.isDirectory() || match === null || processIsAlive(Number(match[1]))) continue;
        rmSync(join(hostDirectory, entry.name), { recursive: true, force: true });
    }
}
