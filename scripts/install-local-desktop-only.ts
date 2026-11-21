import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanDesktopPackages } from "../src/release/desktop-package-gc.ts";
import {
    findDesktopPackage,
    installDesktopPackage,
    readDesktopPackageTarballManifest,
} from "../src/release/desktop-packages.ts";
import { currentReleaseBuildId, releaseDirectory, sourceCheckoutRoot } from "../src/release/layout.ts";
import { readStampedRelease } from "../src/release/stamp.ts";
import { RELEASE_VERSION_PATTERN } from "../src/release/version.ts";
import {
    describeDesktopOutcome,
    isDesktopPrefix,
    placeApp,
    type LocalDesktopOutcome,
    type LocalDesktopSettings,
} from "./install-local-desktop.ts";
import { buildDesktopForHostBuild } from "./desktop-release/build-for-host.ts";

// The files that define what the host and its clients send each other.
export const WIRE_FILES = ["src/host/protocol.ts", "src/engine/protocol.ts", "src/engine/host-protocol.ts"] as const;

const LOCAL_TAG = "local";

export interface DesktopOnlyOptions extends Omit<LocalDesktopSettings, "desktopVersion"> {
    readonly prefix: string;
    // The checkout the desktop app is built from. Defaults to this one.
    readonly checkoutRoot?: string;
    readonly report?: (line: string) => void;
}

export type DesktopOnlyOutcome =
    | {
        readonly kind: "installed";
        readonly hostBuildId: string;
        readonly desktopVersion: string;
        readonly app: LocalDesktopOutcome;
    }
    // Nothing was installed.
    | { readonly kind: "refused"; readonly message: string }
    | { readonly kind: "failed"; readonly message: string };

// The version after `newest` for a desktop built from a checkout. Repeated local installs count local.N up.
export function nextLocalDesktopVersion(newest: string): string {
    const match = RELEASE_VERSION_PATTERN.exec(newest);
    if (match === null) throw new Error(`Invalid version '${newest}'. Expected a version like 0.1.0.`);
    const [major, minor, patch] = [match[1], match[2], match[3]];
    const pre = match[4] === undefined ? [] : match[4].slice(1).split(".");
    if (pre.length === 0) return `${major}.${minor}.${Number(patch) + 1}-${LOCAL_TAG}.1`;
    const last = pre[pre.length - 1] ?? "";
    const counted = pre.length >= 2 && pre[pre.length - 2] === LOCAL_TAG && /^[0-9]+$/.test(last);
    const next = counted ? [...pre.slice(0, -1), String(Number(last) + 1)] : [...pre, LOCAL_TAG, "1"];
    return `${major}.${minor}.${patch}-${next.join(".")}`;
}

// The wire files whose bytes differ between the checkout and an installed release root. A missing file counts as different.
export function changedWireFiles(checkoutRoot: string, releaseRoot: string): readonly string[] {
    return WIRE_FILES.filter((file) => !sameBytes(join(checkoutRoot, file), join(releaseRoot, file)));
}

// Builds this checkout's desktop app for the host build that current names and installs it as a newer desktop version
// of that build. The host is never touched. Never throws.
export async function installDesktopOnly(options: DesktopOnlyOptions): Promise<DesktopOnlyOutcome> {
    const { prefix } = options;
    if ((options.platform ?? process.platform) !== "darwin") return refused("the desktop app installs on macOS only.");
    if (!isDesktopPrefix(prefix, options.home)) return refused("the desktop app needs Vera in ~/.local.");
    const hostBuildId = currentReleaseBuildId(prefix);
    if (hostBuildId === undefined) return refused("no Vera build is installed. Run bun run install:local first.");
    const releaseRoot = releaseDirectory(hostBuildId, prefix);
    const changed = changedWireFiles(options.checkoutRoot ?? sourceCheckoutRoot(), releaseRoot);
    if (changed.length > 0) {
        return refused(
            `this checkout's ${changed.join(", ")} differ from build ${hostBuildId}, so nothing was installed. `
            + "Run bun run install:local to update the host and the desktop app together.",
        );
    }
    const scratch = mkdtempSync(join(tmpdir(), "vera-desktop-only-"));
    try {
        const newest = findDesktopPackage(hostBuildId, prefix);
        const desktopVersion = newest === undefined
            ? readStampedRelease(releaseRoot).product_version
            : nextLocalDesktopVersion(newest.desktopVersion);
        options.report?.(`Building desktop ${desktopVersion} for ${hostBuildId}.`);
        const built = await (options.build ?? buildDesktopForHostBuild)({
            hostBuildId,
            desktopVersion,
            arch: process.arch,
            outputDirectory: scratch,
        });
        // The app is checked first, so a package is never installed for a shell that cannot load it.
        const { shell_api: shellApi } = await readDesktopPackageTarballManifest(built.desktopPackage.path);
        const app = await placeApp(options, shellApi, built.shell.path, desktopVersion);
        if (app.kind === "running") {
            return refused(
                `the desktop app at ${app.appPath} needs a newer app shell and Vera is running, so nothing was installed. `
                + "Quit Vera and run this again.",
            );
        }
        if (app.kind === "failed") return { kind: "failed", message: app.message };
        const installed = await installDesktopPackage({
            tarball: built.desktopPackage.path,
            sha256: built.desktopPackage.sha256,
            hostBuildId,
            desktopVersion,
            prefix,
        });
        if (!installed.installed) {
            return { kind: "failed", message: `desktop ${desktopVersion} for ${hostBuildId} was already installed by another run. Run this again.` };
        }
        try {
            cleanDesktopPackages(prefix, { onHeld: options.report });
        } catch (error) {
            options.report?.(`Desktop package cleanup failed: ${String(error)}`);
        }
        return { kind: "installed", hostBuildId, desktopVersion, app };
    } catch (error) {
        return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

// What install:local --desktop-only prints. A refusal or failure makes the command exit 1.
export function describeDesktopOnlyOutcome(outcome: DesktopOnlyOutcome): { readonly lines: readonly string[]; readonly failure: boolean } {
    switch (outcome.kind) {
        case "installed": {
            const lines = [
                `vera install:local: installed desktop ${outcome.desktopVersion} for ${outcome.hostBuildId}. An open Vera window reloads into it.`,
            ];
            if (outcome.app.kind === "installed" || outcome.app.kind === "replaced") {
                lines.push(describeDesktopOutcome(outcome.app).line);
            }
            return { lines, failure: false };
        }
        case "refused":
        case "failed":
            return { lines: [`vera install:local: ${outcome.message}`], failure: true };
    }
}

function refused(message: string): DesktopOnlyOutcome {
    return { kind: "refused", message };
}

function sameBytes(left: string, right: string): boolean {
    try {
        return readFileSync(left).equals(readFileSync(right));
    } catch {
        return false;
    }
}
