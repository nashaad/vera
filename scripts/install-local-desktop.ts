import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { installDesktopPackage, type DesktopPackage } from "../src/release/desktop-packages.ts";
import { processExecutables } from "../src/release/gc.ts";
import { userHome } from "../src/release/layout.ts";
import { VERA_PRODUCT_VERSION } from "../src/release/manifest.ts";
import {
    ShellHeldError,
    installedShellApi,
    stageShell,
    sweepShellLeftovers,
    writeDesktopInstallRecord,
} from "../src/release/shell-update.ts";
import { buildDesktopForHostBuild, type BuildDesktopForHostOptions } from "./desktop-release/build-for-host.ts";
import type { DesktopRelease } from "./desktop-release/release-build.ts";

export interface LocalDesktopSettings {
    readonly desktopVersion?: string;
    // The folder that holds Vera.app. Defaults to the one install.sh picks.
    readonly applicationsDirectory?: string;
    readonly build?: (options: BuildDesktopForHostOptions) => Promise<DesktopRelease>;
    // Throws when it cannot tell.
    readonly isRunning?: (appPath: string) => boolean;
    readonly platform?: string;
    // The home whose ~/.local is the only prefix the desktop app can use. Defaults to the user's home.
    readonly home?: string;
}

export interface LocalDesktopOptions extends LocalDesktopSettings {
    readonly prefix: string;
    // The host build the package is matched to.
    readonly buildId: string;
    readonly report?: (line: string) => void;
}

export type LocalDesktopOutcome =
    | { readonly kind: "installed"; readonly appPath: string }
    | { readonly kind: "replaced"; readonly appPath: string }
    | { readonly kind: "kept"; readonly appPath: string }
    // The app needs replacing and is running, so it was left as it is.
    | { readonly kind: "running"; readonly appPath: string }
    // The prefix is not ~/.local, the only place the desktop app finds Vera.
    | { readonly kind: "other_prefix" }
    | { readonly kind: "failed"; readonly message: string };

const APP_NAME = "Vera.app";

// Compares the way install.sh does: one trailing slash is dropped, nothing is resolved.
export function isDesktopPrefix(prefix: string, home = userHome()): boolean {
    return (prefix.endsWith("/") ? prefix.slice(0, -1) : prefix) === `${home}/.local`;
}

// The line install:local prints about the desktop app. Only a failure makes the command exit 1.
export function describeDesktopOutcome(outcome: LocalDesktopOutcome): { readonly line: string; readonly failure: boolean } {
    switch (outcome.kind) {
        case "installed":
        case "replaced":
        case "kept":
            return { line: `vera install:local: ${outcome.kind} the desktop app at ${outcome.appPath}`, failure: false };
        case "running":
            return {
                line: `vera install:local: the desktop app at ${outcome.appPath} needs replacing and Vera is running. Quit Vera and run this again.`,
                failure: false,
            };
        case "other_prefix":
            return { line: "The desktop app needs Vera in ~/.local; it was not installed.", failure: false };
        case "failed":
            return { line: `vera install:local: the desktop app was not installed: ${outcome.message}`, failure: true };
    }
}

// The same choice install.sh makes, so both installers put the app in one place.
export function chooseApplicationsDirectory(
    env: NodeJS.ProcessEnv = process.env,
    home = userHome(),
): string {
    const system = env.VERA_INSTALL_APPLICATIONS || "/Applications";
    const apps = isWritableDirectory(system) ? system : join(home, "Applications");
    if (!isAbsolute(apps)) throw new Error(`the Applications directory must be an absolute path: ${apps}`);
    return apps;
}

// Builds the desktop package for one host build and installs it, then installs or updates Vera.app and records it.
// Never throws: a desktop problem comes back as `failed` so the host install carries on.
export async function installLocalDesktop(options: LocalDesktopOptions): Promise<LocalDesktopOutcome> {
    const scratch = mkdtempSync(join(tmpdir(), "vera-desktop-local-"));
    try {
        const version = options.desktopVersion ?? VERA_PRODUCT_VERSION;
        options.report?.(`Building the desktop app for ${options.buildId}.`);
        const built = await (options.build ?? buildDesktopForHostBuild)({
            hostBuildId: options.buildId,
            desktopVersion: version,
            arch: process.arch,
            outputDirectory: scratch,
        });
        const installed = await installDesktopPackage({
            tarball: built.desktopPackage.path,
            sha256: built.desktopPackage.sha256,
            hostBuildId: options.buildId,
            desktopVersion: version,
            prefix: options.prefix,
        });
        return await placeApp(options, installed.package, built.shell.path, version);
    } catch (error) {
        return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

async function placeApp(
    options: LocalDesktopOptions,
    desktopPackage: DesktopPackage,
    shellArchive: string,
    version: string,
): Promise<LocalDesktopOutcome> {
    const apps = options.applicationsDirectory ?? chooseApplicationsDirectory();
    const appPath = join(apps, APP_NAME);
    sweepShellLeftovers(options.prefix);
    const present = existsAt(appPath);
    const api = present ? installedShellApi(appPath) : undefined;
    if (present && api === undefined) {
        return failed(`${appPath} is not the Vera desktop app, so it was left alone. Move it away and run this again.`);
    }
    if (api !== undefined && api >= desktopPackage.shellApi) {
        writeDesktopInstallRecord(options.prefix, appPath);
        return { kind: "kept", appPath };
    }
    if (present) {
        let running: boolean;
        try {
            running = (options.isRunning ?? shellIsRunning)(appPath);
        } catch {
            return failed("could not tell whether Vera is running. Quit Vera and run this again.");
        }
        if (running) {
            writeDesktopInstallRecord(options.prefix, appPath);
            return { kind: "running", appPath };
        }
    }
    mkdirSync(apps, { recursive: true });
    try {
        const staged = await stageShell(
            { kind: "swap", appPath, tarball: shellArchive, requiredApi: desktopPackage.shellApi, version },
            options.prefix,
        );
        staged.commit();
    } catch (error) {
        if (error instanceof ShellHeldError) return failed(error.message);
        throw error;
    }
    writeDesktopInstallRecord(options.prefix, appPath);
    return { kind: present ? "replaced" : "installed", appPath };
}

// True when a process runs from inside the app, by its path or by the path it resolves to.
export function shellIsRunning(
    appPath: string,
    listExecutables: () => readonly string[] = processExecutables,
): boolean {
    const roots = [`${appPath}/Contents/`, `${realpathSync(appPath)}/Contents/`];
    return listExecutables().some((executable) => roots.some((root) => executable.startsWith(root)));
}

function failed(message: string): LocalDesktopOutcome {
    return { kind: "failed", message };
}

function isWritableDirectory(path: string): boolean {
    try {
        if (!statSync(path).isDirectory()) return false;
        accessSync(path, constants.W_OK);
        return true;
    } catch {
        return false;
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
