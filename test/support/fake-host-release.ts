import { spawn, type ChildProcess } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { activateRelease } from "../../src/release/activate.ts";
import { releaseDirectory } from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";
import { writeUpgradeJournal } from "../../src/release/upgrade.ts";

// Fake release directories whose `host` script stands in for a Vera host, plus
// the processes, locks and journals the upgrade tests set up around them.

export const RUN_DEFAULT_UPGRADE_FIXTURE = resolve(
    import.meta.dir,
    "..",
    "release",
    "fixtures",
    "run-default-upgrade.ts",
);

const cleanups: Array<() => Promise<void>> = [];

export function registerCleanup(cleanup: () => Promise<void>): void {
    cleanups.push(cleanup);
}

// Each test file passes this to its own afterEach; a hook registered here would
// belong only to the first file that imports the module.
export async function runCleanups(): Promise<void> {
    while (cleanups.length > 0) {
        await cleanups.pop()?.();
    }
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

export async function waitUntilGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid)) {
        if (Date.now() >= deadline) return false;
        await new Promise((done) => setTimeout(done, 25));
    }
    return true;
}

// A host left running on purpose can write its pid file after the test is over,
// so cleanup also kills it by the pid the test saw.
export function killOnCleanup(pid: number): void {
    registerCleanup(async () => {
        if (!isAlive(pid)) return;
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            return;
        }
        await waitUntilGone(pid);
    });
}

export function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-host-home-"));
    registerCleanup(async () => {
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}

export interface Disposable {
    readonly pid: number;
}

// Stands in for a resident host: a process this test owns and reaps.
export function spawnDisposable(): Disposable {
    const child: ChildProcess = spawn("sleep", ["60"], { stdio: "ignore" });
    const pid = child.pid;
    if (pid === undefined) throw new Error("could not spawn the disposable process");
    registerCleanup(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>((done) => child.once("exit", () => done()));
            child.kill("SIGKILL");
            await exited;
        }
    });
    return { pid };
}

function lockPathIn(home: string): string {
    return join(home, "runtime", "host.json");
}

export function writeLock(
    home: string,
    record: { readonly pid: number; readonly buildId: string; readonly startedAt?: string },
): void {
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(lockPathIn(home), `${JSON.stringify({
        schema_version: 3,
        pid: record.pid,
        started_at: record.startedAt ?? new Date().toISOString(),
        socket_path: join(home, "runtime", "host.sock"),
        build_id: record.buildId,
    })}\n`);
}

export function readLockBuild(home: string): { readonly pid: number; readonly build: string } {
    const parsed = JSON.parse(readFileSync(lockPathIn(home), "utf8")) as {
        pid: number;
        build_id: string;
    };
    return { pid: parsed.pid, build: parsed.build_id };
}

export type HostBehavior =
    | "publish"
    | "publish-other-build"
    | "publish-as-other-pid"
    | "yield-to-rival"
    | "crash-beside-rival"
    | "silent"
    | "ignores-sigterm";

export interface Release {
    readonly root: string;
    readonly pidFile: string;
}

// The `host` script records its pid, optionally publishes a lock, then idles. The
// rival behaviors publish under foreignPid, then exit 75 (yield) or 1 (crash).
export function writeRelease(
    prefix: string,
    buildId: string,
    home: string,
    behavior: HostBehavior,
    foreignPid?: number,
): Release {
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
    writeFileSync(join(root, "vera"), "#!/bin/sh\necho dummy\n", { mode: 0o755 });
    chmodSync(join(root, "vera"), 0o755);

    const pidFile = join(root, "host.pids");
    const lock = lockPathIn(home);
    const published = behavior === "publish-other-build" ? "vera-other" : buildId;
    const publish = behavior === "silent" || behavior === "ignores-sigterm"
        ? ""
        : [
            "now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
            `printf '{"schema_version":3,"pid":%s,"started_at":"%s","socket_path":"%s","build_id":"%s"}\\n' "${foreignPid ?? "$$"}" "$now" '${join(home, "runtime", "host.sock")}' '${published}' > '${lock}.tmp'`,
            `mv '${lock}.tmp' '${lock}'`,
        ].join("\n");
    writeFileSync(join(root, "host"), [
        "#!/bin/sh",
        `mkdir -p '${join(home, "runtime")}'`,
        `echo "$$" >> '${pidFile}'`,
        behavior === "ignores-sigterm" ? "trap '' TERM" : "",
        publish,
        behavior === "yield-to-rival"
            ? "exit 75"
            : behavior === "crash-beside-rival" ? "exit 1" : "exec sleep 30",
        "",
    ].join("\n"), { mode: 0o755 });
    chmodSync(join(root, "host"), 0o755);

    registerCleanup(async () => {
        if (!existsSync(pidFile)) return;
        for (const line of readFileSync(pidFile, "utf8").split("\n")) {
            const pid = Number(line);
            if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
                process.kill(pid, "SIGKILL");
                await waitUntilGone(pid);
            }
        }
    });
    return { root, pidFile };
}

export function spawnedPids(release: Release): number[] {
    if (!existsSync(release.pidFile)) return [];
    return readFileSync(release.pidFile, "utf8")
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function withVeraHome<T>(home: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        return await run();
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
    }
}

export interface FixtureRun {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

// Runs the real upgrade code in a child whose HOME is a temp directory, because
// Bun does not see an in-process change to HOME.
export async function runDefaultUpgrade(options: {
    readonly mode: "upgrade" | "recover";
    readonly root: string;
    readonly prefix: string;
    readonly releaseRoot: string;
    readonly veraHome?: string;
}): Promise<FixtureRun> {
    const env: Record<string, string> = {
        HOME: join(options.root, "home"),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        VERA_FIXTURE_ROOT: options.root,
    };
    if (options.veraHome !== undefined) env.VERA_HOME = options.veraHome;
    const child = Bun.spawn(
        [process.execPath, RUN_DEFAULT_UPGRADE_FIXTURE, options.mode, options.prefix, options.releaseRoot],
        { cwd: options.root, env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode: await child.exited, stdout, stderr };
}

export function defaultHomeOf(root: string): string {
    return join(root, "home", ".vera");
}

export interface SurvivorSetup {
    readonly prefix: string;
    readonly old: Release;
    readonly next: Release;
    readonly survivor: Disposable;
}

export interface InterruptedStart {
    readonly home: string;
    readonly prefix: string;
    readonly old: Release;
    readonly next: Release;
}

// A start with no failed-start marker, as an installer leaves it when it dies while it
// waits for the new host. "activating" died after it moved current, before "starting".
export function interruptedStart(
    phase: "starting" | "activating" = "starting",
): InterruptedStart {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const old = writeRelease(prefix, "vera-old", home, "publish");
    const next = writeRelease(prefix, "vera-new", home, "silent");
    activateRelease(next.root, prefix);
    writeUpgradeJournal({
        phase,
        from_build_id: "vera-old",
        to_build_id: "vera-new",
        host_was_running: true,
    }, prefix);
    return { home, prefix, old, next };
}
