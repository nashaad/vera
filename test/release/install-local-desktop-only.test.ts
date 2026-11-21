import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    changedWireFiles,
    describeDesktopOnlyOutcome,
    installDesktopOnly,
    nextLocalDesktopVersion,
    WIRE_FILES,
    type DesktopOnlyOptions,
    type DesktopOnlyOutcome,
} from "../../scripts/install-local-desktop-only.ts";
import { parseArgs } from "../../scripts/install-local.ts";
import type { BuildDesktopForHostOptions } from "../../scripts/desktop-release/build-for-host.ts";
import type { ArchiveFile } from "../../scripts/desktop-release/archive.ts";
import { findDesktopPackage, installDesktopPackage, scanDesktopPackages } from "../../src/release/desktop-packages.ts";
import { currentReleaseBuildId, releaseDirectory, releasesDirectory } from "../../src/release/layout.ts";
import { compareReleaseVersions } from "../../src/release/version-order.ts";
import { desktopTarball, prefixWithOldRelease, shellLabel, shellTarball, writeShellApp } from "./update-fixtures.ts";

// The root doubles as the home, so <root>/.local is the one prefix the desktop app can use.
interface Setup {
    readonly root: string;
    readonly prefix: string;
    readonly checkout: string;
    readonly apps: string;
    readonly appPath: string;
}

async function withSetup(run: (setup: Setup) => Promise<void>, options: { readonly installed?: boolean } = {}): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "vera-desktop-only-"));
    try {
        const prefix = options.installed === false ? join(root, ".local") : prefixWithOldRelease(root, ".local").prefix;
        const checkout = join(root, "checkout");
        for (const file of WIRE_FILES) {
            writeAt(join(checkout, file), `// ${file}\n`);
            if (options.installed !== false) writeAt(join(releaseDirectory("vera-old", prefix), file), `// ${file}\n`);
        }
        const apps = join(root, "Applications");
        mkdirSync(apps);
        await run({ root, prefix, checkout, apps, appPath: join(apps, "Vera.app") });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function writeAt(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}

function archive(path: string): ArchiveFile {
    const bytes = readFileSync(path);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

interface FakeBuild {
    readonly calls: BuildDesktopForHostOptions[];
    readonly build: NonNullable<DesktopOnlyOptions["build"]>;
}

// A package that needs shell API `needs`, shipped with a shell of the same API.
function fakeBuild(setup: Setup, needs = 1): FakeBuild {
    const calls: BuildDesktopForHostOptions[] = [];
    return {
        calls,
        build: async (options) => {
            calls.push(options);
            return {
                desktopPackage: archive(desktopTarball(setup.root, options.hostBuildId, options.desktopVersion, needs)),
                shell: archive(shellTarball(setup.root, needs, { label: `new-shell-${needs}` })),
            };
        },
    };
}

function installOnly(setup: Setup, fake: FakeBuild, options: Partial<DesktopOnlyOptions> = {}): Promise<DesktopOnlyOutcome> {
    return installDesktopOnly({
        prefix: setup.prefix,
        checkoutRoot: setup.checkout,
        build: fake.build,
        applicationsDirectory: setup.apps,
        isRunning: () => false,
        home: setup.root,
        platform: "darwin",
        ...options,
    });
}

async function installPackage(setup: Setup, version: string): Promise<void> {
    const tarball = archive(desktopTarball(setup.root, "vera-old", version));
    await installDesktopPackage({
        tarball: tarball.path,
        sha256: tarball.sha256,
        hostBuildId: "vera-old",
        desktopVersion: version,
        prefix: setup.prefix,
    });
}

function packageVersions(setup: Setup): readonly string[] {
    return scanDesktopPackages("vera-old", setup.prefix).valid.map((item) => item.desktopVersion);
}

test("@core a desktop-only install adds a newer desktop for the current build and leaves the host alone", async () => {
    await withSetup(async (setup) => {
        await installPackage(setup, "0.1.0-alpha.1");
        const releasesBefore = readdirSync(releasesDirectory(setup.prefix));
        const fake = fakeBuild(setup);
        const outcome = await installOnly(setup, fake);
        expect(outcome).toEqual({
            kind: "installed",
            hostBuildId: "vera-old",
            desktopVersion: "0.1.0-alpha.1.local.1",
            app: { kind: "installed", appPath: setup.appPath },
        });
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]).toMatchObject({ hostBuildId: "vera-old", desktopVersion: "0.1.0-alpha.1.local.1" });
        expect(findDesktopPackage("vera-old", setup.prefix)?.desktopVersion).toBe("0.1.0-alpha.1.local.1");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(readdirSync(releasesDirectory(setup.prefix))).toEqual(releasesBefore);
        // Nothing holds the older package, so cleanup removes it.
        expect(packageVersions(setup)).toEqual(["0.1.0-alpha.1.local.1"]);
    });
});

test("a second desktop-only install counts the local version up", async () => {
    await withSetup(async (setup) => {
        await installPackage(setup, "0.1.0-alpha.1");
        const fake = fakeBuild(setup);
        await installOnly(setup, fake);
        const second = await installOnly(setup, fake);
        expect(second).toMatchObject({ kind: "installed", desktopVersion: "0.1.0-alpha.1.local.2", app: { kind: "kept" } });
        expect(packageVersions(setup)).toEqual(["0.1.0-alpha.1.local.2"]);
    });
});

test("with no package for the current build, the desktop takes the build's product version", async () => {
    await withSetup(async (setup) => {
        const outcome = await installOnly(setup, fakeBuild(setup));
        expect(outcome).toMatchObject({ kind: "installed", desktopVersion: "0.1.0-alpha.1" });
        expect(packageVersions(setup)).toEqual(["0.1.0-alpha.1"]);
    });
});

test("@core a checkout whose wire files differ from the current build installs nothing and names the files", async () => {
    await withSetup(async (setup) => {
        await installPackage(setup, "0.1.0-alpha.1");
        writeAt(join(setup.checkout, "src/engine/protocol.ts"), "// changed\n");
        const fake = fakeBuild(setup);
        const outcome = await installOnly(setup, fake);
        expect(outcome.kind).toBe("refused");
        const message = outcome.kind === "refused" ? outcome.message : "";
        expect(message).toContain("src/engine/protocol.ts");
        expect(message).not.toContain("src/host/protocol.ts");
        expect(message).toContain("bun run install:local");
        expect(fake.calls).toEqual([]);
        expect(packageVersions(setup)).toEqual(["0.1.0-alpha.1"]);
        expect(readdirSync(setup.apps)).toEqual([]);
    });
});

test("a wire file missing on either side counts as changed", async () => {
    await withSetup(async (setup) => {
        const releaseRoot = releaseDirectory("vera-old", setup.prefix);
        expect(changedWireFiles(setup.checkout, releaseRoot)).toEqual([]);
        rmSync(join(releaseRoot, "src/host/protocol.ts"));
        rmSync(join(setup.checkout, "src/engine/host-protocol.ts"));
        expect(changedWireFiles(setup.checkout, releaseRoot)).toEqual(["src/host/protocol.ts", "src/engine/host-protocol.ts"]);
    });
});

test("a desktop-only install is refused with no installed build, on another prefix, or off macOS", async () => {
    await withSetup(async (setup) => {
        const fake = fakeBuild(setup);
        expect(await installOnly(setup, fake)).toMatchObject({ kind: "refused", message: expect.stringContaining("no Vera build is installed") });
        expect(fake.calls).toEqual([]);
    }, { installed: false });
    await withSetup(async (setup) => {
        const fake = fakeBuild(setup);
        expect(await installOnly(setup, fake, { home: join(setup.root, "elsewhere") }))
            .toMatchObject({ kind: "refused", message: expect.stringContaining("~/.local") });
        expect(await installOnly(setup, fake, { platform: "linux" }))
            .toMatchObject({ kind: "refused", message: expect.stringContaining("macOS") });
        expect(fake.calls).toEqual([]);
    });
});

test("@core a desktop that needs a newer app shell while Vera is running installs nothing", async () => {
    await withSetup(async (setup) => {
        await installPackage(setup, "0.1.0-alpha.1");
        writeShellApp(setup.appPath, 1, { label: "old" });
        const outcome = await installOnly(setup, fakeBuild(setup, 2), { isRunning: () => true });
        expect(outcome).toMatchObject({ kind: "refused", message: expect.stringContaining("Quit Vera") });
        expect(packageVersions(setup)).toEqual(["0.1.0-alpha.1"]);
        expect(shellLabel(setup.appPath)).toBe("old");
    });
});

test("a desktop that needs a newer app shell replaces the app when Vera is not running", async () => {
    await withSetup(async (setup) => {
        await installPackage(setup, "0.1.0-alpha.1");
        writeShellApp(setup.appPath, 1, { label: "old" });
        const outcome = await installOnly(setup, fakeBuild(setup, 2));
        expect(outcome).toMatchObject({ kind: "installed", app: { kind: "replaced", appPath: setup.appPath } });
        expect(shellLabel(setup.appPath)).toBe("new-shell-2");
        expect(findDesktopPackage("vera-old", setup.prefix)).toMatchObject({ desktopVersion: "0.1.0-alpha.1.local.1", shellApi: 2 });
        expect(describeDesktopOnlyOutcome(outcome).lines).toEqual([
            "vera install:local: installed desktop 0.1.0-alpha.1.local.1 for vera-old. An open Vera window reloads into it.",
            `vera install:local: replaced the desktop app at ${setup.appPath}`,
        ]);
    });
});

test("@core the local desktop version sorts above the one it follows", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
        ["0.1.0-alpha.2", "0.1.0-alpha.2.local.1"],
        ["0.1.0-alpha.2.local.1", "0.1.0-alpha.2.local.2"],
        ["0.1.0-alpha.2.local.9", "0.1.0-alpha.2.local.10"],
        ["0.1.0", "0.1.1-local.1"],
        ["0.1.1-local.3", "0.1.1-local.4"],
        ["0.1.0+abc", "0.1.1-local.1"],
        ["1.0.0-rc.1+abc", "1.0.0-rc.1.local.1"],
    ];
    for (const [newest, next] of cases) {
        expect(nextLocalDesktopVersion(newest)).toBe(next);
        expect(compareReleaseVersions(next, newest)).toBe(1);
    }
    expect(compareReleaseVersions("0.1.0-alpha.2.local.1", "0.1.0-alpha.3")).toBe(-1);
    expect(compareReleaseVersions("0.1.1-local.1", "0.1.1")).toBe(-1);
});

test("--desktop-only parses alone and is refused with --no-desktop or --force", () => {
    const onError = (message: string): never => {
        throw new Error(message);
    };
    expect(parseArgs(["--desktop-only"], onError)).toEqual({ prefix: undefined, force: false, noDesktop: false, desktopOnly: true });
    expect(parseArgs(["--desktop-only", "--prefix", "/p"], onError)).toMatchObject({ prefix: "/p", desktopOnly: true });
    expect(() => parseArgs(["--desktop-only", "--no-desktop"], onError)).toThrow("cannot be used together");
    expect(() => parseArgs(["--force", "--desktop-only"], onError)).toThrow("--force");
});
