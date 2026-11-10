import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { HOST_PROTOCOL_VERSION } from "../../src/host/protocol.ts";
import { releaseBuildId } from "../../src/release/build-id.ts";
import {
    packedAnnexRoot,
    RELEASE_WORKER_NAME,
    releaseDirectory,
    releaseManifestPath,
} from "../../src/release/layout.ts";
import {
    parseReleaseManifest,
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    serializeReleaseManifest,
    VERA_PRODUCT_VERSION,
    type ReleaseManifest,
} from "../../src/release/manifest.ts";
import { digestPackedAnnex, verifyPackedRelease } from "../../src/release/verify.ts";
import {
    buildThenSwap,
    packRelease,
    packRunnableRelease,
    replaceReleaseDirectory,
} from "../../scripts/pack-release.ts";
import { packWebAssets } from "../../scripts/pack-web.ts";

const packer = resolve(import.meta.dir, "..", "..", "scripts", "pack-release.ts");
const repoRoot = resolve(import.meta.dir, "..", "..");

function runFixtureProcess(command: string[], timeout = 5_000) {
    return Bun.spawnSync(command, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout,
        killSignal: "SIGKILL",
    });
}

function exitedFixturePid(): number {
    const child = runFixtureProcess(["true"]);
    expect(child.exitCode).toBe(0);
    return child.pid;
}

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

test("a stalled fixture process is stopped at its deadline", () => {
    const child = runFixtureProcess(["sleep", "30"], 100);
    expect(child.success).toBe(false);
    try {
        process.kill(child.pid, 0);
        throw new Error("fixture process is still running");
    } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
    }
}, 5_000);

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
        const spawned = runFixtureProcess([join(output, "worker")], 500);
        expect(spawned.pid).toBeGreaterThan(0);
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
        "clients/host/session-worker.ts",
        "clients/tui/flight-watchdog.ts",
        "scripts/release-role-entry.ts",
        "src/annex/main.ts",
        "src/host/session-import-child.ts",
        "src/host/worker/adapter.ts",
        "src/host/worker/entry.ts",
        "src/host/worker-supervisor.ts",
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

function scaffoldReleaseModules(source: string): void {
    const treeSitter = join(source, "node_modules", "web-tree-sitter");
    mkdirSync(treeSitter, { recursive: true });
    writeFileSync(join(treeSitter, "tree-sitter.wasm"), "\n");
    const tui = join(source, "node_modules", "@opentui", "core");
    mkdirSync(tui, { recursive: true });
    writeFileSync(join(tui, "index.js"), "export {};\n");
    writeFileSync(join(tui, "testing.js"), "export {};\n");
    writeFileSync(
        join(tui, "parser.worker.js"),
        'import "web-tree-sitter"; import "web-tree-sitter/tree-sitter.wasm";\n',
    );
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

        scaffoldReleaseModules(source);
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
    scaffoldReleaseModules(source);
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
    scaffoldReleaseModules(source);
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
    scaffoldReleaseModules(source);
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
    scaffoldReleaseModules(source);
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-prefix-"));
    try {
        const target = releaseDirectory(releaseBuildId(repo), prefix);
        const exited = exitedFixturePid();
        const releasesRoot = dirname(target);
        const dead = [
            `.staging-${exited}-vera-dead`,
            `.retired-${exited}-vera-dead`,
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
    scaffoldReleaseModules(source);
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-prefix-"));
    try {
        const options = { prefix, cwd: repo, sourceRoot: source };
        const first = await packRunnableRelease(options);
        const target = first.releaseRoot;
        const buildId = first.manifest.build_id;
        const exited = exitedFixturePid();
        const releasesRoot = dirname(target);
        const staging = join(releasesRoot, `.staging-${exited}-${buildId}`);
        const retired = join(releasesRoot, `.retired-${exited}-${buildId}`);
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

test("a re-pack into an output directory that fails midway leaves the finished pack whole", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-output-"));
    try {
        const output = join(parent, "release");
        const first = await packRelease(output, { cwd: repo });
        const stamp = readFileSync(releaseManifestPath(output), "utf8");
        writeFileSync(join(repo, "file.txt"), "dirty working tree\n");

        await expect(packRelease(output, {
            cwd: repo,
            now: () => {
                throw new Error("clock failed");
            },
        })).rejects.toThrow("clock failed");

        expect(readFileSync(releaseManifestPath(output), "utf8")).toBe(stamp);
        expect(digestPackedAnnex(packedAnnexRoot(output)))
            .toBe(first.manifest.asset_digest);
        expect(readFileSync(join(packedAnnexRoot(output), "build-id"), "utf8").trim())
            .toBe(first.manifest.build_id);
        expect(packLeftovers(output)).toEqual([]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a re-pack into an output directory replaces the tree whole, with a fresh stamp", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-output-"));
    try {
        const output = join(parent, "release");
        const first = await packRelease(output, { cwd: repo });
        const marker = join(output, "old-tree-marker");
        writeFileSync(marker, "old tree\n");
        await Bun.sleep(5);

        const second = await packRelease(output, { cwd: repo });

        expect(existsSync(marker)).toBe(false);
        expect(second.manifest.built_at).not.toBe(first.manifest.built_at);
        expect(parseReleaseManifest(readFileSync(releaseManifestPath(output), "utf8")))
            .toEqual(second.manifest);
        expect(digestPackedAnnex(packedAnnexRoot(output)))
            .toBe(second.manifest.asset_digest);
        expect(packLeftovers(output)).toEqual([]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack into an output directory removes only its own staging left by a pack that died, and keeps a live pack's", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-output-"));
    try {
        const output = join(parent, "release");
        const exited = exitedFixturePid();
        const dead = [
            `.staging-${exited}-release`,
            `.retired-${exited}-release`,
        ];
        const live = `.staging-${process.pid}-other`;
        // Left by a dead pack, but named for a different directory in the same parent.
        const deadOther = `.staging-${exited}-other`;
        for (const name of [...dead, live, deadOther]) {
            mkdirSync(join(parent, name, "annex"), { recursive: true });
        }

        await packRelease(output, { cwd: repo });

        expect(packLeftovers(output).sort()).toEqual([deadOther, live].sort());
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

function stamp(directory: string, buildId: string): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(releaseManifestPath(directory), serializeReleaseManifest(fakeManifest(buildId)));
}

function fakeManifest(buildId: string): ReleaseManifest {
    return {
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
    };
}

test("a pack refuses a non-empty output directory that is not a pack and deletes nothing", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-notapack-"));
    const output = join(parent, "release");
    mkdirSync(output);
    try {
        writeFileSync(join(output, "notes.txt"), "keep\n");
        mkdirSync(join(output, ".git"));

        await expect(packRelease(output, { cwd: repo }))
            .rejects.toThrow(/not empty and has no release stamp/);

        expect(readFileSync(join(output, "notes.txt"), "utf8")).toBe("keep\n");
        expect(existsSync(join(output, ".git"))).toBe(true);
        expect(packLeftovers(output)).toEqual([]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack replaces unstamped pack:web output", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-webonly-"));
    const output = join(parent, "release");
    try {
        await packWebAssets(packedAnnexRoot(output), { cwd: repo });
        expect(existsSync(releaseManifestPath(output))).toBe(false);

        const result = await packRelease(output, { cwd: repo });

        expect(readFileSync(releaseManifestPath(output), "utf8"))
            .toBe(serializeReleaseManifest(result.manifest));
        expect(existsSync(join(output, "worker"))).toBe(true);
        expect(packLeftovers(output)).toEqual([]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack replaces a pack that died before its stamp, so every name a pack writes is replaceable", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-nostamp-"));
    const output = join(parent, "release");
    try {
        await packRelease(output, { cwd: repo });
        rmSync(releaseManifestPath(output));
        expect(readdirSync(output).sort())
            .toEqual(["annex", "session-worker", "vera-annex", "vera-supervisor", "worker"]);

        await packRelease(output, { cwd: repo });

        expect(existsSync(releaseManifestPath(output))).toBe(true);
        expect(packLeftovers(output)).toEqual([]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack refuses an unstamped directory that holds a pack's names and one other file, and keeps both", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-mixed-"));
    const output = join(parent, "release");
    try {
        mkdirSync(join(output, "annex"), { recursive: true });
        writeFileSync(join(output, "annex", "index.html"), "web\n");
        writeFileSync(join(output, "worker"), "wrapper\n");
        writeFileSync(join(output, "notes.txt"), "keep\n");

        await expect(packRelease(output, { cwd: repo }))
            .rejects.toThrow(/not empty and has no release stamp.*holds notes\.txt/);

        expect(readFileSync(join(output, "annex", "index.html"), "utf8")).toBe("web\n");
        expect(readFileSync(join(output, "worker"), "utf8")).toBe("wrapper\n");
        expect(readFileSync(join(output, "notes.txt"), "utf8")).toBe("keep\n");
        expect(packLeftovers(output)).toEqual([]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack refuses an output path that is a file", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-file-"));
    try {
        const output = join(parent, "release");
        writeFileSync(output, "a file\n");

        await expect(packRelease(output, { cwd: repo }))
            .rejects.toThrow(`${output} exists and is not a directory.`);

        expect(readFileSync(output, "utf8")).toBe("a file\n");
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack refuses an output directory that is or contains the checkout, even a stamped one", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-contains-"));
    try {
        const repo = join(parent, "checkout");
        mkdirSync(repo);
        git(repo, ["init", "-q"]);
        writeFileSync(join(repo, "file.txt"), "clean\n");
        stamp(parent, "vera-stamped");

        await expect(packRelease(repo, { cwd: repo }))
            .rejects.toThrow(/is or contains the checkout being packed/);
        await expect(packRelease(parent, { cwd: repo }))
            .rejects.toThrow(/is or contains the checkout being packed/);

        expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("clean\n");
        expect(existsSync(join(repo, ".git"))).toBe(true);
        expect(existsSync(releaseManifestPath(parent))).toBe(true);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack refuses an output directory that is or contains the current directory", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-cwd-"));
    const start = process.cwd();
    try {
        const inner = join(parent, "inner");
        mkdirSync(inner);
        process.chdir(inner);

        await expect(packRelease(inner, { cwd: repo }))
            .rejects.toThrow(/is or contains the current directory/);
        await expect(packRelease("..", { cwd: repo }))
            .rejects.toThrow(/is or contains the current directory/);

        expect(existsSync(inner)).toBe(true);
    } finally {
        process.chdir(start);
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("the CLI refuses '.' in a directory that is not a pack and exits non-zero", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "vera-pack-cli-refuse-")));
    try {
        writeFileSync(join(directory, "notes.txt"), "keep\n");
        mkdirSync(join(directory, ".git"));

        const ran = Bun.spawnSync(["bun", packer, "."], {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
        });

        expect(ran.exitCode).toBe(1);
        expect(ran.stderr.toString()).toMatch(/Refusing to replace .*Nothing was deleted/);
        expect(readFileSync(join(directory, "notes.txt"), "utf8")).toBe("keep\n");
        expect(existsSync(join(directory, ".git"))).toBe(true);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a pack creates a missing output directory and its parents", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-missing-"));
    try {
        const output = join(parent, "a", "b", "release");

        const packed = await packRelease(output, { cwd: repo });

        expect(packed.outputDirectory).toBe(output);
        expect(parseReleaseManifest(readFileSync(releaseManifestPath(output), "utf8")))
            .toEqual(packed.manifest);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack into a symlinked output directory replaces the tree it points at and keeps the link", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-link-"));
    try {
        const real = join(parent, "real-pack");
        const link = join(parent, "release");
        const first = await packRelease(real, { cwd: repo });
        symlinkSync(real, link);
        writeFileSync(join(real, "old-tree-marker"), "old tree\n");
        await Bun.sleep(5);

        const second = await packRelease(link, { cwd: repo });

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(second.outputDirectory).toBe(link);
        expect(existsSync(join(real, "old-tree-marker"))).toBe(false);
        expect(parseReleaseManifest(readFileSync(releaseManifestPath(real), "utf8")))
            .toEqual(second.manifest);
        expect(second.manifest.built_at).not.toBe(first.manifest.built_at);
        expect(readdirSync(parent).sort()).toEqual(["real-pack", "release"]);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack refuses an output symlink that points nowhere", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-dangling-"));
    try {
        const link = join(parent, "release");
        symlinkSync(join(parent, "missing"), link);

        await expect(packRelease(link, { cwd: repo })).rejects.toThrow(/does not exist/);

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack reports why an output symlink cannot be resolved", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-loop-"));
    try {
        const loop = join(parent, "release");
        symlinkSync(join(parent, "other"), loop);
        symlinkSync(loop, join(parent, "other"));

        await expect(packRelease(loop, { cwd: repo })).rejects.toThrow(/Cannot resolve .*ELOOP/);

        expect(lstatSync(loop).isSymbolicLink()).toBe(true);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack refuses an output directory that is or contains the source root, even a stamped one", async () => {
    const repo = initRepo();
    const output = mkdtempSync(join(tmpdir(), "vera-pack-srcroot-"));
    try {
        stamp(output, "vera-stamped");
        const sourceRoot = join(output, "source");
        mkdirSync(sourceRoot);
        writeFileSync(join(sourceRoot, "keep.txt"), "keep\n");

        await expect(packRelease(output, { cwd: repo, sourceRoot }))
            .rejects.toThrow(/is or contains the source root/);
        await expect(packRelease(sourceRoot, { cwd: repo, sourceRoot }))
            .rejects.toThrow(/is or contains the source root/);

        expect(readFileSync(join(sourceRoot, "keep.txt"), "utf8")).toBe("keep\n");
        expect(existsSync(releaseManifestPath(output))).toBe(true);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(output, { recursive: true, force: true });
    }
}, 60_000);

// A stamped directory that a checkout pack must never replace, built under a temp prefix.
function installedRelease(prefix: string, buildId = "vera-installed"): string {
    const release = join(prefix, "share", "vera", "releases", buildId);
    stamp(release, buildId);
    writeFileSync(join(release, "vera"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(release, "host"), "#!/bin/sh\n", { mode: 0o755 });
    return release;
}

test("a pack refuses an installed release, also through the current link", async () => {
    const repo = initRepo();
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-installed-"));
    try {
        const release = installedRelease(prefix);
        const current = join(prefix, "share", "vera", "current");
        symlinkSync(release, current);

        await expect(packRelease(release, { cwd: repo })).rejects.toThrow(/is an installed release/);
        await expect(packRelease(current, { cwd: repo })).rejects.toThrow(/is an installed release/);

        expect(readdirSync(release).sort()).toEqual(["host", "manifest.json", "vera"]);
        expect(lstatSync(current).isSymbolicLink()).toBe(true);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
}, 60_000);

test("a pack refuses a stamped directory directly under releases, even without wrappers", async () => {
    const repo = initRepo();
    const prefix = mkdtempSync(join(tmpdir(), "vera-pack-releases-"));
    try {
        const release = join(prefix, "releases", "vera-bare");
        stamp(release, "vera-bare");

        await expect(packRelease(release, { cwd: repo })).rejects.toThrow(/is an installed release/);

        expect(existsSync(releaseManifestPath(release))).toBe(true);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
}, 60_000);

test("a pack refuses a stamped directory that holds the installed wrappers outside releases", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-wrappers-"));
    try {
        for (const wrapper of ["vera", "host"]) {
            const directory = join(parent, `has-${wrapper}`);
            stamp(directory, "vera-copy");
            writeFileSync(join(directory, wrapper), "#!/bin/sh\n");

            await expect(packRelease(directory, { cwd: repo }))
                .rejects.toThrow(/is an installed release/);

            expect(existsSync(join(directory, wrapper))).toBe(true);
        }
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack replaces a pack stamped by another layout version", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-oldstamp-"));
    try {
        const output = join(parent, "release");
        mkdirSync(output);
        writeFileSync(
            releaseManifestPath(output),
            `${JSON.stringify({ layout_version: 999, build_id: "vera-future" })}\n`,
        );
        writeFileSync(join(output, "old-layout-marker"), "old\n");

        const packed = await packRelease(output, { cwd: repo });

        expect(existsSync(join(output, "old-layout-marker"))).toBe(false);
        expect(parseReleaseManifest(readFileSync(releaseManifestPath(output), "utf8")))
            .toEqual(packed.manifest);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

test("a pack refuses a directory whose stamp does not name a build", async () => {
    const repo = initRepo();
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-badstamp-"));
    try {
        const stamps: Record<string, string> = {
            "not-json": "layout_version 1\n",
            "an-array": "[]\n",
            "no-build": `${JSON.stringify({ layout_version: 1 })}\n`,
            "empty-build": `${JSON.stringify({ build_id: "" })}\n`,
            "number-build": `${JSON.stringify({ build_id: 7 })}\n`,
        };
        for (const [name, text] of Object.entries(stamps)) {
            const output = join(parent, name);
            mkdirSync(output);
            writeFileSync(releaseManifestPath(output), text);

            await expect(packRelease(output, { cwd: repo }), name)
                .rejects.toThrow(/not empty and has no release stamp/);

            expect(readFileSync(releaseManifestPath(output), "utf8")).toBe(text);
        }
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
    }
}, 60_000);

function stagedBy(buildId: string): (staging: string) => Promise<ReleaseManifest> {
    return async (staging) => {
        stamp(staging, buildId);
        return fakeManifest(buildId);
    };
}

// Stands in for a second pack that finished its swap between this pack's two renames.
function rivalWins(buildId: string): (from: string, to: string) => void {
    return (_from, to) => {
        stamp(to, buildId);
        writeFileSync(join(to, "rival-marker"), "rival\n");
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rename '${to}'`), {
            code: "ENOTEMPTY",
        });
    };
}

test("a pack that loses the swap to a concurrent pack of the same build succeeds and removes its staging", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-race-"));
    try {
        const target = join(parent, "release");

        const manifest = await buildThenSwap(target, stagedBy("vera-same"), rivalWins("vera-same"));

        expect(manifest.build_id).toBe("vera-same");
        expect(existsSync(join(target, "rival-marker"))).toBe(true);
        expect(packLeftovers(target)).toEqual([]);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test("a pack that loses the swap to a pack of another build fails and removes its staging", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-race-other-"));
    try {
        const target = join(parent, "release");

        await expect(buildThenSwap(target, stagedBy("vera-mine"), rivalWins("vera-theirs")))
            .rejects.toThrow(/ENOTEMPTY/);

        expect(packLeftovers(target)).toEqual([]);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test("a pack whose swap fails for another reason removes its staging", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-swap-fail-"));
    try {
        const target = join(parent, "release");
        stamp(target, "vera-same");

        await expect(buildThenSwap(target, stagedBy("vera-same"), () => {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        })).rejects.toThrow(/EACCES/);

        expect(packLeftovers(target)).toEqual([]);
        expect(existsSync(releaseManifestPath(target))).toBe(true);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

// Stands in for a rival that took the slot after this pack moved the old tree aside.
function rivalWinsAfterRetire(buildId: string): (from: string, to: string) => void {
    return (from, to) => {
        if (basename(to).startsWith(".retired-")) {
            renameSync(from, to);
            return;
        }
        rivalWins(buildId)(from, to);
    };
}

test("a pack that loses the swap to a rival of the same build removes the old tree it moved aside", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-race-retired-"));
    try {
        const target = join(parent, "release");
        stamp(target, "vera-same");
        writeFileSync(join(target, "old-marker"), "old\n");

        await buildThenSwap(target, stagedBy("vera-same"), rivalWinsAfterRetire("vera-same"));

        expect(existsSync(join(target, "rival-marker"))).toBe(true);
        expect(packLeftovers(target)).toEqual([]);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

// Stands in for a rival that moved the old tree aside before this pack's first rename ran.
function rivalMovedTargetAside(): (from: string, to: string) => void {
    let renames = 0;
    return (from, to) => {
        renames += 1;
        if (renames === 1) {
            rmSync(from, { recursive: true, force: true });
            throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}'`), {
                code: "ENOENT",
            });
        }
        renameSync(from, to);
    };
}

test("a pack whose first rename finds the target already moved aside takes the empty slot", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-race-enoent-"));
    try {
        const target = join(parent, "release");
        stamp(target, "vera-same");
        writeFileSync(join(target, "old-marker"), "old\n");

        const manifest = await buildThenSwap(target, stagedBy("vera-same"), rivalMovedTargetAside());

        expect(manifest.build_id).toBe("vera-same");
        expect(existsSync(releaseManifestPath(target))).toBe(true);
        expect(existsSync(join(target, "old-marker"))).toBe(false);
        expect(packLeftovers(target)).toEqual([]);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test("a pack whose first rename finds the target moved aside and then loses the slot to a rival of the same build succeeds", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-race-enoent-lost-"));
    try {
        const target = join(parent, "release");
        stamp(target, "vera-same");
        let renames = 0;

        await buildThenSwap(target, stagedBy("vera-same"), (from, to) => {
            renames += 1;
            if (renames === 1) {
                rmSync(from, { recursive: true, force: true });
                throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
            }
            stamp(to, "vera-same");
            writeFileSync(join(to, "rival-marker"), "rival\n");
            throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
        });

        expect(existsSync(join(target, "rival-marker"))).toBe(true);
        expect(packLeftovers(target)).toEqual([]);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test("a pack whose old tree cannot be deleted after the swap still succeeds with the new tree in place", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-cleanup-"));
    const target = join(parent, "release");
    const locked = join(parent, `.retired-${process.pid}-release`, "locked");
    try {
        stamp(target, "vera-old");
        mkdirSync(join(target, "locked"));
        writeFileSync(join(target, "locked", "file"), "old\n");
        // A read-only directory stops rmSync from emptying the retired tree.
        chmodSync(join(target, "locked"), 0o500);

        const manifest = await buildThenSwap(target, stagedBy("vera-new"));

        expect(manifest.build_id).toBe("vera-new");
        expect(parseReleaseManifest(readFileSync(releaseManifestPath(target), "utf8")).build_id)
            .toBe("vera-new");
        expect(existsSync(join(target, "locked"))).toBe(false);
        expect(existsSync(locked), "the retired tree was deleted despite the lock").toBe(true);

        chmodSync(locked, 0o700);
        await buildThenSwap(target, stagedBy("vera-newer"));
        expect(packLeftovers(target), "the next pack left the retired tree").toEqual([]);
    } finally {
        if (existsSync(locked)) chmodSync(locked, 0o700);
        rmSync(parent, { recursive: true, force: true });
    }
});

test("a pack whose second rename fails puts the old tree back", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-pack-restore-"));
    try {
        const target = join(parent, "release");
        stamp(target, "vera-old");
        writeFileSync(join(target, "old-marker"), "old\n");
        let renames = 0;

        await expect(buildThenSwap(target, stagedBy("vera-new"), (from, to) => {
            renames += 1;
            if (renames > 1) throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
            renameSync(from, to);
        })).rejects.toThrow(/EACCES/);

        expect(readFileSync(join(target, "old-marker"), "utf8")).toBe("old\n");
        expect(packLeftovers(target)).toEqual([]);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});
