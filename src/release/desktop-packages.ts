import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
    createReadStream,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
    DESKTOP_PACKAGE_MANIFEST_NAME,
    isSafeHostBuildId,
    parseDesktopPackageManifest,
} from "./desktop-package-manifest.ts";
import {
    defaultInstallPrefix,
    desktopPackageDirectory,
    desktopPackagesDirectory,
} from "./layout.ts";
import { isReleaseVersion } from "./version.ts";
import { compareReleaseVersions } from "./version-order.ts";

const MAX_MANIFEST_BYTES = 64 * 1024;

export interface DesktopPackage {
    readonly hostBuildId: string;
    readonly desktopVersion: string;
    readonly directory: string;
    readonly entryPath: string;
    readonly shellApi: number;
}

export interface DesktopPackageIdentity {
    readonly hostBuildId: string;
    readonly desktopVersion: string;
}

export interface DesktopPackageScan {
    // Newest first.
    readonly valid: readonly DesktopPackage[];
    // Directory names that hold no usable package.
    readonly invalid: readonly string[];
}

export interface InstallDesktopPackageOptions extends DesktopPackageIdentity {
    readonly tarball: string;
    readonly sha256: string;
    readonly prefix?: string;
}

export interface InstalledDesktopPackage {
    // False when the version was already installed and nothing was written.
    readonly installed: boolean;
    readonly package: DesktopPackage;
}

// Throws unless the directory holds the named package whole: a manifest that names this host build and version, and its entry file.
export function readDesktopPackage(
    directory: string,
    expected: DesktopPackageIdentity,
): DesktopPackage {
    const manifestPath = join(directory, DESKTOP_PACKAGE_MANIFEST_NAME);
    let manifestText: string;
    try {
        if (lstatSync(manifestPath).size > MAX_MANIFEST_BYTES) {
            throw new Error(`${DESKTOP_PACKAGE_MANIFEST_NAME} is larger than ${MAX_MANIFEST_BYTES} bytes`);
        }
        manifestText = readFileSync(manifestPath, "utf8");
    } catch (error) {
        throw new Error(`Desktop package at ${directory} has no readable manifest: ${errorText(error)}`);
    }
    const manifest = parseDesktopPackageManifest(manifestText);
    if (manifest.host_build_id !== expected.hostBuildId) {
        throw new Error(
            `Desktop package at ${directory} targets host build ${manifest.host_build_id}, not ${expected.hostBuildId}.`,
        );
    }
    if (manifest.desktop_version !== expected.desktopVersion) {
        throw new Error(
            `Desktop package at ${directory} is version ${manifest.desktop_version}, not ${expected.desktopVersion}.`,
        );
    }
    const entryPath = join(directory, manifest.entry);
    try {
        if (!lstatSync(entryPath).isFile()) throw new Error("not a file");
        // A symlinked directory on the way could point the entry outside the package.
        if (!realpathSync(entryPath).startsWith(`${realpathSync(directory)}${sep}`)) {
            throw new Error("outside the package");
        }
    } catch (error) {
        throw new Error(`Desktop package at ${directory} has no usable entry ${manifest.entry}: ${errorText(error)}`);
    }
    return {
        hostBuildId: manifest.host_build_id,
        desktopVersion: manifest.desktop_version,
        directory,
        entryPath,
        shellApi: manifest.shell_api,
    };
}

// Hidden directories are installs and collections in flight, never packages.
export function scanDesktopPackages(
    hostBuildId: string,
    prefix = defaultInstallPrefix(),
): DesktopPackageScan {
    const hostDirectory = join(desktopPackagesDirectory(prefix), hostBuildId);
    let names: string[];
    try {
        names = readdirSync(hostDirectory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => entry.name);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { valid: [], invalid: [] };
        throw error;
    }
    const valid: DesktopPackage[] = [];
    const invalid: string[] = [];
    for (const name of names) {
        const found = isReleaseVersion(name)
            ? tryReadDesktopPackage(join(hostDirectory, name), { hostBuildId, desktopVersion: name })
            : undefined;
        if (found === undefined) invalid.push(name);
        else valid.push(found);
    }
    valid.sort((a, b) =>
        compareReleaseVersions(b.desktopVersion, a.desktopVersion)
        || a.desktopVersion.localeCompare(b.desktopVersion));
    return { valid, invalid };
}

export function findDesktopPackage(
    hostBuildId: string,
    prefix = defaultInstallPrefix(),
): DesktopPackage | undefined {
    if (!isSafeHostBuildId(hostBuildId)) return undefined;
    return scanDesktopPackages(hostBuildId, prefix).valid[0];
}

// The package reaches its final path by one rename of a finished directory, so no reader sees it half written.
export async function installDesktopPackage(
    options: InstallDesktopPackageOptions,
): Promise<InstalledDesktopPackage> {
    const prefix = options.prefix ?? defaultInstallPrefix();
    const expected = { hostBuildId: options.hostBuildId, desktopVersion: options.desktopVersion };
    if (!isSafeHostBuildId(expected.hostBuildId)) {
        throw new Error(`'${expected.hostBuildId}' cannot name a host build directory.`);
    }
    if (!isReleaseVersion(expected.desktopVersion)) {
        throw new Error(`Invalid version '${expected.desktopVersion}'. Expected a version like 0.1.0.`);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(options.sha256)) {
        throw new Error("The expected checksum is not a SHA-256 sum.");
    }
    const destination = desktopPackageDirectory(expected.hostBuildId, expected.desktopVersion, prefix);
    const present = tryReadDesktopPackage(destination, expected);
    if (present !== undefined) return { installed: false, package: present };

    const actual = await sha256OfFile(options.tarball);
    if (actual !== options.sha256.toLowerCase()) {
        throw new Error(`Checksum mismatch for ${basename(options.tarball)}.`);
    }
    const temporary = join(dirname(destination), `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(temporary, { recursive: true, mode: 0o755 });
    try {
        await unpack(options.tarball, temporary);
        readDesktopPackage(temporary, expected);
        if (existsSync(destination)) {
            const raced = tryReadDesktopPackage(destination, expected);
            if (raced !== undefined) return { installed: false, package: raced };
            rmSync(destination, { recursive: true, force: true });
        }
        try {
            renameSync(temporary, destination);
        } catch (error) {
            const winner = tryReadDesktopPackage(destination, expected);
            if (winner === undefined) throw error;
            return { installed: false, package: winner };
        }
        return { installed: true, package: readDesktopPackage(destination, expected) };
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

function tryReadDesktopPackage(
    directory: string,
    expected: DesktopPackageIdentity,
): DesktopPackage | undefined {
    try {
        return readDesktopPackage(directory, expected);
    } catch {
        return undefined;
    }
}

async function sha256OfFile(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
}

function unpack(tarball: string, into: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn("tar", ["-xzf", resolve(tarball), "-C", into], {
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
            if (stderr.length < 4096) stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolvePromise();
                return;
            }
            const detail = stderr.trim() || `tar exited ${code}`;
            reject(new Error(`Could not unpack ${basename(tarball)}: ${detail}`));
        });
    });
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
