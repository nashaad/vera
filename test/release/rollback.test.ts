import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { installRelease } from "../../scripts/pack-release.ts";
import { launcherPath } from "../../src/release/layout.ts";

import { activateRelease } from "../../src/release/activate.ts";
import {
    currentReleaseBuildId,
    currentSymlinkPath,
    releaseDirectory,
    rollbackReleaseBuildId,
} from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";
import {
    RollbackUnavailableError,
    rollbackLocalInstall,
} from "../../src/release/rollback.ts";

function writeDummyRelease(prefix: string, buildId: string, script = "echo dummy\n"): string {
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
    writeFileSync(join(root, "vera"), `#!/bin/sh\n${script}`, {
        encoding: "utf8",
        mode: 0o755,
    });
    chmodSync(join(root, "vera"), 0o755);
    return root;
}

test("rollbackLocalInstall restores the pinned previous release", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-"));
    try {
        activateRelease(writeDummyRelease(prefix, "vera-good"), prefix);
        activateRelease(
            writeDummyRelease(prefix, "vera-broken", "echo broken; exit 1\n"),
            prefix,
        );
        expect(currentReleaseBuildId(prefix)).toBe("vera-broken");
        expect(rollbackReleaseBuildId(prefix)).toBe("vera-good");

        const result = rollbackLocalInstall(prefix);
        expect(result.toBuildId).toBe("vera-good");
        expect(result.fromBuildId).toBe("vera-broken");
        expect(readlinkSync(currentSymlinkPath(prefix))).toBe("releases/vera-good");
        expect(rollbackReleaseBuildId(prefix)).toBe("vera-broken");
        expect(existsSync(releaseDirectory("vera-broken", prefix))).toBe(true);
        expect(existsSync(releaseDirectory("vera-good", prefix))).toBe(true);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("rollbackLocalInstall refuses when there is no pin", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-empty-"));
    try {
        activateRelease(writeDummyRelease(prefix, "vera-only"), prefix);
        expect(() => rollbackLocalInstall(prefix)).toThrow(RollbackUnavailableError);
        expect(currentReleaseBuildId(prefix)).toBe("vera-only");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("rollbackLocalInstall refuses a pin whose release is gone", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-missing-"));
    try {
        activateRelease(writeDummyRelease(prefix, "vera-good"), prefix);
        activateRelease(writeDummyRelease(prefix, "vera-broken"), prefix);
        rmSync(releaseDirectory("vera-good", prefix), { recursive: true, force: true });
        expect(() => rollbackLocalInstall(prefix)).toThrow(/not retained/);
        expect(currentReleaseBuildId(prefix)).toBe("vera-broken");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

const repoRoot = resolve(import.meta.dir, "..", "..");
const mainCheckout = resolve(repoRoot, "..", "..");

function sandboxProfile(denied: readonly string[]): string {
    const denies = denied.flatMap((path) => [
        `(deny file-read* (subpath "${path}"))`,
        `(deny file-write* (subpath "${path}"))`,
    ]);
    return `(version 1)\n(allow default)\n(deny network*)\n${denies.join("\n")}\n`;
}

test("vera rollback restores the previous release with the repo and network denied", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "vera-rollback-home-"));
    const prefix = join(userHome, ".local");
    const veraHome = mkdtempSync(join(tmpdir(), "vera-rollback-vera-"));
    const scratch = mkdtempSync(join(tmpdir(), "vera-rollback-scratch-"));
    try {
        activateRelease(writeDummyRelease(prefix, "vera-old"), prefix);
        await installRelease({
            prefix,
            cwd: repoRoot,
            sourceRoot: repoRoot,
            force: true,
        });
        expect(currentReleaseBuildId(prefix)).not.toBe("vera-old");
        expect(rollbackReleaseBuildId(prefix)).toBe("vera-old");

        const profilePath = join(scratch, "vera-rollback.sb");
        writeFileSync(profilePath, sandboxProfile([repoRoot, mainCheckout]));
        const pathEnv = [join(prefix, "bin"), "/usr/bin", "/bin"].join(":");
        const blocked = Bun.spawnSync(
            ["sandbox-exec", "-f", profilePath, "/bin/cat", join(repoRoot, "package.json")],
            { cwd: scratch, stdout: "pipe", stderr: "pipe" },
        );
        expect(blocked.exitCode).not.toBe(0);

        const ran = Bun.spawnSync(
            ["sandbox-exec", "-f", profilePath, "vera", "rollback"],
            {
                cwd: scratch,
                env: {
                    HOME: userHome,
                    PATH: pathEnv,
                    VERA_HOME: veraHome,
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        expect(ran.exitCode, ran.stderr.toString()).toBe(0);
        expect(ran.stdout.toString()).toContain("vera-old");
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(launcherPath(prefix))).toBe(true);
    } finally {
        rmSync(userHome, { recursive: true, force: true });
        rmSync(veraHome, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
    }
}, 120_000);
