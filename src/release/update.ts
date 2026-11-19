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
import { exitAt } from "./exit-at.ts";
import { prefixOfReleaseRoot } from "./handoff.ts";
import {
    installRelease,
    type InstallOutcome,
    type InstallReleaseOptions,
    type PackedInstallRelease,
} from "./install.ts";
import {
    prepareShell,
    ShellHeldError,
    stageShell,
    sweepShellLeftovers,
    type ShellPlan,
    type StagedShell,
} from "./shell-update.ts";
import { readStampedRelease } from "./stamp.ts";
import { stagedReleaseBuild } from "./staged-release.ts";
import { sweepStaleStaging } from "./staging-sweep.ts";
import { acquireUpdateLock } from "./update-lock.ts";
import { formatDuration, UpdateBusyError, waitForIdleHost, type IdleWaitOptions } from "./update-wait.ts";
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

export interface ResolvedRelease extends PublishedRelease {
    readonly draft: boolean;
}

export interface ReleaseWindow {
    readonly target: ResolvedRelease;
    readonly notes: readonly ResolvedRelease[];
    readonly truncated: boolean;
}

export type UpdateInstall = (options: InstallReleaseOptions) => Promise<InstallOutcome>;

export interface UpdateWaitingSession {
    readonly id: string;
    readonly title: string;
}

export type UpdatePhase =
    | { readonly phase: "checking" }
    | {
        readonly phase: "waiting";
        readonly sessions: readonly UpdateWaitingSession[];
        readonly waitedMs: number;
        readonly limitMs: number;
    }
    | { readonly phase: "switching" };

export type UpdateReport =
    | { readonly kind: "up_to_date"; readonly version: string }
    | {
        readonly kind: "checked";
        readonly runningVersion: string;
        readonly runningBuildId: string;
        readonly targetVersion: string;
        readonly requested: boolean;
    }
    // The release is on disk but must not become current yet; `message` says why.
    | { readonly kind: "held"; readonly version: string; readonly buildId: string; readonly message: string }
    | { readonly kind: "downloaded"; readonly version: string; readonly buildId: string }
    | {
        readonly kind: "installed";
        readonly version: string;
        readonly buildId: string;
        readonly outcome: InstallOutcome;
    };

// Thrown when the signal in UpdateOptions aborts before the switch starts.
export class UpdateCancelled extends Error {
    constructor() {
        super("The update was cancelled.");
        this.name = "UpdateCancelled";
    }
}

export interface UpdateOptions extends DownloadOptions {
    readonly prefix?: string;
    readonly check?: boolean;
    // Stage the release and its desktop package, then stop before anything becomes current.
    readonly downloadOnly?: boolean;
    readonly onPhase?: (phase: UpdatePhase) => void;
    // Set by tests; the wait for busy sessions reads these.
    readonly idle?: IdleWaitOptions;
    // The run must end by this time (ms since the epoch); the wait for busy sessions shortens to fit.
    readonly deadlineAt?: number;
    // How long the whole run, and the check alone, may take in JSON mode. Tests shorten them.
    readonly runLimitMs?: number;
    readonly checkLimitMs?: number;
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
    let announced = "";
    const report = await performUpdate({
        ...options,
        onPhase: (phase) => {
            if (phase.phase === "waiting") {
                // Said once for each set of sessions, not at every poll.
                const names = phase.sessions.map((session) => session.title).join(", ");
                if (names !== announced) {
                    announced = names;
                    writeLine(
                        output,
                        `Waiting for ${names} to finish before updating`
                        + ` (up to ${formatDuration(phase.limitMs)}). Press Ctrl-C to stop waiting.`,
                    );
                }
            }
            options.onPhase?.(phase);
        },
    });
    return renderUpdateReport(report, output, errorOutput);
}

// The update as data. Throws for a failure; a held or staged-only update is a report.
export async function performUpdate(options: UpdateOptions = {}): Promise<UpdateReport> {
    const running = options.running ?? installedRunningRelease();
    const prefix = options.prefix ?? running.prefix;
    const requestedVersion = requestedVersionOf(options);

    if (requestedVersion !== undefined && compareVersions(requestedVersion, running.version) === 0) {
        return { kind: "up_to_date", version: running.version };
    }
    return await updateOnce(options, running, prefix, requestedVersion);
}

async function updateOnce(
    options: UpdateOptions,
    running: InstalledRelease,
    prefix: string,
    requestedVersion: string | undefined,
): Promise<UpdateReport> {
    options.onPhase?.({ phase: "checking" });
    const releases = await fetchReleaseWindow(options, running.version, requestedVersion);
    const target = releases.target;
    throwIfCancelled(options.signal);

    if (options.check === true) {
        return {
            kind: "checked",
            runningVersion: running.version,
            runningBuildId: running.buildId,
            targetVersion: target.version,
            requested: requestedVersion !== undefined,
        };
    }

    const comparison = compareVersions(target.version, running.version);
    if (comparison === 0) return { kind: "up_to_date", version: target.version };
    if (comparison < 0) {
        throw new Error(
            `Vera ${target.version} is older than the running Vera ${running.version}.`
            + " vera update does not downgrade. Run 'vera rollback' to restore the previous release.",
        );
    }

    // A check only reads, so it never takes the lock.
    const release = acquireUpdateLock(prefix);
    try {
        return await stageAndSwitch(options, prefix, releases, target);
    } catch (error) {
        throw diskFullError(error, target.version) ?? error;
    } finally {
        release();
    }
}

export function diskFullError(error: unknown, version: string): Error | undefined {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code !== "ENOSPC" && !/\bENOSPC\b|no space left on device/i.test(message)) return undefined;
    return new Error(`Not enough disk space to download Vera ${version}.`, { cause: error });
}

async function stageAndSwitch(
    options: UpdateOptions,
    prefix: string,
    releases: ReleaseWindow,
    target: ResolvedRelease,
): Promise<UpdateReport> {
    sweepStaleStaging(prefix);
    sweepShellLeftovers(prefix);
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
    const buildId = prepared.manifest.build_id;
    exitAt("update:release-staged");

    const platform = options.platform ?? process.platform;
    let shell: ShellPlan = { kind: "none" };
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
                hostBuildId: buildId,
                preferStored: !prepared.created,
            });
            throwIfCancelled(options.signal);
            exitAt("update:package-staged");
            if (desktop.kind === "ready") {
                shell = await prepareShell({
                    ...options,
                    prefix,
                    tag: target.tag,
                    version: target.version,
                    platform,
                    arch: options.arch ?? process.arch,
                    requiredApi: desktop.package.shellApi,
                });
                throwIfCancelled(options.signal);
            }
        } catch (error) {
            if (createdReleaseRoot !== undefined) {
                rmSync(createdReleaseRoot, { recursive: true, force: true });
            }
            throw error;
        }
        if (desktop.kind === "held") {
            return {
                kind: "held",
                version: target.version,
                buildId,
                message: desktopHeldMessage(target.version),
            };
        }
        if (shell.kind === "held") {
            return { kind: "held", version: target.version, buildId, message: shell.message };
        }
    }

    if (options.downloadOnly === true) {
        return { kind: "downloaded", version: target.version, buildId };
    }

    try {
        await waitForIdleHost({
            buildId,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
            onWaiting: (waiting) => options.onPhase?.({ phase: "waiting", ...waiting }),
            ...(options.idle === undefined ? {} : { idle: options.idle }),
        });
    } catch (error) {
        if (error instanceof UpdateBusyError) {
            return { kind: "held", version: target.version, buildId, message: error.message };
        }
        throw error;
    }
    throwIfCancelled(options.signal);

    let staged: StagedShell | undefined;
    try {
        if (shell.kind === "swap") staged = await stageShell(shell, prefix, options.signal);
        throwIfCancelled(options.signal);
    } catch (error) {
        staged?.discard();
        if (error instanceof ShellHeldError) {
            return { kind: "held", version: target.version, buildId, message: error.message };
        }
        throw error;
    }

    exitAt("update:before-switch");
    options.onPhase?.({ phase: "switching" });
    if (staged !== undefined) {
        try {
            staged.commit();
        } catch (error) {
            if (error instanceof ShellHeldError) {
                return { kind: "held", version: target.version, buildId, message: error.message };
            }
            throw error;
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
    return { kind: "installed", version: target.version, buildId, outcome };
}

export function desktopHeldMessage(version: string): string {
    return `Vera ${version} is downloaded. It turns on once the desktop app for it is released;`
        + " run 'vera update' again then.";
}

function requestedVersionOf(options: UpdateOptions): string | undefined {
    if (options.version === undefined || options.version.length === 0) return undefined;
    const requested = normalizeReleaseVersion(options.version);
    if (!isReleaseVersion(requested)) {
        throw new Error(`Invalid version '${options.version}'. Expected a version like 0.1.0.`);
    }
    return requested;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) throw new UpdateCancelled();
}

export function renderUpdateReport(
    report: UpdateReport,
    output: (text: string) => void,
    errorOutput: (text: string) => void,
): number {
    switch (report.kind) {
        case "up_to_date":
            writeLine(output, `Vera ${report.version} is up to date`);
            return 0;
        case "checked":
            writeLine(output, `Running Vera ${report.runningVersion} (${report.runningBuildId}).`);
            writeLine(
                output,
                report.requested
                    ? `Target release is Vera ${report.targetVersion}.`
                    : `Newest release is Vera ${report.targetVersion}.`,
            );
            return compareVersions(report.targetVersion, report.runningVersion) > 0 ? 10 : 0;
        case "held":
            writeLine(output, report.message);
            return 0;
        case "downloaded":
            writeLine(
                output,
                `Vera ${report.version} is downloaded. Run 'vera update' to switch to it.`,
            );
            return 0;
        case "installed":
            return printInstallOutcome(report.outcome, report.version, output, errorOutput);
    }
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

export async function fetchReleaseWindow(
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
        throwIfCancelled(options.signal);
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
    // A release staged by an earlier run is switched to without downloading it again.
    const staged = stagedReleaseBuild(prefix, target.version, platform, arch);
    if (staged !== undefined) {
        const releaseRoot = releaseDirectory(staged, prefix);
        return { releaseRoot, manifest: readStampedRelease(releaseRoot), created: false };
    }
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
