import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Packed release directory this tree's pack step writes. */
export function packedReleaseRoot(): string {
    return join(REPO_ROOT, "dist", "release");
}

/** Packed annex assets: index.html, main.js, styles.css, build-id. */
export function packedAnnexRoot(releaseRoot = packedReleaseRoot()): string {
    return join(releaseRoot, "annex");
}

/** Release manifest written next to the packed artifacts. */
export function releaseManifestPath(releaseRoot = packedReleaseRoot()): string {
    return join(releaseRoot, "manifest.json");
}
