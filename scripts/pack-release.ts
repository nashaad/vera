#!/usr/bin/env bun

import {
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { processIsAlive } from "../src/host/process-identity.ts";
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
import {
    releaseSourceEntries,
    writeCheckoutPackWrappers,
} from "../src/release/wrappers.ts";
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
    const target = resolve(outputDirectory);
    const staged = await stageRelease(target, options);
    await stampRelease(target, staged.manifest);
    return {
        outputDirectory: target,
        manifest: staged.manifest,
        packed: staged.packed,
    };
}

// Writes everything but the stamp. The stamp is what marks a directory as a
// finished pack, so it is written last, by stampRelease.
async function stageRelease(
    target: string,
    options: PackReleaseOptions,
): Promise<{ readonly manifest: ReleaseManifest; readonly packed: boolean }> {
    const cwd = options.cwd ?? REPO_ROOT;
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
    writeCheckoutPackWrappers(
        target,
        process.execPath,
        releaseSourceEntries(cwd),
    );
    return { manifest, packed: packed.packed };
}

async function stampRelease(
    target: string,
    manifest: ReleaseManifest,
): Promise<void> {
    const path = releaseManifestPath(target);
    const temporary = `${path}.${process.pid}.tmp`;
    await Bun.write(temporary, serializeReleaseManifest(manifest));
    renameSync(temporary, path);
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
    const packed = await packRunnableRelease(options);
    activateRelease(packed.releaseRoot, packed.prefix);
    return {
        prefix: packed.prefix,
        releaseRoot: packed.releaseRoot,
        launcher: launcherPath(packed.prefix),
        current: packedReleaseRoot(packed.prefix),
        manifest: packed.manifest,
    };
}

/**
 * Pack a runnable tree at releases/<build-id> without pointing `current` at
 * it. Does not write ~/.vera.
 */
export async function packRunnableRelease(
    options: InstallReleaseOptions = {},
): Promise<{
    readonly prefix: string;
    readonly releaseRoot: string;
    readonly manifest: ReleaseManifest;
}> {
    const prefix = options.prefix ?? defaultInstallPrefix();
    const cwd = options.cwd ?? REPO_ROOT;
    const sourceRoot = options.sourceRoot ?? REPO_ROOT;
    const identity = releaseSourceIdentity(cwd);
    const target = releaseDirectory(identity.buildId, prefix);
    const releasesRoot = dirname(target);
    mkdirSync(releasesRoot, { recursive: true, mode: 0o755 });
    removeAbandonedPackDirectories(releasesRoot);
    let existing: ReleaseManifest | undefined;
    try {
        existing = readStampedRelease(target);
    } catch {
        existing = undefined;
    }
    if (existing?.build_id === identity.buildId && options.force !== true) {
        return { prefix, releaseRoot: target, manifest: existing };
    }
    // Built beside the target and moved in whole: copying over an existing
    // tree would nest each directory inside itself.
    const staging = join(releasesRoot, `${STAGING_PREFIX}${process.pid}-${identity.buildId}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o755 });
    let manifest: ReleaseManifest;
    try {
        const staged = await stageRelease(staging, {
            cwd,
            force: options.force ?? true,
            sourceRoot: join(sourceRoot, "clients", "annex"),
        });
        assembleRunnableRelease(staging, sourceRoot);
        await stampRelease(staging, staged.manifest);
        manifest = staged.manifest;
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    replaceReleaseDirectory(
        target,
        staging,
        join(releasesRoot, `${RETIRED_PREFIX}${process.pid}-${identity.buildId}`),
    );
    return { prefix, releaseRoot: target, manifest };
}

const STAGING_PREFIX = ".staging-";
const RETIRED_PREFIX = ".retired-";

// A crash between the two renames leaves no target and a stamped staging
// tree; the next pack's cleanup moves that tree into place.
export function replaceReleaseDirectory(
    target: string,
    staging: string,
    retired: string,
    rename: (from: string, to: string) => void = renameSync,
): void {
    rmSync(retired, { recursive: true, force: true });
    if (existsSync(target)) rename(target, retired);
    rename(staging, target);
    rmSync(retired, { recursive: true, force: true });
}

// The pid in the name says which pack made the directory; a live pid's pack
// may still be running.
function removeAbandonedPackDirectories(releasesRoot: string): void {
    for (const name of readdirSync(releasesRoot)) {
        const match = /^\.(staging|retired)-(\d+)-(.+)$/.exec(name);
        if (match === null) continue;
        const pid = Number(match[2]);
        if (pid > 0 && processIsAlive(pid)) continue;
        const path = join(releasesRoot, name);
        const target = join(releasesRoot, match[3] ?? "");
        if (
            match[1] === "staging"
            && !existsSync(target)
            && stampedBuildId(path) === match[3]
        ) {
            renameSync(path, target);
            continue;
        }
        rmSync(path, { recursive: true, force: true });
    }
}

function stampedBuildId(releaseRoot: string): string | undefined {
    try {
        return readStampedRelease(releaseRoot).build_id;
    } catch {
        return undefined;
    }
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
