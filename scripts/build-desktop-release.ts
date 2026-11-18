import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { VERA_PRODUCT_VERSION, parseReleaseManifest } from "../src/release/manifest.ts";
import { isSafeHostBuildId } from "../src/release/desktop-package-manifest.ts";
import { isReleaseVersion } from "../src/release/version.ts";
import { buildDesktopRelease } from "./desktop-release/release-build.ts";
import { run } from "./desktop-release/run.ts";

// Builds the desktop package and the app shell for one macOS arch, both matched to one host build, into an output folder.

const root = resolve(import.meta.dir, "..");
const USAGE = "usage: build-desktop-release.ts (--release FILE.tar.gz | --build-id ID --arch ARCH) [--arch ARCH] [--desktop-version VERSION] [--out DIR]";

interface Args {
    readonly release: string | undefined;
    readonly buildId: string | undefined;
    readonly arch: string | undefined;
    readonly desktopVersion: string | undefined;
    readonly out: string;
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function parseArgs(argv: readonly string[]): Args {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index];
        const value = argv[index + 1];
        if (name === undefined || !["--release", "--build-id", "--arch", "--desktop-version", "--out"].includes(name) || value === undefined) {
            fail(USAGE);
        }
        values.set(name, value);
    }
    const release = values.get("--release");
    const buildId = values.get("--build-id");
    if ((release === undefined) === (buildId === undefined)) fail(USAGE);
    return {
        release: release === undefined ? undefined : resolve(release),
        buildId,
        arch: values.get("--arch"),
        desktopVersion: values.get("--desktop-version"),
        out: resolve(values.get("--out") ?? join(root, "dist", "desktop-release")),
    };
}

function readTarballManifest(tarball: string) {
    const expected = readFileSync(`${tarball}.sha256`, "utf8").trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (actual !== expected) fail(`${tarball} does not match its .sha256 file.`);
    const first = run("tar", ["-tzf", tarball]).split("\n")[0] ?? "";
    const directory = first.split("/")[0] ?? "";
    if (directory.length === 0) fail(`${tarball} holds no release directory.`);
    return parseReleaseManifest(run("tar", ["-xzOf", tarball, `${directory}/manifest.json`]));
}

async function main(): Promise<void> {
    if (process.platform !== "darwin") fail("The desktop app builds on macOS only.");
    const args = parseArgs(Bun.argv.slice(2));

    let hostBuildId = args.buildId;
    let arch = args.arch;
    let desktopVersion = args.desktopVersion;
    if (args.release !== undefined) {
        if (!existsSync(`${args.release}.sha256`)) fail(`${args.release}.sha256 is missing.`);
        const manifest = readTarballManifest(args.release);
        if (manifest.platform !== "darwin") fail(`The release is for ${manifest.platform}; the desktop app is macOS only.`);
        if (arch !== undefined && arch !== manifest.arch) fail(`--arch ${arch} does not match the release's ${manifest.arch}.`);
        hostBuildId = manifest.build_id;
        arch = manifest.arch;
        desktopVersion ??= manifest.product_version;
    }
    desktopVersion ??= VERA_PRODUCT_VERSION;
    if (hostBuildId === undefined || !isSafeHostBuildId(hostBuildId)) fail(`'${String(hostBuildId)}' cannot name a host build.`);
    if (arch === undefined) fail(USAGE);
    if (arch !== process.arch) fail(`The app shell is built from this machine's Electron, so --arch must be ${process.arch}, not ${arch}.`);
    if (!isReleaseVersion(desktopVersion)) fail(`'${desktopVersion}' is not a version like 0.1.0.`);

    const desktop = createRequire(join(root, "clients", "desktop", "package.json"));
    const electronApp = join(dirname(desktop.resolve("electron")), "dist", "Electron.app");
    if (!existsSync(electronApp)) fail(`${electronApp} is missing. Install the desktop dependencies first.`);
    const iconSource = join(root, "docs", "site", "public", "favicon.svg");
    if (!existsSync(iconSource)) fail(`${iconSource} is missing; the app icon is built from it.`);

    const scratch = mkdtempSync(join(tmpdir(), "vera-desktop-build-"));
    let built;
    try {
        run(process.execPath, ["run", join(root, "clients", "desktop", "build.ts"), "--out", scratch, "--build-id", hostBuildId]);
        built = await buildDesktopRelease({
            hostBuildId,
            desktopVersion,
            arch,
            desktopBuild: join(scratch, "dist"),
            electronApp,
            iconSource,
            shellEntry: join(root, "clients", "desktop", "shell", "main.ts"),
            outputDirectory: args.out,
        });
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
    for (const file of [built.desktopPackage, built.shell]) {
        console.log(`${file.path} ${(file.bytes / 1_048_576).toFixed(1)} MiB`);
    }
    console.log(`${hostBuildId} desktop ${desktopVersion}`);
}

await main();
