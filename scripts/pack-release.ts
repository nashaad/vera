#!/usr/bin/env bun

import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { processIsAlive } from "../src/host/process-identity.ts";
import { HOST_PROTOCOL_VERSION } from "../src/host/protocol.ts";
import { activateRelease } from "../src/release/activate.ts";
import { assembleRunnableRelease } from "../src/release/assemble.ts";
import { releaseSourceIdentity } from "../src/release/build-id.ts";
import {
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
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
    CHECKOUT_PACK_WRAPPER_NAMES,
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
    const requested = resolve(outputDirectory);
    const target = checkedOutputTarget(requested, options);
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    // An unfinished tree is never worth restoring here: the next pack rebuilds it.
    removeAbandonedPackDirectories(parent, {
        restoreStaging: () => false,
        onlyNamed: basename(target),
    });
    let packed = false;
    // The annex is rebuilt in the empty staging tree every run, so force skips nothing.
    const manifest = await buildThenSwap(target, async (staging) => {
        const staged = await stageRelease(staging, options);
        await stampRelease(staging, staged.manifest);
        packed = staged.packed;
        return staged.manifest;
    });
    return { outputDirectory: requested, manifest, packed };
}

// The swap deletes what the target holds. Only a pack, an empty directory or
// nothing may be there, and never an installed release or a directory in use.
function checkedOutputTarget(requested: string, options: PackReleaseOptions): string {
    try {
        lstatSync(requested);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return requested;
        throw error;
    }
    let real: string;
    try {
        real = realpathSync(requested);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`${requested} is a symbolic link to a path that does not exist.`);
        }
        throw new Error(
            `Cannot resolve ${requested}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!statSync(real).isDirectory()) {
        throw new Error(`${requested} exists and is not a directory.`);
    }
    const inUse: ReadonlyArray<readonly [string, string]> = [
        ["the current directory", process.cwd()],
        ["the checkout being packed", options.cwd ?? REPO_ROOT],
        ["the source root", options.sourceRoot ?? REPO_ROOT],
    ];
    for (const [label, path] of inUse) {
        if (isSameOrInside(real, realpathOrSelf(path))) {
            throw new Error(
                `Refusing to replace ${requested}: it is or contains ${label}, ${path}. `
                    + "Nothing was deleted.",
            );
        }
    }
    if (isInstalledRelease(real)) {
        throw new Error(
            `Refusing to replace ${requested}: it is an installed release (${real}). `
                + "Nothing was deleted.",
        );
    }
    if (!hasPackStamp(real)) {
        const foreign = readdirSync(real).filter((name) => !packWritesName(name));
        if (foreign.length > 0) {
            throw new Error(
                `Refusing to replace ${requested}: it is not empty and has no release `
                    + `stamp, so it is not a pack (it holds ${foreign.join(", ")}). `
                    + "Nothing was deleted. Choose another output directory, or "
                    + "remove this one yourself.",
            );
        }
    }
    return real;
}

// An unstamped directory holding only these is pack:web output or a pack that died before its
// stamp. The stamp's own name is left out: a manifest.json that names no build is not a pack's.
function packWritesName(name: string): boolean {
    return name === basename(packedAnnexRoot(""))
        || CHECKOUT_PACK_WRAPPER_NAMES.includes(name);
}

// A checkout pack has no CLI or host wrapper, and installs live under releases/.
function isInstalledRelease(directory: string): boolean {
    return basename(dirname(directory)) === "releases"
        || existsSync(join(directory, RELEASE_CLI_NAME))
        || existsSync(join(directory, RELEASE_HOST_NAME));
}

// Any stamp that names a build counts, so a pack from another layout version is still replaceable.
function hasPackStamp(directory: string): boolean {
    try {
        const stamp: unknown = JSON.parse(readFileSync(releaseManifestPath(directory), "utf8"));
        if (stamp === null || typeof stamp !== "object" || Array.isArray(stamp)) return false;
        const buildId = (stamp as Record<string, unknown>).build_id;
        return typeof buildId === "string" && buildId.length > 0;
    } catch {
        return false;
    }
}

function realpathOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

function isSameOrInside(directory: string, candidate: string): boolean {
    const path = relative(directory, candidate);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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
        relaunch_record_version: 1,
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
    removeAbandonedPackDirectories(releasesRoot, {
        restoreStaging: (path, name) => stampedBuildId(path) === name,
    });
    let existing: ReleaseManifest | undefined;
    try {
        existing = readStampedRelease(target);
    } catch {
        existing = undefined;
    }
    if (existing?.build_id === identity.buildId && options.force !== true) {
        return { prefix, releaseRoot: target, manifest: existing };
    }
    const manifest = await buildThenSwap(target, async (staging) => {
        const staged = await stageRelease(staging, {
            cwd,
            force: options.force ?? true,
            sourceRoot: join(sourceRoot, "clients", "annex"),
        });
        await assembleRunnableRelease(staging, sourceRoot);
        await stampRelease(staging, staged.manifest);
        return staged.manifest;
    });
    return { prefix, releaseRoot: target, manifest };
}

export interface PackedTarball {
    readonly path: string;
    readonly digestPath: string;
    readonly manifest: ReleaseManifest;
}

/**
 * Pack a runnable release and archive it as `<build-id>/...` in a gzip tarball,
 * the shape install.sh extracts into releases/. Writes `<path>.sha256` beside it.
 */
export async function packReleaseTarball(
    path: string,
    options: Omit<InstallReleaseOptions, "prefix"> = {},
): Promise<PackedTarball> {
    const target = resolve(path);
    if (!target.endsWith(".tar.gz")) {
        throw new Error(`tarball path must end in .tar.gz: ${target}`);
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    const prefix = join(dirname(target), `.tarball-${process.pid}`);
    rmSync(prefix, { recursive: true, force: true });
    try {
        const packed = await packRunnableRelease({ ...options, prefix, force: true });
        const releasesRoot = dirname(packed.releaseRoot);
        const temporary = `${target}.${process.pid}.tmp`;
        const tar = Bun.spawnSync(
            ["tar", "-czf", temporary, "-C", releasesRoot, packed.manifest.build_id],
            { stdout: "inherit", stderr: "inherit" },
        );
        if (tar.exitCode !== 0) {
            rmSync(temporary, { force: true });
            throw new Error(`tar exited with ${tar.exitCode}`);
        }
        renameSync(temporary, target);
        const digest = new Bun.CryptoHasher("sha256")
            .update(readFileSync(target))
            .digest("hex");
        const digestPath = `${target}.sha256`;
        writeFileSync(digestPath, `${digest}  ${basename(target)}\n`);
        return { path: target, digestPath, manifest: packed.manifest };
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
}

// Built beside the target and moved in whole: building in place leaves a mixed tree
// when the build fails, and copying over an existing tree nests each directory in itself.
export async function buildThenSwap(
    target: string,
    build: (staging: string) => Promise<ReleaseManifest>,
    rename: (from: string, to: string) => void = renameSync,
): Promise<ReleaseManifest> {
    const parent = dirname(target);
    const name = basename(target);
    const staging = join(parent, `${STAGING_PREFIX}${process.pid}-${name}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o755 });
    try {
        const manifest = await build(staging);
        const retired = join(parent, `${RETIRED_PREFIX}${process.pid}-${name}`);
        try {
            replaceReleaseDirectory(target, staging, retired, rename);
        } catch (error) {
            settleFailedSwap(target, retired);
            // A concurrent pack of the same build won the swap; its tree is as good as ours.
            if (!lostSwapToSameBuild(error, target, manifest.build_id)) throw error;
        }
        return manifest;
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

// The old tree is back in place unless another pack took the slot; then it is dropped.
function settleFailedSwap(target: string, retired: string): void {
    if (!existsSync(retired)) return;
    if (existsSync(target)) rmSync(retired, { recursive: true, force: true });
    else renameSync(retired, target);
}

function lostSwapToSameBuild(error: unknown, target: string, buildId: string): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") return false;
    return stampedBuildId(target) === buildId;
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
    if (existsSync(target)) {
        try {
            rename(target, retired);
        } catch (error) {
            // A concurrent pack moved the target aside first. Take the empty slot,
            // or lose to its staging tree with ENOTEMPTY or EEXIST.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    rename(staging, target);
    try {
        rmSync(retired, { recursive: true, force: true });
    } catch {
        // The new tree is in place; the next pack removes this directory.
    }
}

// The pid in the name says which pack made the directory; a live pid's pack may still run.
// restoreStaging says whether a staging tree is a finished pack a crashed swap left behind.
function removeAbandonedPackDirectories(
    parent: string,
    options: {
        readonly restoreStaging: (path: string, name: string) => boolean;
        // The parent may hold other packs' directories: leave those alone.
        readonly onlyNamed?: string;
    },
): void {
    for (const entry of readdirSync(parent)) {
        const match = /^\.(staging|retired)-(\d+)-(.+)$/.exec(entry);
        if (match === null) continue;
        const name = match[3] ?? "";
        if (options.onlyNamed !== undefined && name !== options.onlyNamed) continue;
        const pid = Number(match[2]);
        if (pid > 0 && processIsAlive(pid)) continue;
        const path = join(parent, entry);
        const target = join(parent, name);
        if (
            match[1] === "staging"
            && !existsSync(target)
            && options.restoreStaging(path, name)
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
    readonly tarball: string | undefined;
    readonly prefix: string | undefined;
    readonly force: boolean;
} {
    let force = false;
    let install = false;
    let tarball: string | undefined;
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
        if (arg === "--tarball") {
            tarball = argv[++i];
            if (tarball === undefined || tarball.length === 0) {
                fail("missing --tarball path");
            }
            continue;
        }
        if (arg?.startsWith("-")) {
            fail(`unknown flag: ${arg}`);
        }
        if (arg !== undefined) positional.push(arg);
    }
    if (tarball !== undefined) {
        if (install || prefix !== undefined || positional.length > 0) {
            fail("usage: scripts/pack-release.ts --tarball FILE.tar.gz");
        }
        return { outputDirectory: undefined, install: false, tarball, prefix, force };
    }
    if (install) {
        if (positional.length > 0) {
            fail("usage: scripts/pack-release.ts --install [--prefix DIR] [--force]");
        }
        return { outputDirectory: undefined, install: true, tarball, prefix, force };
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
        tarball: undefined,
        prefix: undefined,
        force,
    };
}

if (import.meta.main) {
    try {
        const args = parseArgs(Bun.argv.slice(2));
        if (args.tarball !== undefined) {
            const result = await packReleaseTarball(args.tarball);
            process.stdout.write(`${result.path}\n`);
            process.stdout.write(`${result.manifest.build_id}\n`);
        } else if (args.install) {
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
