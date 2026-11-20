import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { VERA_PRODUCT_VERSION, parseReleaseManifest } from "../src/release/manifest.ts";
import { buildDesktopForHostBuild } from "./desktop-release/build-for-host.ts";
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
    if (hostBuildId === undefined || arch === undefined) fail(USAGE);

    let built;
    try {
        built = await buildDesktopForHostBuild({ hostBuildId, desktopVersion, arch, outputDirectory: args.out });
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
    for (const file of [built.desktopPackage, built.shell]) {
        console.log(`${file.path} ${(file.bytes / 1_048_576).toFixed(1)} MiB`);
    }
    console.log(`${hostBuildId} desktop ${desktopVersion}`);
}

await main();
