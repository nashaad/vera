import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    chmodSync,
    cpSync,
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
import { join, resolve } from "node:path";

import { defaultHostLockPath } from "../../src/host/lockfile.ts";

import { runCli } from "../../clients/cli/main.ts";
import { activateRelease } from "../../src/release/activate.ts";
import {
    currentReleaseBuildId,
    currentSymlinkPath,
    RELEASE_ANNEX_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_SESSION_WORKER_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_WORKER_NAME,
    releaseDirectory,
    releasesDirectory,
    rollbackSymlinkPath,
    upgradeJournalPath,
    launcherPath,
} from "../../src/release/layout.ts";
import {
    installRelease,
} from "../../src/release/install.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    serializeReleaseManifest,
    type ReleaseManifest,
} from "../../src/release/manifest.ts";
import {
    runUpdate,
} from "../../src/release/update.ts";
import {
    writeUpgradeJournal,
} from "../../src/release/upgrade.ts";
import { digestPackedAnnex } from "../../src/release/verify.ts";
import {
    compareVersions,
    isReleaseVersion,
} from "../../src/release/version.ts";

const API = "https://api.test/releases";
const ASSET = "vera-darwin-arm64.tar.gz";
const installer = resolve(import.meta.dir, "..", "..", "scripts", "install.sh");
const WRAPPERS = [
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_WORKER_NAME,
    RELEASE_SESSION_WORKER_NAME,
    RELEASE_ANNEX_NAME,
    RELEASE_SUPERVISOR_NAME,
] as const;

interface FakeRoute {
    readonly status?: number;
    readonly body?: string | Uint8Array;
    readonly headers?: Record<string, string>;
}

function fakeFetch(routes: Record<string, FakeRoute>, log: string[] = []): typeof fetch {
    return (async (input: string | URL | Request) => {
        const url = typeof input === "string"
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url;
        log.push(url);
        const route = routes[url];
        if (route === undefined) {
            return new Response("not found", { status: 404 });
        }
        return new Response(route.body ?? "", {
            status: route.status ?? 200,
            headers: route.headers,
        });
    }) as typeof fetch;
}

function streamedBody(bytes: Uint8Array, delayMs: number, stall = false): ReadableStream<Uint8Array> {
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishPull: (() => void) | undefined;
    return new ReadableStream({
        pull(controller) {
            if (stall && offset > 0) return;
            return new Promise<void>((resolve) => {
                finishPull = resolve;
                timer = setTimeout(() => {
                    const end = Math.min(bytes.length, offset + Math.ceil(bytes.length / 5));
                    controller.enqueue(bytes.slice(offset, end));
                    offset = end;
                    if (offset === bytes.length && !stall) controller.close();
                    resolve();
                }, delayMs);
            });
        },
        cancel() {
            if (timer !== undefined) clearTimeout(timer);
            finishPull?.();
        },
    });
}

function writeVerifiableRelease(
    root: string,
    buildId: string,
    version: string,
): ReleaseManifest {
    mkdirSync(root, { recursive: true });
    const annex = join(root, "annex");
    mkdirSync(annex);
    writeFileSync(join(annex, "index.html"), "<html></html>\n");
    writeFileSync(join(annex, "main.js"), "console.log(1)\n");
    writeFileSync(join(annex, "styles.css"), "body{}\n");
    writeFileSync(join(annex, "build-id"), `${buildId}\n`);
    for (const name of WRAPPERS) {
        writeFileSync(join(root, name), "#!/bin/sh\nexit 0\n");
        chmodSync(join(root, name), 0o755);
    }
    for (const directory of ["clients", "config", "docs", "extensions", "src", "node_modules"]) {
        mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, "index.ts"), "export {};\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    writeFileSync(join(root, "bunfig.toml"), "");
    mkdirSync(join(root, "clients", "cli"), { recursive: true });
    mkdirSync(join(root, "clients", "host"), { recursive: true });
    mkdirSync(join(root, "src", "annex"), { recursive: true });
    writeFileSync(join(root, "clients", "cli", "main.ts"), "export {};\n");
    writeFileSync(join(root, "clients", "host", "main.ts"), "export {};\n");
    writeFileSync(join(root, "clients", "host", "session-worker.ts"), "export {};\n");
    writeFileSync(join(root, "src", "annex", "main.ts"), "export {};\n");
    writeFileSync(join(root, "docs", "index.md"), "# docs\n");
    const manifest: ReleaseManifest = {
        layout_version: RELEASE_LAYOUT_VERSION,
        product_version: version,
        source_revision: "abc123",
        build_id: buildId,
        protocol_version: 1,
        platform: "darwin",
        arch: "arm64",
        asset_digest: digestPackedAnnex(annex),
        built_at: "2026-11-10T00:00:00.000Z",
        artifacts: [...RELEASE_ARTIFACT_NAMES],
    };
    writeFileSync(join(root, "manifest.json"), serializeReleaseManifest(manifest));
    return manifest;
}

function tarballFor(work: string, releaseRoot: string, buildId: string): string {
    const stage = join(work, `stage-${buildId}`);
    mkdirSync(stage, { recursive: true });
    cpSync(releaseRoot, join(stage, buildId), { recursive: true });
    const tarball = join(work, `${buildId}.tar.gz`);
    const tar = Bun.spawnSync(["tar", "-czf", tarball, "-C", stage, buildId]);
    expect(tar.exitCode, tar.stderr.toString()).toBe(0);
    return tarball;
}

// install.sh accepts a local tarball by layout: one vera-<build> directory, a
// manifest.json and an executable vera. It does not verify the full stamp.
function fakeInstallerTarball(work: string, buildId: string): string {
    const stage = join(work, `install-stage-${buildId}`);
    const release = join(stage, buildId);
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "manifest.json"), `{"build_id":"${buildId}"}\n`);
    writeFileSync(join(release, "vera"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(release, "vera"), 0o755);
    const tarball = join(work, `install-${buildId}.tar.gz`);
    const tar = Bun.spawnSync(["tar", "-czf", tarball, "-C", stage, buildId]);
    expect(tar.exitCode, tar.stderr.toString()).toBe(0);
    return tarball;
}

function checksumFor(tarball: string): string {
    return `${createHash("sha256").update(readFileSync(tarball)).digest("hex")}  ${ASSET}\n`;
}

function assetUrl(version: string): string {
    return `https://github.com/nashaad/vera/releases/download/v${version}/${ASSET}`;
}

function routeFor(version: string, tarball: string, checksum = checksumFor(tarball)): Record<string, FakeRoute> {
    const url = assetUrl(version);
    return {
        [url]: { body: new Uint8Array(readFileSync(tarball)) },
        [`${url}.sha256`]: { body: checksum },
    };
}

function releaseJson(...items: readonly {
    version: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
}[]): string {
    return JSON.stringify(items.map((item) => ({
        tag_name: `v${item.version}`,
        body: item.body ?? "",
        draft: item.draft ?? false,
        prerelease: item.prerelease ?? item.version.includes("-"),
    })));
}

function withTempEnvironment<T>(home: string, run: () => Promise<T>): Promise<T> {
    const saved = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    return run().finally(() => {
        if (saved === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = saved;
    });
}

function prefixWithOldRelease(root: string): {
    readonly prefix: string;
    readonly oldRoot: string;
} {
    const prefix = join(root, "prefix");
    const oldRoot = releaseDirectory("vera-old", prefix);
    writeVerifiableRelease(oldRoot, "vera-old", "0.1.0-alpha.1");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const saved = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        activateRelease(oldRoot, prefix);
    } finally {
        if (saved === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = saved;
    }
    return { prefix, oldRoot };
}

test("version ordering uses semver prereleases and ignores build metadata", () => {
    expect(compareVersions("0.1.0-alpha.2", "0.1.0-alpha.10")).toBeLessThan(0);
    expect(compareVersions("0.1.0-rc.1", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "0.1.0+build.2")).toBe(0);
    expect(compareVersions("1.0.0", "0.1.9")).toBeGreaterThan(0);
    expect(isReleaseVersion("1.0.0+build.2")).toBe(true);
    expect(isReleaseVersion("1.0.0-")).toBe(false);
});

test("update prints the up-to-date line and never downloads a tarball", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-current-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        const output: string[] = [];
        const calls: string[] = [];
        const exit = await runUpdate({
            prefix,
            running: {
                root: oldRoot,
                prefix,
                version: "0.1.0-alpha.1",
                buildId: "vera-old",
            },
            platform: "darwin",
            arch: "arm64",
            releasesApi: API,
            fetch: fakeFetch({
                [API]: { body: releaseJson({ version: "0.1.0-alpha.1" }) },
            }, calls),
            output: (text) => output.push(text),
        });
        expect(exit).toBe(0);
        expect(output.join("")).toBe("Vera 0.1.0-alpha.1 is up to date\n");
        expect(calls).toEqual([API]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a named running version needs no release lookup", async () => {
    const output: string[] = [];
    const calls: string[] = [];
    const exit = await runUpdate({
        running: { root: "/unused", prefix: "/unused", version: "0.1.0-alpha.1", buildId: "vera-old" },
        version: "v0.1.0-alpha.1",
        fetch: fakeFetch({}, calls),
        output: (text) => output.push(text),
    });
    expect(exit).toBe(0);
    expect(output.join("")).toBe("Vera 0.1.0-alpha.1 is up to date\n");
    expect(calls).toEqual([]);
});

test("a slow steady download can take longer than the stall timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-steady-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        const newRoot = join(root, "new-release");
        writeVerifiableRelease(newRoot, "vera-new", "0.1.0-alpha.3");
        const tarball = tarballFor(root, newRoot, "vera-new");
        const url = assetUrl("0.1.0-alpha.3");
        const fallback = fakeFetch({ [API]: { body: releaseJson({ version: "0.1.0-alpha.3" }) }, ...routeFor("0.1.0-alpha.3", tarball) });
        const start = Date.now();
        const exit = await withTempEnvironment(join(root, "home"), () => runUpdate({
            prefix,
            running: { root: oldRoot, prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
            platform: "darwin", arch: "arm64", releasesApi: API, timeoutMs: 160,
            fetch: (async (input: string | URL | Request, init?: RequestInit) => {
                if (input === url) return new Response(streamedBody(new Uint8Array(readFileSync(tarball)), 50));
                return await fallback(input, init);
            }) as typeof fetch,
            output: () => undefined,
            install: (options) => installRelease({ ...options, readLiveHost: async () => undefined }),
        }));
        expect(Date.now() - start).toBeGreaterThan(160);
        expect(exit).toBe(0);
        expect(currentReleaseBuildId(prefix)).toBe("vera-new");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a stalled download leaves the installation untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-stall-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        const url = assetUrl("0.1.0-alpha.3");
        const fallback = fakeFetch({ [API]: { body: releaseJson({ version: "0.1.0-alpha.3" }) } });
        await withTempEnvironment(join(root, "home"), async () => {
            await expect(runUpdate({
                prefix,
                running: { root: oldRoot, prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
                platform: "darwin", arch: "arm64", releasesApi: API, timeoutMs: 100,
                fetch: (async (input: string | URL | Request, init?: RequestInit) => {
                    if (input === url) return new Response(streamedBody(new Uint8Array([1, 2, 3, 4, 5]), 5, true));
                    return await fallback(input, init);
                }) as typeof fetch,
            })).rejects.toThrow(`Download of ${url} stalled for 0.1 s.`);
            expect(currentReleaseBuildId(prefix)).toBe("vera-old");
            expect(existsSync(rollbackSymlinkPath(prefix))).toBe(false);
            expect(readdirSync(releasesDirectory(prefix))).toEqual(["vera-old"]);
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a release list that stalls before headers or during its body times out", async () => {
    const running = { root: "/unused", prefix: "/unused", version: "0.1.0-alpha.1", buildId: "vera-old" };
    for (const fetchImpl of [
        (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
        (async () => new Response(streamedBody(new TextEncoder().encode("[12345]"), 5, true))) as unknown as typeof fetch,
    ]) {
        await expect(runUpdate({ running, releasesApi: API, timeoutMs: 80, fetch: fetchImpl }))
            .rejects.toThrow(`Download of ${API} stalled for 0.08 s.`);
    }
});

test("a stalled checksum body leaves the installation untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-checksum-stall-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        const url = assetUrl("0.1.0-alpha.3");
        const checksumUrl = `${url}.sha256`;
        const fallback = fakeFetch({
            [API]: { body: releaseJson({ version: "0.1.0-alpha.3" }) },
            [url]: { body: new Uint8Array([1, 2, 3]) },
        });
        await withTempEnvironment(join(root, "home"), async () => {
            await expect(runUpdate({
                prefix,
                running: { root: oldRoot, prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
                platform: "darwin", arch: "arm64", releasesApi: API, timeoutMs: 80,
                fetch: (async (input: string | URL | Request, init?: RequestInit) => {
                    if (input === checksumUrl) return new Response(streamedBody(new TextEncoder().encode("12345"), 5, true));
                    return await fallback(input, init);
                }) as typeof fetch,
            })).rejects.toThrow(`Download of ${checksumUrl} stalled for 0.08 s.`);
            expect(currentReleaseBuildId(prefix)).toBe("vera-old");
            expect(existsSync(rollbackSymlinkPath(prefix))).toBe(false);
            expect(readdirSync(releasesDirectory(prefix))).toEqual(["vera-old"]);
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("update --check reports running and newest, and exits 10 when newer", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-check-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        const output: string[] = [];
        const calls: string[] = [];
        const exit = await runUpdate({
            prefix,
            check: true,
            running: {
                root: oldRoot,
                prefix,
                version: "0.1.0-alpha.1",
                buildId: "vera-old",
            },
            platform: "darwin",
            arch: "arm64",
            releasesApi: API,
            fetch: fakeFetch({
                [API]: { body: releaseJson({ version: "0.1.0-alpha.3" }) },
            }, calls),
            output: (text) => output.push(text),
        });
        expect(exit).toBe(10);
        expect(output.join("")).toContain("Running Vera 0.1.0-alpha.1 (vera-old).");
        expect(output.join("")).toContain("Newest release is Vera 0.1.0-alpha.3.");
        expect(calls).toEqual([API]);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("update --check exits 0 when the running release is newest", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-check-current-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        const exit = await runUpdate({
            check: true,
            prefix,
            running: {
                root: oldRoot,
                prefix,
                version: "0.1.0-alpha.1",
                buildId: "vera-old",
            },
            platform: "darwin",
            arch: "arm64",
            releasesApi: API,
            fetch: fakeFetch({
                [API]: { body: releaseJson({ version: "0.1.0-alpha.1" }) },
            }),
            output: () => undefined,
        });
        expect(exit).toBe(0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("update --check exits 0 when the running release is newer than the published release", async () => {
    const output: string[] = [];
    const exit = await runUpdate({
        check: true,
        running: { root: "/unused", prefix: "/unused", version: "0.1.0-alpha.4", buildId: "vera-new" },
        releasesApi: API,
        fetch: fakeFetch({ [API]: { body: releaseJson({ version: "0.1.0-alpha.3" }) } }),
        output: (text) => output.push(text),
    });
    expect(exit).toBe(0);
    expect(output.join("")).toBe("Running Vera 0.1.0-alpha.4 (vera-new).\nNewest release is Vera 0.1.0-alpha.3.\n");
});

test("update refuses a downgrade and points to rollback", async () => {
    await expect(runUpdate({
        running: { root: "/unused", prefix: "/unused", version: "0.1.0-alpha.4", buildId: "vera-new" },
        releasesApi: API,
        fetch: fakeFetch({ [API]: { body: releaseJson({ version: "0.1.0-alpha.3" }) } }),
    })).rejects.toThrow("Vera 0.1.0-alpha.3 is older than the running Vera 0.1.0-alpha.4. vera update does not downgrade. Run 'vera rollback'");
});

test("a checksum mismatch leaves current, rollback and releases untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-checksum-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        const newRoot = join(root, "new-release");
        writeVerifiableRelease(newRoot, "vera-new", "0.1.0-alpha.3");
        const tarball = tarballFor(root, newRoot, "vera-new");
        const url = assetUrl("0.1.0-alpha.3");
        await withTempEnvironment(join(root, "home"), async () => {
            await expect(runUpdate({
                prefix,
                running: {
                    root: oldRoot,
                    prefix,
                    version: "0.1.0-alpha.1",
                    buildId: "vera-old",
                },
                platform: "darwin",
                arch: "arm64",
                repo: "nashaad/vera",
                releasesApi: API,
                fetch: fakeFetch({
                    [API]: { body: releaseJson({ version: "0.1.0-alpha.3" }) },
                    [url]: { body: new Uint8Array(readFileSync(tarball)) },
                    [`${url}.sha256`]: { body: `${"0".repeat(64)}  ${ASSET}\n` },
                }),
            })).rejects.toThrow(/Checksum mismatch/);
            expect(currentReleaseBuildId(prefix)).toBe("vera-old");
            expect(existsSync(rollbackSymlinkPath(prefix))).toBe(false);
            expect(existsSync(releaseDirectory("vera-new", prefix))).toBe(false);
            expect(readdirSync(releasesDirectory(prefix)).filter((name) => name.startsWith(".staging")))
                .toEqual([]);
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a download failure leaves current, rollback and releases untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-download-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        await withTempEnvironment(join(root, "home"), async () => {
            await expect(runUpdate({
                prefix,
                running: {
                    root: oldRoot,
                    prefix,
                    version: "0.1.0-alpha.1",
                    buildId: "vera-old",
                },
                platform: "darwin",
                arch: "arm64",
                repo: "nashaad/vera",
                releasesApi: API,
                fetch: fakeFetch({
                    [API]: { body: releaseJson({ version: "0.1.0-alpha.3" }) },
                }),
            })).rejects.toThrow(/Could not reach .*HTTP 404|Could not download .*HTTP 404/);
            expect(currentReleaseBuildId(prefix)).toBe("vera-old");
            expect(existsSync(rollbackSymlinkPath(prefix))).toBe(false);
            expect(readdirSync(releasesDirectory(prefix)).filter((name) => name.startsWith(".staging")))
                .toEqual([]);
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a failed update does not let installRelease recover an interrupted journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-journal-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        writeUpgradeJournal({
            phase: "draining",
            from_build_id: "vera-old",
            to_build_id: "vera-next",
            host_was_running: false,
        }, prefix);
        const journal = upgradeJournalPath(prefix);
        const before = readFileSync(journal, "utf8");
        await withTempEnvironment(join(root, "home"), async () => {
            await expect(runUpdate({
                prefix,
                running: {
                    root: oldRoot,
                    prefix,
                    version: "0.1.0-alpha.1",
                    buildId: "vera-old",
                },
                platform: "darwin",
                arch: "arm64",
                repo: "nashaad/vera",
                releasesApi: API,
                fetch: fakeFetch({
                    [API]: { body: releaseJson({ version: "0.1.0-alpha.3" }) },
                }),
                output: () => undefined,
            })).rejects.toThrow(/Could not download .*HTTP 404|Could not reach .*HTTP 404/);
            expect(readFileSync(journal, "utf8")).toBe(before);
            expect(currentReleaseBuildId(prefix)).toBe("vera-old");
            expect(existsSync(rollbackSymlinkPath(prefix))).toBe(false);
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("update prints nonempty release bodies oldest first, across API pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-notes-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        const newRoot = join(root, "new-release");
        writeVerifiableRelease(newRoot, "vera-new", "0.1.0-alpha.4");
        const tarball = tarballFor(root, newRoot, "vera-new");
        const pageTwo = `${API}&page=2`;
        const output: string[] = [];
        const result = await withTempEnvironment(join(root, "home"), () => runUpdate({
            prefix,
            running: {
                root: oldRoot,
                prefix,
                version: "0.1.0-alpha.1",
                buildId: "vera-old",
            },
            platform: "darwin",
            arch: "arm64",
            repo: "nashaad/vera",
            releasesApi: API,
            fetch: fakeFetch({
                [API]: {
                    body: releaseJson(
                        { version: "0.1.0-alpha.4", body: "- four" },
                        { version: "0.1.0-alpha.1", body: "- old" },
                    ),
                    headers: { link: `<${pageTwo}>; rel="next"` },
                },
                [pageTwo]: {
                    body: releaseJson(
                        { version: "0.1.0-alpha.3", body: "- three" },
                        { version: "0.1.0-alpha.2", body: "- two" },
                    ),
                },
                ...routeFor("0.1.0-alpha.4", tarball),
            }),
            output: (text) => output.push(text),
            install: (options) => installRelease({ ...options, readLiveHost: async () => undefined }),
        }));
        expect(result).toBe(0);
        const text = output.join("");
        expect(text.indexOf("Vera 0.1.0-alpha.2")).toBeGreaterThan(-1);
        expect(text.indexOf("Vera 0.1.0-alpha.3")).toBeGreaterThan(-1);
        expect(text.indexOf("Vera 0.1.0-alpha.2")).toBeLessThan(text.indexOf("Vera 0.1.0-alpha.3"));
        expect(text.indexOf("Vera 0.1.0-alpha.3")).toBeLessThan(text.indexOf("Vera 0.1.0-alpha.4"));
        expect(text).toContain("- two");
        expect(text).toContain("- three");
        expect(text).toContain("- four");
        expect(text).not.toContain("- old");
        expect(text).toContain("Vera 0.1.0-alpha.4 is installed.");
        expect(readlinkSync(currentSymlinkPath(prefix))).toBe("releases/vera-new");
        expect(readlinkSync(rollbackSymlinkPath(prefix))).toBe("releases/vera-old");
        expect(existsSync(oldRoot)).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("update prints gathered notes and a releases link when the page cap is reached", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-notes-cap-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        const newRoot = join(root, "new-release");
        writeVerifiableRelease(newRoot, "vera-new", "0.1.0-alpha.3");
        const tarball = tarballFor(root, newRoot, "vera-new");
        const routes: Record<string, FakeRoute> = { ...routeFor("0.1.0-alpha.3", tarball) };
        for (let page = 1; page <= 20; page += 1) {
            const url = page === 1 ? API : `${API}?page=${page}`;
            routes[url] = {
                body: page === 1 ? releaseJson({ version: "0.1.0-alpha.3", body: "- notes" }) : "[]",
                headers: { link: `<${API}?page=${page + 1}>; rel="next"` },
            };
        }
        const calls: string[] = [];
        const output: string[] = [];
        const exit = await withTempEnvironment(join(root, "home"), () => runUpdate({
            running: { root: oldRoot, prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
            platform: "darwin",
            arch: "arm64",
            releasesApi: API,
            fetch: fakeFetch(routes, calls),
            output: (text) => output.push(text),
            install: (options) => installRelease({ ...options, readLiveHost: async () => undefined }),
        }));
        expect(exit).toBe(0);
        expect(output.join("")).toContain("Vera 0.1.0-alpha.3\n- notes\nMore releases: https://github.com/nashaad/vera/releases\n");
        expect(calls).not.toContain(`${API}?page=21`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("update installs a fake newer release end to end from an installed temp prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-e2e-"));
    const savedHome = process.env.VERA_HOME;
    const savedPrefix = process.env.VERA_INSTALL_PREFIX;
    try {
        const prefix = join(root, "prefix");
        const home = join(root, "home");
        mkdirSync(home, { recursive: true });
        process.env.VERA_HOME = home;
        process.env.VERA_INSTALL_PREFIX = prefix;

        const installed = Bun.spawnSync(["sh", installer, fakeInstallerTarball(root, "vera-old")], {
            env: {
                ...process.env,
                HOME: root,
                VERA_HOME: home,
                VERA_INSTALL_PREFIX: prefix,
                PATH: process.env.PATH ?? "/usr/bin:/bin",
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(installed.exitCode, installed.stderr.toString()).toBe(0);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");

        const newRoot = join(root, "new-release");
        writeVerifiableRelease(newRoot, "vera-new", "0.1.0-alpha.3");
        const tarball = tarballFor(root, newRoot, "vera-new");
        const output: string[] = [];
        const exit = await runUpdate({
            running: {
                root: releaseDirectory("vera-old", prefix),
                prefix,
                version: "0.1.0-alpha.1",
                buildId: "vera-old",
            },
            platform: "darwin",
            arch: "arm64",
            repo: "nashaad/vera",
            releasesApi: API,
            fetch: fakeFetch({
                [API]: {
                    body: releaseJson({ version: "0.1.0-alpha.3", body: "- end to end" }),
                },
                ...routeFor("0.1.0-alpha.3", tarball),
            }),
            output: (text) => output.push(text),
        });

        expect(exit).toBe(0);
        expect(readlinkSync(currentSymlinkPath(prefix))).toBe("releases/vera-new");
        expect(readlinkSync(rollbackSymlinkPath(prefix))).toBe("releases/vera-old");
        expect(existsSync(releaseDirectory("vera-old", prefix))).toBe(true);
        expect(existsSync(launcherPath(prefix))).toBe(true);
        expect(existsSync(defaultHostLockPath())).toBe(false);
        expect(readdirSync(releasesDirectory(prefix)).filter((name) => name.startsWith(".staging")))
            .toEqual([]);
        const text = output.join("");
        expect(text).toContain("Vera 0.1.0-alpha.3");
        expect(text).toContain("- end to end");
        expect(text).toContain("Vera 0.1.0-alpha.3 is installed.");
    } finally {
        if (savedHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = savedHome;
        if (savedPrefix === undefined) delete process.env.VERA_INSTALL_PREFIX;
        else process.env.VERA_INSTALL_PREFIX = savedPrefix;
        rmSync(root, { recursive: true, force: true });
    }
});

test("update refuses a checkout and points at bun run install:local", async () => {
    const saved = process.env.VERA_DEV_INSTANCE;
    delete process.env.VERA_DEV_INSTANCE;
    const calls: string[] = [];
    try {
        await expect(runUpdate({
            releasesApi: API,
            platform: "darwin",
            arch: "arm64",
            fetch: fakeFetch({}, calls),
        })).rejects.toThrow(/bun run install:local/);
        expect(calls).toEqual([]);
    } finally {
        if (saved === undefined) delete process.env.VERA_DEV_INSTANCE;
        else process.env.VERA_DEV_INSTANCE = saved;
    }
});

test("the CLI routes update flags to runUpdate", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const output: string[] = [];
    const dependencies = {
        update: async (options: { check?: boolean; version?: string; prefix?: string }) => {
            seen.push(options);
            return 10;
        },
        stdout: { write: (text: string) => output.push(text) },
        stderr: { write: (text: string) => output.push(text) },
    };
    expect(await runCli(["update", "--check"], dependencies)).toBe(10);
    expect(await runCli(["update", "0.1.0-alpha.3"], dependencies)).toBe(10);
    expect(seen[0]?.check).toBe(true);
    expect(seen[1]?.version).toBe("0.1.0-alpha.3");
    expect(await runCli(["update", "--nope"], dependencies)).toBe(1);
    expect(await runCli(["update", "--prefix", "/tmp/p"], dependencies)).toBe(1);
    expect(output.join("")).toContain("vera update: unknown flag: --nope");
});
