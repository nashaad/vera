import { expect, test } from "bun:test";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { packRelease } from "../../scripts/pack-release.ts";
import { packedReleaseRoot } from "../../src/release/layout.ts";
import { VERA_PRODUCT_VERSION } from "../../src/release/manifest.ts";
import { formatVeraVersion, readStampedRelease } from "../../src/release/stamp.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");

function bunPath(): string {
    const path = process.env.PATH ?? "";
    const bunDir = dirname(process.execPath);
    const entries = path.split(":").filter((entry) => entry.length > 0);
    if (entries.includes(bunDir)) return path;
    return `${bunDir}:${path}`;
}

function pathWithoutGit(): string {
    return bunPath().split(":").filter((entry) => {
        if (entry.length === 0) return false;
        return !existsSync(join(entry, "git"));
    }).join(":");
}

function copyTreeWithoutGit(from: string, to: string): void {
    mkdirSync(to, { recursive: true });
    for (const name of [
        "src",
        "clients",
        "scripts",
        "extensions",
        "config",
        "python",
        "package.json",
        "bun.lock",
        "tsconfig.json",
        "bunfig.toml",
        "index.ts",
    ]) {
        const source = join(from, name);
        if (!existsSync(source)) continue;
        cpSync(source, join(to, name), { recursive: true });
    }
    mkdirSync(join(to, "dist"), { recursive: true });
    cpSync(
        join(from, "dist", "release"),
        join(to, "dist", "release"),
        { recursive: true },
    );
    symlinkSync(join(from, "node_modules"), join(to, "node_modules"));
}

test("vera --version reads the packed stamp with git gone and the repo moved", async () => {
    const packed = await packRelease(packedReleaseRoot(), {
        force: true,
        cwd: repoRoot,
    });
    const relocated = mkdtempSync(join(tmpdir(), "vera-stamp-relocated-"));
    try {
        copyTreeWithoutGit(repoRoot, relocated);
        expect(existsSync(join(relocated, ".git"))).toBe(false);
        let gitAvailable = false;
        try {
            gitAvailable = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
                cwd: relocated,
                env: { PATH: pathWithoutGit(), HOME: relocated },
                stdout: "pipe",
                stderr: "pipe",
            }).exitCode === 0;
        } catch {
            gitAvailable = false;
        }
        expect(gitAvailable).toBe(false);

        const version = Bun.spawnSync(
            [process.execPath, join(relocated, "clients", "cli", "main.ts"), "--version"],
            {
                cwd: relocated,
                env: {
                    HOME: relocated,
                    PATH: pathWithoutGit(),
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        expect(version.stderr.toString()).toBe("");
        expect(version.exitCode).toBe(0);
        expect(version.stdout.toString()).toBe(
            `${formatVeraVersion(readStampedRelease(join(relocated, "dist", "release")))}\n`,
        );
        expect(version.stdout.toString()).toContain(VERA_PRODUCT_VERSION);
        expect(version.stdout.toString()).toContain(packed.manifest.build_id);
    } finally {
        rmSync(relocated, { recursive: true, force: true });
    }
});

test("vera --version fails loudly when the stamp is missing", () => {
    const relocated = mkdtempSync(join(tmpdir(), "vera-stamp-missing-"));
    try {
        copyTreeWithoutGit(repoRoot, relocated);
        rmSync(join(relocated, "dist"), { recursive: true, force: true });
        const version = Bun.spawnSync(
            [process.execPath, join(relocated, "clients", "cli", "main.ts"), "--version"],
            {
                cwd: relocated,
                env: {
                    HOME: relocated,
                    PATH: pathWithoutGit(),
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        expect(version.exitCode).not.toBe(0);
        expect(version.stderr.toString()).toMatch(/No release stamp at /);
        expect(version.stderr.toString()).toMatch(/pack:release/);
        expect(version.stdout.toString()).toBe("");
    } finally {
        rmSync(relocated, { recursive: true, force: true });
    }
});
