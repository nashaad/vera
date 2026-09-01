import { existsSync, readdirSync, rmSync } from "node:fs";

import {
    defaultInstallPrefix,
    releaseDirectory,
    releasesDirectory,
} from "./layout.ts";
import {
    isReleaseReferenced,
    referenceReasons,
    referencedBuildIds,
} from "./references.ts";

export class ReleaseInUseError extends Error {
    constructor(
        readonly buildId: string,
        readonly reasons: readonly string[],
    ) {
        const why = reasons.length === 0 ? "referenced" : reasons.join(", ");
        super(`Release ${buildId} is still ${why} and cannot be removed.`);
        this.name = "ReleaseInUseError";
    }
}

export function removeRelease(
    buildId: string,
    prefix = defaultInstallPrefix(),
): void {
    if (isReleaseReferenced(buildId, prefix)) {
        throw new ReleaseInUseError(buildId, referenceReasons(buildId, prefix));
    }
    const path = releaseDirectory(buildId, prefix);
    if (!existsSync(path)) {
        return;
    }
    rmSync(path, { recursive: true, force: false });
}

export function gcReleases(
    prefix = defaultInstallPrefix(),
): readonly string[] {
    const root = releasesDirectory(prefix);
    if (!existsSync(root)) {
        return [];
    }
    const referenced = referencedBuildIds(prefix);
    const removed: string[] = [];
    for (const name of readdirSync(root)) {
        if (referenced.has(name)) continue;
        const path = releaseDirectory(name, prefix);
        rmSync(path, { recursive: true, force: false });
        removed.push(name);
    }
    return removed;
}
