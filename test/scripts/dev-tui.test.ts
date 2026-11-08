import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";

import {
    candidateBuildId,
    candidateHomePath,
    candidateLaunchEnv,
    dropClonedSchedules,
    evictHome,
    formatDevInstanceMarker,
    factoryHomePath,
    parseDevTuiArgs,
    quarantineUnknownHomeEntries,
    runDevTui,
} from "../../scripts/dev-tui.ts";
import {
    FACTORY_HELLO_SESSION_ID,
    synthesizeFactoryHome,
} from "../../scripts/synthesize-factory-home.ts";
import { devInstancePath, registerDevInstance } from "../../src/dev-instances.ts";
import { spawnVeraLookingProcess } from "../support/vera-looking-process.ts";

function linkedWorktree(name: string): string {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-src-"));
    const repository = join(root, "repository");
    const checkout = join(root, name);
    mkdirSync(repository);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repository });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repository });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], {
        cwd: repository,
    });
    writeFileSync(join(repository, "tracked"), "fixture\n");
    Bun.spawnSync(["git", "add", "tracked"], { cwd: repository });
    Bun.spawnSync(["git", "commit", "-qm", "fixture"], { cwd: repository });
    Bun.spawnSync(["git", "worktree", "add", "-q", checkout], {
        cwd: repository,
    });
    return realpathSync(checkout);
}

function dailyHome(root: string): string {
    const home = join(root, "daily");
    mkdirSync(join(home, "runtime"), { recursive: true });
    mkdirSync(join(home, "machine"), { recursive: true });
    writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
            schema_version: 1,
        }, null, 2) + "\n",
    );
    writeFileSync(join(home, "runtime", "session.jsonl"), "daily-session\n");
    writeFileSync(join(home, "runtime", "schedules.db"), "");
    writeFileSync(join(home, "machine", "auth.json"), "{\"token\":\"secret\"}\n");
    return home;
}

test("dev:tui flags parse without swallowing passthrough args", () => {
    expect(parseDevTuiArgs(["--status"])).toEqual({
        action: "status",
        fresh: false,
        yes: false,
        passthrough: [],
    });
    expect(parseDevTuiArgs(["--fresh", "--yes", "-c"])).toEqual({
        action: "run",
        fresh: true,
        yes: true,
        passthrough: ["-c"],
    });
    expect(parseDevTuiArgs(["--discard", "--stop"]).action).toBe("stop");
    expect(parseDevTuiArgs(["--pool", "--no-discovery", "-c"])).toEqual({
        action: "run", fresh: false, yes: false, passthrough: ["-c"], pool: true, noDiscovery: true,
    });
});

test("the DEV marker is text, not a color-only cue", () => {
    expect(formatDevInstanceMarker("/tmp/ovu26", "vera-abc")).toBe(
        "[DEV ovu26 vera-abc]",
    );
    const source = readFileSync(
        join(import.meta.dir, "../../clients/tui/main.ts"),
        "utf8",
    );
    expect(source).toContain("[DEV ${marker}]");
    expect(source).toContain("tuiDevInstancePrefix()");
});

test("two worktrees get different complete homes and sockets", () => {
    const first = mkdtempSync(join(tmpdir(), "vera-dev-a-"));
    const second = mkdtempSync(join(tmpdir(), "vera-dev-b-"));
    mkdirSync(join(first, "nested"), { recursive: true });
    mkdirSync(join(second, "nested"), { recursive: true });
    const firstHome = candidateHomePath(first);
    const secondHome = candidateHomePath(second);
    expect(firstHome).not.toBe(secondHome);
    expect(join(firstHome, "runtime", "host.sock"))
        .not.toBe(join(secondHome, "runtime", "host.sock"));
    expect(firstHome).toMatch(/\/vera-dev\/[a-f0-9]{12}\/\.vera$/);
});

function unmigratedDailyHome(root: string): string {
    const home = join(root, "daily");
    mkdirSync(join(home, "machine"), { recursive: true });
    mkdirSync(join(home, "profiles", "default", "memory"), { recursive: true });
    mkdirSync(join(home, "profiles", "other"), { recursive: true });
    writeFileSync(join(home, "machine", "auth.json"), "{\"token\":\"secret\"}\n");
    writeFileSync(
        join(home, "profiles", "default", "config.json"),
        JSON.stringify({
            schema_version: 1,
        }, null, 2) + "\n",
    );
    writeFileSync(join(home, "profiles", "default", "memory", "note.md"), "keep\n");
    writeFileSync(join(home, "profiles", "other", "config.json"), "other-config\n");
    mkdirSync(join(home, "profiles", "default", "runtime"), { recursive: true });
    writeFileSync(
        join(home, "profiles", "default", "runtime", "host.json"),
        JSON.stringify({
            pid: 177,
            socket_path: join(home, "profiles", "default", "runtime", "host.sock"),
        }),
    );
    return home;
}

test("the first launch clones the daily home with outbound consumers off", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-a");
    const sourceHome = dailyHome(root);
    const launches: Array<{ env: NodeJS.ProcessEnv }> = [];
    try {
        const code = await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                launches.push({ env });
                return 0;
            },
        });
        expect(code).toBe(0);
        const dest = launches[0]?.env.VERA_HOME;
        expect(dest).toBeDefined();
        expect(readFileSync(join(dest!, "runtime", "session.jsonl"), "utf8"))
            .toBe("daily-session\n");
        expect(existsSync(join(dest!, "runtime", "schedules.db"))).toBe(false);
        expect(existsSync(join(sourceHome, "runtime", "schedules.db"))).toBe(true);
        expect(launches[0]?.env.VERA_RUNTIME_DIR).toBeUndefined();
        expect(launches[0]?.env.VERA_DEV_INSTANCE).toMatch(/^ovu-a /);
        expect(existsSync(join(dest!, "runtime", "host.sock"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("a profiles/ daily home is lifted in the clone only", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-lift");
    const sourceHome = unmigratedDailyHome(root);
    try {
        const code = await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                const dest = env.VERA_HOME!;
                expect(existsSync(join(dest, "profiles"))).toBe(false);
                expect(existsSync(join(dest, "runtime", "host.json"))).toBe(false);
                expect(readFileSync(join(dest, "memory", "note.md"), "utf8")).toBe("keep\n");
                expect(existsSync(join(dest, "memory", "secret.md"))).toBe(false);
                return 0;
            },
        });
        expect(code).toBe(0);
        expect(existsSync(join(sourceHome, "profiles", "default"))).toBe(true);
        expect(existsSync(join(sourceHome, "profiles", "other"))).toBe(true);
        expect(existsSync(join(sourceHome, "config.json"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("a reused clone drops a lifted daily host lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-scrub");
    const sourceHome = dailyHome(root);
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async () => 0,
        });
        const dest = candidateHomePath(worktree, join(root, "instances"));
        writeFileSync(
            join(dest, "runtime", "host.json"),
            JSON.stringify({
                pid: 177,
                socket_path: join(sourceHome, "runtime", "host.sock"),
            }),
        );
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                expect(existsSync(join(env.VERA_HOME!, "runtime", "host.json")))
                    .toBe(false);
                return 0;
            },
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("reusing a development home preserves its running host and socket", async () => {
    const root = mkdtempSync("/tmp/vera-dev-reuse-");
    const worktree = linkedWorktree("reuse-host");
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const server = createServer((socket) => socket.end("same host"));
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot,
            spawnTui: async () => 0,
        });
        const home = candidateHomePath(worktree, temporaryRoot);
        const socketPath = join(home, "runtime", "host.sock");
        const lockPath = join(home, "runtime", "host.json");
        const lock = JSON.stringify({
            schema_version: 1,
            pid: process.pid,
            started_at: new Date().toISOString(),
            socket_path: socketPath,
        });
        writeFileSync(lockPath, lock);
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await runDevTui([], worktree, {
                sourceHome,
                temporaryRoot,
                spawnTui: async () => {
                    expect(readFileSync(lockPath, "utf8")).toBe(lock);
                    const reply = await new Promise<string>((resolve, reject) => {
                        const socket = createConnection(socketPath);
                        socket.once("error", reject);
                        socket.once("data", (data) => resolve(data.toString()));
                    });
                    expect(reply).toBe("same host");
                    return 0;
                },
            });
        }
    } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("a development host from another build is stopped before launch; one from this build is kept", async () => {
    const root = mkdtempSync("/tmp/vera-dev-stale-");
    const worktree = linkedWorktree("stale-host");
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const leftover = Bun.spawn(["sleep", "60"]);
    try {
        await runDevTui([], worktree, { sourceHome, temporaryRoot, spawnTui: async () => 0 });
        const home = candidateHomePath(worktree, temporaryRoot);
        const lockPath = join(home, "runtime", "host.json");
        const lock = (pid: number, buildId: string) => JSON.stringify({
            schema_version: 2, pid, started_at: new Date().toISOString(),
            socket_path: join(home, "runtime", "host.sock"), build_id: buildId,
        });

        writeFileSync(lockPath, lock(process.pid, candidateBuildId(worktree)));
        let errors = "";
        await runDevTui([], worktree, {
            sourceHome, temporaryRoot, spawnTui: async () => 0,
            stderr: { write: (text: string) => errors += text },
        });
        expect(errors).toBe("");
        expect(existsSync(lockPath)).toBe(true);

        writeFileSync(lockPath, lock(leftover.pid, "vera-old-build"));
        await runDevTui([], worktree, {
            sourceHome, temporaryRoot,
            stderr: { write: (text: string) => errors += text },
            spawnTui: async () => {
                expect(existsSync(lockPath)).toBe(false);
                return 0;
            },
        });
        expect(errors).toContain(`Stopping development host PID ${leftover.pid} from build vera-old-build`);
        expect(await leftover.exited).not.toBe(0);
    } finally {
        leftover.kill("SIGKILL");
        await leftover.exited;
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

/** Runs runDevTui in a child whose PATH has git but no ps, so process start times are unreadable. */
function runDevTuiWithoutPs(
    args: readonly string[],
    worktree: string,
    temporaryRoot: string,
    binDirectory: string,
): { readonly code: number; readonly stderr: string; readonly launched: boolean } {
    const devTui = join(import.meta.dir, "..", "..", "scripts", "dev-tui.ts");
    const script = `
        import { runDevTui } from ${JSON.stringify(devTui)};
        let launched = false;
        const messages: string[] = [];
        const code = await runDevTui(${JSON.stringify(args)}, ${JSON.stringify(worktree)}, {
            temporaryRoot: ${JSON.stringify(temporaryRoot)},
            stderr: { write: (text: string) => messages.push(text) },
            spawnTui: async () => { launched = true; return 0; },
        });
        console.log(JSON.stringify({ code, stderr: messages.join(""), launched }));
    `;
    const ran = Bun.spawnSync([process.execPath, "-e", script], {
        env: { PATH: binDirectory, HOME: temporaryRoot },
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    return JSON.parse(ran.stdout.toString().trim());
}

test("a development host whose start time cannot be read is left running and the launch stops", async () => {
    const root = mkdtempSync("/tmp/vera-dev-unverified-");
    const worktree = linkedWorktree("unverified-host");
    const temporaryRoot = join(root, "instances");
    const binDirectory = join(root, "bin");
    mkdirSync(binDirectory);
    const git = Bun.which("git");
    expect(git).not.toBeNull();
    symlinkSync(git as string, join(binDirectory, "git"));
    const bystander = Bun.spawn(["sleep", "60"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    try {
        const home = candidateHomePath(worktree, temporaryRoot);
        mkdirSync(join(home, "runtime"), { recursive: true });
        const lockPath = join(home, "runtime", "host.json");
        writeFileSync(lockPath, JSON.stringify({
            schema_version: 2,
            pid: bystander.pid,
            started_at: new Date().toISOString(),
            socket_path: join(home, "runtime", "host.sock"),
            build_id: "vera-old-build",
        }));
        const message = `Could not confirm PID ${bystander.pid} is the Vera host`
            + " (process start time unreadable); left it running and kept its"
            + " lockfile. Try again.\n";

        const stopped = runDevTuiWithoutPs(
            ["--stop"], worktree, temporaryRoot, binDirectory,
        );
        expect(stopped.code).toBe(1);
        expect(stopped.stderr).toBe(message);

        const launch = runDevTuiWithoutPs([], worktree, temporaryRoot, binDirectory);
        expect(launch.code).toBe(1);
        expect(launch.stderr).toContain(message);
        expect(launch.launched).toBe(false);

        expect(bystander.signalCode).toBeNull();
        expect(bystander.exitCode).toBeNull();
        expect(existsSync(lockPath)).toBe(true);
    } finally {
        bystander.kill("SIGKILL");
        await bystander.exited;
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

async function expectUnverifiedHostSurvives(
    name: string,
    args: readonly string[],
): Promise<void> {
    const root = mkdtempSync("/tmp/vera-dev-unverified-");
    const worktree = linkedWorktree(name);
    const temporaryRoot = join(root, "instances");
    const binDirectory = join(root, "bin");
    mkdirSync(binDirectory);
    symlinkSync(Bun.which("git") as string, join(binDirectory, "git"));
    const bystander = Bun.spawn(["sleep", "60"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    try {
        const home = candidateHomePath(worktree, temporaryRoot);
        mkdirSync(join(home, "runtime"), { recursive: true });
        const lockPath = join(home, "runtime", "host.json");
        const sessionPath = join(home, "runtime", "session.jsonl");
        writeFileSync(sessionPath, "kept-session\n");
        writeFileSync(lockPath, JSON.stringify({
            schema_version: 2,
            pid: bystander.pid,
            started_at: new Date().toISOString(),
            socket_path: join(home, "runtime", "host.sock"),
            build_id: candidateBuildId(worktree),
        }));

        const ran = runDevTuiWithoutPs(args, worktree, temporaryRoot, binDirectory);

        expect(ran.code).toBe(1);
        expect(ran.stderr).toContain(`Could not confirm PID ${bystander.pid}`);
        expect(ran.stderr).toContain("Nothing was deleted.");
        expect(ran.launched).toBe(false);
        expect(bystander.signalCode).toBeNull();
        expect(bystander.exitCode).toBeNull();
        expect(existsSync(lockPath)).toBe(true);
        expect(readFileSync(sessionPath, "utf8")).toBe("kept-session\n");
    } finally {
        bystander.kill("SIGKILL");
        await bystander.exited;
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
}

test("--discard leaves the home and its host alone when the host cannot be identified", async () => {
    await expectUnverifiedHostSurvives("unverified-discard", ["--discard", "--yes"]);
});

test("--fresh on the same build leaves the home and its host alone when the host cannot be identified", async () => {
    await expectUnverifiedHostSurvives("unverified-fresh", ["--fresh", "--yes"]);
});

async function expectInvalidStartTimeSurvives(
    name: string,
    args: readonly string[],
    buildId: (worktree: string) => string,
): Promise<void> {
    const root = mkdtempSync("/tmp/vera-dev-badtime-");
    const worktree = linkedWorktree(name);
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const bystander = spawnVeraLookingProcess(root);
    try {
        await runDevTui([], worktree, { sourceHome, temporaryRoot, spawnTui: async () => 0 });
        const home = candidateHomePath(worktree, temporaryRoot);
        const lockPath = join(home, "runtime", "host.json");
        const sessionPath = join(home, "runtime", "session.jsonl");
        writeFileSync(sessionPath, "kept-session\n");
        writeFileSync(lockPath, JSON.stringify({
            schema_version: 2,
            pid: bystander.pid,
            started_at: "not a timestamp",
            socket_path: join(home, "runtime", "host.sock"),
            build_id: buildId(worktree),
        }));
        let errors = "";
        let launched = false;

        const code = await runDevTui(args, worktree, {
            sourceHome,
            temporaryRoot,
            stderr: { write: (text: string) => errors += text },
            spawnTui: async () => {
                launched = true;
                return 0;
            },
        });

        expect(code).toBe(1);
        expect(errors).toContain(
            `Could not confirm PID ${bystander.pid} is the Vera host (its lockfile`
                + " has no valid start time)",
        );
        expect(launched).toBe(false);
        expect(bystander.signalCode).toBeNull();
        expect(bystander.exitCode).toBeNull();
        expect(existsSync(lockPath)).toBe(true);
        expect(readFileSync(sessionPath, "utf8")).toBe("kept-session\n");
    } finally {
        bystander.kill("SIGKILL");
        await bystander.exited;
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
}

test("--discard keeps the home when the host lockfile has no valid start time", async () => {
    await expectInvalidStartTimeSurvives(
        "badtime-discard", ["--discard", "--yes"], candidateBuildId,
    );
});

test("--fresh keeps the home when the host lockfile has no valid start time", async () => {
    await expectInvalidStartTimeSurvives(
        "badtime-fresh", ["--fresh", "--yes"], candidateBuildId,
    );
});

test("--stop reports a host lockfile with no valid start time and exits nonzero", async () => {
    await expectInvalidStartTimeSurvives(
        "badtime-stop", ["--stop"], candidateBuildId,
    );
});

test("a launch keeps a host of another build whose lockfile has no valid start time", async () => {
    await expectInvalidStartTimeSurvives(
        "badtime-launch", [], () => "vera-old-build",
    );
});

async function expectDamagedLockSurvives(
    name: string,
    args: readonly string[],
    lock: (home: string, hostPid: number) => string,
    expectedError: (hostPid: number, lockPath: string) => string,
): Promise<void> {
    const root = mkdtempSync("/tmp/vera-dev-damaged-");
    const worktree = linkedWorktree(name);
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const bystander = spawnVeraLookingProcess(root);
    try {
        await runDevTui([], worktree, { sourceHome, temporaryRoot, spawnTui: async () => 0 });
        const home = candidateHomePath(worktree, temporaryRoot);
        const lockPath = join(home, "runtime", "host.json");
        const sessionPath = join(home, "runtime", "session.jsonl");
        writeFileSync(sessionPath, "kept-session\n");
        writeFileSync(lockPath, lock(home, bystander.pid));
        let errors = "";
        let launches = 0;

        const code = await runDevTui(args, worktree, {
            sourceHome,
            temporaryRoot,
            stderr: { write: (text: string) => errors += text },
            spawnTui: async () => {
                launches += 1;
                return 0;
            },
        });

        expect(code).toBe(1);
        expect(launches).toBe(0);
        expect(errors).toContain(expectedError(bystander.pid, lockPath));
        expect(errors).not.toContain("No development instance host is running");
        expect(bystander.signalCode).toBeNull();
        expect(bystander.exitCode).toBeNull();
        expect(existsSync(lockPath)).toBe(true);
        expect(readFileSync(sessionPath, "utf8")).toBe("kept-session\n");
    } finally {
        bystander.kill("SIGKILL");
        await bystander.exited;
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
}

test("--stop does not report no host for a lockfile with no readable PID", async () => {
    await expectDamagedLockSurvives(
        "damaged-nopid-stop",
        ["--stop"],
        () => '{ "schema_version": 3, "pid": 51',
        (_pid, lockPath) => `The host lockfile ${lockPath} exists but cannot be read`,
    );
});

test("--discard keeps the home when the host lockfile has no readable PID", async () => {
    await expectDamagedLockSurvives(
        "damaged-nopid-discard",
        ["--discard", "--yes"],
        () => "",
        (_pid, lockPath) => `The host lockfile ${lockPath} exists but cannot be read`,
    );
});

test("--discard keeps the home when a lockfile missing its socket path names a Vera-looking PID", async () => {
    await expectDamagedLockSurvives(
        "damaged-socket-discard",
        ["--discard", "--yes"],
        (_home, pid) => JSON.stringify({
            schema_version: 3,
            pid,
            started_at: new Date().toISOString(),
            build_id: "vera-old",
        }),
        (pid) => `Could not confirm PID ${pid} is the Vera host (its lockfile is damaged)`,
    );
});

test("a launch refuses a damaged lockfile with no readable PID instead of starting over a host", async () => {
    await expectDamagedLockSurvives(
        "damaged-nopid-launch",
        [],
        () => '{ "schema_version": 3, "pid": 51',
        (_pid, lockPath) => `The host lockfile ${lockPath} exists but cannot be read`,
    );
});

test("a launch refuses a cut-off lockfile whose PID is a Vera-looking process", async () => {
    await expectDamagedLockSurvives(
        "damaged-cutoff-launch",
        [],
        (_home, pid) => `{\n  "schema_version": 3,\n  "pid": ${pid},\n  "started_at": "2026-08`,
        (pid) => `Could not confirm PID ${pid} is the Vera host (its lockfile is damaged)`,
    );
});

test("a launch clears a damaged lockfile whose PID has exited and starts the client", async () => {
    const root = mkdtempSync("/tmp/vera-dev-damaged-");
    const worktree = linkedWorktree("damaged-dead-launch");
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    try {
        await runDevTui([], worktree, { sourceHome, temporaryRoot, spawnTui: async () => 0 });
        const home = candidateHomePath(worktree, temporaryRoot);
        const lockPath = join(home, "runtime", "host.json");
        writeFileSync(lockPath, JSON.stringify({ schema_version: 3, pid: 2_000_000_903 }));
        let launches = 0;

        const code = await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot,
            stderr: { write: () => true },
            spawnTui: async () => {
                launches += 1;
                return 0;
            },
        });

        expect(code).toBe(0);
        expect(launches).toBe(1);
        expect(existsSync(lockPath)).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

async function statusAfterWritingLock(
    name: string,
    lock: (home: string) => string,
): Promise<{ report: string; lockPath: string }> {
    const root = mkdtempSync("/tmp/vera-dev-damaged-");
    const worktree = linkedWorktree(name);
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    try {
        await runDevTui([], worktree, { sourceHome, temporaryRoot, spawnTui: async () => 0 });
        const home = candidateHomePath(worktree, temporaryRoot);
        const lockPath = join(home, "runtime", "host.json");
        writeFileSync(lockPath, lock(home));
        const chunks: string[] = [];

        const code = await runDevTui(["--status"], worktree, {
            sourceHome,
            temporaryRoot,
            stdout: { write: (text) => chunks.push(String(text)) },
            spawnTui: async () => {
                throw new Error("status must not launch");
            },
        });

        expect(code).toBe(0);
        return { report: chunks.join(""), lockPath };
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
}

test("--status says the host lockfile is damaged when it names no PID", async () => {
    const { report, lockPath } = await statusAfterWritingLock(
        "status-nopid",
        () => "garbage",
    );

    expect(report).toContain(`Host PID: unknown (the host lockfile ${lockPath} is damaged)`);
    expect(report).not.toContain("Host PID: not running");
});

test("--status keeps the PID of a damaged lockfile and says it is damaged", async () => {
    const { report, lockPath } = await statusAfterWritingLock(
        "status-pid",
        () => JSON.stringify({ schema_version: 3, pid: process.pid }),
    );

    expect(report).toContain(
        `Host PID: ${process.pid} (the host lockfile ${lockPath} is damaged)`,
    );
});

test("--status reports a valid lockfile whose PID has exited as not running", async () => {
    const { report } = await statusAfterWritingLock(
        "status-dead",
        (home) => JSON.stringify({
            schema_version: 3,
            pid: 2_000_000_904,
            started_at: new Date().toISOString(),
            socket_path: join(home, "runtime", "host.sock"),
            build_id: "vera-old",
        }),
    );

    expect(report).toContain("Host PID: not running");
    expect(report).not.toContain("host lockfile");
});

test("the first launch refuses to clone a daily home whose host lockfile is damaged", async () => {
    const root = mkdtempSync("/tmp/vera-dev-damaged-");
    const worktree = linkedWorktree("clone-damaged");
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const lockPath = join(sourceHome, "runtime", "host.json");
    try {
        writeFileSync(lockPath, "garbage");
        let errors = "";
        let launches = 0;

        const code = await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot,
            stderr: { write: (text: string) => errors += text },
            spawnTui: async () => {
                launches += 1;
                return 0;
            },
        });

        expect(code).toBe(1);
        expect(launches).toBe(0);
        expect(errors).toContain(`The host lockfile ${lockPath} exists but cannot be read`);
        expect(existsSync(candidateHomePath(worktree, temporaryRoot))).toBe(false);
        expect(readFileSync(lockPath, "utf8")).toBe("garbage");
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("the first launch clones a daily home whose damaged lockfile names an exited PID", async () => {
    const root = mkdtempSync("/tmp/vera-dev-damaged-");
    const worktree = linkedWorktree("clone-damaged-dead");
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const lockPath = join(sourceHome, "runtime", "host.json");
    try {
        writeFileSync(lockPath, JSON.stringify({ schema_version: 3, pid: 2_000_000_905 }));
        let launches = 0;

        const code = await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot,
            stderr: { write: () => true },
            spawnTui: async () => {
                launches += 1;
                return 0;
            },
        });

        expect(code).toBe(0);
        expect(launches).toBe(1);
        expect(existsSync(candidateHomePath(worktree, temporaryRoot))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("the first launch clones a daily home whose damaged lockfile names a program that is not Vera", async () => {
    const root = mkdtempSync("/tmp/vera-dev-damaged-");
    const worktree = linkedWorktree("clone-damaged-other");
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const lockPath = join(sourceHome, "runtime", "host.json");
    const bystander = Bun.spawn(["sleep", "60"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    try {
        writeFileSync(lockPath, JSON.stringify({ schema_version: 3, pid: bystander.pid }));
        let launches = 0;

        const code = await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot,
            stderr: { write: () => true },
            spawnTui: async () => {
                launches += 1;
                return 0;
            },
        });

        expect(code).toBe(0);
        expect(launches).toBe(1);
        expect(existsSync(candidateHomePath(worktree, temporaryRoot))).toBe(true);
        expect(bystander.exitCode).toBeNull();
    } finally {
        bystander.kill("SIGKILL");
        await bystander.exited;
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("--discard deletes the home when the host lockfile has no valid start time and its PID is not Vera", async () => {
    const root = mkdtempSync("/tmp/vera-dev-stale-");
    const worktree = linkedWorktree("stale-discard");
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const bystander = Bun.spawn(["sleep", "60"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    try {
        await runDevTui([], worktree, { sourceHome, temporaryRoot, spawnTui: async () => 0 });
        const home = candidateHomePath(worktree, temporaryRoot);
        writeFileSync(join(home, "runtime", "host.json"), JSON.stringify({
            schema_version: 2,
            pid: bystander.pid,
            started_at: "not a timestamp",
            socket_path: join(home, "runtime", "host.sock"),
            build_id: candidateBuildId(worktree),
        }));

        const code = await runDevTui(["--discard", "--yes"], worktree, {
            sourceHome,
            temporaryRoot,
            stdout: { write: () => true },
            stderr: { write: () => true },
        });

        expect(code).toBe(0);
        expect(existsSync(home)).toBe(false);
        expect(bystander.signalCode).toBeNull();
        expect(bystander.exitCode).toBeNull();
    } finally {
        bystander.kill("SIGKILL");
        await bystander.exited;
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("leftover root files on a clone move into machine/leftover", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-leftover-"));
    const home = join(root, ".vera");
    mkdirSync(join(home, "machine"), { recursive: true });
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(join(home, "tui.json"), "{}\n");
    writeFileSync(join(home, "whisker"), "stay-out\n");
    writeFileSync(join(home, "notes.md"), "loose\n");
    writeFileSync(join(home, "extensions.json"), "[]\n");
    try {
        mkdirSync(join(home, "hooks"));
        writeFileSync(join(home, "hooks", "greet"), "context");
        quarantineUnknownHomeEntries(home);
        expect(readFileSync(join(home, "hooks", "greet"), "utf8")).toBe("context");
        expect(existsSync(join(home, "tui.json"))).toBe(true);
        // The home owns its extension registry, so it is not a leftover.
        expect(existsSync(join(home, "extensions.json"))).toBe(true);
        expect(existsSync(join(home, "whisker"))).toBe(false);
        expect(existsSync(join(home, "notes.md"))).toBe(false);
        expect(readFileSync(join(home, "machine", "leftover", "whisker"), "utf8"))
            .toBe("stay-out\n");
        expect(readFileSync(
            join(home, "machine", "leftover", "notes.md"),
            "utf8",
        )).toBe("loose\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a root directory named like an installed extension id is a leftover", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-leftover-ext-"));
    const home = join(root, ".vera");
    const manifests = join(home, "extensions");
    mkdirSync(join(manifests, "chrome"), { recursive: true });
    writeFileSync(
        join(manifests, "chrome", "vera.extension.json"),
        JSON.stringify({ id: "vera.chrome", version: "1.0.0" }),
    );
    mkdirSync(join(manifests, ".managed"), { recursive: true });
    writeFileSync(join(manifests, ".managed", "vera.btw.json"), "{}");
    mkdirSync(join(home, "vera.chrome"));
    writeFileSync(join(home, "vera.chrome", "pairing.json"), "{\"old\":true}");
    mkdirSync(join(home, "vera.btw"));
    mkdirSync(join(home, "extension-data", "vera.chrome"), { recursive: true });
    try {
        quarantineUnknownHomeEntries(home);
        expect(existsSync(join(home, "vera.chrome"))).toBe(false);
        expect(existsSync(join(home, "vera.btw"))).toBe(false);
        expect(readFileSync(
            join(home, "machine", "leftover", "vera.chrome", "pairing.json"),
            "utf8",
        )).toBe("{\"old\":true}");
        expect(existsSync(join(home, "machine", "leftover", "vera.btw"))).toBe(true);
        expect(existsSync(join(manifests, "chrome", "vera.extension.json"))).toBe(true);
        expect(existsSync(join(home, "extension-data", "vera.chrome"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a second leftover with the same name gets a unique path", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-leftover-again-"));
    const home = join(root, ".vera");
    mkdirSync(join(home, "machine", "leftover", "Library", "Caches"), {
        recursive: true,
    });
    writeFileSync(join(home, "machine", "leftover", "Library", "first"), "old\n");
    mkdirSync(join(home, "Library", "Caches"), { recursive: true });
    writeFileSync(join(home, "Library", "Caches", "bun"), "new\n");
    try {
        quarantineUnknownHomeEntries(home);
        expect(existsSync(join(home, "Library"))).toBe(false);
        expect(readFileSync(
            join(home, "machine", "leftover", "Library", "first"),
            "utf8",
        )).toBe("old\n");
        expect(readFileSync(
            join(home, "machine", "leftover", "Library-2", "Caches", "bun"),
            "utf8",
        )).toBe("new\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("reusing a worktree preserves its sessions and never writes the daily home", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-reuse");
    const sourceHome = dailyHome(root);
    const deps = {
        sourceHome,
        temporaryRoot: join(root, "instances"),
        spawnTui: async (_args: readonly string[], env: NodeJS.ProcessEnv) => {
            writeFileSync(join(env.VERA_HOME!, "runtime", "session.jsonl"), "candidate\n");
            mkdirSync(join(env.VERA_HOME!, "memory"), { recursive: true });
            writeFileSync(join(env.VERA_HOME!, "memory", "candidate-only"), "mine\n");
            return 0;
        },
    };
    try {
        await runDevTui([], worktree, deps);
        const dailyBefore = readFileSync(join(sourceHome, "runtime", "session.jsonl"), "utf8");
        await runDevTui([], worktree, {
            ...deps,
            spawnTui: async (_args, env) => {
                expect(readFileSync(join(env.VERA_HOME!, "runtime", "session.jsonl"), "utf8"))
                    .toBe("candidate\n");
                expect(readFileSync(join(env.VERA_HOME!, "memory", "candidate-only"), "utf8"))
                    .toBe("mine\n");
                return 0;
            },
        });
        expect(readFileSync(join(sourceHome, "runtime", "session.jsonl"), "utf8"))
            .toBe(dailyBefore);
        expect(existsSync(join(sourceHome, "memory", "candidate-only"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("--fresh does not overwrite without confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-fresh");
    const sourceHome = dailyHome(root);
    const stderr: string[] = [];
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                writeFileSync(join(env.VERA_HOME!, "keep-me"), "yes\n");
                return 0;
            },
        });
        const code = await runDevTui(["--fresh"], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            confirm: async () => false,
            stderr: { write: (text) => stderr.push(String(text)) },
            spawnTui: async () => {
                throw new Error("must not relaunch after a refused refresh");
            },
        });
        expect(code).toBe(0);
        expect(stderr.join("")).toContain("Kept the existing development instance");
        const dest = candidateHomePath(worktree, join(root, "instances"));
        expect(readFileSync(join(dest, "keep-me"), "utf8")).toBe("yes\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("--fresh --yes reclones after confirmation is skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-yes");
    const sourceHome = dailyHome(root);
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                writeFileSync(join(env.VERA_HOME!, "keep-me"), "yes\n");
                return 0;
            },
        });
        await runDevTui(["--fresh", "--yes"], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                expect(existsSync(join(env.VERA_HOME!, "keep-me"))).toBe(false);
                expect(readFileSync(join(env.VERA_HOME!, "runtime", "session.jsonl"), "utf8"))
                    .toBe("daily-session\n");
                return 0;
            },
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("a failed live-host checkpoint refuses the clone", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-ckpt");
    const sourceHome = dailyHome(root);
    writeFileSync(
        join(sourceHome, "runtime", "host.json"),
        JSON.stringify({
            schema_version: 1,
            pid: process.pid,
            started_at: new Date().toISOString(),
            socket_path: join(sourceHome, "runtime", "host.sock"),
        }),
    );
    writeFileSync(join(sourceHome, "runtime", "host.sock"), "socket");
    try {
        await expect(runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            checkpointDaily: async () => {
                throw new Error("checkpoint boom");
            },
            spawnTui: async () => {
                throw new Error("must not launch after a refused clone");
            },
        })).rejects.toThrow("Checkpoint failed; clone refused");
        expect(existsSync(candidateHomePath(worktree, join(root, "instances"))))
            .toBe(false);
        expect(readFileSync(join(sourceHome, "runtime", "session.jsonl"), "utf8"))
            .toBe("daily-session\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("--status reports the candidate home without launching", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-status");
    const chunks: string[] = [];
    try {
        const code = await runDevTui(["--status"], worktree, {
            sourceHome: dailyHome(root),
            temporaryRoot: join(root, "instances"),
            stdout: { write: (text) => chunks.push(String(text)) },
            spawnTui: async () => {
                throw new Error("status must not launch");
            },
        });
        expect(code).toBe(0);
        const report = chunks.join("");
        expect(report).toContain(`Worktree: ${worktree}`);
        expect(report).toContain("Host PID: not running");
        expect(report).toContain(candidateHomePath(worktree, join(root, "instances")));
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("a reused home labels the launch with the worktree's current build", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-rebuild");
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const labels: string[] = [];
    const launch = () => runDevTui([], worktree, {
        sourceHome,
        temporaryRoot,
        spawnTui: async (_args, env) => {
            labels.push(env.VERA_DEV_INSTANCE ?? "");
            return 0;
        },
    });
    try {
        await launch();
        writeFileSync(join(worktree, "tracked"), "edited\n");
        await launch();
        expect(labels[0]).not.toBe(labels[1]);

        const chunks: string[] = [];
        await runDevTui(["--status"], worktree, {
            sourceHome,
            temporaryRoot,
            stdout: { write: (text) => chunks.push(String(text)) },
        });
        expect(labels[1]).toBe(
            `ovu-rebuild ${chunks.join("").match(/^Build: (.+)$/m)?.[1]}`,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
}, 20_000);

test("--discard without confirmation keeps the instance", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-keep");
    const sourceHome = dailyHome(root);
    const stderr: string[] = [];
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async () => 0,
        });
        await runDevTui(["--discard"], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            confirm: async () => false,
            stderr: { write: (text) => stderr.push(String(text)) },
        });
        expect(stderr.join("")).toContain("Kept the development instance");
        expect(existsSync(candidateHomePath(worktree, join(root, "instances"))))
            .toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("--discard removes the instance's registry record, and a declined discard keeps it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-record");
    const sourceHome = dailyHome(root);
    const temporaryRoot = join(root, "instances");
    const devInstanceRoot = join(root, "registry");
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot,
            spawnTui: async () => 0,
        });
        const home = candidateHomePath(worktree, temporaryRoot);
        registerDevInstance({
            source: fileURLToPath(import.meta.url),
            home,
            root: devInstanceRoot,
        });
        const record = devInstancePath(home, devInstanceRoot);

        await runDevTui(["--discard"], worktree, {
            sourceHome,
            temporaryRoot,
            devInstanceRoot,
            confirm: async () => false,
            stderr: { write: () => true },
        });
        expect(existsSync(home)).toBe(true);
        expect(existsSync(record)).toBe(true);

        await runDevTui(["--discard"], worktree, {
            sourceHome,
            temporaryRoot,
            devInstanceRoot,
            confirm: async () => true,
            stdout: { write: () => true },
        });
        expect(existsSync(home)).toBe(false);
        expect(existsSync(record)).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("dropClonedSchedules removes the schedule store and keeps the inbox", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-outbound-"));
    const home = join(root, ".vera");
    mkdirSync(join(home, "runtime"), { recursive: true });
    for (const name of ["schedules.db", "schedules.db-wal", "inbox.db"]) {
        writeFileSync(join(home, "runtime", name), "");
    }
    try {
        dropClonedSchedules(home);
        expect(existsSync(join(home, "runtime", "schedules.db"))).toBe(false);
        expect(existsSync(join(home, "runtime", "schedules.db-wal"))).toBe(false);
        expect(existsSync(join(home, "runtime", "inbox.db"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the default source is the factory home, not the daily home", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-factory");
    const daily = dailyHome(root);
    writeFileSync(join(daily, "runtime", "session.jsonl"), "must-not-clone\n");
    synthesizeFactoryHome(factoryHomePath(worktree));
    try {
        const code = await runDevTui([], worktree, {
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                const dest = env.VERA_HOME!;
                expect(existsSync(join(
                    dest,
                    "runtime",
                    "sessions",
                    `${FACTORY_HELLO_SESSION_ID}.jsonl`,
                ))).toBe(true);
                expect(existsSync(join(dest, "runtime", "session.jsonl"))).toBe(false);
                expect(readFileSync(join(daily, "runtime", "session.jsonl"), "utf8"))
                    .toBe("must-not-clone\n");
                return 0;
            },
        });
        expect(code).toBe(0);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("candidate launch env drops runtime islands, keeps provider keys and names the DEV instance", () => {
    const env = candidateLaunchEnv(
        "/tmp/vera-dev/abc/.vera",
        "/Users/nash/Projects/vera/.worktrees/ovu26",
        "vera-deadbeef",
        {
            VERA_RUNTIME_DIR: "/tmp/old-runtime",
            VERA_WORKTREE_RUNTIME: "/tmp/old-runtime",
            PATH: "/bin",
            OPENROUTER_API_KEY: "sk-or-crows-nest",
        },
    );
    expect(env.VERA_HOME).toBe("/tmp/vera-dev/abc/.vera");
    expect(env.VERA_RUNTIME_DIR).toBeUndefined();
    expect(env.VERA_WORKTREE_RUNTIME).toBeUndefined();
    expect(env.VERA_DEV_INSTANCE).toBe("ovu26 vera-deadbeef");
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-crows-nest");
});

/** A machine with `pids` running against the home. `politely` says whether they stop on SIGTERM; SIGKILL always stops them. */
function machine(pids: readonly number[], politely: boolean) {
    const alive = new Set(pids);
    const signalled: string[] = [];
    return {
        alive,
        signalled,
        processesUsingHome: () => [...alive],
        signalProcess: (pid: number, signal: NodeJS.Signals) => {
            signalled.push(`${signal} ${pid}`);
            if (signal === "SIGKILL" || politely) alive.delete(pid);
        },
    };
}

test("a fresh start clears every process holding the home, not just the one in the lockfile", async () => {
    // The lockfile names one host. Four are running, because each fresh start
    // overwrote the record of the one before it.
    const box = machine([101, 102, 103, 104], true);
    const stderr: string[] = [];
    const code = await evictHome(
        "/tmp/whatever/.vera",
        { write: (text) => stderr.push(String(text)) },
        { ...box, sigtermGraceMs: 50, sigkillGraceMs: 50 },
    );
    expect(code).toBe(0);
    expect(box.alive.size).toBe(0);
    expect(box.signalled).toEqual([
        "SIGTERM 101",
        "SIGTERM 102",
        "SIGTERM 103",
        "SIGTERM 104",
    ]);
    expect(stderr.join("")).toContain("Stopped 4 process(es)");
});

test("a process that ignores the polite signal is killed", async () => {
    const box = machine([201], false);
    const code = await evictHome("/tmp/whatever/.vera", { write: () => {} }, {
        ...box,
        sigtermGraceMs: 50,
        sigkillGraceMs: 50,
    });
    expect(code).toBe(0);
    expect(box.signalled).toEqual(["SIGTERM 201", "SIGKILL 201"]);
});

test("an empty home is evicted silently", async () => {
    const stderr: string[] = [];
    const code = await evictHome(
        "/tmp/whatever/.vera",
        { write: (text) => stderr.push(String(text)) },
        machine([], true),
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
});

test("a survivor stops the fresh start rather than having its home deleted underneath it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-survivor");
    const sourceHome = dailyHome(root);
    const stderr: string[] = [];
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                writeFileSync(join(env.VERA_HOME!, "keep-me"), "yes\n");
                return 0;
            },
        });
        const code = await runDevTui(["--fresh", "--yes"], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            stderr: { write: (text) => stderr.push(String(text)) },
            processesUsingHome: () => [909],
            signalProcess: () => {},
            sigtermGraceMs: 50,
            sigkillGraceMs: 50,
            spawnTui: async () => {
                throw new Error("must not launch over a home someone still holds");
            },
        });
        expect(code).toBe(1);
        expect(stderr.join("")).toContain("Could not stop 1 process(es)");
        const dest = candidateHomePath(worktree, join(root, "instances"));
        expect(readFileSync(join(dest, "keep-me"), "utf8")).toBe("yes\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});
