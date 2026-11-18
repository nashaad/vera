import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SHELL_API, SHELL_MARKER_NAME } from "../../clients/desktop/shell/bootstrap.ts";
import {
    DESKTOP_PACKAGE_LAYOUT_VERSION,
    DESKTOP_PACKAGE_MANIFEST_NAME,
    serializeDesktopPackageManifest,
} from "../../src/release/desktop-package-manifest.ts";
import { readDesktopPackage } from "../../src/release/desktop-packages.ts";
import { APP_NAME, assembleApp, signAdHoc } from "./app-bundle.ts";
import { createArchive, type ArchiveFile } from "./archive.ts";

export interface DesktopReleaseOptions {
    readonly hostBuildId: string;
    readonly desktopVersion: string;
    readonly arch: string;
    // The output of clients/desktop/build.ts.
    readonly desktopBuild: string;
    // The Electron.app that ships in node_modules/electron/dist.
    readonly electronApp: string;
    readonly iconSource: string;
    // clients/desktop/shell/main.ts.
    readonly shellEntry: string;
    readonly outputDirectory: string;
}

export interface DesktopRelease {
    readonly desktopPackage: ArchiveFile;
    readonly shell: ArchiveFile;
}

export const PACKAGE_ENTRY = "main.js";

export function desktopPackageAssetName(arch: string): string {
    return `vera-desktop-darwin-${arch}.tar.gz`;
}

export function desktopShellAssetName(arch: string): string {
    return `vera-desktop-shell-darwin-${arch}.tar.gz`;
}

// Writes the package archive and the shell archive, each with a .sha256 beside it.
export async function buildDesktopRelease(options: DesktopReleaseOptions): Promise<DesktopRelease> {
    mkdirSync(options.outputDirectory, { recursive: true });
    const stage = mkdtempSync(join(tmpdir(), "vera-desktop-release-"));
    try {
        const packageDirectory = join(stage, "package");
        cpSync(options.desktopBuild, packageDirectory, { recursive: true });
        // The nearest package.json decides how the entry loads, so one at the package root keeps a file above it out of the way.
        writeFileSync(join(packageDirectory, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
        writeFileSync(join(packageDirectory, DESKTOP_PACKAGE_MANIFEST_NAME), serializeDesktopPackageManifest({
            layout_version: DESKTOP_PACKAGE_LAYOUT_VERSION,
            desktop_version: options.desktopVersion,
            host_build_id: options.hostBuildId,
            entry: PACKAGE_ENTRY,
            shell_api: SHELL_API,
        }));
        readDesktopPackage(packageDirectory, {
            hostBuildId: options.hostBuildId,
            desktopVersion: options.desktopVersion,
        });
        const desktopPackage = createArchive(
            packageDirectory,
            readdirSync(packageDirectory).sort(),
            join(options.outputDirectory, desktopPackageAssetName(options.arch)),
        );

        const shellBuild = join(stage, "shell-build");
        const bundle = await Bun.build({
            entrypoints: [options.shellEntry],
            outdir: shellBuild,
            target: "node",
            format: "esm",
            external: ["electron"],
            naming: "main.js",
        });
        if (!bundle.success) throw new Error(`The shell did not build:\n${bundle.logs.join("\n")}`);
        const shellApp = join(stage, `${APP_NAME}.app`);
        await assembleApp({
            electronApp: options.electronApp,
            appBuild: shellBuild,
            iconSource: options.iconSource,
            version: options.desktopVersion,
            destination: shellApp,
        });
        writeFileSync(join(shellApp, "Contents", "Resources", SHELL_MARKER_NAME), `${JSON.stringify({ shell_api: SHELL_API })}\n`);
        signAdHoc(shellApp);
        const shell = createArchive(stage, [`${APP_NAME}.app`], join(options.outputDirectory, desktopShellAssetName(options.arch)));
        return { desktopPackage, shell };
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
}
