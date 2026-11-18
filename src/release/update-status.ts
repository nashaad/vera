import { existsSync } from "node:fs";

import { desktopInstallRecorded, findDesktopPackage } from "./desktop-packages.ts";
import { cachedShellTarball, inspectShell } from "./shell-update.ts";
import { stagedReleaseBuild } from "./staged-release.ts";
import {
    desktopHeldMessage,
    fetchReleaseWindow,
    installedRunningRelease,
    type InstalledRelease,
    type UpdateOptions,
} from "./update.ts";
import { compareVersions, isReleaseVersion, normalizeReleaseVersion } from "./version.ts";

export interface UpdateStatus {
    readonly status: "up_to_date" | "available" | "downloaded" | "held" | "unavailable";
    readonly current_version: string;
    readonly current_build: string;
    readonly latest_version?: string;
    readonly message?: string;
}

// Answers every case as data and never throws: a check that cannot run is `unavailable`.
export async function updateStatus(options: UpdateOptions): Promise<UpdateStatus> {
    let running: InstalledRelease;
    try {
        running = options.running ?? installedRunningRelease();
    } catch (error) {
        return { status: "unavailable", current_version: "", current_build: "", message: messageOf(error) };
    }
    const base = { current_version: running.version, current_build: running.buildId };
    try {
        const prefix = options.prefix ?? running.prefix;
        const requested = options.version === undefined || options.version.length === 0
            ? undefined
            : normalizeReleaseVersion(options.version);
        if (requested !== undefined && !isReleaseVersion(requested)) {
            throw new Error(`Invalid version '${options.version}'. Expected a version like 0.1.0.`);
        }
        const target = requested !== undefined && compareVersions(requested, running.version) === 0
            ? undefined
            : (await fetchReleaseWindow(options, running.version, requested)).target;
        if (target === undefined || compareVersions(target.version, running.version) <= 0) {
            return { status: "up_to_date", ...base, latest_version: target?.version ?? running.version };
        }
        const latest = { latest_version: target.version };
        const platform = options.platform ?? process.platform;
        const staged = stagedReleaseBuild(prefix, target.version, platform, options.arch ?? process.arch);
        if (staged === undefined) return { status: "available", ...base, ...latest };
        if (platform === "darwin" && desktopInstallRecorded(prefix)) {
            const desktop = findDesktopPackage(staged, prefix);
            if (desktop === undefined) {
                return { status: "held", ...base, ...latest, message: desktopHeldMessage(target.version) };
            }
            const shell = inspectShell(prefix, desktop.shellApi, target.version);
            if (shell.kind === "held") return { status: "held", ...base, ...latest, message: shell.message };
            // An app that must be replaced is part of what an update downloads.
            if (shell.kind === "swap"
                && !existsSync(cachedShellTarball(prefix, target.tag, platform, options.arch ?? process.arch))) {
                return { status: "available", ...base, ...latest };
            }
        }
        return { status: "downloaded", ...base, ...latest };
    } catch (error) {
        return { status: "unavailable", ...base, message: messageOf(error) };
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
