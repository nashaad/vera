import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function userHome(): string {
    const home = process.env.HOME;
    if (home !== undefined && home.length > 0) {
        return home;
    }
    return homedir();
}

export const RELEASE_CLI_NAME = "vera";
export const RELEASE_HOST_NAME = "host";
export const RELEASE_WORKER_NAME = "worker";
export const RELEASE_SESSION_WORKER_NAME = "session-worker";
export const RELEASE_ANNEX_NAME = "vera-annex";
export const RELEASE_SUPERVISOR_NAME = "vera-supervisor";

export function defaultInstallPrefix(home = userHome()): string {
    return join(home, ".local");
}

export function prefixOfReleaseRoot(releaseRoot: string): string | undefined {
    const releases = dirname(releaseRoot);
    const veraRoot = dirname(releases);
    const shareRoot = dirname(veraRoot);
    if (basename(releases) !== "releases" || basename(veraRoot) !== "vera" || basename(shareRoot) !== "share") {
        return undefined;
    }
    return dirname(shareRoot);
}

export function runningInstallPrefix(execPath = process.execPath): string | undefined {
    if (process.env.VERA_DEV_INSTANCE !== undefined) return undefined;
    const root = safeRealpath(dirname(execPath)) ?? dirname(execPath);
    return existsSync(releaseManifestPath(root)) ? prefixOfReleaseRoot(root) : undefined;
}

export function veraShareRoot(prefix = defaultInstallPrefix()): string {
    return join(prefix, "share", "vera");
}

export function releasesDirectory(prefix = defaultInstallPrefix()): string {
    return join(veraShareRoot(prefix), "releases");
}

export function releaseDirectory(
    buildId: string,
    prefix = defaultInstallPrefix(),
): string {
    return join(releasesDirectory(prefix), buildId);
}

export function currentSymlinkPath(prefix = defaultInstallPrefix()): string {
    return join(veraShareRoot(prefix), "current");
}

export function rollbackSymlinkPath(prefix = defaultInstallPrefix()): string {
    return join(veraShareRoot(prefix), "rollback");
}

export function currentReleaseBuildId(
    prefix = defaultInstallPrefix(),
): string | undefined {
    return readReleaseLinkBuildId(currentSymlinkPath(prefix));
}

export function rollbackReleaseBuildId(
    prefix = defaultInstallPrefix(),
): string | undefined {
    return readReleaseLinkBuildId(rollbackSymlinkPath(prefix));
}

function readReleaseLinkBuildId(path: string): string | undefined {
    let link: string;
    try {
        link = readlinkSync(path);
    } catch {
        return undefined;
    }
    const expected = "releases/";
    if (!link.startsWith(expected)) return undefined;
    const buildId = link.slice(expected.length);
    if (buildId.length === 0 || buildId.includes("/") || buildId.includes("\0")) {
        return undefined;
    }
    return buildId;
}

export function upgradeJournalPath(prefix = defaultInstallPrefix()): string {
    return join(veraShareRoot(prefix), "upgrade.json");
}

export function launcherPath(prefix = defaultInstallPrefix()): string {
    return join(prefix, "bin", RELEASE_CLI_NAME);
}

export function packedReleaseRoot(prefix = defaultInstallPrefix()): string {
    return currentSymlinkPath(prefix);
}

export function packedAnnexRoot(releaseRoot = thisProcessReleaseRoot()): string {
    return join(releaseRoot, "annex");
}

export function releaseManifestPath(releaseRoot = packedReleaseRoot()): string {
    return join(releaseRoot, "manifest.json");
}

export function releaseBinaryPath(
    name: string,
    releaseRoot = thisProcessReleaseRoot(),
): string {
    return join(releaseRoot, name);
}

// The checkout pack is the one `bun run pack:release` writes under the working directory.
export function checkoutPackRoot(checkoutRoot = process.cwd()): string {
    return join(checkoutRoot, "dist", "release");
}

export function thisProcessReleaseRoot(
    prefix = defaultInstallPrefix(),
    execPath = process.execPath,
    checkoutRoot = process.cwd(),
): string {
    const candidate = dirname(execPath);
    if (existsSync(releaseManifestPath(candidate))) {
        return candidate;
    }
    const checkoutPack = checkoutPackRoot(checkoutRoot);
    if (
        process.env.VERA_DEV_INSTANCE
        && existsSync(releaseManifestPath(checkoutPack))
    ) {
        return checkoutPack;
    }
    return packedReleaseRoot(prefix);
}

// Undefined in a development instance whose root would be the installed release; callers run their source entry.
export function childReleaseRoot(
    prefix = defaultInstallPrefix(),
    execPath = process.execPath,
    checkoutRoot = process.cwd(),
): string | undefined {
    const root = thisProcessReleaseRoot(prefix, execPath, checkoutRoot);
    if (!process.env.VERA_DEV_INSTANCE) return root;
    const installed = packedReleaseRoot(prefix);
    if ((safeRealpath(root) ?? root) === (safeRealpath(installed) ?? installed)) {
        return undefined;
    }
    return root;
}

export function safeRealpath(path: string): string | undefined {
    try {
        return realpathSync(path);
    } catch {
        return undefined;
    }
}
