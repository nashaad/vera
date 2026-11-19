import { copyFileSync, cpSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    BUNDLED_RELEASE_DIRECTORY,
    BUNDLED_RELEASE_MANIFEST,
    BUNDLED_RELEASE_TARBALL,
} from "../../clients/desktop/src/release-install.ts";
import { writeAppIcon } from "./app-icon.ts";
import { run } from "./run.ts";

export const APP_NAME = "Vera";
export const APP_BUNDLE_ID = "dev.vera.desktop";

const ELECTRON_NAME = "Electron";
const ICON_NAME = "Vera";
const ELECTRON_ICON = "electron.icns";

export interface AppBundleOptions {
    // The Electron.app that ships in node_modules/electron/dist.
    readonly electronApp: string;
    // The output of clients/desktop/build.ts.
    readonly appBuild: string;
    // A release tarball with its `.sha256` beside it, and the manifest text it holds.
    readonly releaseTarball: string;
    readonly releaseManifest: string;
    // An SVG of the Vera mark, turned into the app icon.
    readonly iconSource: string;
    readonly version: string;
    readonly destination: string;
}

// Electron treats an executable named "electron" as an unpackaged run, so the executable and helpers are renamed.
export async function assembleApp(options: AppBundleOptions): Promise<void> {
    const { destination } = options;
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(join(destination, ".."), { recursive: true });
    run("ditto", [options.electronApp, destination]);

    const contents = join(destination, "Contents");
    const resources = join(contents, "Resources");
    renameSync(join(contents, "MacOS", ELECTRON_NAME), join(contents, "MacOS", APP_NAME));
    const mainPlist = join(contents, "Info.plist");
    setPlist(mainPlist, "CFBundleName", APP_NAME);
    setPlist(mainPlist, "CFBundleDisplayName", APP_NAME);
    setPlist(mainPlist, "CFBundleExecutable", APP_NAME);
    setPlist(mainPlist, "CFBundleIdentifier", APP_BUNDLE_ID);
    setPlist(mainPlist, "CFBundleShortVersionString", options.version);
    setPlist(mainPlist, "CFBundleVersion", options.version);
    run("plutil", ["-remove", "ElectronAsarIntegrity", mainPlist]);
    rmSync(join(resources, ELECTRON_ICON), { force: true });
    await writeAppIcon(options.iconSource, join(resources, `${ICON_NAME}.icns`));
    setPlist(mainPlist, "CFBundleIconFile", `${ICON_NAME}.icns`);

    renameHelpers(join(contents, "Frameworks"));

    rmSync(join(resources, "default_app.asar"), { force: true });
    const app = join(resources, "app");
    mkdirSync(app, { recursive: true });
    cpSync(options.appBuild, join(app, "dist"), { recursive: true });
    writeFileSync(join(app, "package.json"), `${JSON.stringify({
        name: "vera-desktop",
        productName: APP_NAME,
        version: options.version,
        type: "module",
        main: "dist/main.js",
    }, null, 4)}\n`);

    const release = join(resources, BUNDLED_RELEASE_DIRECTORY);
    mkdirSync(release, { recursive: true });
    copyFileSync(options.releaseTarball, join(release, BUNDLED_RELEASE_TARBALL));
    copyFileSync(`${options.releaseTarball}.sha256`, join(release, `${BUNDLED_RELEASE_TARBALL}.sha256`));
    writeFileSync(join(release, BUNDLED_RELEASE_MANIFEST), options.releaseManifest);
}

export function signAdHoc(app: string): void {
    run("codesign", ["--force", "--deep", "-s", "-", app]);
    run("codesign", ["--verify", "--deep", "--strict", app]);
}

function renameHelpers(frameworks: string): void {
    for (const entry of readdirSync(frameworks)) {
        if (!entry.startsWith(`${ELECTRON_NAME} Helper`) || !entry.endsWith(".app")) continue;
        const oldName = entry.slice(0, -".app".length);
        const newName = oldName.replace(ELECTRON_NAME, APP_NAME);
        const variant = /\((.+)\)$/.exec(oldName)?.[1];
        const oldBundle = join(frameworks, entry);
        const macOs = join(oldBundle, "Contents", "MacOS");
        renameSync(join(macOs, oldName), join(macOs, newName));
        const plist = join(oldBundle, "Contents", "Info.plist");
        setPlist(plist, "CFBundleName", newName);
        setPlist(plist, "CFBundleDisplayName", newName);
        setPlist(plist, "CFBundleExecutable", newName);
        setPlist(plist, "CFBundleIdentifier", `${APP_BUNDLE_ID}.helper${variant === undefined ? "" : `.${variant}`}`);
        renameSync(oldBundle, join(frameworks, `${newName}.app`));
    }
}

function setPlist(plist: string, key: string, value: string): void {
    run("plutil", ["-replace", key, "-string", value, plist]);
}
