import { spawn, spawnSync } from "node:child_process";
import {
    accessSync,
    constants,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { processIsAlive } from "../host/process-identity.ts";
import { readDesktopPackageHolds } from "./desktop-package-references.ts";
import { desktopInstallRecordPath, desktopShellDownloadsDirectory } from "./layout.ts";
import { tarMemberText } from "./desktop-packages.ts";
import {
    DownloadStatusError,
    downloadToFile,
    fetchText,
    releaseAssetBase,
    verifyChecksum,
    type DownloadOptions,
} from "./download.ts";
import { exitAt } from "./exit-at.ts";
import { swapPaths } from "./swap-paths.ts";

export const SHELL_BUNDLE_ID = "dev.vera.desktop";
const SHELL_APP_NAME = "Vera.app";
const SHELL_MARKER = "Contents/Resources/vera-shell.json";
// Every shell that shipped carries at least this API, so a package that needs no more is never a reason to replace one.
const OLDEST_SHELL_API = 1;

export function shellAssetName(platform: string, arch: string): string {
    return `vera-desktop-shell-${platform}-${arch}.tar.gz`;
}

// A hold is a reason the update waits with nothing switched; the message is what the user reads.
export class ShellHeldError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ShellHeldError";
    }
}

export interface DesktopInstallRecord {
    readonly appPath: string;
}

export function readDesktopInstallRecord(prefix: string): DesktopInstallRecord | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(desktopInstallRecordPath(prefix), "utf8"));
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const appPath = (parsed as Record<string, unknown>).app_path;
        return typeof appPath === "string" && isAbsolute(appPath) ? { appPath } : undefined;
    } catch {
        return undefined;
    }
}

// The shell API of the app at a path, or undefined when it is not a Vera shell.
export function installedShellApi(appPath: string): number | undefined {
    try {
        if (!lstatSync(appPath).isDirectory()) return undefined;
        if (bundleIdentifier(join(appPath, "Contents", "Info.plist")) !== SHELL_BUNDLE_ID) return undefined;
        return markerShellApi(readFileSync(join(appPath, SHELL_MARKER), "utf8"));
    } catch {
        return undefined;
    }
}

function markerShellApi(text: string): number | undefined {
    try {
        const parsed: unknown = JSON.parse(text);
        const api = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).shell_api : undefined;
        return typeof api === "number" && Number.isInteger(api) ? api : undefined;
    } catch {
        return undefined;
    }
}

function bundleIdentifier(plist: string): string | undefined {
    const text = readFileSync(plist, "utf8");
    if (text.startsWith("<?xml")) {
        return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
    }
    const converted = spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist], { encoding: "utf8" });
    return converted.status === 0 ? converted.stdout.trim() : undefined;
}

export type ShellNeed =
    | { readonly kind: "current" }
    | { readonly kind: "swap"; readonly appPath: string }
    | { readonly kind: "held"; readonly message: string };

// Whether the installed desktop app can run a package that needs shell API `requiredApi`. Reads the disk only.
export function inspectShell(prefix: string, requiredApi: number, version: string): ShellNeed {
    const record = readDesktopInstallRecord(prefix);
    if (record === undefined || requiredApi <= OLDEST_SHELL_API) return { kind: "current" };
    const appPath = record.appPath;
    const present = existsAt(appPath);
    const api = installedShellApi(appPath);
    if (api !== undefined && api >= requiredApi) return { kind: "current" };
    const needs = `Vera ${version} needs a newer desktop app`;
    if (!present) {
        return {
            kind: "held",
            message: `${needs}, but there is no app at ${appPath}. Nothing was changed. Run the Vera installer to add it.`,
        };
    }
    if (api === undefined) {
        return {
            kind: "held",
            message: `${needs}, but ${appPath} is not the Vera desktop app, so it was left alone and nothing was changed.`
                + " Move it away and run the Vera installer.",
        };
    }
    try {
        accessSync(dirname(appPath), constants.W_OK);
    } catch {
        return {
            kind: "held",
            message: `${needs}, but ${dirname(appPath)} is not writable, so nothing was changed.`
                + " Run the Vera installer to update the app.",
        };
    }
    return { kind: "swap", appPath };
}

export type ShellPlan =
    | { readonly kind: "none" }
    | { readonly kind: "held"; readonly message: string }
    | {
        readonly kind: "swap";
        readonly appPath: string;
        readonly tarball: string;
        readonly requiredApi: number;
        readonly version: string;
    };

export interface ShellPrepareOptions extends DownloadOptions {
    readonly prefix: string;
    readonly tag: string;
    readonly version: string;
    readonly platform: string;
    readonly arch: string;
    readonly requiredApi: number;
}

export function cachedShellTarball(prefix: string, tag: string, platform: string, arch: string): string {
    return join(desktopShellDownloadsDirectory(prefix), tag, shellAssetName(platform, arch));
}

// Downloads and checks the app shell archive when the installed shell is too old for the package. Nothing outside the cache changes.
export async function prepareShell(options: ShellPrepareOptions): Promise<ShellPlan> {
    const need = inspectShell(options.prefix, options.requiredApi, options.version);
    if (need.kind === "current") return { kind: "none" };
    if (need.kind === "held") return need;
    const tarball = cachedShellTarball(options.prefix, options.tag, options.platform, options.arch);
    const plan: ShellPlan = {
        kind: "swap",
        appPath: need.appPath,
        tarball,
        requiredApi: options.requiredApi,
        version: options.version,
    };
    if (existsSync(tarball)) return plan;
    const asset = shellAssetName(options.platform, options.arch);
    const url = `${releaseAssetBase(options, options.tag)}/${asset}`;
    let checksumText: string;
    try {
        checksumText = await fetchText(`${url}.sha256`, options);
    } catch (error) {
        if (error instanceof DownloadStatusError && error.status === 404) {
            return {
                kind: "held",
                message: `Vera ${options.version} needs a newer desktop app, and the release does not include one yet.`
                    + " It turns on once the app is released; run 'vera update' again then.",
            };
        }
        throw error;
    }
    const directory = dirname(tarball);
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    const partial = join(directory, `.${asset}.${process.pid}.part`);
    const checksumFile = `${partial}.sha256`;
    try {
        writeFileSync(checksumFile, checksumText);
        await downloadToFile(url, partial, options);
        await verifyChecksum(partial, checksumFile, asset);
        const problem = await archiveProblem(partial, options.requiredApi);
        if (problem !== undefined) {
            return { kind: "held", message: `${asset} ${problem}. Nothing was changed.` };
        }
        renameSync(partial, tarball);
    } finally {
        rmSync(partial, { force: true });
        rmSync(checksumFile, { force: true });
    }
    return plan;
}

// The archive holds only Vera.app, stays inside its directory and carries a shell that is new enough.
async function archiveProblem(tarball: string, requiredApi: number): Promise<string | undefined> {
    const listing = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (listing.status !== 0) return "could not be read";
    const tops = new Set<string>();
    for (const line of listing.stdout.split("\n")) {
        const name = line.trim();
        if (name.length === 0 || name === "./") continue;
        if (name.startsWith("/") || name.split("/").includes("..")) return "holds a path outside its directory";
        tops.add(name.replace(/^\.\//, "").split("/")[0]!);
    }
    if (tops.size !== 1 || !tops.has(SHELL_APP_NAME)) return "does not hold only Vera.app";
    for (const member of [`./${SHELL_APP_NAME}/${SHELL_MARKER}`, `${SHELL_APP_NAME}/${SHELL_MARKER}`]) {
        const text = await tarMemberText(tarball, member).catch(() => undefined);
        if (text === undefined) continue;
        const api = markerShellApi(text);
        if (api === undefined) return "does not hold the Vera desktop app";
        return api < requiredApi ? "is older than the desktop package needs" : undefined;
    }
    return "does not hold the Vera desktop app";
}

export type SwapPaths = (first: string, second: string) => boolean;

export interface StagedShell {
    // Replaces the app in one exchange, or by two renames when the volume cannot exchange.
    readonly commit: () => void;
    readonly discard: () => void;
}

// Unpacks the archive beside the installed app, where one rename can put it in place. Throws ShellHeldError when what came out is not a new enough Vera shell.
export async function stageShell(
    plan: Extract<ShellPlan, { kind: "swap" }>,
    prefix: string,
    signal?: AbortSignal,
    swap: SwapPaths = swapPaths,
): Promise<StagedShell> {
    const directory = dirname(plan.appPath);
    const staged = join(directory, `.Vera.app.new-${process.pid}`);
    const unpacked = join(directory, `.Vera.app.x-${process.pid}`);
    const discard = (): void => {
        rmSync(staged, { recursive: true, force: true });
        rmSync(unpacked, { recursive: true, force: true });
    };
    discard();
    try {
        mkdirSync(unpacked);
        const status = await untar(plan.tarball, unpacked, signal);
        if (status !== 0) {
            signal?.throwIfAborted();
            rmSync(plan.tarball, { force: true });
            throw new Error("Could not unpack the desktop app download. Run the update again to fetch it again.");
        }
        const entries = readdirSync(unpacked);
        const app = join(unpacked, SHELL_APP_NAME);
        const api = entries.length === 1 && entries[0] === SHELL_APP_NAME ? installedShellApi(app) : undefined;
        if (api === undefined) {
            rmSync(plan.tarball, { force: true });
            throw new ShellHeldError(
                `The desktop app in the Vera ${plan.version} release is not the Vera desktop app, so nothing was changed.`,
            );
        }
        if (api < plan.requiredApi) {
            rmSync(plan.tarball, { force: true });
            throw new ShellHeldError(
                `The desktop app in the Vera ${plan.version} release is older than its desktop package needs, so nothing was changed.`,
            );
        }
        spawnSync("xattr", ["-dr", "com.apple.quarantine", app], { stdio: "ignore" });
        renameSync(app, staged);
        rmSync(unpacked, { recursive: true, force: true });
    } catch (error) {
        discard();
        throw error;
    }
    return {
        discard,
        commit: () => commitShell(plan.appPath, staged, prefix, swap),
    };
}

function commitShell(appPath: string, staged: string, prefix: string, swap: SwapPaths): void {
    const aside = join(dirname(appPath), `.Vera.app.old-${process.pid}`);
    rmSync(aside, { recursive: true, force: true });
    const hadApp = existsAt(appPath);
    if (hadApp && swap(staged, appPath)) {
        // One exchange: Vera.app is never missing. The old app now sits under the staging name.
        exitAt("shell:placed");
        try {
            renameSync(staged, aside);
        } catch {
            // The next update removes it from under the staging name.
        }
    } else {
        try {
            if (hadApp) renameSync(appPath, aside);
            exitAt("shell:aside");
            renameSync(staged, appPath);
        } catch (error) {
            if (hadApp && !existsAt(appPath) && existsAt(aside)) renameSync(aside, appPath);
            rmSync(staged, { recursive: true, force: true });
            throw new ShellHeldError(
                `Could not replace the desktop app at ${appPath}: ${error instanceof Error ? error.message : String(error)}.`
                + " The previous app is in place and nothing was changed.",
            );
        }
        exitAt("shell:placed");
    }
    // A running desktop still reads from the old bundle, so it stays until the next update finds none running.
    if (!desktopIsRunning(prefix)) rmSync(aside, { recursive: true, force: true });
    rmSync(desktopShellDownloadsDirectory(prefix), { recursive: true, force: true });
}

// What a killed update left beside the app. A missing app comes back from its aside first.
export function sweepShellLeftovers(prefix: string): void {
    const record = readDesktopInstallRecord(prefix);
    if (record === undefined) return;
    const directory = dirname(record.appPath);
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch {
        return;
    }
    const dead = (name: string, pattern: RegExp): boolean => {
        const match = pattern.exec(name);
        return match !== null && !processIsAlive(Number(match[1]));
    };
    for (const name of names) {
        if (dead(name, /^\.Vera\.app\.(?:new|x)-(\d+)$/)) {
            rmSync(join(directory, name), { recursive: true, force: true });
        }
    }
    for (const name of names) {
        if (!dead(name, /^\.Vera\.app\.old-(\d+)$/)) continue;
        const aside = join(directory, name);
        if (!existsAt(record.appPath)) {
            try {
                renameSync(aside, record.appPath);
            } catch {
                // The aside stays where it is for the next run.
            }
        } else if (!desktopIsRunning(prefix)) {
            rmSync(aside, { recursive: true, force: true });
        }
    }
}

function desktopIsRunning(prefix: string): boolean {
    try {
        const holds = readDesktopPackageHolds(prefix);
        return holds.held.size > 0 || holds.unreadable;
    } catch {
        return true;
    }
}

function existsAt(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

function untar(tarball: string, into: string, signal: AbortSignal | undefined): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawn("tar", ["-xzf", tarball, "-C", into], {
            stdio: "ignore",
            ...(signal === undefined ? {} : { signal }),
        });
        child.on("error", (error) => {
            if ((error as NodeJS.ErrnoException).name === "AbortError") reject(signal?.reason ?? error);
            else reject(error);
        });
        child.on("close", (code) => resolve(code));
    });
}
