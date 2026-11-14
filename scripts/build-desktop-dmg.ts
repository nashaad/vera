import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { parseReleaseManifest, type ReleaseManifest } from "../src/release/manifest.ts";
import { assembleApp, APP_NAME, signAdHoc } from "./desktop-dmg/app-bundle.ts";
import { createDiskImage } from "./desktop-dmg/disk-image.ts";
import { run } from "./desktop-dmg/run.ts";
import { packReleaseTarball } from "./pack-release.ts";

// Builds dist/desktop-dmg/Vera-<platform>-<arch>.dmg: the desktop app with this checkout's release inside it.

const root = resolve(import.meta.dir, "..");

interface Args {
    readonly releaseTarball: string | undefined;
    readonly outputDirectory: string;
}

function parseArgs(argv: readonly string[]): Args {
    let releaseTarball: string | undefined;
    let outputDirectory = join(root, "dist", "desktop-dmg");
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index + 1];
        if (argv[index] === "--release" && value !== undefined) {
            releaseTarball = resolve(value);
            index += 1;
        } else if (argv[index] === "--out" && value !== undefined) {
            outputDirectory = resolve(value);
            index += 1;
        } else {
            fail("usage: build-desktop-dmg.ts [--release FILE.tar.gz] [--out DIR]");
        }
    }
    return { releaseTarball, outputDirectory };
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function readTarballManifest(tarball: string): { readonly text: string; readonly manifest: ReleaseManifest } {
    const first = run("tar", ["-tzf", tarball]).split("\n")[0] ?? "";
    const buildId = first.split("/")[0] ?? "";
    if (buildId.length === 0) throw new Error(`${tarball} holds no release directory.`);
    const text = run("tar", ["-xzOf", tarball, `${buildId}/manifest.json`]);
    return { text, manifest: parseReleaseManifest(text) };
}

function requireChecksum(tarball: string): void {
    const expected = readFileSync(`${tarball}.sha256`, "utf8").trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (actual !== expected) throw new Error(`${tarball} does not match its .sha256 file.`);
}

async function main(): Promise<void> {
    if (process.platform !== "darwin") fail("The DMG builds on macOS only.");
    const args = parseArgs(Bun.argv.slice(2));
    mkdirSync(args.outputDirectory, { recursive: true });

    run(process.execPath, ["run", join(root, "clients", "desktop", "build.ts")]);

    let tarball = args.releaseTarball;
    if (tarball === undefined) {
        tarball = join(args.outputDirectory, "vera-release.tar.gz");
        await packReleaseTarball(tarball);
    }
    if (!existsSync(`${tarball}.sha256`)) fail(`${tarball}.sha256 is missing.`);
    requireChecksum(tarball);
    const { text: manifestText, manifest } = readTarballManifest(tarball);
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
        fail(`The release is for ${manifest.platform}-${manifest.arch}; this machine is ${process.platform}-${process.arch}.`);
    }

    const desktop = createRequire(join(root, "clients", "desktop", "package.json"));
    const electronApp = join(dirname(desktop.resolve("electron")), "dist", "Electron.app");
    if (!existsSync(electronApp)) fail(`${electronApp} is missing. Install the desktop dependencies first.`);

    const iconSource = join(root, "docs", "site", "public", "favicon.svg");
    if (!existsSync(iconSource)) fail(`${iconSource} is missing; the app icon is built from it.`);

    const stage = join(args.outputDirectory, "stage");
    const app = join(stage, `${APP_NAME}.app`);
    rmSync(stage, { recursive: true, force: true });
    await assembleApp({
        electronApp,
        appBuild: join(root, "clients", "desktop", "dist"),
        releaseTarball: tarball,
        releaseManifest: manifestText,
        iconSource,
        version: manifest.product_version,
        destination: app,
    });
    signAdHoc(app);

    const image = join(args.outputDirectory, `${APP_NAME}-${manifest.platform}-${manifest.arch}.dmg`);
    createDiskImage(stage, image);
    rmSync(stage, { recursive: true, force: true });
    console.log(image);
    console.log(`${manifest.build_id} ${(statSync(image).size / 1_048_576).toFixed(1)} MiB`);
}

await main();
