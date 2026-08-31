import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Packed release directory this tree's pack step writes. */
export function packedReleaseRoot(): string {
    return join(REPO_ROOT, "dist", "release");
}

/** Packed usage assets: index.html, main.js, styles.css. */
export function packedWebRoot(releaseRoot = packedReleaseRoot()): string {
    return join(releaseRoot, "web");
}
