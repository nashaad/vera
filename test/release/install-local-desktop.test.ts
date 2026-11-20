import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    chooseApplicationsDirectory,
    describeDesktopOutcome,
    isDesktopPrefix,
    shellIsRunning,
} from "../../scripts/install-local-desktop.ts";
import { installLocal, type InstallLocalOptions, type InstallLocalResult } from "../../scripts/install-local.ts";
import type { BuildDesktopForHostOptions } from "../../scripts/desktop-release/build-for-host.ts";
import type { ArchiveFile } from "../../scripts/desktop-release/archive.ts";
import { findDesktopPackage } from "../../src/release/desktop-packages.ts";
import {
    currentReleaseBuildId,
    desktopInstallRecordPath,
    desktopPackagesDirectory,
    releaseDirectory,
} from "../../src/release/layout.ts";
import { VERA_PRODUCT_VERSION } from "../../src/release/manifest.ts";
import { readDesktopInstallRecord, writeDesktopInstallRecord } from "../../src/release/shell-update.ts";
import {
    desktopTarball,
    prefixWithOldRelease,
    shellLabel,
    shellTarball,
    writeShellApp,
    writeVerifiableRelease,
} from "./update-fixtures.ts";

// The root doubles as the home: the prefix is <root>/.local, the one prefix the desktop app can use.
interface Setup {
    readonly root: string;
    readonly prefix: string;
    readonly apps: string;
    readonly appPath: string;
}

async function withSetup(run: (setup: Setup) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "vera-local-desktop-"));
    try {
        const { prefix } = prefixWithOldRelease(root, ".local");
        const apps = join(root, "Applications");
        mkdirSync(apps);
        await run({ root, prefix, apps, appPath: join(apps, "Vera.app") });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function archive(path: string): ArchiveFile {
    const bytes = readFileSync(path);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

interface FakeBuild {
    readonly calls: BuildDesktopForHostOptions[];
    readonly build: (options: BuildDesktopForHostOptions) => Promise<{ desktopPackage: ArchiveFile; shell: ArchiveFile }>;
}

// A package that needs shell API `needs`, shipped with a shell archive of API `ships` labelled `label`.
function fakeBuild(setup: Setup, needs: number, ships = needs, label = `new-shell-${ships}`): FakeBuild {
    const calls: BuildDesktopForHostOptions[] = [];
    return {
        calls,
        build: async (options) => {
            calls.push(options);
            return {
                desktopPackage: archive(desktopTarball(setup.root, options.hostBuildId, options.desktopVersion, needs)),
                shell: archive(shellTarball(setup.root, ships, { label })),
            };
        },
    };
}

interface RunOptions extends Partial<InstallLocalOptions> {
    readonly buildId?: string;
}

function install(setup: Setup, fake: FakeBuild, options: RunOptions = {}): Promise<InstallLocalResult> {
    const { buildId = "vera-new", desktop, ...rest } = options;
    return installLocal({
        prefix: setup.prefix,
        pack: async () => {
            const releaseRoot = releaseDirectory(buildId, setup.prefix);
            return { releaseRoot, manifest: writeVerifiableRelease(releaseRoot, buildId, VERA_PRODUCT_VERSION) };
        },
        verify: () => {},
        readLiveHost: async () => undefined,
        report: () => {},
        ...rest,
        desktop: {
            build: fake.build,
            applicationsDirectory: setup.apps,
            isRunning: () => false,
            home: setup.root,
            ...desktop,
        },
    });
}

test("@core the desktop package for the packed build is installed before the build becomes current", async () => {
    await withSetup(async (setup) => {
        const fake = fakeBuild(setup, 1);
        const seen: Array<{ current: string | undefined; packaged: boolean }> = [];
        const result = await install(setup, fake, {
            verify: () => {
                seen.push({
                    current: currentReleaseBuildId(setup.prefix),
                    packaged: findDesktopPackage("vera-new", setup.prefix) !== undefined,
                });
            },
        });
        expect(seen).toEqual([{ current: "vera-old", packaged: true }]);
        expect(result.outcome.kind).toBe("activated");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]).toMatchObject({
            hostBuildId: "vera-new",
            desktopVersion: VERA_PRODUCT_VERSION,
            arch: process.arch,
        });
        expect(findDesktopPackage("vera-new", setup.prefix)).toMatchObject({
            hostBuildId: "vera-new",
            desktopVersion: VERA_PRODUCT_VERSION,
            shellApi: 1,
        });
    });
});

test("@core the app is installed when none is installed, and the record names it", async () => {
    await withSetup(async (setup) => {
        const result = await install(setup, fakeBuild(setup, 1));
        expect(result.desktop).toEqual({ kind: "installed", appPath: setup.appPath });
        expect(shellLabel(setup.appPath)).toBe("new-shell-1");
        expect(readDesktopInstallRecord(setup.prefix)).toEqual({ appPath: setup.appPath });
        expect(JSON.parse(readFileSync(desktopInstallRecordPath(setup.prefix), "utf8")))
            .toEqual({ layout_version: 1, app_path: setup.appPath });
        expect(readdirSync(setup.apps)).toEqual(["Vera.app"]);
    });
});

test("an app whose shell API is high enough is kept and recorded", async () => {
    await withSetup(async (setup) => {
        writeShellApp(setup.appPath, 2, { label: "kept" });
        const result = await install(setup, fakeBuild(setup, 2));
        expect(result.desktop).toEqual({ kind: "kept", appPath: setup.appPath });
        expect(shellLabel(setup.appPath)).toBe("kept");
        expect(readDesktopInstallRecord(setup.prefix)?.appPath).toBe(setup.appPath);
        expect(findDesktopPackage("vera-new", setup.prefix)).toBeDefined();
        expect(readdirSync(setup.apps)).toEqual(["Vera.app"]);
    });
});

test("@core an app whose shell API is lower than the package needs is replaced", async () => {
    await withSetup(async (setup) => {
        writeShellApp(setup.appPath, 1, { label: "old" });
        const result = await install(setup, fakeBuild(setup, 2));
        expect(result.desktop).toEqual({ kind: "replaced", appPath: setup.appPath });
        expect(shellLabel(setup.appPath)).toBe("new-shell-2");
        expect(readDesktopInstallRecord(setup.prefix)?.appPath).toBe(setup.appPath);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
        expect(readdirSync(setup.apps).filter((name) => name !== "Vera.app")).toEqual([]);
    });
});

test("@core a running app that needs replacing is left alone while the package and the host install go ahead", async () => {
    await withSetup(async (setup) => {
        writeShellApp(setup.appPath, 1, { label: "old" });
        const asked: string[] = [];
        const fake = fakeBuild(setup, 2);
        const result = await install(setup, fake, {
            desktop: {
                build: fake.build,
                applicationsDirectory: setup.apps,
                isRunning: (appPath) => {
                    asked.push(appPath);
                    return true;
                },
            },
        });
        expect(asked).toEqual([setup.appPath]);
        expect(result.desktop).toEqual({ kind: "running", appPath: setup.appPath });
        expect(shellLabel(setup.appPath)).toBe("old");
        expect(readdirSync(setup.apps)).toEqual(["Vera.app"]);
        expect(findDesktopPackage("vera-new", setup.prefix)).toBeDefined();
        expect(result.outcome.kind).toBe("activated");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
        expect(describeDesktopOutcome(result.desktop!)).toEqual({
            line: `vera install:local: the desktop app at ${setup.appPath} needs replacing and Vera is running. Quit Vera and run this again.`,
            failure: false,
        });
    });
});

test("a running app that needs no replacement is not asked about", async () => {
    await withSetup(async (setup) => {
        writeShellApp(setup.appPath, 2, { label: "kept" });
        const fake = fakeBuild(setup, 2);
        const result = await install(setup, fake, {
            desktop: {
                build: fake.build,
                applicationsDirectory: setup.apps,
                isRunning: () => {
                    throw new Error("must not be asked");
                },
            },
        });
        expect(result.desktop?.kind).toBe("kept");
    });
});

test("noDesktop builds and installs nothing for the desktop", async () => {
    await withSetup(async (setup) => {
        const fake = fakeBuild(setup, 1);
        const result = await install(setup, fake, { noDesktop: true });
        expect(result.desktop).toBeUndefined();
        expect(result.outcome.kind).toBe("activated");
        expect(fake.calls).toEqual([]);
        expect(readdirSync(setup.apps)).toEqual([]);
        expect(existsSync(desktopPackagesDirectory(setup.prefix))).toBe(false);
    });
});

test("@core a prefix other than ~/.local skips the desktop step and still installs the host", async () => {
    await withSetup(async (setup) => {
        const fake = fakeBuild(setup, 1);
        const result = await install(setup, fake, { desktop: { home: join(setup.root, "elsewhere") } });
        expect(result.desktop).toEqual({ kind: "other_prefix" });
        expect(describeDesktopOutcome(result.desktop!)).toEqual({
            line: "The desktop app needs Vera in ~/.local; it was not installed.",
            failure: false,
        });
        expect(result.outcome.kind).toBe("activated");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
        expect(fake.calls).toEqual([]);
        expect(readdirSync(setup.apps)).toEqual([]);
        expect(existsSync(desktopPackagesDirectory(setup.prefix))).toBe(false);
    });
});

test("noDesktop stays silent for a prefix other than ~/.local", async () => {
    await withSetup(async (setup) => {
        const result = await install(setup, fakeBuild(setup, 1), {
            noDesktop: true,
            desktop: { home: join(setup.root, "elsewhere") },
        });
        expect(result.desktop).toBeUndefined();
    });
});

test("isDesktopPrefix compares the prefix with <home>/.local the way install.sh does", () => {
    expect(isDesktopPrefix("/Users/crow/.local", "/Users/crow")).toBe(true);
    expect(isDesktopPrefix("/Users/crow/.local/", "/Users/crow")).toBe(true);
    expect(isDesktopPrefix("/Users/crow/.local//", "/Users/crow")).toBe(false);
    expect(isDesktopPrefix("/Users/crow/local", "/Users/crow")).toBe(false);
    expect(isDesktopPrefix("/opt/vera", "/Users/crow")).toBe(false);
    expect(isDesktopPrefix("/Users/crow/.local", "/Users/other")).toBe(false);
});

test("a platform other than macOS does nothing for the desktop and says nothing", async () => {
    await withSetup(async (setup) => {
        const fake = fakeBuild(setup, 1);
        const lines: string[] = [];
        const result = await install(setup, fake, {
            report: (line) => lines.push(line),
            desktop: { platform: "linux", build: fake.build, applicationsDirectory: setup.apps },
        });
        expect(result.desktop).toBeUndefined();
        expect(fake.calls).toEqual([]);
        expect(readdirSync(setup.apps)).toEqual([]);
        expect(lines.join("\n")).not.toMatch(/desktop/i);
    });
});

test("@core a desktop build failure never blocks the host install and comes back as the reason", async () => {
    await withSetup(async (setup) => {
        const result = await install(setup, fakeBuild(setup, 1), {
            desktop: {
                applicationsDirectory: setup.apps,
                build: async () => {
                    throw new Error("clients/desktop/build.ts exited 1");
                },
            },
        });
        expect(result.outcome.kind).toBe("activated");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
        expect(result.desktop).toEqual({ kind: "failed", message: "clients/desktop/build.ts exited 1" });
        expect(describeDesktopOutcome(result.desktop!)).toEqual({
            line: "vera install:local: the desktop app was not installed: clients/desktop/build.ts exited 1",
            failure: true,
        });
        expect(readdirSync(setup.apps)).toEqual([]);
    });
});

test("a package that fails its checksum is a desktop failure and leaves the app alone", async () => {
    await withSetup(async (setup) => {
        writeShellApp(setup.appPath, 1, { label: "old" });
        const good = fakeBuild(setup, 2);
        const result = await install(setup, good, {
            desktop: {
                applicationsDirectory: setup.apps,
                build: async (options) => {
                    const built = await good.build(options);
                    return { ...built, desktopPackage: { ...built.desktopPackage, sha256: "0".repeat(64) } };
                },
            },
        });
        expect(result.desktop).toMatchObject({ kind: "failed" });
        expect(result.outcome.kind).toBe("activated");
        expect(shellLabel(setup.appPath)).toBe("old");
        expect(findDesktopPackage("vera-new", setup.prefix)).toBeUndefined();
    });
});

test("something that is not the Vera app at the destination is never replaced", async () => {
    await withSetup(async (setup) => {
        writeShellApp(setup.appPath, 1, { bundleId: "com.example.other", label: "theirs" });
        const result = await install(setup, fakeBuild(setup, 1));
        expect(result.desktop).toMatchObject({ kind: "failed" });
        expect((result.desktop as { message: string }).message).toContain("is not the Vera desktop app");
        expect(shellLabel(setup.appPath)).toBe("theirs");
        expect(result.outcome.kind).toBe("activated");
        expect(existsSync(desktopInstallRecordPath(setup.prefix))).toBe(false);
    });
});

test("a shell archive older than its package needs is not installed", async () => {
    await withSetup(async (setup) => {
        const result = await install(setup, fakeBuild(setup, 2, 1));
        expect(result.desktop).toMatchObject({ kind: "failed" });
        expect(existsSync(setup.appPath)).toBe(false);
        expect(readdirSync(setup.apps)).toEqual([]);
        expect(result.outcome.kind).toBe("activated");
    });
});

test("an app that cannot be checked for running is left alone and reported", async () => {
    await withSetup(async (setup) => {
        writeShellApp(setup.appPath, 1, { label: "old" });
        const fake = fakeBuild(setup, 2);
        const result = await install(setup, fake, {
            desktop: {
                build: fake.build,
                applicationsDirectory: setup.apps,
                isRunning: () => {
                    throw new Error("lsof is missing");
                },
            },
        });
        expect(result.desktop).toMatchObject({ kind: "failed" });
        expect(shellLabel(setup.appPath)).toBe("old");
        expect(result.outcome.kind).toBe("activated");
    });
});

test("a second run keeps the app the first run installed", async () => {
    await withSetup(async (setup) => {
        expect((await install(setup, fakeBuild(setup, 1))).desktop?.kind).toBe("installed");
        const second = await install(setup, fakeBuild(setup, 1), { buildId: "vera-newer" });
        expect(second.desktop).toEqual({ kind: "kept", appPath: setup.appPath });
        expect(findDesktopPackage("vera-newer", setup.prefix)).toBeDefined();
    });
});

test("a local build's package is collected once the build is neither current nor the rollback", async () => {
    await withSetup(async (setup) => {
        for (const buildId of ["vera-one", "vera-two", "vera-three"]) {
            await install(setup, fakeBuild(setup, 1), { buildId });
        }
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-three");
        expect(findDesktopPackage("vera-three", setup.prefix)).toBeDefined();
        expect(findDesktopPackage("vera-two", setup.prefix)).toBeDefined();
        expect(findDesktopPackage("vera-one", setup.prefix)).toBeUndefined();
    });
});

test("chooseApplicationsDirectory picks the writable system folder, else the home one", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-apps-choice-"));
    try {
        const system = join(root, "system");
        mkdirSync(system);
        const home = join(root, "home");
        expect(chooseApplicationsDirectory({ VERA_INSTALL_APPLICATIONS: system }, home)).toBe(system);
        expect(chooseApplicationsDirectory({ VERA_INSTALL_APPLICATIONS: join(root, "missing") }, home))
            .toBe(join(home, "Applications"));
        writeFileSync(join(root, "file"), "x");
        expect(chooseApplicationsDirectory({ VERA_INSTALL_APPLICATIONS: join(root, "file") }, home))
            .toBe(join(home, "Applications"));
        expect(() => chooseApplicationsDirectory({ VERA_INSTALL_APPLICATIONS: "relative" }, "relative-home"))
            .toThrow(/absolute/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("shellIsRunning is true only for a process that runs from inside the app", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-shell-running-"));
    try {
        const app = join(root, "Vera.app");
        writeShellApp(app, 1);
        expect(shellIsRunning(app, () => [`${app}/Contents/MacOS/Vera`])).toBe(true);
        expect(shellIsRunning(app, () => [`${app}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper`])).toBe(true);
        expect(shellIsRunning(app, () => [`${root}/Vera.app.old/Contents/MacOS/Vera`, "/usr/bin/true"])).toBe(false);
        expect(shellIsRunning(app, () => [])).toBe(false);
        expect(() => shellIsRunning(app, () => {
            throw new Error("cannot list");
        })).toThrow("cannot list");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("writeDesktopInstallRecord writes the record install.sh writes and leaves no temporary file", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-record-"));
    try {
        writeDesktopInstallRecord(prefix, "/Applications/Vera.app");
        writeDesktopInstallRecord(prefix, "/Users/someone/Applications/Vera.app");
        expect(readFileSync(desktopInstallRecordPath(prefix), "utf8"))
            .toBe('{"layout_version":1,"app_path":"/Users/someone/Applications/Vera.app"}\n');
        expect(readdirSync(desktopPackagesDirectory(prefix))).toEqual(["installed.json"]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});
