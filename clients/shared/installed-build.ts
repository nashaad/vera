import {
    childReleaseRoot,
    currentReleaseBuildId,
    defaultInstallPrefix,
    prefixOfReleaseRoot,
    safeRealpath,
} from "../../src/release/layout.ts";

export type BuildClient = "TUI" | "desktop app";

export interface InstalledBuildMismatch {
    readonly clientBuildId: string;
    readonly installedBuildId: string;
}

export class InstalledBuildChangedError extends Error {
    constructor(readonly clientBuildId: string, readonly installedBuildId: string) {
        super();
    }
}

// A client with no build id, or an install with no current release, is never refused.
export function installedBuildMismatch(
    clientBuildId: string | undefined,
    installed: string | undefined,
): InstalledBuildMismatch | undefined {
    if (clientBuildId === undefined || installed === undefined || clientBuildId === installed) return undefined;
    return { clientBuildId, installedBuildId: installed };
}

export function assertInstalledBuild(clientBuildId: string, installed: string | undefined): void {
    const mismatch = installedBuildMismatch(clientBuildId, installed);
    if (mismatch !== undefined) throw new InstalledBuildChangedError(mismatch.clientBuildId, mismatch.installedBuildId);
}

export function installedBuildChangedMessage(client: BuildClient, mismatch: InstalledBuildMismatch): string {
    return `The installed Vera is now build ${mismatch.installedBuildId}, and this ${client} is build ${mismatch.clientBuildId}. `
        + "Quit and reopen Vera to continue.";
}

export function installedBuildAtPrefix(prefix = defaultInstallPrefix()): string | undefined {
    return currentReleaseBuildId(prefix);
}

export function installedBuildId(releaseRoot = childReleaseRoot()): string | undefined {
    if (releaseRoot === undefined) return undefined;
    const prefix = prefixOfReleaseRoot(safeRealpath(releaseRoot) ?? releaseRoot);
    return prefix === undefined ? undefined : installedBuildAtPrefix(prefix);
}
