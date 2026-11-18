import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { currentReleaseBuildId, releasesDirectory } from "./layout.ts";
import { readStampedRelease } from "./stamp.ts";

// The build id of an unpacked release of this version that is not current, if one is on disk.
export function stagedReleaseBuild(
    prefix: string,
    version: string,
    platform: string,
    arch: string,
): string | undefined {
    const directory = releasesDirectory(prefix);
    if (!existsSync(directory)) return undefined;
    const current = currentReleaseBuildId(prefix);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === current) continue;
        try {
            const manifest = readStampedRelease(join(directory, entry.name));
            if (
                manifest.build_id === entry.name
                && manifest.product_version === version
                && manifest.platform === platform
                && manifest.arch === arch
            ) {
                return entry.name;
            }
        } catch {
            continue;
        }
    }
    return undefined;
}
