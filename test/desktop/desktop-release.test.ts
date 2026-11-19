import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createArchive } from "../../scripts/desktop-release/archive.ts";
import { APP_BUNDLE_ID } from "../../scripts/desktop-release/app-bundle.ts";
import {
    buildDesktopRelease,
    desktopPackageAssetName,
    desktopShellAssetName,
} from "../../scripts/desktop-release/release-build.ts";
import { run } from "../../scripts/desktop-release/run.ts";
import { SHELL_API, SHELL_MARKER_NAME } from "../../clients/desktop/shell/bootstrap.ts";
import { parseDesktopPackageManifest } from "../../src/release/desktop-package-manifest.ts";
import { findDesktopPackage, installDesktopPackage } from "../../src/release/desktop-packages.ts";
import { fakeElectronApp } from "./fake-electron-app.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-desktop-release-test-"));
    roots.push(root);
    return root;
}

const MARK = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 400 400\"><circle cx=\"200\" cy=\"200\" r=\"200\" fill=\"#e8582a\"/></svg>\n";
const HOST = "vera-host-a";

function listing(archive: string): string[] {
    return run("tar", ["-tzf", archive]).split("\n").filter((line) => line.length > 0);
}

function unpack(archive: string, into: string): void {
    mkdirSync(into, { recursive: true });
    run("tar", ["-xzf", archive, "-C", into]);
}

test("archives keep symlinks and modes and carry no AppleDouble files", () => {
    const root = scratch();
    const source = join(root, "source");
    mkdirSync(join(source, "dir"), { recursive: true });
    writeFileSync(join(source, "dir", "tool"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(source, "plain"), "data\n", { mode: 0o644 });
    symlinkSync("dir/tool", join(source, "link"));
    const archive = createArchive(source, ["dir", "link", "plain"], join(root, "out.tar.gz"));

    expect(listing(archive.path).some((name) => name.split("/").some((part) => part.startsWith("._")))).toBe(false);
    expect(readFileSync(`${archive.path}.sha256`, "utf8")).toBe(`${archive.sha256}  out.tar.gz\n`);
    expect(createHash("sha256").update(readFileSync(archive.path)).digest("hex")).toBe(archive.sha256);
    const target = join(root, "target");
    unpack(archive.path, target);
    expect(lstatSync(join(target, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(target, "link"))).toBe("dir/tool");
    expect(statSync(join(target, "dir", "tool")).mode & 0o777).toBe(0o755);
    expect(statSync(join(target, "plain")).mode & 0o777).toBe(0o644);
});

test.skipIf(process.platform !== "darwin")("@core the desktop release is a package archive and a signed shell archive, each with a checksum", async () => {
    const root = scratch();
    const desktopBuild = join(root, "dist");
    mkdirSync(join(desktopBuild, "renderer"), { recursive: true });
    writeFileSync(join(desktopBuild, "main.js"), "export {};\n");
    writeFileSync(join(desktopBuild, "preload.cjs"), "\n");
    writeFileSync(join(desktopBuild, "renderer", "index.html"), "<html></html>\n");
    const iconSource = join(root, "mark.svg");
    writeFileSync(iconSource, MARK);
    const out = join(root, "out");

    const release = await buildDesktopRelease({
        hostBuildId: HOST,
        desktopVersion: "0.4.0",
        arch: "arm64",
        desktopBuild,
        electronApp: fakeElectronApp(root),
        iconSource,
        shellEntry: join(import.meta.dir, "..", "..", "clients", "desktop", "shell", "main.ts"),
        outputDirectory: out,
    });

    expect(desktopPackageAssetName("arm64")).toBe("vera-desktop-darwin-arm64.tar.gz");
    expect(desktopShellAssetName("arm64")).toBe("vera-desktop-shell-darwin-arm64.tar.gz");
    expect(readdirSync(out).sort()).toEqual([
        "vera-desktop-darwin-arm64.tar.gz",
        "vera-desktop-darwin-arm64.tar.gz.sha256",
        "vera-desktop-shell-darwin-arm64.tar.gz",
        "vera-desktop-shell-darwin-arm64.tar.gz.sha256",
    ]);
    for (const file of [release.desktopPackage, release.shell]) {
        const name = file.path.split("/").pop();
        expect(readFileSync(`${file.path}.sha256`, "utf8")).toBe(`${file.sha256}  ${name}\n`);
        expect(createHash("sha256").update(readFileSync(file.path)).digest("hex")).toBe(file.sha256);
        expect(listing(file.path).some((entry) => entry.split("/").some((part) => part.startsWith("._")))).toBe(false);
    }

    // The package: files at the archive root with the manifest, installable through the store.
    expect(listing(release.desktopPackage.path).sort()).toEqual([
        "desktop-package.json",
        "main.js",
        "package.json",
        "preload.cjs",
        "renderer/",
        "renderer/index.html",
    ]);
    const packageFiles = join(root, "package-files");
    unpack(release.desktopPackage.path, packageFiles);
    expect(JSON.parse(readFileSync(join(packageFiles, "desktop-package.json"), "utf8"))).toEqual({
        layout_version: 1,
        desktop_version: "0.4.0",
        host_build_id: HOST,
        entry: "main.js",
        shell_api: SHELL_API,
    });
    expect(parseDesktopPackageManifest(readFileSync(join(packageFiles, "desktop-package.json"), "utf8")).shell_api).toBe(1);
    expect(JSON.parse(readFileSync(join(packageFiles, "package.json"), "utf8"))).toEqual({ type: "module" });
    const prefix = join(root, "prefix");
    const installed = await installDesktopPackage({
        tarball: release.desktopPackage.path,
        sha256: release.desktopPackage.sha256,
        hostBuildId: HOST,
        desktopVersion: "0.4.0",
        prefix,
    });
    expect(installed.installed).toBe(true);
    expect(findDesktopPackage(HOST, prefix)?.entryPath).toBe(installed.package.entryPath);

    // The shell: Vera.app at the root, its identity and marker, and an ad-hoc signature that survives unpacking.
    const entries = listing(release.shell.path);
    expect(entries.every((entry) => entry === "Vera.app/" || entry.startsWith("Vera.app/"))).toBe(true);
    const applications = join(root, "applications");
    unpack(release.shell.path, applications);
    const app = join(applications, "Vera.app");
    const plist = join(app, "Contents", "Info.plist");
    expect(run("plutil", ["-extract", "CFBundleIdentifier", "raw", plist]).trim()).toBe(APP_BUNDLE_ID);
    expect(APP_BUNDLE_ID).toBe("dev.vera.desktop");
    expect(JSON.parse(readFileSync(join(app, "Contents", "Resources", SHELL_MARKER_NAME), "utf8"))).toEqual({ shell_api: 1 });
    expect(SHELL_MARKER_NAME).toBe("vera-shell.json");
    run("codesign", ["--verify", "--deep", "--strict", app]);
    expect(existsSync(join(app, "Contents", "Resources", "app", "dist", "main.js"))).toBe(true);
    const shellMain = readFileSync(join(app, "Contents", "Resources", "app", "dist", "main.js"), "utf8");
    expect(shellMain).not.toContain("renderer");
    expect(statSync(join(app, "Contents", "MacOS", "Vera")).mode & 0o111).not.toBe(0);
});
