import { expect, test } from "bun:test";
import {
    existsSync,
    lstatSync,
    mkdtempSync,
    readlinkSync,
    realpathSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { installRelease } from "../../scripts/pack-release.ts";
import {
    RELEASE_ANNEX_NAME,
    RELEASE_BUN_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_WORKER_NAME,
    launcherPath,
} from "../../src/release/layout.ts";
import { formatVeraVersion, readStampedRelease } from "../../src/release/stamp.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const packer = resolve(repoRoot, "scripts", "pack-release.ts");

test("installRelease packs a runnable tree and points current at it", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-install-"));
    try {
        const installed = await installRelease({
            prefix,
            cwd: repoRoot,
            sourceRoot: repoRoot,
        });
        expect(readlinkSync(installed.current)).toBe(
            `releases/${installed.manifest.build_id}`,
        );
        expect(realpathSync(installed.current)).toBe(
            realpathSync(installed.releaseRoot),
        );
        expect(existsSync(join(installed.releaseRoot, RELEASE_BUN_NAME))).toBe(true);
        expect(existsSync(join(installed.releaseRoot, RELEASE_CLI_NAME))).toBe(true);
        expect(existsSync(join(installed.releaseRoot, RELEASE_HOST_NAME))).toBe(true);
        expect(existsSync(join(installed.releaseRoot, RELEASE_WORKER_NAME))).toBe(true);
        expect(existsSync(join(installed.releaseRoot, RELEASE_ANNEX_NAME))).toBe(true);
        expect(existsSync(join(installed.releaseRoot, "src"))).toBe(true);
        expect(existsSync(join(installed.releaseRoot, "clients"))).toBe(true);
        expect(existsSync(join(installed.releaseRoot, "extensions"))).toBe(true);
        expect(existsSync(join(installed.releaseRoot, "node_modules"))).toBe(true);
        expect(existsSync(join(installed.releaseRoot, "annex", "index.html"))).toBe(true);
        expect(lstatSync(join(installed.releaseRoot, RELEASE_CLI_NAME)).isFile())
            .toBe(true);
        expect(installed.launcher).toBe(launcherPath(prefix));

        const version = Bun.spawnSync([installed.launcher, "--version"], {
            cwd: tmpdir(),
            env: {
                HOME: prefix,
                PATH: [dirname(installed.launcher), "/usr/bin", "/bin"].join(":"),
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(version.stderr.toString()).toBe("");
        expect(version.exitCode).toBe(0);
        expect(version.stdout.toString()).toBe(
            `${formatVeraVersion(readStampedRelease(installed.releaseRoot))}\n`,
        );
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
}, 120_000);

test("pack-release --install writes current and the launcher", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-install-cli-"));
    try {
        const ran = Bun.spawnSync(
            ["bun", packer, "--install", "--prefix", prefix, "--force"],
            { stdout: "pipe", stderr: "pipe" },
        );
        expect(ran.exitCode).toBe(0);
        expect(ran.stderr.toString()).toBe("");
        const lines = ran.stdout.toString().trim().split("\n");
        expect(lines[1]).toBe(launcherPath(prefix));
        expect(existsSync(launcherPath(prefix))).toBe(true);
        expect(readlinkSync(join(prefix, "share", "vera", "current"))).toMatch(
            /^releases\//,
        );
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
}, 120_000);
