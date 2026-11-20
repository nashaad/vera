import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isSafeHostBuildId } from "../../src/release/desktop-package-manifest.ts";
import { isReleaseVersion } from "../../src/release/version.ts";
import { buildDesktopRelease, type DesktopRelease } from "./release-build.ts";
import { run } from "./run.ts";

const root = resolve(import.meta.dir, "..", "..");

export interface BuildDesktopForHostOptions {
    readonly hostBuildId: string;
    readonly desktopVersion: string;
    readonly arch: string;
    readonly outputDirectory: string;
}

// Builds this checkout's desktop package and app shell for one host build, using this machine's Electron.
export async function buildDesktopForHostBuild(options: BuildDesktopForHostOptions): Promise<DesktopRelease> {
    const { hostBuildId, desktopVersion, arch } = options;
    if (process.platform !== "darwin") throw new Error("The desktop app builds on macOS only.");
    if (!isSafeHostBuildId(hostBuildId)) throw new Error(`'${hostBuildId}' cannot name a host build.`);
    if (arch !== process.arch) {
        throw new Error(`The app shell is built from this machine's Electron, so --arch must be ${process.arch}, not ${arch}.`);
    }
    if (!isReleaseVersion(desktopVersion)) throw new Error(`'${desktopVersion}' is not a version like 0.1.0.`);

    const desktop = createRequire(join(root, "clients", "desktop", "package.json"));
    const electronApp = join(dirname(desktop.resolve("electron")), "dist", "Electron.app");
    if (!existsSync(electronApp)) throw new Error(`${electronApp} is missing. Install the desktop dependencies first.`);
    const iconSource = join(root, "docs", "site", "public", "favicon.svg");
    if (!existsSync(iconSource)) throw new Error(`${iconSource} is missing; the app icon is built from it.`);

    const scratch = mkdtempSync(join(tmpdir(), "vera-desktop-build-"));
    try {
        run(process.execPath, ["run", join(root, "clients", "desktop", "build.ts"), "--out", scratch, "--build-id", hostBuildId]);
        return await buildDesktopRelease({
            hostBuildId,
            desktopVersion,
            arch,
            desktopBuild: join(scratch, "dist"),
            electronApp,
            iconSource,
            shellEntry: join(root, "clients", "desktop", "shell", "main.ts"),
            outputDirectory: options.outputDirectory,
        });
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
