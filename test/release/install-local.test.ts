import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { installLocal } from "../../scripts/install-local.ts";
import { activateRelease } from "../../src/release/activate.ts";
import {
    currentReleaseBuildId,
    currentSymlinkPath,
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
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        expect(ran.exitCode, ran.stderr.toString()).toBe(0);
        const lines = ran.stdout.toString().trim().split("\n");
        expect(lines[1]).toBe(launcherPath(prefix));
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
            .toContain("$here/clients/cli/main.ts");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
        rmSync(userHome, { recursive: true, force: true });
        rmSync(veraHome, { recursive: true, force: true });
    }
}, 120_000);

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
            drainHost: async () => "absent",
            startHost: async () => {
                throw new Error("startHost must not run");
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
