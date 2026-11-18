import { childReleaseRoot, currentReleaseBuildId, prefixOfReleaseRoot, safeRealpath } from "../../src/release/layout.ts";

export class InstalledBuildChangedError extends Error {
    constructor(readonly clientBuildId: string, readonly installedBuildId: string) {
        super();
    }
}

export function assertInstalledBuild(clientBuildId: string, installed: string | undefined): void {
    if (installed !== undefined && installed !== clientBuildId) {
        throw new InstalledBuildChangedError(clientBuildId, installed);
    }
}

export function installedBuildId(releaseRoot = childReleaseRoot()): string | undefined {
    if (releaseRoot === undefined) return undefined;
    const prefix = prefixOfReleaseRoot(safeRealpath(releaseRoot) ?? releaseRoot);
    return prefix === undefined ? undefined : currentReleaseBuildId(prefix);
}
