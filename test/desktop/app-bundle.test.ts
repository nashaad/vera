import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APP_BUNDLE_ID, assembleApp } from "../../scripts/desktop-release/app-bundle.ts";
import { run } from "../../scripts/desktop-release/run.ts";
import { fakeElectronApp } from "./fake-electron-app.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function extract(plistPath: string, key: string): string {
    return run("plutil", ["-extract", key, "raw", plistPath]).trim();
}

const MARK = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 400 400\"><circle cx=\"200\" cy=\"200\" r=\"200\" fill=\"#e8582a\"/></svg>\n";

test.skipIf(process.platform !== "darwin")("assembleApp renames the executable and helpers without a bundled release", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-app-bundle-"));
    roots.push(root);
    const appBuild = join(root, "dist");
    mkdirSync(join(appBuild, "renderer"), { recursive: true });
    writeFileSync(join(appBuild, "main.js"), "export {};\n");
    writeFileSync(join(appBuild, "renderer", "index.html"), "<html></html>\n");
    mkdirSync(join(appBuild, "extensions", "vera.sample"), { recursive: true });
    writeFileSync(join(appBuild, "extensions", "vera.sample", "vera.desktop.json"), "{}\n");
    writeFileSync(join(appBuild, "extensions", "vera.sample", "worker.cjs"), "module.exports = {};\n");
    const destination = join(root, "stage", "Vera.app");
    const iconSource = join(root, "mark.svg");
    writeFileSync(iconSource, MARK);

    await assembleApp({
        electronApp: fakeElectronApp(root),
        appBuild,
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
    expect(readFileSync(join(app, "dist", "extensions", "vera.sample", "worker.cjs"), "utf8")).toBe("module.exports = {};\n");
    expect(existsSync(join(app, "dist", "extensions", "vera.sample", "vera.desktop.json"))).toBe(true);
    expect(existsSync(join(contents, "Resources", "release"))).toBe(false);
});
