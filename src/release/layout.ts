import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** POSIX home. Not a Vera locator; the daily prefix is `$HOME/.local`. */
function userHome(): string {
    const home = process.env.HOME;
    if (home !== undefined && home.length > 0) {
        return home;
    }
    return homedir();
}

/** Names of the executables at the root of a packed release. */
export const RELEASE_CLI_NAME = "vera";
export const RELEASE_HOST_NAME = "host";
export const RELEASE_WORKER_NAME = "worker";
export const RELEASE_ANNEX_NAME = "vera-annex";
export const RELEASE_SUPERVISOR_NAME = "vera-supervisor";
export const RELEASE_BUN_NAME = "bun";

export function defaultInstallPrefix(home = userHome()): string {
    return join(home, ".local");
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

export function launcherPath(prefix = defaultInstallPrefix()): string {
    return join(prefix, "bin", RELEASE_CLI_NAME);
}

/**
 * The activated release root: `current`, not a particular `releases/<id>`
 * path. Running processes that belong to one release should pass that
 * release's directory instead of using this default.
 */
export function packedReleaseRoot(prefix = defaultInstallPrefix()): string {
    return currentSymlinkPath(prefix);
}

/** Packed annex assets: index.html, main.js, styles.css, build-id. */
export function packedAnnexRoot(releaseRoot = thisProcessReleaseRoot()): string {
    return join(releaseRoot, "annex");
}

/** Release manifest written next to the packed artifacts. */
export function releaseManifestPath(releaseRoot = packedReleaseRoot()): string {
    return join(releaseRoot, "manifest.json");
}

export function releaseBinaryPath(
    name: string,
    releaseRoot = thisProcessReleaseRoot(),
): string {
    return join(releaseRoot, name);
}

/**
 * The release this process belongs to. A packed bun sits next to
 * `manifest.json`. Anything else (source `bun test`, a checkout CLI) uses
 * the activated `current`.
 */
export function thisProcessReleaseRoot(
    prefix = defaultInstallPrefix(),
): string {
    const candidate = dirname(process.execPath);
    if (existsSync(releaseManifestPath(candidate))) {
        return candidate;
    }
    return packedReleaseRoot(prefix);
}
