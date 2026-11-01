import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { activateRelease } from "../../src/release/activate.ts";
import {
    currentReleaseBuildId,
    defaultInstallPrefix,
    releaseDirectory,
    upgradeJournalPath,
} from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";
import { readStampedRelease } from "../../src/release/stamp.ts";
import {
    StartedHostSurvivedError,
    defaultEnsureHost,
    readUpgradeJournal,
    recoverInterruptedUpgrade,
    upgradeLocalInstall,
    writeUpgradeJournal,
} from "../../src/release/upgrade.ts";

const fixture = resolve(import.meta.dir, "fixtures", "run-default-upgrade.ts");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        await cleanups.pop()?.();
    }
});

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function waitUntilGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid)) {
        if (Date.now() >= deadline) return false;
        await new Promise((done) => setTimeout(done, 25));
    }
    return true;
}

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-host-home-"));
    cleanups.push(async () => {
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}

interface Disposable {
    readonly pid: number;
}

// Stands in for a resident host: a process this test owns and reaps.
function spawnDisposable(): Disposable {
    const child: ChildProcess = spawn("sleep", ["60"], { stdio: "ignore" });
    const pid = child.pid;
    if (pid === undefined) throw new Error("could not spawn the disposable process");
    cleanups.push(async () => {
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

function writeLock(
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

function readLockBuild(home: string): { readonly pid: number; readonly build: string } {
    const parsed = JSON.parse(readFileSync(lockPathIn(home), "utf8")) as {
        pid: number;
        build_id: string;
    };
    return { pid: parsed.pid, build: parsed.build_id };
}

type HostBehavior = "publish" | "publish-other-build" | "silent" | "ignores-sigterm";

interface Release {
    readonly root: string;
    readonly pidFile: string;
}

// The `host` script records its pid, optionally publishes a lock, then idles.
function writeRelease(
    prefix: string,
    buildId: string,
    home: string,
    behavior: HostBehavior,
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
            `printf '{"schema_version":3,"pid":%s,"started_at":"%s","socket_path":"%s","build_id":"%s"}\\n' "$$" "$now" '${join(home, "runtime", "host.sock")}' '${published}' > '${lock}.tmp'`,
            `mv '${lock}.tmp' '${lock}'`,
        ].join("\n");
    writeFileSync(join(root, "host"), [
        "#!/bin/sh",
        `mkdir -p '${join(home, "runtime")}'`,
        `echo "$$" >> '${pidFile}'`,
        behavior === "ignores-sigterm" ? "trap '' TERM" : "",
        publish,
        "exec sleep 30",
        "",
    ].join("\n"), { mode: 0o755 });
    chmodSync(join(root, "host"), 0o755);

    cleanups.push(async () => {
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

function spawnedPids(release: Release): number[] {
    if (!existsSync(release.pidFile)) return [];
    return readFileSync(release.pidFile, "utf8")
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function withVeraHome<T>(home: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        return await run();
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
    }
}

interface FixtureRun {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

// Runs the real upgrade code in a child whose HOME is a temp directory. Bun
// does not see an in-process change to HOME, so the default home is only
// resolved safely in a child that is given HOME in its environment.
async function runDefaultUpgrade(options: {
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
        [process.execPath, fixture, options.mode, options.prefix, options.releaseRoot],
        { cwd: options.root, env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode: await child.exited, stdout, stderr };
}

function defaultHomeOf(root: string): string {
    return join(root, "home", ".vera");
}

test("a test prefix with the default home refuses and leaves the host running", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const prefix = join(root, "test-prefix");
    const host = spawnDisposable();
    writeLock(defaultHome, { pid: host.pid, buildId: "vera-daily" });
    const old = writeRelease(prefix, "vera-old", defaultHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", defaultHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
    });

    expect(isAlive(host.pid), "the default home's host was stopped").toBe(true);
    expect(spawnedPids(next), "a host was started for the test prefix").toEqual([]);
    expect(ran.exitCode, ran.stdout).toBe(1);
    expect(ran.stderr).toContain("VERA_HOME");
    expect(readLockBuild(defaultHome)).toEqual({ pid: host.pid, build: "vera-daily" });
    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
});

test("a test prefix refuses when VERA_HOME names the default home by another spelling", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const alias = join(root, "alias-to-default");
    mkdirSync(defaultHome, { recursive: true });
    symlinkSync(defaultHome, alias);
    const spellings = [`${defaultHome}/`, defaultHome, alias];

    for (const [index, spelling] of spellings.entries()) {
        const prefix = join(root, `test-prefix-${index}`);
        const host = spawnDisposable();
        writeLock(defaultHome, { pid: host.pid, buildId: "vera-daily" });
        const old = writeRelease(prefix, "vera-old", defaultHome, "publish");
        activateRelease(old.root, prefix);
        const next = writeRelease(prefix, "vera-new", defaultHome, "publish");

        const ran = await runDefaultUpgrade({
            mode: "upgrade",
            root,
            prefix,
            releaseRoot: next.root,
            veraHome: spelling,
        });

        expect(ran.exitCode, `${spelling}: ${ran.stdout}`).toBe(1);
        expect(isAlive(host.pid), spelling).toBe(true);
        expect(spawnedPids(next), spelling).toEqual([]);
        expect(currentReleaseBuildId(prefix), spelling).toBe("vera-old");
    }
});

test("a test prefix with a private VERA_HOME manages only that home's host", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const privateHome = join(root, "private-home");
    const prefix = join(root, "test-prefix");
    const daily = spawnDisposable();
    const test = spawnDisposable();
    writeLock(defaultHome, { pid: daily.pid, buildId: "vera-daily" });
    writeLock(privateHome, { pid: test.pid, buildId: "vera-old" });
    const old = writeRelease(prefix, "vera-old", privateHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", privateHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
        veraHome: privateHome,
    });

    expect(ran.exitCode, ran.stderr).toBe(0);
    expect(await waitUntilGone(test.pid)).toBe(true);
    expect(isAlive(daily.pid)).toBe(true);
    expect(readLockBuild(defaultHome)).toEqual({ pid: daily.pid, build: "vera-daily" });
    const started = readLockBuild(privateHome);
    expect(started.build).toBe("vera-new");
    expect(spawnedPids(next)).toEqual([started.pid]);
    expect(currentReleaseBuildId(prefix)).toBe("vera-new");
});

test("the daily prefix still drains and restarts the default home's host", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const prefix = join(root, "home", ".local");
    const host = spawnDisposable();
    writeLock(defaultHome, { pid: host.pid, buildId: "vera-old" });
    const old = writeRelease(prefix, "vera-old", defaultHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", defaultHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
    });

    expect(ran.exitCode, ran.stderr).toBe(0);
    expect(await waitUntilGone(host.pid)).toBe(true);
    expect(readLockBuild(defaultHome).build).toBe("vera-new");
    expect(currentReleaseBuildId(prefix)).toBe("vera-new");
});

test("recovering a test prefix against the default home keeps the journal and starts nothing", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const prefix = join(root, "test-prefix");
    const old = writeRelease(prefix, "vera-old", defaultHome, "publish");
    activateRelease(old.root, prefix);
    writeUpgradeJournal({
        phase: "draining",
        from_build_id: "vera-old",
        to_build_id: "vera-new",
        host_was_running: true,
    }, prefix);

    const ran = await runDefaultUpgrade({
        mode: "recover",
        root,
        prefix,
        releaseRoot: old.root,
    });

    expect(ran.exitCode, ran.stdout).toBe(1);
    expect(ran.stderr).toContain("VERA_HOME");
    expect(spawnedPids(old)).toEqual([]);
    expect(existsSync(upgradeJournalPath(prefix))).toBe(true);
});

test("the daily prefix with a private VERA_HOME refuses and changes nothing", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const privateHome = join(root, "private-home");
    const prefix = join(root, "home", ".local");
    const daily = spawnDisposable();
    const test = spawnDisposable();
    writeLock(defaultHome, { pid: daily.pid, buildId: "vera-daily" });
    writeLock(privateHome, { pid: test.pid, buildId: "vera-old" });
    const old = writeRelease(prefix, "vera-old", privateHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", privateHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
        veraHome: privateHome,
    });

    expect(ran.exitCode, ran.stdout).toBe(1);
    expect(ran.stderr).toContain("Unset VERA_HOME");
    expect(ran.stderr).toContain(privateHome);
    expect(isAlive(daily.pid), "the default home's host was stopped").toBe(true);
    expect(isAlive(test.pid), "the private home's host was stopped").toBe(true);
    expect(spawnedPids(next), "a host was started").toEqual([]);
    expect(readLockBuild(defaultHome)).toEqual({ pid: daily.pid, build: "vera-daily" });
    expect(readLockBuild(privateHome)).toEqual({ pid: test.pid, build: "vera-old" });
    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
});

test("the daily prefix refuses a private VERA_HOME when --prefix spells it another way", async () => {
    const root = makeRoot();
    const privateHome = join(root, "private-home");
    const prefix = join(root, "home", ".local");
    const alias = join(root, "alias-to-daily-prefix");
    const old = writeRelease(prefix, "vera-old", privateHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", privateHome, "publish");
    symlinkSync(prefix, alias);

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix: alias,
        releaseRoot: next.root,
        veraHome: privateHome,
    });

    expect(ran.exitCode, ran.stdout).toBe(1);
    expect(ran.stderr).toContain("Unset VERA_HOME");
    expect(spawnedPids(next)).toEqual([]);
    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
});

test("the daily prefix accepts VERA_HOME when it names the default home by another spelling", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const alias = join(root, "alias-to-default");
    const prefix = join(root, "home", ".local");
    const host = spawnDisposable();
    writeLock(defaultHome, { pid: host.pid, buildId: "vera-old" });
    symlinkSync(defaultHome, alias);
    const old = writeRelease(prefix, "vera-old", defaultHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", defaultHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
        veraHome: alias,
    });

    expect(ran.exitCode, ran.stderr).toBe(0);
    expect(await waitUntilGone(host.pid)).toBe(true);
    expect(readLockBuild(defaultHome).build).toBe("vera-new");
    expect(currentReleaseBuildId(prefix)).toBe("vera-new");
});

test("a test prefix refuses when VERA_HOME is a link to a default home that does not exist yet", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const danglingLink = join(root, "dangling-to-default");
    const linkedParent = join(root, "linked-home");
    symlinkSync(defaultHome, danglingLink);
    symlinkSync(join(root, "home"), linkedParent);
    const spellings = [danglingLink, join(linkedParent, ".vera")];

    for (const [index, spelling] of spellings.entries()) {
        const prefix = join(root, `test-prefix-${index}`);
        const old = writeRelease(prefix, "vera-old", defaultHome, "publish");
        activateRelease(old.root, prefix);
        const next = writeRelease(prefix, "vera-new", defaultHome, "publish");

        const ran = await runDefaultUpgrade({
            mode: "upgrade",
            root,
            prefix,
            releaseRoot: next.root,
            veraHome: spelling,
        });

        expect(ran.exitCode, `${spelling}: ${ran.stdout}`).toBe(1);
        expect(ran.stderr, spelling).toContain("VERA_HOME");
        expect(spawnedPids(next), spelling).toEqual([]);
        expect(currentReleaseBuildId(prefix), spelling).toBe("vera-old");
        expect(existsSync(defaultHome), `${spelling} created the default home`).toBe(false);
    }
});

test("the daily prefix accepts VERA_HOME when it is a link to a default home that does not exist yet", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const danglingLink = join(root, "dangling-to-default");
    const prefix = join(root, "home", ".local");
    symlinkSync(defaultHome, danglingLink);
    const old = writeRelease(prefix, "vera-old", defaultHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", defaultHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
        veraHome: danglingLink,
    });

    expect(ran.exitCode, ran.stderr).toBe(0);
    expect(currentReleaseBuildId(prefix)).toBe("vera-new");
});

test("a chain of dangling links to the default home is refused", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const first = join(root, "first");
    const second = join(root, "second");
    const prefix = join(root, "test-prefix");
    symlinkSync(second, first);
    symlinkSync(defaultHome, second);
    const old = writeRelease(prefix, "vera-old", defaultHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", defaultHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
        veraHome: first,
    });

    expect(ran.exitCode, ran.stdout).toBe(1);
    expect(ran.stderr).toContain("VERA_HOME");
    expect(spawnedPids(next)).toEqual([]);
    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
});

test("a VERA_HOME that is a link loop does not hang the home check", async () => {
    const root = makeRoot();
    const defaultHome = defaultHomeOf(root);
    const loopA = join(root, "loop-a");
    const loopB = join(root, "loop-b");
    const prefix = join(root, "test-prefix");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    const daily = spawnDisposable();
    writeLock(defaultHome, { pid: daily.pid, buildId: "vera-daily" });
    const old = writeRelease(prefix, "vera-old", defaultHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", defaultHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
        veraHome: loopA,
    });

    expect(typeof ran.exitCode).toBe("number");
    expect(isAlive(daily.pid), "the default home's host was stopped").toBe(true);
});

test("recovering the daily prefix against a private VERA_HOME keeps the journal and starts nothing", async () => {
    const root = makeRoot();
    const privateHome = join(root, "private-home");
    const prefix = join(root, "home", ".local");
    const old = writeRelease(prefix, "vera-old", privateHome, "publish");
    activateRelease(old.root, prefix);
    writeUpgradeJournal({
        phase: "draining",
        from_build_id: "vera-old",
        to_build_id: "vera-new",
        host_was_running: true,
    }, prefix);

    const ran = await runDefaultUpgrade({
        mode: "recover",
        root,
        prefix,
        releaseRoot: old.root,
        veraHome: privateHome,
    });

    expect(ran.exitCode, ran.stdout).toBe(1);
    expect(ran.stderr).toContain("Unset VERA_HOME");
    expect(spawnedPids(old)).toEqual([]);
    expect(existsSync(upgradeJournalPath(prefix))).toBe(true);
});

// In this process HOME is the pinned test user home, so the daily prefix is
// under the repository's test directory and never the real one.
test("the home check is skipped only when both drain and start are injected", async () => {
    const privateHome = makeRoot();
    const packReached = new Error("pack reached");
    const upgrade = (hooks: object): Promise<unknown> => upgradeLocalInstall({
        prefix: defaultInstallPrefix(),
        pack: async () => {
            throw packReached;
        },
        ...hooks,
    });

    await withVeraHome(privateHome, async () => {
        await expect(upgrade({
            drainHost: async () => "absent",
            startHost: async () => undefined,
        })).rejects.toBe(packReached);
        await expect(upgrade({ drainHost: async () => "absent" }))
            .rejects.toThrow(/Unset VERA_HOME/);
        await expect(upgrade({ startHost: async () => undefined }))
            .rejects.toThrow(/Unset VERA_HOME/);
    });
});

test("ensure refuses a live host that is running a different build and spawns nothing", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const stale = spawnDisposable();
    writeLock(home, { pid: stale.pid, buildId: "vera-stale" });
    const next = writeRelease(prefix, "vera-new", home, "publish");

    await withVeraHome(home, async () => {
        await expect(defaultEnsureHost(next.root)).rejects.toThrow(
            /vera-stale.*vera-new|vera-new.*vera-stale/,
        );
    });

    expect(spawnedPids(next)).toEqual([]);
    expect(isAlive(stale.pid)).toBe(true);
});

test("ensure accepts a live host that already runs the release", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const running = spawnDisposable();
    writeLock(home, { pid: running.pid, buildId: "vera-new" });
    const next = writeRelease(prefix, "vera-new", home, "publish");

    await withVeraHome(home, async () => {
        await defaultEnsureHost(next.root);
    });

    expect(spawnedPids(next)).toEqual([]);
});

test("ensure starts the release's host and waits for its build id", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const next = writeRelease(prefix, "vera-new", home, "publish");

    await withVeraHome(home, async () => {
        await defaultEnsureHost(next.root);
    });

    expect(spawnedPids(next)).toHaveLength(1);
    expect(readLockBuild(home).build).toBe("vera-new");
});

test("ensure ignores a lock whose process has gone", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const gone = spawn("true", [], { stdio: "ignore" });
    const gonePid = gone.pid;
    if (gonePid === undefined) throw new Error("could not spawn the short-lived process");
    await new Promise<void>((done) => gone.once("exit", () => done()));
    writeLock(home, { pid: gonePid, buildId: "vera-new" });
    const next = writeRelease(prefix, "vera-new", home, "publish");

    await withVeraHome(home, async () => {
        await defaultEnsureHost(next.root);
    });

    expect(spawnedPids(next)).toHaveLength(1);
    expect(readLockBuild(home).pid).not.toBe(gonePid);
});

test("ensure ignores a lock whose pid now belongs to a different process", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const other = spawnDisposable();
    writeLock(home, {
        pid: other.pid,
        buildId: "vera-new",
        startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const next = writeRelease(prefix, "vera-new", home, "publish");

    await withVeraHome(home, async () => {
        await defaultEnsureHost(next.root);
    });

    expect(spawnedPids(next)).toHaveLength(1);
    expect(isAlive(other.pid)).toBe(true);
});

test("ensure fails and stops the host it started when that host publishes another build", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const next = writeRelease(prefix, "vera-new", home, "publish-other-build");

    await withVeraHome(home, async () => {
        await expect(defaultEnsureHost(next.root, { publishTimeoutMs: 1_000 }))
            .rejects.toThrow(/vera-new.*vera-other|vera-other.*vera-new/);
    });

    const [pid] = spawnedPids(next);
    expect(pid).toBeDefined();
    expect(await waitUntilGone(pid as number)).toBe(true);
});

test("ensure fails and stops the host it started when that host never publishes", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const next = writeRelease(prefix, "vera-new", home, "silent");

    await withVeraHome(home, async () => {
        await expect(defaultEnsureHost(next.root, { publishTimeoutMs: 500 }))
            .rejects.toThrow(/did not publish/);
    });

    const [pid] = spawnedPids(next);
    expect(pid).toBeDefined();
    expect(await waitUntilGone(pid as number)).toBe(true);
});

test("ensure force-stops a started host that ignores SIGTERM", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const next = writeRelease(prefix, "vera-new", home, "ignores-sigterm");

    await withVeraHome(home, async () => {
        await expect(defaultEnsureHost(next.root, {
            publishTimeoutMs: 300,
            exitGraceMs: 500,
        })).rejects.toThrow(/did not publish.*was stopped/);
    });

    const [pid] = spawnedPids(next);
    expect(pid).toBeDefined();
    expect(isAlive(pid as number), "the started host survived").toBe(false);
});

test("an upgrade whose started host cannot be stopped restores the release but starts no host and keeps the journal", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const old = writeRelease(prefix, "vera-old", home, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", home, "publish");
    const started: string[] = [];
    const survivor = new StartedHostSurvivedError("The started host is still running.");

    await withVeraHome(home, async () => {
        await expect(upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next.root,
                manifest: readStampedRelease(next.root),
            }),
            verify: () => undefined,
            drainHost: async () => "stopped",
            startHost: async (releaseRoot) => {
                started.push(releaseRoot);
                throw survivor;
            },
        })).rejects.toBe(survivor);
    });

    expect(started, "a second host was started").toEqual([next.root]);
    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    expect((await readUpgradeJournal(prefix))?.phase).toBe("starting");

    const recovered = await recoverInterruptedUpgrade({
        prefix,
        startHost: async (releaseRoot) => {
            started.push(releaseRoot);
        },
    });
    expect(recovered).toEqual({ recovered: true, buildId: "vera-old" });
    expect(started).toEqual([next.root, old.root]);
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
});

test("an upgrade whose home still has a host on the old build rolls back instead of passing", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const stale = spawnDisposable();
    writeLock(home, { pid: stale.pid, buildId: "vera-old" });
    const old = writeRelease(prefix, "vera-old", home, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", home, "publish");

    await withVeraHome(home, async () => {
        await expect(upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next.root,
                manifest: readStampedRelease(next.root),
            }),
            verify: () => undefined,
            drainHost: async () => "stopped",
        })).rejects.toThrow(/vera-old.*vera-new|vera-new.*vera-old/);
    });

    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    expect(spawnedPids(next)).toEqual([]);
    expect(isAlive(stale.pid)).toBe(true);
});
