import { readFileSync } from "node:fs";

import { releaseManifestPath, thisProcessReleaseRoot } from "./layout.ts";
import {
    parseReleaseManifest,
    type ReleaseManifest,
} from "./manifest.ts";

/**
 * The identity of this running process. One file, no fallback: the manifest
 * the packer wrote into this process's release directory.
 */
export function readStampedRelease(
    releaseRoot = thisProcessReleaseRoot(),
): ReleaseManifest {
    const path = releaseManifestPath(releaseRoot);
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            throw new Error(
                `No release stamp at ${path}. Pack this tree first with bun run pack:release.`,
            );
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Release stamp at ${path} is unreadable: ${reason}`);
    }
    return parseReleaseManifest(text);
}

export function thisProcessBuildId(): string {
    return readStampedRelease().build_id;
}

export function formatVeraVersion(manifest: ReleaseManifest): string {
    return `vera ${manifest.product_version} (${manifest.build_id})`;
}
