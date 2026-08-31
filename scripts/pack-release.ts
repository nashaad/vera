#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_PROTOCOL_VERSION } from "../src/host/protocol.ts";
import { releaseSourceIdentity } from "../src/release/build-id.ts";
import {
    packedAnnexRoot,
    packedReleaseRoot,
    releaseManifestPath,
} from "../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
    type ReleaseManifest,
} from "../src/release/manifest.ts";
import { packWebAssets } from "./pack-web.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ANNEX_ASSET_FILES = [
    "index.html",
    "main.js",
    "styles.css",
    "build-id",
] as const;

export interface PackReleaseResult {
    readonly outputDirectory: string;
    readonly manifest: ReleaseManifest;
    readonly packed: boolean;
}

export interface PackReleaseOptions {
    readonly cwd?: string;
    readonly sourceRoot?: string;
    readonly force?: boolean;
    readonly protocolVersion?: number;
    readonly productVersion?: string;
    readonly now?: () => Date;
    readonly platform?: string;
    readonly arch?: string;
}

function fail(message: string): never {
    console.error(`vera pack-release: ${message}`);
    process.exit(1);
}

export function digestPackedAnnex(directory: string): string {
    const hash = createHash("sha256");
    for (const name of ANNEX_ASSET_FILES) {
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(join(directory, name)));
        hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
}

export async function packRelease(
    outputDirectory: string = packedReleaseRoot(),
    options: PackReleaseOptions = {},
): Promise<PackReleaseResult> {
    const cwd = options.cwd ?? REPO_ROOT;
    const target = resolve(outputDirectory);
    const annexRoot = packedAnnexRoot(target);
    const identity = releaseSourceIdentity(cwd);
    const packed = await packWebAssets(annexRoot, {
        cwd,
        force: options.force,
        ...(options.sourceRoot === undefined ? {} : { sourceRoot: options.sourceRoot }),
    });
    const manifest: ReleaseManifest = {
        layout_version: RELEASE_LAYOUT_VERSION,
        product_version: options.productVersion ?? VERA_PRODUCT_VERSION,
        source_revision: identity.sourceRevision,
        build_id: identity.buildId,
        protocol_version: options.protocolVersion ?? HOST_PROTOCOL_VERSION,
        platform: options.platform ?? process.platform,
        arch: options.arch ?? process.arch,
        asset_digest: digestPackedAnnex(annexRoot),
        built_at: (options.now ?? (() => new Date()))().toISOString(),
        artifacts: [...RELEASE_ARTIFACT_NAMES],
    };
    await Bun.write(
        releaseManifestPath(target),
        serializeReleaseManifest(manifest),
    );
    return {
        outputDirectory: target,
        manifest,
        packed: packed.packed,
    };
}

function parseArgs(argv: readonly string[]): {
    readonly outputDirectory: string;
    readonly force: boolean;
} {
    let force = false;
    const positional: string[] = [];
    for (const arg of argv) {
        if (arg === "--force") {
            force = true;
            continue;
        }
        if (arg.startsWith("-")) {
            fail(`unknown flag: ${arg}`);
        }
        positional.push(arg);
    }
    if (positional.length > 1) {
        fail("usage: scripts/pack-release.ts [output-directory] [--force]");
    }
    return {
        outputDirectory: positional[0] ?? packedReleaseRoot(),
        force,
    };
}

if (import.meta.main) {
    try {
        const { outputDirectory, force } = parseArgs(Bun.argv.slice(2));
        const result = await packRelease(outputDirectory, { force });
        process.stdout.write(`${result.outputDirectory}\n`);
        process.stdout.write(`${result.manifest.build_id}\n`);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}
