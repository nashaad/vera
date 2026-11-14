import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APP_BUNDLE_ID, assembleApp } from "../../scripts/desktop-dmg/app-bundle.ts";
import { run } from "../../scripts/desktop-dmg/run.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HELPERS = ["Electron Helper", "Electron Helper (GPU)", "Electron Helper (Plugin)", "Electron Helper (Renderer)"];

function plist(entries: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${entries}</dict></plist>\n`;
}

function fakeElectronApp(parent: string): string {
    const app = join(parent, "Electron.app");
    const contents = join(app, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    writeFileSync(join(contents, "MacOS", "Electron"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(contents, "Resources", "default_app.asar"), "asar");
    writeFileSync(join(contents, "Resources", "electron.icns"), "old icon");
    writeFileSync(join(contents, "Info.plist"), plist(
        "<key>CFBundleName</key><string>Electron</string>"
        + "<key>CFBundleExecutable</key><string>Electron</string>"
        + "<key>CFBundleIdentifier</key><string>com.github.Electron</string>"
        + "<key>ElectronAsarIntegrity</key><dict><key>Resources/default_app.asar</key><dict/></dict>",
    ));
    for (const name of HELPERS) {
        const helper = join(contents, "Frameworks", `${name}.app`, "Contents");
        mkdirSync(join(helper, "MacOS"), { recursive: true });
        writeFileSync(join(helper, "MacOS", name), "#!/bin/sh\n", { mode: 0o755 });
        writeFileSync(join(helper, "Info.plist"), plist(
            `<key>CFBundleName</key><string>${name}</string><key>CFBundleIdentifier</key><string>com.github.Electron.helper</string>`,
        ));
    }
    return app;
}

function extract(plistPath: string, key: string): string {
    return run("plutil", ["-extract", key, "raw", plistPath]).trim();
}

const MARK = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 400 400\"><circle cx=\"200\" cy=\"200\" r=\"200\" fill=\"#e8582a\"/></svg>\n";

test.skipIf(process.platform !== "darwin")("assembleApp renames the executable and helpers and carries the release", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-app-bundle-"));
    roots.push(root);
    const appBuild = join(root, "dist");
    mkdirSync(join(appBuild, "renderer"), { recursive: true });
    writeFileSync(join(appBuild, "main.js"), "export {};\n");
    writeFileSync(join(appBuild, "renderer", "index.html"), "<html></html>\n");
    const tarball = join(root, "vera-release.tar.gz");
    writeFileSync(tarball, "archive");
    writeFileSync(`${tarball}.sha256`, "abc  vera-release.tar.gz\n");
    const destination = join(root, "stage", "Vera.app");
    const iconSource = join(root, "mark.svg");
    writeFileSync(iconSource, MARK);

    await assembleApp({
        electronApp: fakeElectronApp(root),
        appBuild,
        releaseTarball: tarball,
        releaseManifest: "{\"build_id\":\"vera-x\"}\n",
        iconSource,
        version: "0.1.0",
        destination,
    });

    const contents = join(destination, "Contents");
    expect(existsSync(join(contents, "MacOS", "Vera"))).toBe(true);
    expect(existsSync(join(contents, "MacOS", "Electron"))).toBe(false);
    const main = join(contents, "Info.plist");
    expect(extract(main, "CFBundleExecutable")).toBe("Vera");
    expect(extract(main, "CFBundleName")).toBe("Vera");
    expect(extract(main, "CFBundleIdentifier")).toBe(APP_BUNDLE_ID);
    expect(extract(main, "CFBundleShortVersionString")).toBe("0.1.0");
    expect(run("plutil", ["-p", main])).not.toContain("ElectronAsarIntegrity");
    expect(extract(main, "CFBundleIconFile")).toBe("Vera.icns");
    expect(existsSync(join(contents, "Resources", "electron.icns"))).toBe(false);
    const icon = readFileSync(join(contents, "Resources", "Vera.icns"));
    expect(icon.subarray(0, 4).toString("latin1")).toBe("icns");
    expect(icon.readUInt32BE(4)).toBe(icon.length);

    for (const [oldName, id] of [
        ["Electron Helper", ""],
        ["Electron Helper (GPU)", ".GPU"],
        ["Electron Helper (Plugin)", ".Plugin"],
        ["Electron Helper (Renderer)", ".Renderer"],
    ] as const) {
        const name = oldName.replace("Electron", "Vera");
        const helper = join(contents, "Frameworks", `${name}.app`, "Contents");
        expect(existsSync(join(helper, "MacOS", name))).toBe(true);
        expect(extract(join(helper, "Info.plist"), "CFBundleExecutable")).toBe(name);
        expect(extract(join(helper, "Info.plist"), "CFBundleIdentifier")).toBe(`${APP_BUNDLE_ID}.helper${id}`);
        expect(existsSync(join(contents, "Frameworks", `${oldName}.app`))).toBe(false);
    }

    expect(existsSync(join(contents, "Resources", "default_app.asar"))).toBe(false);
    const app = join(contents, "Resources", "app");
    expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8"))).toMatchObject({
        type: "module",
        main: "dist/main.js",
        version: "0.1.0",
    });
    expect(readFileSync(join(app, "dist", "renderer", "index.html"), "utf8")).toBe("<html></html>\n");
    const release = join(contents, "Resources", "release");
    expect(readFileSync(join(release, "vera-release.tar.gz"), "utf8")).toBe("archive");
    expect(readFileSync(join(release, "vera-release.tar.gz.sha256"), "utf8")).toContain("abc");
    expect(readFileSync(join(release, "manifest.json"), "utf8")).toContain("vera-x");
});
