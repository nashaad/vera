import { expect } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findDesktopPackage } from "../../src/release/desktop-packages.ts";
import {
    currentReleaseBuildId,
    currentSymlinkPath,
    launcherPath,
    releaseDirectory,
    rollbackSymlinkPath,
} from "../../src/release/layout.ts";
import { installedShellApi } from "../../src/release/shell-update.ts";
import { readStampedRelease } from "../../src/release/stamp.ts";
import { readUpgradeJournal } from "../../src/release/upgrade.ts";
import type { ChildConfig } from "./update-child.ts";
import {
    API,
    NEW_VERSION,
    desktopRoutes,
    desktopTarball,
    fixtureAppPath,
    installPackageFixture,
    prefixWithOldRelease,
    recordDesktopInstall,
    releaseJson,
    routeFor,
    shellRoutes,
    shellTarball,
    tarballFor,
    writeShellApp,
    writeVerifiableRelease,
    type FakeRoute,
} from "./update-fixtures.ts";

const CHILD = join(import.meta.dir, "update-child.ts");

export interface World {
    readonly root: string;
    readonly prefix: string;
    readonly home: string;
    readonly app: string;
    readonly api: string;
    readonly base: string;
    readonly requests: string[];
}

export interface ChildRun {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly lines: Array<Record<string, unknown>>;
    readonly stderr: string;
}

export interface WorldOptions {
    // Serve only the release list, as when the files an update needs are already on disk.
    readonly listOnly?: boolean;
    // Serve a shell archive and a package that needs it, so the update replaces the app.
    readonly newShell?: boolean;
    // Send the host archive in small pieces, this far apart.
    readonly slowHostMs?: number;
}

// An installed pair on vera-old with its desktop package and app, and a local feed for the next release.
export async function withWorld(run: (world: World) => Promise<void>, options: WorldOptions = {}): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "vera-update-world-"));
    const requests: string[] = [];
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
        const { prefix } = prefixWithOldRelease(root);
        recordDesktopInstall(prefix);
        const app = fixtureAppPath(prefix);
        writeShellApp(app, 1);
        await installPackageFixture(root, prefix, "vera-old", "0.1.0-alpha.1", 1);
        const newRoot = join(root, "new-release");
        writeVerifiableRelease(newRoot, "vera-new", NEW_VERSION);
        const needs = options.newShell === true ? 2 : 1;
        const routes: Record<string, FakeRoute> = {
            [API]: { body: releaseJson({ version: NEW_VERSION }) },
            ...routeFor(NEW_VERSION, tarballFor(root, newRoot, "vera-new")),
            ...desktopRoutes(NEW_VERSION, desktopTarball(root, "vera-new", NEW_VERSION, needs)),
            ...(options.newShell === true ? shellRoutes(NEW_VERSION, shellTarball(root, 2)) : {}),
        };
        const byPath = new Map<string, FakeRoute>();
        for (const [url, route] of Object.entries(routes)) byPath.set(new URL(url).pathname, route);
        server = Bun.serve({
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                requests.push(path);
                const route = byPath.get(path);
                if (route === undefined || (options.listOnly === true && path !== new URL(API).pathname)) {
                    return new Response("not found", { status: 404 });
                }
                if (options.slowHostMs !== undefined && path.endsWith("/vera-darwin-arm64.tar.gz")) {
                    return new Response(slowBody(route.body as Uint8Array, options.slowHostMs), {
                        headers: { "content-length": String((route.body as Uint8Array).byteLength) },
                    });
                }
                return new Response(route.body ?? "", { status: route.status ?? 200 });
            },
        });
        const home = join(root, "home");
        mkdirSync(home, { recursive: true });
        await run({
            root,
            prefix,
            home,
            app,
            api: `http://localhost:${server.port}${new URL(API).pathname}`,
            base: `http://localhost:${server.port}/nashaad/vera/releases/download`,
            requests,
        });
    } finally {
        server?.stop(true);
        rmSync(root, { recursive: true, force: true });
    }
}

function slowBody(bytes: Uint8Array, delayMs: number): ReadableStream<Uint8Array> {
    const pieces = 20;
    const size = Math.ceil(bytes.byteLength / pieces);
    let offset = 0;
    return new ReadableStream({
        async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            controller.enqueue(bytes.slice(offset, offset + size));
            offset += size;
            if (offset >= bytes.byteLength) controller.close();
        },
    });
}

// Starts the child. `exitAt` names the step at which it kills itself.
export function startChild(world: World, config: Omit<ChildConfig, "prefix" | "api" | "base">, exitAt?: string): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...process.env, VERA_HOME: world.home };
    delete env.VERA_UPDATE_EXIT_AT;
    delete env.VERA_HOT_UPDATE;
    if (exitAt !== undefined) env.VERA_UPDATE_EXIT_AT = exitAt;
    const full: ChildConfig = { ...config, prefix: world.prefix, api: world.api, base: world.base };
    return spawn(process.execPath, [CHILD, JSON.stringify(full)], { env, stdio: ["ignore", "pipe", "pipe"] });
}

export function finish(child: ChildProcess): Promise<ChildRun> {
    return new Promise((resolve) => {
        let out = "";
        let err = "";
        child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
        child.on("close", (code, signal) => {
            const lines = out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
            resolve({ code, signal, lines, stderr: err });
        });
    });
}

export function runChild(world: World, config: Omit<ChildConfig, "prefix" | "api" | "base">, exitAt?: string): Promise<ChildRun> {
    return finish(startChild(world, config, exitAt));
}

export function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (existsSync(path)) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                reject(new Error(`${path} did not appear`));
            }
        }, 20);
    });
}

export interface PairState {
    readonly current: string;
    readonly shellApi: number | undefined;
}

// The pair on disk is whole: current names a stamped release, the launcher reaches it and boots, the desktop
// package for that release is present and the app is new enough for it, and every pin and journal reads.
export async function expectWholePair(world: World, label: string): Promise<PairState> {
    const prefix = world.prefix;
    const current = currentReleaseBuildId(prefix);
    expect(current === "vera-old" || current === "vera-new", `${label}: current is ${current}`).toBe(true);
    expect(readStampedRelease(releaseDirectory(current!, prefix)).build_id, label).toBe(current!);
    expect(realpathSync(currentSymlinkPath(prefix)), label).toBe(realpathSync(releaseDirectory(current!, prefix)));
    const pin = lstatSyncOrUndefined(rollbackSymlinkPath(prefix));
    if (pin !== undefined) expect(existsSync(rollbackSymlinkPath(prefix)), `${label}: rollback pin dangles`).toBe(true);
    expect(await readUpgradeJournal(prefix).catch((error: unknown) => `unreadable: ${String(error)}`), label)
        .not.toEqual(expect.stringContaining("unreadable"));
    const boot = spawnSync(launcherPath(prefix), ["boot", "--json"], { env: { ...process.env, VERA_HOME: world.home }, encoding: "utf8" });
    expect(boot.status, `${label}: vera boot --json: ${boot.stderr} ${boot.signal} ${String(boot.error)}`).toBe(0);
    const desktop = findDesktopPackage(current!, prefix);
    expect(desktop, `${label}: no desktop package for ${current}`).toBeDefined();
    const shellApi = installedShellApi(world.app);
    expect(shellApi, `${label}: the app is missing or not a Vera shell`).toBeDefined();
    expect(shellApi! >= desktop!.shellApi, `${label}: app shell API ${shellApi} is below the package's ${desktop!.shellApi}`).toBe(true);
    return { current: current!, shellApi };
}

function lstatSyncOrUndefined(path: string): unknown {
    try {
        return lstatSync(path);
    } catch {
        return undefined;
    }
}

export function readTextOrEmpty(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

export function touch(path: string): void {
    writeFileSync(path, "1");
}
