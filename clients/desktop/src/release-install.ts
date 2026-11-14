import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    accessSync,
    constants,
    createReadStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import { join } from "node:path";

import { activateRelease } from "../../../src/release/activate.ts";
import {
    currentReleaseBuildId,
    currentSymlinkPath,
    defaultInstallPrefix,
    launcherPath,
    RELEASE_CLI_NAME,
    releaseDirectory,
    releasesDirectory,
} from "../../../src/release/layout.ts";
import { parseReleaseManifest, type ReleaseManifest } from "../../../src/release/manifest.ts";
import { readStampedRelease } from "../../../src/release/stamp.ts";
import { verifyPackedRelease } from "../../../src/release/verify.ts";
import { compareReleaseVersions } from "../../../src/release/version-order.ts";

// Under the app's resources directory; the app builder writes these three files.
export const BUNDLED_RELEASE_DIRECTORY = "release";
export const BUNDLED_RELEASE_TARBALL = "vera-release.tar.gz";
export const BUNDLED_RELEASE_MANIFEST = "manifest.json";

// An install killed midway leaves its staging directory, which release GC skips.
const STALE_STAGING_MS = 60 * 60 * 1_000;

export type InstallDecision = "missing" | "older" | "keep";

export type InstallOutcome =
    | { readonly kind: "absent" }
    | { readonly kind: "kept"; readonly buildId: string }
    | { readonly kind: "installed"; readonly buildId: string; readonly reason: "missing" | "older" }
    // `kept` is true when a working Vera command is still in place after the failure.
    | { readonly kind: "failed"; readonly reason: string; readonly kept: boolean };

export interface InstallOptions {
    // The directory holding the three bundled release files.
    readonly bundleDirectory: string;
    readonly prefix?: string;
    // Called once, when the install is about to start and not when the installed release is kept.
    readonly onInstalling?: () => void;
}

// Equal versions are common because the product version only changes on a release, so the later build wins.
export function decideInstall(
    bundled: ReleaseManifest,
    installed: ReleaseManifest | undefined,
): InstallDecision {
    if (installed === undefined) return "missing";
    if (installed.build_id === bundled.build_id) return "keep";
    const order = compareReleaseVersions(bundled.product_version, installed.product_version);
    if (order > 0) return "older";
    if (order < 0) return "keep";
    return Date.parse(bundled.built_at) > Date.parse(installed.built_at) ? "older" : "keep";
}

export async function installBundledRelease(options: InstallOptions): Promise<InstallOutcome> {
    const prefix = options.prefix ?? defaultInstallPrefix();
    const manifestPath = join(options.bundleDirectory, BUNDLED_RELEASE_MANIFEST);
    if (!existsSync(manifestPath)) return { kind: "absent" };
    try {
        const bundled = parseReleaseManifest(readFileSync(manifestPath, "utf8"));
        const decision = decideInstall(bundled, readInstalledManifest(prefix));
        if (decision === "keep") return { kind: "kept", buildId: bundled.build_id };
        options.onInstalling?.();
        await installFromTarball(bundled, join(options.bundleDirectory, BUNDLED_RELEASE_TARBALL), prefix);
        return { kind: "installed", buildId: bundled.build_id, reason: decision };
    } catch (error) {
        return {
            kind: "failed",
            reason: error instanceof Error ? error.message : String(error),
            kept: isUsableLauncher(prefix),
        };
    }
}

// Undefined when the launcher, the current link or the release it names is not usable.
function readInstalledManifest(prefix: string): ReleaseManifest | undefined {
    if (!isUsableLauncher(prefix)) return undefined;
    try {
        return readStampedRelease(currentSymlinkPath(prefix));
    } catch {
        return undefined;
    }
}

function isUsableLauncher(prefix: string): boolean {
    if (currentReleaseBuildId(prefix) === undefined) return false;
    return isExecutable(launcherPath(prefix)) && isExecutable(join(currentSymlinkPath(prefix), RELEASE_CLI_NAME));
}

async function installFromTarball(bundled: ReleaseManifest, tarball: string, prefix: string): Promise<void> {
    await requireDigest(tarball);
    const releases = releasesDirectory(prefix);
    mkdirSync(releases, { recursive: true, mode: 0o755 });
    removeStaleStaging(releases);
    const staging = mkdtempSync(join(releases, ".install-"));
    try {
        await run("tar", ["-xzf", tarball, "-C", staging]);
        const names = readdirSync(staging);
        if (names.length !== 1 || names[0] !== bundled.build_id) {
            throw new Error(`The bundled archive does not hold exactly ${bundled.build_id}.`);
        }
        const destination = releaseDirectory(bundled.build_id, prefix);
        if (existsSync(destination) && !verifies(destination, prefix)) {
            rmSync(destination, { recursive: true, force: true });
        }
        if (!existsSync(destination)) {
            renameSync(join(staging, bundled.build_id), destination);
            try {
                verifyPackedRelease(destination, prefix);
            } catch (error) {
                rmSync(destination, { recursive: true, force: true });
                throw error;
            }
        }
        // Past this point current may already name the new release, so it is never removed.
        activateRelease(destination, prefix);
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

function removeStaleStaging(releases: string): void {
    const cutoff = Date.now() - STALE_STAGING_MS;
    for (const entry of readdirSync(releases, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(".install-")) continue;
        const path = join(releases, entry.name);
        try {
            if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
        } catch {
            // Another install may be removing it.
        }
    }
}

function verifies(releaseRoot: string, prefix: string): boolean {
    try {
        verifyPackedRelease(releaseRoot, prefix);
        return true;
    } catch {
        return false;
    }
}

async function requireDigest(tarball: string): Promise<void> {
    let expected: string;
    try {
        expected = readFileSync(`${tarball}.sha256`, "utf8").trim().split(/\s+/)[0] ?? "";
    } catch {
        throw new Error("The bundled archive has no checksum file.");
    }
    if (await sha256Of(tarball) !== expected) {
        throw new Error("The bundled archive does not match its checksum.");
    }
}

function sha256Of(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(path);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.once("error", reject);
        stream.once("end", () => resolve(hash.digest("hex")));
    });
}

function run(command: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr = `${stderr}${chunk}`.slice(-1_024);
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} exited with code ${code}. ${stderr.trim()}`.trim()));
        });
    });
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
