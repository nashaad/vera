import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
    chmodSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { activateRelease } from "../../src/release/activate.ts";
import {
    DESKTOP_PACKAGE_MANIFEST_NAME,
    serializeDesktopPackageManifest,
} from "../../src/release/desktop-package-manifest.ts";
import {
    desktopInstallRecordPath,
    RELEASE_ANNEX_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_SESSION_WORKER_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_WORKER_NAME,
    releaseDirectory,
} from "../../src/release/layout.ts";
import { installDesktopPackage } from "../../src/release/desktop-packages.ts";
import { installRelease } from "../../src/release/install.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    serializeReleaseManifest,
    type ReleaseManifest,
} from "../../src/release/manifest.ts";
import { runUpdate } from "../../src/release/update.ts";
import { digestPackedAnnex } from "../../src/release/verify.ts";

export const API = "https://api.test/releases";
export const ASSET = "vera-darwin-arm64.tar.gz";
const WRAPPERS = [
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_WORKER_NAME,
    RELEASE_SESSION_WORKER_NAME,
    RELEASE_ANNEX_NAME,
    RELEASE_SUPERVISOR_NAME,
] as const;

export interface FakeRoute {
    readonly status?: number;
    readonly body?: string | Uint8Array;
    readonly headers?: Record<string, string>;
}

export function fakeFetch(routes: Record<string, FakeRoute>, log: string[] = []): typeof fetch {
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

export function streamedBody(bytes: Uint8Array, delayMs: number, stall = false): ReadableStream<Uint8Array> {
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

export function writeVerifiableRelease(
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

export function tarballFor(work: string, releaseRoot: string, buildId: string): string {
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
export function fakeInstallerTarball(work: string, buildId: string): string {
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

export function checksumFor(tarball: string): string {
    return `${createHash("sha256").update(readFileSync(tarball)).digest("hex")}  ${ASSET}\n`;
}

export function assetUrl(version: string): string {
    return `https://github.com/nashaad/vera/releases/download/v${version}/${ASSET}`;
}

export function routeFor(version: string, tarball: string, checksum = checksumFor(tarball)): Record<string, FakeRoute> {
    const url = assetUrl(version);
    return {
        [url]: { body: new Uint8Array(readFileSync(tarball)) },
        [`${url}.sha256`]: { body: checksum },
    };
}

export function releaseJson(...items: readonly {
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

export function withTempEnvironment<T>(home: string, run: () => Promise<T>): Promise<T> {
    const saved = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    return run().finally(() => {
        if (saved === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!;
        else process.env.VERA_HOME = saved;
    });
}

export function prefixWithOldRelease(root: string): {
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
        if (saved === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!;
        else process.env.VERA_HOME = saved;
    }
    return { prefix, oldRoot };
}

export const DESKTOP_ASSET = "vera-desktop-darwin-arm64.tar.gz";
export const NEW_VERSION = "0.1.0-alpha.3";

export function desktopAssetUrl(version: string, asset = DESKTOP_ASSET): string {
    return `https://github.com/nashaad/vera/releases/download/v${version}/${asset}`;
}

export function desktopTarball(
    work: string,
    hostBuildId: string,
    desktopVersion: string,
    shellApi = 1,
): string {
    const source = mkdtempSync(join(work, "desktop-src-"));
    writeFileSync(
        join(source, DESKTOP_PACKAGE_MANIFEST_NAME),
        serializeDesktopPackageManifest({
            layout_version: 1,
            desktop_version: desktopVersion,
            host_build_id: hostBuildId,
            entry: "main.js",
            shell_api: shellApi,
        }),
    );
    writeFileSync(join(source, "main.js"), "// entry\n");
    const tarball = join(work, `desktop-${hostBuildId}-${desktopVersion}-${shellApi}.tar.gz`);
    const tar = Bun.spawnSync(["tar", "-czf", tarball, "-C", source, "."]);
    expect(tar.exitCode, tar.stderr.toString()).toBe(0);
    return tarball;
}

export async function installPackageFixture(
    work: string,
    prefix: string,
    hostBuildId: string,
    desktopVersion: string,
    shellApi = 1,
): Promise<void> {
    const tarball = desktopTarball(work, hostBuildId, desktopVersion, shellApi);
    await installDesktopPackage({
        tarball,
        hostBuildId,
        desktopVersion,
        prefix,
        sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
    });
}

export function desktopRoutes(version: string, tarball: string, checksum?: string): Record<string, FakeRoute> {
    const url = desktopAssetUrl(version);
    const sum = checksum ?? createHash("sha256").update(readFileSync(tarball)).digest("hex");
    return {
        [url]: { body: new Uint8Array(readFileSync(tarball)) },
        [`${url}.sha256`]: { body: `${sum}  ${DESKTOP_ASSET}\n` },
    };
}

// Where the fixtures put the desktop app: a folder beside the prefix, never a real Applications folder.
export function fixtureAppPath(prefix: string): string {
    return join(dirname(prefix), "Applications", "Vera.app");
}

export function recordDesktopInstall(prefix: string, appPath = fixtureAppPath(prefix)): void {
    mkdirSync(join(prefix, "share", "vera", "desktop"), { recursive: true });
    mkdirSync(dirname(appPath), { recursive: true });
    writeFileSync(
        desktopInstallRecordPath(prefix),
        `${JSON.stringify({ layout_version: 1, app_path: appPath })}\n`,
    );
}

export const SHELL_ASSET = "vera-desktop-shell-darwin-arm64.tar.gz";

// A bundle the update code accepts as a Vera shell: the bundle id, the marker and one file that says which build it is.
export function writeShellApp(
    appPath: string,
    shellApi: number | undefined,
    options: { readonly bundleId?: string; readonly label?: string } = {},
): void {
    rmSync(appPath, { recursive: true, force: true });
    mkdirSync(join(appPath, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
        join(appPath, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key>`
        + `<string>${options.bundleId ?? "dev.vera.desktop"}</string></dict></plist>\n`,
    );
    if (shellApi !== undefined) {
        writeFileSync(join(appPath, "Contents", "Resources", "vera-shell.json"), `${JSON.stringify({ shell_api: shellApi })}\n`);
    }
    writeFileSync(join(appPath, "Contents", "MacOS", "Vera"), `${options.label ?? `shell-api-${shellApi}`}\n`);
}

export function shellLabel(appPath: string): string | undefined {
    try {
        return readFileSync(join(appPath, "Contents", "MacOS", "Vera"), "utf8").trim();
    } catch {
        return undefined;
    }
}

export function shellTarball(
    work: string,
    shellApi: number | undefined,
    options: { readonly bundleId?: string; readonly label?: string; readonly extraTop?: boolean } = {},
): string {
    const source = mkdtempSync(join(work, "shell-src-"));
    writeShellApp(join(source, "Vera.app"), shellApi, options);
    if (options.extraTop === true) writeFileSync(join(source, "extra.txt"), "x\n");
    const tarball = join(work, `shell-${shellApi ?? "none"}-${options.label ?? "x"}-${options.extraTop === true ? "extra" : "plain"}.tar.gz`);
    const tar = Bun.spawnSync(["tar", "-czf", tarball, "-C", source, "."]);
    expect(tar.exitCode, tar.stderr.toString()).toBe(0);
    return tarball;
}

export function shellRoutes(version: string, tarball: string, checksum?: string): Record<string, FakeRoute> {
    const url = desktopAssetUrl(version, SHELL_ASSET);
    const sum = checksum ?? createHash("sha256").update(readFileSync(tarball)).digest("hex");
    return {
        [url]: { body: new Uint8Array(readFileSync(tarball)) },
        [`${url}.sha256`]: { body: `${sum}  ${SHELL_ASSET}\n` },
    };
}

export interface DesktopUpdateRun {
    readonly root: string;
    readonly prefix: string;
    readonly oldRoot: string;
    readonly tarball: string;
    readonly feed: () => Record<string, FakeRoute>;
}

// A prefix on vera-old with a desktop app recorded, and a feed for 0.1.0-alpha.3 whose host release is vera-new.
export async function withDesktopUpdate(
    run: (setup: DesktopUpdateRun) => Promise<void>,
    options: { readonly recorded?: boolean } = {},
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "vera-update-desktop-"));
    try {
        const { prefix, oldRoot } = prefixWithOldRelease(root);
        if (options.recorded !== false) recordDesktopInstall(prefix);
        const newRoot = join(root, "new-release");
        writeVerifiableRelease(newRoot, "vera-new", NEW_VERSION);
        const tarball = tarballFor(root, newRoot, "vera-new");
        await run({
            root,
            prefix,
            oldRoot,
            tarball,
            feed: () => ({
                [API]: { body: releaseJson({ version: NEW_VERSION }) },
                ...routeFor(NEW_VERSION, tarball),
            }),
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

export async function updateWith(
    setup: DesktopUpdateRun,
    routes: Record<string, FakeRoute>,
    extra: { readonly calls?: string[]; readonly installed?: string[] } = {},
): Promise<{ readonly exit: number; readonly output: string }> {
    const output: string[] = [];
    const exit = await withTempEnvironment(join(setup.root, "home"), () => runUpdate({
        prefix: setup.prefix,
        running: { root: setup.oldRoot, prefix: setup.prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
        platform: "darwin",
        arch: "arm64",
        releasesApi: API,
        fetch: fakeFetch(routes, extra.calls ?? []),
        output: (text) => output.push(text),
        install: (options) => {
            extra.installed?.push(options.prefix ?? "");
            return installRelease({ ...options, readLiveHost: async () => undefined });
        },
    }));
    return { exit, output: output.join("") };
}
