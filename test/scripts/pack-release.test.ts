import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { HOST_PROTOCOL_VERSION } from "../../src/host/protocol.ts";
import { releaseBuildId } from "../../src/release/build-id.ts";
import {
    packedAnnexRoot,
    RELEASE_WORKER_NAME,
    releaseDirectory,
    releaseManifestPath,
} from "../../src/release/layout.ts";
import { parseReleaseManifest } from "../../src/release/manifest.ts";
import { verifyPackedRelease } from "../../src/release/verify.ts";
import {
    packRelease,
    packRunnableRelease,
    replaceReleaseDirectory,
} from "../../scripts/pack-release.ts";

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
            .toContain("<title>Vera</title>");
        expect(readFileSync(join(packedAnnexRoot(output), "build-id"), "utf8").trim())
            .toBe(manifest.build_id);
        expect(manifest.asset_digest.startsWith("sha256:")).toBe(true);
        expect(existsSync(join(output, "worker"))).toBe(true);
        expect(existsSync(join(output, "vera-annex"))).toBe(true);
        expect(existsSync(join(output, "vera-supervisor"))).toBe(true);
        expect(existsSync(join(output, "host"))).toBe(false);
        expect(readFileSync(join(output, "worker"), "utf8"))
            .toContain("src/host/worker/entry.ts");
        const spawned = Bun.spawn([join(output, "worker")], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(spawned.pid).toBeGreaterThan(0);
        spawned.kill();
        await spawned.exited;
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
    expect(pkg.scripts["dev:tui"]?.startsWith("bun run pack:release &&"))
        .toBe(true);
});

// A source tree with the files a release needs, minus node_modules.
function scaffoldReleaseSource(): string {
    const source = mkdtempSync(join(tmpdir(), "vera-pack-source-"));
    const files = [
        "clients/cli/main.ts",
        "clients/host/main.ts",
        "src/annex/main.ts",
        "docs/index.md",
        "index.ts",
        "package.json",
        "tsconfig.json",
        "bunfig.toml",
    ];
    for (const file of files) {
        mkdirSync(join(source, file, ".."), { recursive: true });
        writeFileSync(join(source, file), file.endsWith(".json") ? "{}\n" : "\n");
    }
    mkdirSync(join(source, "config"));
    mkdirSync(join(source, "extensions"));
    symlinkSync(
        join(repoRoot, "clients", "annex"),
        join(source, "clients", "annex"),
    );
    return source;
}

test("a pack that fails during assembly is rebuilt on the next run, not reused", async () => {
    const repo = initRepo();
    const source = scaffoldReleaseSource();
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-prefix-"));
    try {
        const options = { prefix, cwd: repo, sourceRoot: source };
        const target = releaseDirectory(releaseBuildId(repo), prefix);

        await expect(packRunnableRelease(options)).rejects.toThrow(/node_modules/);
        expect(existsSync(releaseManifestPath(target))).toBe(false);

        mkdirSync(join(source, "node_modules"));
        writeFileSync(join(source, "node_modules", "dependency.js"), "\n");
        const packed = await packRunnableRelease(options);

        expect(packed.releaseRoot).toBe(target);
        verifyPackedRelease(target, prefix);
        expect(existsSync(join(target, "clients", "clients"))).toBe(false);
        expect(existsSync(join(target, "node_modules", "node_modules"))).toBe(false);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(source, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
}, 60_000);

test("a finished pack of the same build is reused", async () => {
    const repo = initRepo();
    const source = scaffoldReleaseSource();
    mkdirSync(join(source, "node_modules"));
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-prefix-"));
    try {
        const options = { prefix, cwd: repo, sourceRoot: source };
        const first = await packRunnableRelease(options);
        const marker = join(first.releaseRoot, "reuse-marker");
        writeFileSync(marker, "kept\n");

        const second = await packRunnableRelease(options);

        expect(second.manifest).toEqual(first.manifest);
        expect(readFileSync(marker, "utf8")).toBe("kept\n");
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(source, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
}, 60_000);

function expectNoNesting(releaseRoot: string): void {
    for (const entry of ["clients", "src", "docs", "node_modules"]) {
        expect(existsSync(join(releaseRoot, entry, entry))).toBe(false);
    }
}

function packLeftovers(releaseRoot: string): string[] {
    return readdirSync(dirname(releaseRoot)).filter((name) => name.startsWith("."));
}

test("a forced pack over a finished release replaces it whole, with a fresh stamp", async () => {
    const repo = initRepo();
    const source = scaffoldReleaseSource();
    mkdirSync(join(source, "node_modules"));
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-prefix-"));
    try {
        const options = { prefix, cwd: repo, sourceRoot: source };
        const first = await packRunnableRelease(options);
        const marker = join(first.releaseRoot, "reuse-marker");
        writeFileSync(marker, "old tree\n");
        await Bun.sleep(5);

        const second = await packRunnableRelease({ ...options, force: true });

        expect(second.releaseRoot).toBe(first.releaseRoot);
        expect(second.manifest.built_at).not.toBe(first.manifest.built_at);
        expect(parseReleaseManifest(
            readFileSync(releaseManifestPath(second.releaseRoot), "utf8"),
        )).toEqual(second.manifest);
        expect(existsSync(marker)).toBe(false);
        expectNoNesting(second.releaseRoot);
        verifyPackedRelease(second.releaseRoot, prefix);
        expect(packLeftovers(second.releaseRoot)).toEqual([]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(source, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
}, 60_000);

test("a forced pack that fails during assembly leaves the finished release untouched", async () => {
    const repo = initRepo();
    const source = scaffoldReleaseSource();
    mkdirSync(join(source, "node_modules"));
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-prefix-"));
    try {
        const options = { prefix, cwd: repo, sourceRoot: source };
        const first = await packRunnableRelease(options);
        const stamp = readFileSync(releaseManifestPath(first.releaseRoot), "utf8");
        const worker = readFileSync(join(first.releaseRoot, RELEASE_WORKER_NAME), "utf8");
        rmSync(join(source, "node_modules"), { recursive: true });

        await expect(packRunnableRelease({ ...options, force: true }))
            .rejects.toThrow(/node_modules/);

        expect(readFileSync(releaseManifestPath(first.releaseRoot), "utf8")).toBe(stamp);
        expect(readFileSync(join(first.releaseRoot, RELEASE_WORKER_NAME), "utf8"))
            .toBe(worker);
        expectNoNesting(first.releaseRoot);
        verifyPackedRelease(first.releaseRoot, prefix);
        expect(packLeftovers(first.releaseRoot)).toEqual([]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(source, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
}, 60_000);

test("a pack removes staging left by a pack that died, and keeps a live pack's", async () => {
    const repo = initRepo();
    const source = scaffoldReleaseSource();
    mkdirSync(join(source, "node_modules"));
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-prefix-"));
    try {
        const target = releaseDirectory(releaseBuildId(repo), prefix);
        const exited = Bun.spawn(["true"]);
        await exited.exited;
        const releasesRoot = dirname(target);
        const dead = [
            `.staging-${exited.pid}-vera-dead`,
            `.retired-${exited.pid}-vera-dead`,
        ];
        const live = `.staging-${process.pid}-vera-live`;
        for (const name of [...dead, live]) {
            mkdirSync(join(releasesRoot, name, "clients"), { recursive: true });
        }

        await packRunnableRelease({ prefix, cwd: repo, sourceRoot: source });

        expect(packLeftovers(target)).toEqual([live]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(source, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
}, 60_000);

test("a release swap that stops between its renames leaves both trees stamped", () => {
    const releasesRoot = mkdtempSync(join(tmpdir(), "vera-pack-swap-"));
    try {
        const target = join(releasesRoot, "vera-build");
        const staging = join(releasesRoot, ".staging-1-vera-build");
        const retired = join(releasesRoot, ".retired-1-vera-build");
        for (const root of [target, staging]) {
            mkdirSync(root, { recursive: true });
            writeFileSync(releaseManifestPath(root), "{}\n");
        }
        let renames = 0;
        const stopAfterFirstRename = (from: string, to: string): void => {
            renames += 1;
            if (renames > 1) throw new Error("stopped between renames");
            renameSync(from, to);
        };

        expect(() => replaceReleaseDirectory(
            target,
            staging,
            retired,
            stopAfterFirstRename,
        )).toThrow("stopped between renames");

        expect(existsSync(target)).toBe(false);
        expect(existsSync(releaseManifestPath(retired))).toBe(true);
        expect(existsSync(releaseManifestPath(staging))).toBe(true);
    } finally {
        rmSync(releasesRoot, { recursive: true, force: true });
    }
});

test("a pack moves a finished release left in staging by a pack that died between its renames into place", async () => {
    const repo = initRepo();
    const source = scaffoldReleaseSource();
    mkdirSync(join(source, "node_modules"));
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-prefix-"));
    try {
        const options = { prefix, cwd: repo, sourceRoot: source };
        const first = await packRunnableRelease(options);
        const target = first.releaseRoot;
        const buildId = first.manifest.build_id;
        const exited = Bun.spawn(["true"]);
        await exited.exited;
        const releasesRoot = dirname(target);
        const staging = join(releasesRoot, `.staging-${exited.pid}-${buildId}`);
        const retired = join(releasesRoot, `.retired-${exited.pid}-${buildId}`);
        renameSync(target, staging);
        writeFileSync(join(staging, "restore-marker"), "kept\n");
        mkdirSync(join(retired, "clients"), { recursive: true });

        const second = await packRunnableRelease(options);

        expect(second.releaseRoot).toBe(target);
        expect(second.manifest).toEqual(first.manifest);
        expect(readFileSync(join(target, "restore-marker"), "utf8")).toBe("kept\n");
        expect(packLeftovers(target)).toEqual([]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(source, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
}, 60_000);
