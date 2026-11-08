import { readFileSync } from "node:fs";

import { childReleaseRoot, releaseManifestPath, thisProcessReleaseRoot } from "./layout.ts";
import {
    parseReleaseManifest,
    VERA_PRODUCT_VERSION,
    type ReleaseManifest,
} from "./manifest.ts";

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

export interface ProcessBuildIdOptions {
    readonly prefix?: string;
    readonly execPath?: string;
    readonly checkoutRoot?: string;
}

export function thisProcessBuildId(options: ProcessBuildIdOptions = {}): string {
    const root = childReleaseRoot(
        options.prefix,
        options.execPath,
        options.checkoutRoot,
    );
    if (root === undefined) {
        return devInstanceBuildId(process.env.VERA_DEV_INSTANCE);
    }
    return readStampedRelease(root).build_id;
}

// A development instance without a pack has no manifest, so its version is the product constant and its launch build id.
export function thisProcessVersion(options: ProcessBuildIdOptions = {}): string {
    const root = childReleaseRoot(
        options.prefix,
        options.execPath,
        options.checkoutRoot,
    );
    if (root === undefined) {
        return `vera ${VERA_PRODUCT_VERSION} (${devInstanceBuildId(process.env.VERA_DEV_INSTANCE)})`;
    }
    return formatVeraVersion(readStampedRelease(root));
}

// The label is "<worktree basename> <build id>". The basename may hold spaces, so the build id is the last token.
export function devInstanceBuildId(label: string | undefined): string {
    const tokens = (label ?? "").trim().split(/\s+/).filter((token) => token.length > 0);
    const buildId = tokens.length >= 2 ? tokens[tokens.length - 1] : undefined;
    if (buildId === undefined) {
        throw new Error(
            "This development instance has no build id in VERA_DEV_INSTANCE. Launch it with `bun run dev:tui`.",
        );
    }
    return buildId;
}

export function formatVeraVersion(manifest: ReleaseManifest): string {
    return `vera ${manifest.product_version} (${manifest.build_id})`;
}
