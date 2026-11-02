import { existsSync, readdirSync, rmSync } from "node:fs";

import {
    defaultInstallPrefix,
    releaseDirectory,
    releasesDirectory,
} from "./layout.ts";
import {
    damagedHostLockHold,
    referenceReasons,
    referencedBuildIds,
} from "./references.ts";

export class ReleaseInUseError extends Error {
    constructor(
        readonly buildId: string,
        readonly reasons: readonly string[],
    ) {
        const why = reasons.length === 0 ? "referenced" : reasons.join(", ");
        const damaged = reasons.includes("host-lock-damaged")
            ? " The host lockfile is damaged, so Vera cannot tell which release a running host uses."
            : "";
        super(`Release ${buildId} is still ${why} and cannot be removed.${damaged}`);
        this.name = "ReleaseInUseError";
    }
}

export function removeRelease(
    buildId: string,
    prefix = defaultInstallPrefix(),
): void {
    // One call: each reference check on a damaged lockfile runs ps.
    const reasons = referenceReasons(buildId, prefix);
    if (reasons.length > 0) {
        throw new ReleaseInUseError(buildId, reasons);
    }
    const path = releaseDirectory(buildId, prefix);
    if (!existsSync(path)) {
        return;
    }
    rmSync(path, { recursive: true, force: false });
}

export interface GcOptions {
    // Called with the reason when nothing is removed because a host may be running any release.
    readonly onHeld?: (reason: string) => void;
}

export function gcReleases(
    prefix = defaultInstallPrefix(),
    options: GcOptions = {},
): readonly string[] {
    const root = releasesDirectory(prefix);
    if (!existsSync(root)) {
        return [];
    }
    const hold = damagedHostLockHold();
    if (hold !== undefined) {
        options.onHeld?.(hold);
        return [];
    }
    const referenced = referencedBuildIds(prefix);
    const removed: string[] = [];
    for (const name of readdirSync(root)) {
        // Dot entries belong to a pack that may still be running.
        if (name.startsWith(".")) continue;
        if (referenced.has(name)) continue;
        const path = releaseDirectory(name, prefix);
        rmSync(path, { recursive: true, force: false });
        removed.push(name);
    }
    return removed;
}
