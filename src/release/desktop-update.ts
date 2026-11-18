import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    findDesktopPackage,
    installDesktopPackage,
    readDesktopPackageTarballManifest,
    type DesktopPackage,
} from "./desktop-packages.ts";
import {
    DownloadStatusError,
    downloadToFile,
    fetchText,
    releaseAssetBase,
    verifyChecksum,
    type DownloadOptions,
} from "./download.ts";
import { releasesDirectory } from "./layout.ts";

export interface DesktopUpdateOptions extends DownloadOptions {
    readonly prefix: string;
    readonly tag: string;
    readonly platform: string;
    readonly arch: string;
    // The build id of the host release that was just unpacked.
    readonly hostBuildId: string;
}

export type DesktopUpdateOutcome =
    | { readonly kind: "ready"; readonly package: DesktopPackage }
    // No package for this host build exists yet, so the host must not become current.
    | { readonly kind: "held" };

export function desktopAssetName(platform: string, arch: string): string {
    return `vera-desktop-${platform}-${arch}.tar.gz`;
}

// Installs the release's desktop package for the host build. A release without one, or whose package targets another host build,
// still counts as matched when the store already holds a package for this build; otherwise the update is held.
// Any other failure throws and installs nothing.
export async function readyDesktopPackage(
    options: DesktopUpdateOptions,
): Promise<DesktopUpdateOutcome> {
    const asset = desktopAssetName(options.platform, options.arch);
    const url = `${releaseAssetBase(options, options.tag)}/${asset}`;
    const releases = releasesDirectory(options.prefix);
    mkdirSync(releases, { recursive: true, mode: 0o755 });
    const staging = join(releases, `.staging-${process.pid}-desktop`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging);
    try {
        let checksumText: string;
        try {
            checksumText = await fetchText(`${url}.sha256`, options);
        } catch (error) {
            if (error instanceof DownloadStatusError && error.status === 404) return storedPackage(options);
            throw error;
        }
        const tarball = join(staging, asset);
        const checksumFile = `${tarball}.sha256`;
        writeFileSync(checksumFile, checksumText);
        await downloadToFile(url, tarball, options);
        const sha256 = await verifyChecksum(tarball, checksumFile, asset);
        const manifest = await readDesktopPackageTarballManifest(tarball);
        if (manifest.host_build_id !== options.hostBuildId) return storedPackage(options);
        const installed = await installDesktopPackage({
            tarball,
            sha256,
            hostBuildId: options.hostBuildId,
            desktopVersion: manifest.desktop_version,
            prefix: options.prefix,
        });
        return { kind: "ready", package: installed.package };
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

function storedPackage(options: DesktopUpdateOptions): DesktopUpdateOutcome {
    const found = findDesktopPackage(options.hostBuildId, options.prefix);
    return found === undefined ? { kind: "held" } : { kind: "ready", package: found };
}
