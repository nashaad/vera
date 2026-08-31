#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_PROTOCOL_VERSION } from "../src/host/protocol.ts";
import { activateRelease } from "../src/release/activate.ts";
import { assembleRunnableRelease } from "../src/release/assemble.ts";
import { releaseSourceIdentity } from "../src/release/build-id.ts";
import {
    defaultInstallPrefix,
    launcherPath,
    packedAnnexRoot,
    packedReleaseRoot,
    releaseDirectory,
    releaseManifestPath,
} from "../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
    type ReleaseManifest,
} from "../src/release/manifest.ts";
import { readStampedRelease } from "../src/release/stamp.ts";
import { digestPackedAnnex } from "../src/release/verify.ts";
import { packWebAssets } from "./pack-web.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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

export async function packRelease(
    outputDirectory: string,
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

export interface InstallReleaseOptions {
    readonly prefix?: string;
    readonly cwd?: string;
    readonly sourceRoot?: string;
    readonly force?: boolean;
}

export interface InstalledRelease {
    readonly prefix: string;
    readonly releaseRoot: string;
    readonly launcher: string;
    readonly current: string;
    readonly manifest: ReleaseManifest;
}

/**
 * Pack a runnable release into prefix/share/vera/releases/<build-id> and
 * atomically activate it. Does not write ~/.vera.
 */
export async function installRelease(
    options: InstallReleaseOptions = {},
): Promise<InstalledRelease> {
    const prefix = options.prefix ?? defaultInstallPrefix();
    const cwd = options.cwd ?? REPO_ROOT;
    const sourceRoot = options.sourceRoot ?? REPO_ROOT;
    const identity = releaseSourceIdentity(cwd);
    const target = releaseDirectory(identity.buildId, prefix);
    mkdirSync(target, { recursive: true, mode: 0o755 });
    let manifest: ReleaseManifest | undefined;
    try {
        manifest = readStampedRelease(target);
    } catch {
        manifest = undefined;
    }
    if (manifest?.build_id !== identity.buildId) {
        const packed = await packRelease(target, {
            cwd,
            force: options.force ?? true,
            sourceRoot: join(sourceRoot, "clients", "annex"),
        });
        assembleRunnableRelease(target, sourceRoot);
        manifest = packed.manifest;
    }
    activateRelease(target, prefix);
    return {
        prefix,
        releaseRoot: target,
        launcher: launcherPath(prefix),
        current: packedReleaseRoot(prefix),
        manifest,
    };
}

function parseArgs(argv: readonly string[]): {
    readonly outputDirectory: string | undefined;
    readonly install: boolean;
    readonly prefix: string | undefined;
    readonly force: boolean;
} {
    let force = false;
    let install = false;
    let prefix: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--force") {
            force = true;
            continue;
        }
        if (arg === "--install") {
            install = true;
            continue;
        }
        if (arg === "--prefix") {
            prefix = argv[++i];
            if (prefix === undefined || prefix.length === 0) {
                fail("missing --prefix path");
            }
            continue;
        }
        if (arg?.startsWith("-")) {
            fail(`unknown flag: ${arg}`);
        }
        if (arg !== undefined) positional.push(arg);
    }
    if (install) {
        if (positional.length > 0) {
            fail("usage: scripts/pack-release.ts --install [--prefix DIR] [--force]");
        }
        return { outputDirectory: undefined, install: true, prefix, force };
    }
    if (prefix !== undefined) {
        fail("--prefix is only valid with --install");
    }
    if (positional.length !== 1) {
        fail("usage: scripts/pack-release.ts <output-directory> [--force]");
    }
    return {
        outputDirectory: positional[0],
        install: false,
        prefix: undefined,
        force,
    };
}

if (import.meta.main) {
    try {
        const args = parseArgs(Bun.argv.slice(2));
        if (args.install) {
            const result = await installRelease({
                force: args.force,
                ...(args.prefix === undefined ? {} : { prefix: args.prefix }),
            });
            process.stdout.write(`${result.releaseRoot}\n`);
            process.stdout.write(`${result.launcher}\n`);
            process.stdout.write(`${result.manifest.build_id}\n`);
        } else {
            const result = await packRelease(args.outputDirectory as string, {
                force: args.force,
            });
            process.stdout.write(`${result.outputDirectory}\n`);
            process.stdout.write(`${result.manifest.build_id}\n`);
        }
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}
