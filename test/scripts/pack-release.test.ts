import { expect, test } from "bun:test";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { HOST_PROTOCOL_VERSION } from "../../src/host/protocol.ts";
import { releaseBuildId } from "../../src/release/build-id.ts";
import { packedAnnexRoot, releaseManifestPath } from "../../src/release/layout.ts";
import { parseReleaseManifest } from "../../src/release/manifest.ts";
import { packRelease } from "../../scripts/pack-release.ts";

const packer = resolve(import.meta.dir, "..", "..", "scripts", "pack-release.ts");
const repoRoot = resolve(import.meta.dir, "..", "..");

function git(cwd: string, args: readonly string[]): string {
    const result = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString() || args.join(" "));
    }
    return result.stdout.toString().trim();
}

function initRepo(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-pack-release-"));
    git(directory, ["init", "-q"]);
    git(directory, ["config", "user.email", "ovu05@example.test"]);
    git(directory, ["config", "user.name", "ovu05"]);
    writeFileSync(join(directory, "file.txt"), "clean\n");
    git(directory, ["add", "file.txt"]);
    git(directory, ["commit", "-q", "-m", "init"]);
    return directory;
}

test("pack-release writes a manifest with annex and the host protocol version", async () => {
    const output = mkdtempSync(join(tmpdir(), "vera-release-pack-"));
    try {
        const result = await packRelease(output, { force: true, cwd: repoRoot });
        const manifest = parseReleaseManifest(
            readFileSync(releaseManifestPath(output), "utf8"),
        );
        expect(manifest).toEqual(result.manifest);
        expect(manifest.build_id).toBe(releaseBuildId(repoRoot));
        expect(manifest.protocol_version).toBe(HOST_PROTOCOL_VERSION);
        expect(manifest.artifacts).toContain("annex");
        expect(manifest.artifacts).toContain("annex_assets");
        expect(manifest.artifacts).toContain("host");
        expect(manifest.artifacts).toContain("worker");
        expect(readFileSync(join(packedAnnexRoot(output), "index.html"), "utf8"))
            .toContain("Vera · Usage");
        expect(readFileSync(join(packedAnnexRoot(output), "build-id"), "utf8").trim())
            .toBe(manifest.build_id);
        expect(manifest.asset_digest.startsWith("sha256:")).toBe(true);
    } finally {
        rmSync(output, { recursive: true, force: true });
    }
});

test("two packs of the same commit with different working-tree state differ", async () => {
    const repo = initRepo();
    const firstOut = mkdtempSync(join(tmpdir(), "vera-release-a-"));
    const secondOut = mkdtempSync(join(tmpdir(), "vera-release-b-"));
    try {
        const first = await packRelease(firstOut, { force: true, cwd: repo });
        writeFileSync(join(repo, "file.txt"), "dirty working tree\n");
        const second = await packRelease(secondOut, { force: true, cwd: repo });
        expect(first.manifest.source_revision).toBe(second.manifest.source_revision);
        expect(second.manifest.build_id).not.toBe(first.manifest.build_id);
        expect(first.manifest.build_id).toMatch(/^vera-[0-9a-f]+$/);
        expect(second.manifest.build_id).toMatch(/^vera-[0-9a-f]+\+[0-9a-f]{12}$/);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(firstOut, { recursive: true, force: true });
        rmSync(secondOut, { recursive: true, force: true });
    }
});

test("pack-release CLI writes a throwaway release directory", () => {
    const output = mkdtempSync(join(tmpdir(), "vera-release-cli-"));
    try {
        const ran = Bun.spawnSync(["bun", packer, output, "--force"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(ran.exitCode).toBe(0);
        const lines = ran.stdout.toString().trim().split("\n");
        expect(lines[0]).toBe(output);
        expect(lines[1]).toMatch(/^vera-[0-9a-f]+(\+[0-9a-f]{12})?$/);
        expect(parseReleaseManifest(
            readFileSync(releaseManifestPath(output), "utf8"),
        ).protocol_version).toBe(HOST_PROTOCOL_VERSION);
    } finally {
        rmSync(output, { recursive: true, force: true });
    }
});

test("dev scripts pack the release before tui and host", () => {
    const pkg = JSON.parse(
        readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["pack:release"]).toBe(
        "bun run scripts/pack-release.ts dist/release",
    );
    expect(pkg.scripts.host?.startsWith("bun run pack:release &&")).toBe(true);
    expect(pkg.scripts.tui?.startsWith("bun run pack:release &&")).toBe(true);
    expect(pkg.scripts["tui:worktree"]?.startsWith("bun run pack:release &&"))
        .toBe(true);
});
