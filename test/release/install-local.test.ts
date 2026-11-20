import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { SHELL_API } from "../../clients/desktop/shell/bootstrap.ts";
import { installLocal } from "../../scripts/install-local.ts";
import { activateRelease } from "../../src/release/activate.ts";
import { findDesktopPackage } from "../../src/release/desktop-packages.ts";
import {
    currentReleaseBuildId,
    currentSymlinkPath,
    desktopInstallRecordPath,
    launcherPath,
    RELEASE_CLI_NAME,
    releaseDirectory,
    upgradeJournalPath,
} from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";
import { formatVeraVersion, readStampedRelease } from "../../src/release/stamp.ts";
import { installedShellApi } from "../../src/release/shell-update.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const installer = resolve(repoRoot, "scripts", "install-local.ts");

function writeDummyRelease(prefix: string, buildId: string): string {
    const root = releaseDirectory(buildId, prefix);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), serializeReleaseManifest({
        layout_version: RELEASE_LAYOUT_VERSION,
        product_version: VERA_PRODUCT_VERSION,
        source_revision: "abc",
        build_id: buildId,
        protocol_version: 1,
        platform: "darwin",
        arch: "arm64",
        asset_digest: `sha256:${"ab".repeat(32)}`,
        built_at: "2026-08-31T00:00:00.000Z",
        artifacts: [...RELEASE_ARTIFACT_NAMES],
    }));
    writeFileSync(join(root, "vera"), "#!/bin/sh\necho dummy\n", {
        encoding: "utf8",
        mode: 0o755,
    });
    chmodSync(join(root, "vera"), 0o755);
    return root;
}

test("bun run install:local upgrades a test prefix end to end", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-install-local-"));
    const userHome = mkdtempSync(join(tmpdir(), "vera-install-local-home-"));
    const veraHome = mkdtempSync(join(tmpdir(), "vera-install-local-vera-"));
    const apps = mkdtempSync(join(tmpdir(), "vera-install-local-apps-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");

        const ran = Bun.spawnSync(
            ["bun", installer, "--prefix", prefix, "--force"],
            {
                cwd: repoRoot,
                env: {
                    HOME: userHome,
                    PATH: process.env.PATH,
                    VERA_HOME: veraHome,
                    VERA_INSTALL_APPLICATIONS: apps,
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        expect(ran.exitCode, ran.stderr.toString()).toBe(0);
        const lines = ran.stdout.toString().trim().split("\n");
        expect(lines[1]).toBe(launcherPath(prefix));
        // A prefix other than ~/.local gets no desktop app; the command says so on macOS only.
        expect(readdirSync(apps)).toEqual([]);
        expect(lines[3]).toBe(
            process.platform === "darwin" ? "The desktop app needs Vera in ~/.local; it was not installed." : undefined,
        );
        const buildId = lines[2];
        expect(buildId).toMatch(/^vera-[0-9a-f]+(\+[0-9a-f]{12})?$/);
        expect(buildId).not.toBe("vera-old");
        expect(readlinkSync(currentSymlinkPath(prefix))).toBe(`releases/${buildId}`);
        expect(existsSync(previous)).toBe(true);
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
        expect(ran.stderr.toString()).toContain(`was vera-old`);

        const version = Bun.spawnSync([launcherPath(prefix), "--version"], {
            cwd: tmpdir(),
            env: {
                HOME: userHome,
                PATH: [dirname(launcherPath(prefix)), "/usr/bin", "/bin"].join(":"),
                VERA_HOME: veraHome,
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(version.exitCode, version.stderr.toString()).toBe(0);
        expect(version.stdout.toString()).toBe(
            `${formatVeraVersion(readStampedRelease(join(prefix, "share", "vera", "current")))}\n`,
        );
        expect(readFileSync(join(prefix, "share", "vera", "current", RELEASE_CLI_NAME), "utf8"))
            .toContain("$release/vera-bin");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
        rmSync(userHome, { recursive: true, force: true });
        rmSync(veraHome, { recursive: true, force: true });
        rmSync(apps, { recursive: true, force: true });
    }
}, 120_000);

// Builds the real desktop archives, so it takes a while. The apps folder is a scratch one; nothing reaches the real Applications.
test.skipIf(process.platform !== "darwin")("bun run install:local also installs the desktop package and Vera.app on macOS", async () => {
    // The desktop app only uses <HOME>/.local, so the scratch home holds the prefix.
    const userHome = mkdtempSync(join(tmpdir(), "vera-install-local-desktop-home-"));
    const prefix = join(userHome, ".local");
    const veraHome = mkdtempSync(join(tmpdir(), "vera-install-local-desktop-vera-"));
    const apps = mkdtempSync(join(tmpdir(), "vera-install-local-desktop-apps-"));
    try {
        const ran = Bun.spawnSync(
            ["bun", installer, "--prefix", prefix, "--force"],
            {
                cwd: repoRoot,
                env: {
                    HOME: userHome,
                    PATH: process.env.PATH,
                    VERA_HOME: veraHome,
                    VERA_INSTALL_APPLICATIONS: apps,
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        expect(ran.exitCode, ran.stderr.toString()).toBe(0);
        const lines = ran.stdout.toString().trim().split("\n");
        const buildId = lines[2]!;
        const app = join(apps, "Vera.app");
        expect(lines[3]).toBe(`vera install:local: installed the desktop app at ${app}`);
        expect(currentReleaseBuildId(prefix)).toBe(buildId);
        expect(installedShellApi(app)).toBe(SHELL_API);
        expect(findDesktopPackage(buildId, prefix)).toMatchObject({
            hostBuildId: buildId,
            desktopVersion: VERA_PRODUCT_VERSION,
            shellApi: SHELL_API,
        });
        expect(JSON.parse(readFileSync(desktopInstallRecordPath(prefix), "utf8")))
            .toEqual({ layout_version: 1, app_path: app });
    } finally {
        rmSync(userHome, { recursive: true, force: true });
        rmSync(veraHome, { recursive: true, force: true });
        rmSync(apps, { recursive: true, force: true });
    }
}, 300_000);

test("installLocal leaves the previous release active when pack fails", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-install-local-fail-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        await expect(installLocal({
            prefix,
            pack: async () => {
                throw new Error("disk full while packing");
            },
        })).rejects.toThrow(/disk full while packing/);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("package.json names install:local", () => {
    const pkg = JSON.parse(
        readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["install:local"]).toBe("bun run scripts/install-local.ts");
});
