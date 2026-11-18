import { accessSync, constants, lstatSync } from "node:fs";
import { dirname } from "node:path";

import { holdDesktopPackage } from "../../../src/release/desktop-package-references.ts";
import { findDesktopPackage, type DesktopPackage } from "../../../src/release/desktop-packages.ts";
import {
    currentReleaseBuildId,
    launcherPath,
    prefixOfReleaseRoot,
    safeRealpath,
} from "../../../src/release/layout.ts";

// The shell API this shell offers. A package whose manifest needs a higher one is refused.
export const SHELL_API = 1;
// Beside the shell's resources: its presence marks a Vera shell, and it carries the shell API.
export const SHELL_MARKER_NAME = "vera-shell.json";

export interface ShellBootOptions {
    readonly launcher?: string;
    readonly shellApi?: number;
}

export type ShellBoot =
    | {
        readonly kind: "package";
        readonly package: DesktopPackage;
        readonly prefix: string;
        // Drops the record that tells cleanup this process uses the package.
        readonly release: () => void;
    }
    | { readonly kind: "unavailable"; readonly message: string };

export function notInstalledMessage(): string {
    return "Vera is not installed. Run the Vera installer, then open the desktop app again.";
}

export function packageMissingMessage(buildId: string): string {
    return `The Vera desktop app for build ${buildId} is not installed. Run the Vera installer again to add it.`;
}

export function shellTooOldMessage(buildId: string): string {
    return `The Vera desktop app for build ${buildId} needs a newer app shell. Run the Vera installer again to update it.`;
}

export function packageFailedMessage(buildId: string, reason: string): string {
    return `The Vera desktop app for build ${buildId} could not start (${reason}). Run the Vera installer again.`;
}

// The install prefix is where the launcher sits, or where the release it links to sits.
export function prefixOfLauncher(launcher: string): string {
    const resolved = isLink(launcher) ? safeRealpath(launcher) ?? launcher : launcher;
    return prefixOfReleaseRoot(dirname(resolved)) ?? dirname(dirname(resolved));
}

// Finds the installed `vera` as the desktop app does, learns the host build `current` names, and holds the newest package for it.
export function resolveShellBoot(options: ShellBootOptions = {}): ShellBoot {
    const launcher = options.launcher ?? launcherPath();
    if (!isExecutable(launcher)) return { kind: "unavailable", message: notInstalledMessage() };
    const prefix = prefixOfLauncher(launcher);
    const buildId = currentReleaseBuildId(prefix);
    if (buildId === undefined) return { kind: "unavailable", message: notInstalledMessage() };

    // A package collected between the lookup and the hold is looked up once more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const found = findDesktopPackage(buildId, prefix);
        if (found === undefined) break;
        if (found.shellApi > (options.shellApi ?? SHELL_API)) {
            return { kind: "unavailable", message: shellTooOldMessage(buildId) };
        }
        try {
            return { kind: "package", package: found, prefix, release: holdDesktopPackage(found, prefix) };
        } catch {
            continue;
        }
    }
    return { kind: "unavailable", message: packageMissingMessage(buildId) };
}

function isLink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
