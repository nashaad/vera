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
    DESKTOP_PACKAGE_MANIFEST_NAME,
    serializeDesktopPackageManifest,
} from "../../src/release/desktop-package-manifest.ts";
import { findDesktopPackage } from "../../src/release/desktop-packages.ts";
import {
    currentReleaseBuildId,
    currentSymlinkPath,
    desktopInstallRecordPath,
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
    type UpdateOptions,
} from "../../src/release/update.ts";
import {
    writeUpgradeJournal,
} from "../../src/release/upgrade.ts";
import { digestPackedAnnex } from "../../src/release/verify.ts";
import {
    compareVersions,
    isReleaseVersion,
} from "../../src/release/version.ts";
import {
    API,
    ASSET,
    type FakeRoute,
    DESKTOP_ASSET,
    NEW_VERSION,
    assetUrl,
    checksumFor,
    desktopAssetUrl,
    desktopRoutes,
    desktopTarball,
    fakeFetch,
    fakeInstallerTarball,
    prefixWithOldRelease,
    recordDesktopInstall,
    releaseJson,
    routeFor,
    streamedBody,
    tarballFor,
    updateWith,
    withDesktopUpdate,
    withTempEnvironment,
    writeVerifiableRelease,
} from "./update-fixtures.ts";

const installer = resolve(import.meta.dir, "..", "..", "scripts", "install.sh");

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
        if (savedHome === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!;
        else process.env.VERA_HOME = savedHome;
        if (savedPrefix === undefined) delete process.env.VERA_INSTALL_PREFIX;
        else process.env.VERA_INSTALL_PREFIX = savedPrefix;
        rmSync(root, { recursive: true, force: true });
    }
});

test("update downloads from VERA_RELEASES_DOWNLOAD_BASE over real HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-update-download-base-"));
    const { prefix, oldRoot } = prefixWithOldRelease(root);
    const newRoot = join(root, "new-release");
    writeVerifiableRelease(newRoot, "vera-mirror", "0.1.0-alpha.3");
    const tarball = tarballFor(root, newRoot, "vera-mirror");
    const tarballBytes = new Uint8Array(readFileSync(tarball));
    const checksum = checksumFor(tarball);
    const requests: string[] = [];
    const server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            requests.push(path);
            if (path === "/api") {
                return new Response(releaseJson({ version: "0.1.0-alpha.3" }), {
                    headers: { "content-type": "application/json" },
                });
            }
            if (path === `/mirror/v0.1.0-alpha.3/${ASSET}`) return new Response(tarballBytes);
            if (path === `/mirror/v0.1.0-alpha.3/${ASSET}.sha256`) return new Response(checksum);
            return new Response("not found", { status: 404 });
        },
    });
    try {
        const output: string[] = [];
        const result = await withTempEnvironment(join(root, "home"), () => runUpdate({
            prefix,
            running: { root: oldRoot, prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
            platform: "darwin",
            arch: "arm64",
            releasesApi: `http://localhost:${server.port}/api`,
            downloadBase: `http://localhost:${server.port}/mirror/`,
            output: (text) => output.push(text),
            install: (options) => installRelease({ ...options, readLiveHost: async () => undefined }),
        }));
        expect(result).toBe(0);
        expect(requests).toContain(`/mirror/v0.1.0-alpha.3/${ASSET}`);
        expect(requests).toContain(`/mirror/v0.1.0-alpha.3/${ASSET}.sha256`);
        expect(currentReleaseBuildId(prefix)).toBe("vera-mirror");
        expect(output.join(" ")).toContain("Vera 0.1.0-alpha.3 is installed.");
    } finally {
        server.stop(true);
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

test("@core the CLI routes --json and --download-only to the JSON modes", async () => {
    const seen: Array<{ mode: string; options: UpdateOptions }> = [];
    const output: string[] = [];
    const dependencies = {
        update: async (options: UpdateOptions) => {
            seen.push({ mode: "text", options });
            return 0;
        },
        updateJson: async (options: UpdateOptions) => {
            seen.push({ mode: "json", options });
            return 0;
        },
        stdout: { write: (text: string) => output.push(text) },
        stderr: { write: (text: string) => output.push(text) },
    };
    expect(await runCli(["update", "--check", "--json"], dependencies)).toBe(0);
    expect(await runCli(["update", "--json", "--download-only"], dependencies)).toBe(0);
    expect(await runCli(["update", "--download-only"], dependencies)).toBe(0);
    expect(seen.map((call) => call.mode)).toEqual(["json", "json", "text"]);
    expect(seen[0]?.options.check).toBe(true);
    expect(seen[1]?.options.downloadOnly).toBe(true);
    expect(seen[2]?.options.downloadOnly).toBe(true);
    expect(await runCli(["update", "--check", "--download-only"], dependencies)).toBe(1);
    expect(output.join("")).toContain("usage: vera update [VERSION] [--check] [--download-only] [--json]");
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


test("@core update installs the desktop package for the new host before current moves", async () => {
    await withDesktopUpdate(async (setup) => {
        const desktop = desktopTarball(setup.root, "vera-new", NEW_VERSION);
        const calls: string[] = [];
        let packageWhenCurrentMoved: string | undefined;
        const output: string[] = [];
        const exit = await withTempEnvironment(join(setup.root, "home"), () => runUpdate({
            prefix: setup.prefix,
            running: { root: setup.oldRoot, prefix: setup.prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
            platform: "darwin", arch: "arm64", releasesApi: API,
            fetch: fakeFetch({ ...setup.feed(), ...desktopRoutes(NEW_VERSION, desktop) }, calls),
            output: (text) => output.push(text),
            install: (options) => {
                packageWhenCurrentMoved = findDesktopPackage("vera-new", setup.prefix)?.desktopVersion;
                expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
                return installRelease({ ...options, readLiveHost: async () => undefined });
            },
        }));
        expect(exit).toBe(0);
        expect(output.join("")).toContain("Vera 0.1.0-alpha.3 is installed.");
        expect(packageWhenCurrentMoved).toBe(NEW_VERSION);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
        expect(readlinkSync(rollbackSymlinkPath(setup.prefix))).toBe(join("releases", "vera-old"));
        expect(calls).toContain(desktopAssetUrl(NEW_VERSION));
        expect(calls).toContain(`${desktopAssetUrl(NEW_VERSION)}.sha256`);
        expect(readdirSync(releasesDirectory(setup.prefix)).sort()).toEqual(["vera-new", "vera-old"]);
    });
});

test("@core a release with no desktop asset is downloaded and held, and a later update activates it", async () => {
    await withDesktopUpdate(async (setup) => {
        const installed: string[] = [];
        const held = await updateWith(setup, setup.feed(), { installed });
        expect(held.exit).toBe(0);
        expect(held.output).toContain(
            "Vera 0.1.0-alpha.3 is downloaded. It turns on once the desktop app for it is released; run 'vera update' again then.\n",
        );
        expect(installed).toEqual([]);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(existsSync(rollbackSymlinkPath(setup.prefix))).toBe(false);
        expect(readdirSync(releasesDirectory(setup.prefix)).sort()).toEqual(["vera-new", "vera-old"]);
        expect(findDesktopPackage("vera-new", setup.prefix)).toBeUndefined();
        expect(readdirSync(releasesDirectory(setup.prefix)).filter((name) => name.startsWith("."))).toEqual([]);

        const desktop = desktopTarball(setup.root, "vera-new", NEW_VERSION);
        const later = await updateWith(setup, { ...setup.feed(), ...desktopRoutes(NEW_VERSION, desktop) }, { installed });
        expect(later.exit).toBe(0);
        expect(later.output).toContain("Vera 0.1.0-alpha.3 is installed.");
        expect(installed).toHaveLength(1);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
        expect(findDesktopPackage("vera-new", setup.prefix)?.desktopVersion).toBe(NEW_VERSION);
    });
});

test("a desktop package for another host build holds the update", async () => {
    await withDesktopUpdate(async (setup) => {
        const wrong = desktopTarball(setup.root, "vera-other", NEW_VERSION);
        const installed: string[] = [];
        const result = await updateWith(setup, { ...setup.feed(), ...desktopRoutes(NEW_VERSION, wrong) }, { installed });
        expect(result.exit).toBe(0);
        expect(result.output).toContain("is downloaded. It turns on once the desktop app for it is released");
        expect(installed).toEqual([]);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(findDesktopPackage("vera-new", setup.prefix)).toBeUndefined();
        expect(findDesktopPackage("vera-other", setup.prefix)).toBeUndefined();
        expect(existsSync(releaseDirectory("vera-new", setup.prefix))).toBe(true);
    });
});

test("a package already installed for the new host build matches a release whose asset is absent", async () => {
    await withDesktopUpdate(async (setup) => {
        const desktop = desktopTarball(setup.root, "vera-new", NEW_VERSION);
        const first = await updateWith(setup, { ...setup.feed(), ...desktopRoutes(NEW_VERSION, desktop) }, {});
        expect(first.exit).toBe(0);
        // Back on the old release, as a rollback leaves it, with the new package still in the store.
        const home = join(setup.root, "home");
        await withTempEnvironment(home, async () => {
            activateRelease(setup.oldRoot, setup.prefix);
        });
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        const second = await updateWith(setup, setup.feed(), {});
        expect(second.exit).toBe(0);
        expect(second.output).toContain("Vera 0.1.0-alpha.3 is installed.");
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
    });
});

test("@core a desktop package whose checksum does not match activates nothing", async () => {
    await withDesktopUpdate(async (setup) => {
        const desktop = desktopTarball(setup.root, "vera-new", NEW_VERSION);
        const installed: string[] = [];
        const bad = desktopRoutes(NEW_VERSION, desktop, "0".repeat(64));
        await expect(updateWith(setup, { ...setup.feed(), ...bad }, { installed }))
            .rejects.toThrow(`Checksum mismatch for ${DESKTOP_ASSET}.`);
        expect(installed).toEqual([]);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(existsSync(rollbackSymlinkPath(setup.prefix))).toBe(false);
        expect(readdirSync(releasesDirectory(setup.prefix))).toEqual(["vera-old"]);
        expect(findDesktopPackage("vera-new", setup.prefix)).toBeUndefined();
        expect(existsSync(join(setup.prefix, "share", "vera", "desktop", "vera-new"))).toBe(false);
    });
});

test("a desktop checksum file that cannot be fetched is an error, not a hold", async () => {
    await withDesktopUpdate(async (setup) => {
        const url = desktopAssetUrl(NEW_VERSION);
        const feed = { ...setup.feed(), [`${url}.sha256`]: { status: 500, body: "server error" } };
        await expect(updateWith(setup, feed, {})).rejects.toThrow(/HTTP 500/);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
        expect(readdirSync(releasesDirectory(setup.prefix))).toEqual(["vera-old"]);
    });
});

test("a CLI-only install never asks for the desktop asset", async () => {
    await withDesktopUpdate(async (setup) => {
        const calls: string[] = [];
        const result = await updateWith(setup, setup.feed(), { calls });
        expect(result.exit).toBe(0);
        expect(result.output).toContain("Vera 0.1.0-alpha.3 is installed.");
        expect(calls.some((url) => url.includes("vera-desktop-"))).toBe(false);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
    }, { recorded: false });
});

test("a non-macOS install is treated as CLI-only even with a desktop record", async () => {
    await withDesktopUpdate(async (setup) => {
        const linuxAsset = "vera-linux-arm64.tar.gz";
        const base = `https://github.com/nashaad/vera/releases/download/v${NEW_VERSION}/${linuxAsset}`;
        const calls: string[] = [];
        const output: string[] = [];
        const exit = await withTempEnvironment(join(setup.root, "home"), () => runUpdate({
            prefix: setup.prefix,
            running: { root: setup.oldRoot, prefix: setup.prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
            platform: "linux", arch: "arm64", releasesApi: API,
            fetch: fakeFetch({
                [API]: { body: releaseJson({ version: NEW_VERSION }) },
                [base]: { body: new Uint8Array(readFileSync(setup.tarball)) },
                [`${base}.sha256`]: {
                    body: `${createHash("sha256").update(readFileSync(setup.tarball)).digest("hex")}  ${linuxAsset}\n`,
                },
            }, calls),
            verify: () => undefined,
            output: (text) => output.push(text),
            install: (options) => installRelease({ ...options, readLiveHost: async () => undefined }),
        }));
        expect(exit).toBe(0);
        expect(calls.some((url) => url.includes("vera-desktop-"))).toBe(false);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
    });
});
