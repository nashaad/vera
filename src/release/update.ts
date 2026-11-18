import { spawnSync } from "node:child_process";
import {
    accessSync,
    constants,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { desktopInstallRecorded } from "./desktop-packages.ts";
import { readyDesktopPackage, type DesktopUpdateOutcome } from "./desktop-update.ts";
import {
    downloadToFile,
    fetchText,
    fetchWithTimeout,
    releaseAssetBase,
    verifyChecksum,
    type DownloadOptions,
} from "./download.ts";
import {
    releaseDirectory,
    releaseManifestPath,
    releasesDirectory,
    safeRealpath,
} from "./layout.ts";
import { prefixOfReleaseRoot } from "./handoff.ts";
import {
    installRelease,
    type InstallOutcome,
    type InstallReleaseOptions,
    type PackedInstallRelease,
} from "./install.ts";
import { readStampedRelease } from "./stamp.ts";
import { verifyPackedRelease } from "./verify.ts";
import {
    compareVersions,
    isReleaseVersion,
    normalizeReleaseVersion,
} from "./version.ts";

const RELEASES_PER_PAGE = 100;
const MAX_RELEASE_PAGES = 20;

export interface InstalledRelease {
    readonly root: string;
    readonly prefix: string;
    readonly version: string;
    readonly buildId: string;
}

export interface PublishedRelease {
    readonly tag: string;
    readonly version: string;
    readonly body: string;
}

interface ResolvedRelease extends PublishedRelease {
    readonly draft: boolean;
}

interface ReleaseWindow {
    readonly target: ResolvedRelease;
    readonly notes: readonly ResolvedRelease[];
    readonly truncated: boolean;
}

export type UpdateInstall = (options: InstallReleaseOptions) => Promise<InstallOutcome>;

export interface UpdateOptions extends DownloadOptions {
    readonly prefix?: string;
    readonly check?: boolean;
    readonly version?: string;
    readonly running?: InstalledRelease;
    readonly releasesApi?: string;
    readonly platform?: string;
    readonly arch?: string;
    readonly output?: (text: string) => void;
    readonly errorOutput?: (text: string) => void;
    readonly install?: UpdateInstall;
    readonly verify?: (releaseRoot: string, prefix: string) => void;
}

const UPDATE_REFUSAL =
    "vera update runs only from an installed release. This process runs from a checkout"
    + " or a development instance. Run 'bun run install:local' to pack and install it.";

// An installed process is the one whose own executable sits in releases/<build>.
export function installedRunningRelease(
    execPath: string = process.execPath,
): InstalledRelease {
    if (process.env.VERA_DEV_INSTANCE !== undefined) {
        throw new Error(UPDATE_REFUSAL);
    }
    const candidate = safeRealpath(dirname(execPath)) ?? dirname(execPath);
    if (!existsSync(releaseManifestPath(candidate))) {
        throw new Error(UPDATE_REFUSAL);
    }
    const prefix = prefixOfReleaseRoot(candidate);
    if (prefix === undefined) {
        throw new Error(UPDATE_REFUSAL);
    }
    const manifest = readStampedRelease(candidate);
    return {
        root: candidate,
        prefix,
        version: manifest.product_version,
        buildId: manifest.build_id,
    };
}

export async function runUpdate(options: UpdateOptions = {}): Promise<number> {
    const output = options.output ?? ((text: string) => process.stdout.write(text));
    const errorOutput = options.errorOutput ?? ((text: string) => process.stderr.write(text));
    const running = options.running ?? installedRunningRelease();
    const prefix = options.prefix ?? running.prefix;

    const requestedVersion = options.version === undefined || options.version.length === 0
        ? undefined
        : normalizeReleaseVersion(options.version);
    if (requestedVersion !== undefined && !isReleaseVersion(requestedVersion)) {
        throw new Error(
            `Invalid version '${options.version}'. Expected a version like 0.1.0.`,
        );
    }

    if (requestedVersion !== undefined && compareVersions(requestedVersion, running.version) === 0) {
        writeLine(output, `Vera ${running.version} is up to date`);
        return 0;
    }

    const releases = await fetchReleaseWindow(options, running.version, requestedVersion);
    const target = releases.target;

    if (options.check === true) {
        writeLine(output, `Running Vera ${running.version} (${running.buildId}).`);
        writeLine(
            output,
            requestedVersion === undefined
                ? `Newest release is Vera ${target.version}.`
                : `Target release is Vera ${target.version}.`,
        );
        return compareVersions(target.version, running.version) > 0 ? 10 : 0;
    }

    const comparison = compareVersions(target.version, running.version);
    if (comparison === 0) {
        writeLine(output, `Vera ${target.version} is up to date`);
        return 0;
    }
    if (comparison < 0) {
        throw new Error(
            `Vera ${target.version} is older than the running Vera ${running.version}.`
            + " vera update does not downgrade. Run 'vera rollback' to restore the previous release.",
        );
    }

    let createdReleaseRoot: string | undefined;
    const verify = options.verify ?? verifyPackedRelease;
    const prepared = await prepareRelease({
        ...options,
        prefix,
        target,
        notes: releases.notes,
        notesTruncated: releases.truncated,
        verify,
    });
    createdReleaseRoot = prepared.created ? prepared.releaseRoot : undefined;

    const platform = options.platform ?? process.platform;
    // A CLI-only install has no installed.json and moves on the host release alone.
    if (platform === "darwin" && desktopInstallRecorded(prefix)) {
        let desktop: DesktopUpdateOutcome;
        try {
            desktop = await readyDesktopPackage({
                ...options,
                prefix,
                tag: target.tag,
                platform,
                arch: options.arch ?? process.arch,
                hostBuildId: prepared.manifest.build_id,
            });
        } catch (error) {
            if (createdReleaseRoot !== undefined) {
                rmSync(createdReleaseRoot, { recursive: true, force: true });
            }
            throw error;
        }
        if (desktop.kind === "held") {
            writeLine(
                output,
                `Vera ${target.version} is downloaded. It turns on once the desktop app for it is released;`
                + " run 'vera update' again then.",
            );
            return 0;
        }
    }

    const install = options.install ?? installRelease;
    const outcome = await install({
        prefix,
        pack: async () => prepared,
        verify: (releaseRoot: string) => {
            try {
                verify(releaseRoot, prefix);
            } catch (error) {
                if (createdReleaseRoot !== undefined) {
                    rmSync(createdReleaseRoot, { recursive: true, force: true });
                    createdReleaseRoot = undefined;
                }
                throw error;
            }
        },
    });
    return printInstallOutcome(outcome, target.version, output, errorOutput);
}

function writeLine(output: (text: string) => void, text: string): void {
    output(`${text}\n`);
}

function releaseApiUrl(options: UpdateOptions): string {
    const configured = options.releasesApi ?? process.env.VERA_RELEASES_API;
    if (configured !== undefined && configured.length > 0) return configured;
    const repo = options.repo ?? process.env.VERA_REPO ?? "nashaad/vera";
    return `https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}`;
}

async function fetchReleaseWindow(
    options: UpdateOptions,
    runningVersion: string,
    requestedVersion: string | undefined,
): Promise<ReleaseWindow> {
    const api = releaseApiUrl(options);
    let nextUrl: string | undefined = api;
    let latest: ResolvedRelease | undefined;
    let target: ResolvedRelease | undefined;
    const notes: ResolvedRelease[] = [];
    let pages = 0;

    while (nextUrl !== undefined && pages < MAX_RELEASE_PAGES) {
        const page = await fetchReleasePage(nextUrl, options);
        pages += 1;
        for (const item of page.items) {
            const release = parsePublishedRelease(item);
            if (release === undefined || release.draft) continue;
            latest ??= release;
            if (requestedVersion !== undefined && target === undefined) {
                if (release.version === requestedVersion) target = release;
            }
            if (compareVersions(release.version, runningVersion) > 0
                && release.body.trim().length > 0) {
                notes.push(release);
            }
        }
        nextUrl = page.next;
    }

    const selected = requestedVersion === undefined ? latest : target;
    if (selected === undefined) {
        if (requestedVersion === undefined) {
            throw new Error(`No published releases were found at ${api}.`);
        }
        throw new Error(
            `Release v${requestedVersion} was not found in the published releases`
            + ` Vera reads (up to ${MAX_RELEASE_PAGES * RELEASES_PER_PAGE} entries).`,
        );
    }
    const ordered = dedupeVersions(notes)
        .filter((release) => compareVersions(release.version, selected.version) <= 0)
        .sort((left, right) => compareVersions(left.version, right.version));
    return { target: selected, notes: ordered, truncated: nextUrl !== undefined };
}

function dedupeVersions(releases: readonly ResolvedRelease[]): ResolvedRelease[] {
    const byVersion = new Map<string, ResolvedRelease>();
    for (const release of releases) byVersion.set(release.version, release);
    return [...byVersion.values()];
}

interface ReleasePage {
    readonly items: readonly unknown[];
    readonly next: string | undefined;
}

async function fetchReleasePage(url: string, options: UpdateOptions): Promise<ReleasePage> {
    return await fetchWithTimeout(url, options, {
        accept: "application/vnd.github+json",
        "user-agent": "vera-update",
    }, async (response, readBody) => {
        if (!response.ok) {
            throw new Error(`Could not fetch releases from ${url}: HTTP ${response.status}`);
        }
        const text = await readBody();
        let payload: unknown;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Release list at ${url} is not JSON: ${reason}`);
        }
        if (!Array.isArray(payload)) {
            throw new Error(`Release list at ${url} is not a JSON array.`);
        }
        return {
            items: payload,
            next: parseNextLink(response.headers.get("link")),
        };
    });
}

function parseNextLink(header: string | null): string | undefined {
    if (header === null) return undefined;
    for (const part of header.split(",")) {
        const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
        if (match !== null) return match[1];
    }
    return undefined;
}

function parsePublishedRelease(value: unknown): ResolvedRelease | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.tag_name !== "string") return undefined;
    const tag = record.tag_name;
    const version = normalizeReleaseVersion(tag);
    if (!isReleaseVersion(version)) return undefined;
    return {
        tag,
        version,
        body: typeof record.body === "string" ? record.body : "",
        draft: record.draft === true,
    };
}

function writeReleaseNotes(
    notes: readonly ResolvedRelease[],
    output: (text: string) => void,
): void {
    for (let index = 0; index < notes.length; index += 1) {
        const release = notes[index]!;
        if (index > 0) output("\n");
        writeLine(output, `Vera ${release.version}`);
        output(`${release.body.trimEnd()}\n`);
    }
}

function printInstallOutcome(
    outcome: InstallOutcome,
    version: string,
    output: (text: string) => void,
    errorOutput: (text: string) => void,
): number {
    switch (outcome.kind) {
        case "activated":
            writeLine(output, `Vera ${version} is installed.`);
            return 0;
        case "updated":
            writeLine(output, `Vera ${version} is running.`);
            return 0;
        case "accepted":
            writeLine(
                output,
                `Vera ${version} is unpacked. The running host moves to it when its running turns end.`,
            );
            return 0;
        case "restored":
            writeLine(
                errorOutput,
                `Vera update: the new host for ${version} did not start;`
                + ` ${outcome.runningBuildId ?? "the previous release"} is running.`,
            );
            return 1;
        case "no_host_started":
        case "not_moved":
            writeLine(errorOutput, `Vera update: ${outcome.message}`);
            return 1;
    }
}

function refuseUnsupportedPlatform(platform: string, arch: string): void {
    if (platform !== "darwin" && platform !== "linux") {
        throw new Error(`Unsupported OS: ${platform}`);
    }
    if (arch !== "arm64" && arch !== "x64") {
        throw new Error(`Unsupported architecture: ${arch}`);
    }
    if (platform === "linux") {
        const ldd = spawnSync("ldd", ["--version"], { encoding: "utf8" });
        const text = `${ldd.stdout ?? ""}${ldd.stderr ?? ""}`;
        if (text.toLowerCase().includes("musl")) {
            throw new Error("musl Linux is not supported; Vera needs glibc.");
        }
    }
}

interface StagedRelease {
    readonly releaseRoot: string;
    readonly manifest: PackedInstallRelease["manifest"];
    readonly created: boolean;
}

interface ReleaseDownloadOptions extends UpdateOptions {
    readonly prefix: string;
    readonly target: ResolvedRelease;
}

interface PrepareOptions extends ReleaseDownloadOptions {
    readonly notes: readonly ResolvedRelease[];
    readonly notesTruncated: boolean;
    readonly verify: (releaseRoot: string, prefix: string) => void;
}

// Everything that can fail before a handoff happens here, so installRelease and
// its recovery journal handling never run for a bad download or release.
async function prepareRelease(options: PrepareOptions): Promise<StagedRelease> {
    const prepared = await downloadAndUnpack(options);
    try {
        options.verify(prepared.releaseRoot, options.prefix);
        const output = options.output ?? ((text: string) => process.stdout.write(text));
        writeReleaseNotes(options.notes, output);
        if (options.notesTruncated) {
            const repo = options.repo ?? process.env.VERA_REPO ?? "nashaad/vera";
            writeLine(output, `More releases: https://github.com/${repo}/releases`);
        }
        return prepared;
    } catch (error) {
        if (prepared.created) {
            rmSync(prepared.releaseRoot, { recursive: true, force: true });
        }
        throw error;
    }
}

async function downloadAndUnpack(options: ReleaseDownloadOptions): Promise<StagedRelease> {
    const { prefix, target } = options;
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    refuseUnsupportedPlatform(platform, arch);
    const asset = `vera-${platform}-${arch}.tar.gz`;
    const base = releaseAssetBase(options, target.tag);
    const tarballUrl = `${base}/${asset}`;
    const checksumUrl = `${tarballUrl}.sha256`;

    const releases = releasesDirectory(prefix);
    mkdirSync(releases, { recursive: true, mode: 0o755 });
    const staging = join(releases, `.staging-${process.pid}-update`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging);
    let createdReleaseRoot: string | undefined;
    try {
        const tarball = join(staging, asset);
        const checksumFile = `${tarball}.sha256`;
        await downloadToFile(tarballUrl, tarball, options);
        writeFileSync(checksumFile, await fetchText(checksumUrl, options));
        await verifyChecksum(tarball, checksumFile, asset);

        const extractRoot = join(staging, "x");
        mkdirSync(extractRoot);
        const untar = spawnSync("tar", ["-xzf", tarball, "-C", extractRoot], { encoding: "utf8" });
        if (untar.status !== 0) {
            const detail = (untar.stderr ?? "").trim() || `tar exited ${untar.status}`;
            throw new Error(`Could not unpack ${asset}: ${detail}`);
        }
        const entries = readdirSync(extractRoot).filter((name) => !name.startsWith("."));
        if (entries.length !== 1 || !entries[0]!.startsWith("vera-")) {
            throw new Error(`${asset} does not hold one vera-<build> directory.`);
        }
        const extracted = join(extractRoot, entries[0]!);
        if (!statSync(extracted).isDirectory()) {
            throw new Error(`${asset} does not hold one vera-<build> directory.`);
        }
        if (!existsSync(releaseManifestPath(extracted))) {
            throw new Error(`${asset} has no release manifest.`);
        }
        try {
            accessSync(join(extracted, "vera"), constants.X_OK);
        } catch {
            throw new Error(`${asset} has no executable vera launcher.`);
        }
        const manifest = readStampedRelease(extracted);
        if (manifest.build_id !== entries[0]) {
            throw new Error(
                `${asset} holds ${entries[0]} but its manifest is ${manifest.build_id}.`,
            );
        }
        if (manifest.product_version !== target.version) {
            throw new Error(
                `${asset} is Vera ${manifest.product_version}, not ${target.version}.`,
            );
        }

        const finalRoot = releaseDirectory(manifest.build_id, prefix);
        if (existsSync(finalRoot)) {
            return { releaseRoot: finalRoot, manifest, created: false };
        }
        renameSync(extracted, finalRoot);
        createdReleaseRoot = finalRoot;
        return { releaseRoot: finalRoot, manifest, created: true };
    } catch (error) {
        if (createdReleaseRoot !== undefined) {
            rmSync(createdReleaseRoot, { recursive: true, force: true });
        }
        throw error;
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
