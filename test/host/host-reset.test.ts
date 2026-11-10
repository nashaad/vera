import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../clients/cli/main.ts";
import { HOST_LOG_TAIL_BYTES } from "../../src/host/reset-backup.ts";
import { discoverResetProcesses, type ResetProcessSample } from "../../src/host/reset-discovery.ts";
import {
    GRACEFUL_STOP_DEADLINE_MS,
    RESET_CONFIRM_QUESTION,
    runHostReset,
    type ResetDependencies,
    type ResetSystem,
} from "../../src/host/reset.ts";
import type { LaunchVeraHome } from "../../src/host/launch-environment.ts";
import type { HostIdentity, HostStopResult } from "../../src/host/protocol.ts";

const START = "2026-11-01T10:00:00.000Z";
const START_MS = Date.parse(START);
const NOW = new Date("2026-11-10T12:00:00.000Z");
const HOST_PID = 4001;
const ANNEX_PID = 6001;
const WORKER_PIDS = [5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009];
const HOST_COMMAND = "host --vera-role=host";
const WORKER_COMMAND = "session-worker --vera-role=session-worker";
const ANNEX_COMMAND = "vera-annex --vera-role=annex --home";

interface FakeProcess {
    readonly command: string;
    startedAt: number;
    launch: LaunchVeraHome;
    sockets: readonly string[];
    alive: boolean;
}

interface HostAnswer {
    readonly socketPath: string;
    readonly identity: HostIdentity;
    answering: boolean;
}

// A process table and a signal log. Nothing here touches the OS.
class FakeResetSystem implements ResetSystem {
    readonly processes = new Map<number, FakeProcess>();
    readonly signals: { readonly pid: number; readonly signal: "SIGTERM" | "SIGKILL" }[] = [];
    hostAnswer: HostAnswer | undefined;

    add(pid: number, command: string, options: Partial<Omit<FakeProcess, "command">> = {}): void {
        this.processes.set(pid, {
            command,
            startedAt: START_MS,
            launch: { state: "unreadable" },
            sockets: [],
            alive: true,
            ...options,
        });
    }

    exit(pid: number): void {
        const process = this.processes.get(pid);
        if (process !== undefined) process.alive = false;
    }

    setStartedAt(pid: number, startedAt: number): void {
        const process = this.processes.get(pid);
        if (process !== undefined) process.startedAt = startedAt;
    }

    listProcesses(): readonly ResetProcessSample[] {
        return [...this.processes].map(([pid, process]) => ({ pid, command: process.command }));
    }

    launchHome(pid: number): LaunchVeraHome {
        return this.processes.get(pid)?.launch ?? { state: "unreadable" };
    }

    startedAt(pid: number): number | undefined {
        return this.processes.get(pid)?.startedAt;
    }

    unixSocketPaths(pid: number): readonly string[] {
        return this.processes.get(pid)?.sockets ?? [];
    }

    async hostIdentity(socketPath: string): Promise<HostIdentity | undefined> {
        const answer = this.hostAnswer;
        return answer !== undefined && answer.answering && answer.socketPath === socketPath ? answer.identity : undefined;
    }

    isAlive(pid: number): boolean {
        return this.processes.get(pid)?.alive ?? false;
    }

    commandOf(pid: number): string | undefined {
        return this.processes.get(pid)?.command;
    }

    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
        this.signals.push({ pid, signal });
        const process = this.processes.get(pid);
        if (process !== undefined) process.alive = false;
    }

    wait(): Promise<void> {
        return Promise.resolve();
    }

    signalLog(): string[] {
        return this.signals.map((entry) => `${entry.pid} ${entry.signal}`);
    }
}

interface Transcript {
    readonly out: string[];
    readonly err: string[];
    readonly questions: string[];
}

const roots: string[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setupRoots(): Promise<{ readonly home: string; readonly defaultHome: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vera-reset-test-")));
    roots.push(root);
    const home = join(root, "vera-home");
    const defaultHome = join(root, "default-home");
    await mkdir(home, { recursive: true });
    await mkdir(defaultHome, { recursive: true });
    return { home, defaultHome };
}

function newTranscript(): Transcript {
    return { out: [], err: [], questions: [] };
}

async function refusingStop(): Promise<HostStopResult> {
    return { type: "no_answer" };
}

function makeDeps(
    system: FakeResetSystem,
    transcript: Transcript,
    overrides: Partial<ResetDependencies> = {},
): ResetDependencies {
    return {
        system,
        confirm: async (question) => {
            transcript.questions.push(question);
            return true;
        },
        output: (text) => { transcript.out.push(text); },
        errorOutput: (text) => { transcript.err.push(text); },
        now: () => NOW,
        requestStop: refusingStop,
        listTurns: async () => [],
        termPolls: 3,
        killPolls: 3,
        gracefulDeadlineMs: 5,
        pollMs: 1,
        ...overrides,
    };
}

function hostIdentity(pid: number): HostIdentity {
    return { pid, started_at: START, protocol_version: 37, build_id: "build-a" };
}

function socketPathIn(home: string): string {
    return join(home, "runtime", "host.sock");
}

// The daily-home shape: a host answering on its socket, workers launched with this home, and an annex.
function addDailyStack(system: FakeResetSystem, home: string, workerPids: readonly number[] = WORKER_PIDS): void {
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset" } });
    system.hostAnswer = { socketPath: socketPathIn(home), identity: hostIdentity(HOST_PID), answering: true };
    for (const pid of workerPids) system.add(pid, WORKER_COMMAND, { launch: { state: "set", home } });
    system.add(ANNEX_PID, `${ANNEX_COMMAND} ${home}`, { launch: { state: "unset" } });
}

async function writeWorkerRecords(home: string, pids: readonly number[]): Promise<void> {
    const directory = join(home, "runtime", "workers");
    await mkdir(directory, { recursive: true });
    for (const [index, pid] of pids.entries()) {
        await writeFile(join(directory, `worker-${index}.json`), JSON.stringify({
            id: `worker-${index}`,
            pid,
            started_at: START,
            generation: 3,
        }));
    }
}

async function writeHostLock(home: string, pid: number): Promise<void> {
    await mkdir(join(home, "runtime"), { recursive: true });
    await writeFile(join(home, "runtime", "host.json"), JSON.stringify({
        schema_version: 3,
        pid,
        started_at: START,
        socket_path: socketPathIn(home),
        build_id: "build-a",
    }));
}

async function backupDirs(home: string): Promise<string[]> {
    const names = await readdir(join(home, "runtime", "backups")).catch(() => [] as string[]);
    return names.filter((name) => name.startsWith("reset-"));
}

async function jsonNames(directory: string): Promise<string[]> {
    const names = await readdir(directory).catch(() => [] as string[]);
    return names.filter((name) => name.endsWith(".json"));
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
    const entries = await readdir(join(root, prefix), { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) files.push(...await filesUnder(root, relative));
        else files.push(relative);
    }
    return files.sort();
}

test("@core host reset stops a stuck daily home when the graceful stop never settles", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    addDailyStack(system, home);
    await writeWorkerRecords(home, WORKER_PIDS);
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "s1.jsonl"), "keep\n");
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, defaultHome: home, assumeYes: true },
        makeDeps(system, transcript, { requestStop: () => new Promise<HostStopResult>(() => {}) }),
    );

    expect(code).toBe(0);
    expect(transcript.out.join("")).toContain("The host did not stop within 0 s. Falling back to SIGTERM and SIGKILL.");
    const allPids = [HOST_PID, ANNEX_PID, ...WORKER_PIDS].sort((a, b) => a - b);
    expect(system.signals.map((entry) => entry.pid).sort((a, b) => a - b)).toEqual(allPids);
    expect(system.signals.every((entry) => entry.signal === "SIGTERM")).toBe(true);
    expect(await backupDirs(home)).toHaveLength(1);
    expect(await jsonNames(join(home, "runtime", "workers"))).toEqual([]);
    expect(await readFile(join(home, "sessions", "s1.jsonl"), "utf8")).toBe("keep\n");
});

test("host is proven by its socket answer when its launch environment is unreadable", async () => {
    const { home, defaultHome } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(HOST_PID, "bun /opt/vera/clients/host/main.ts", { launch: { state: "unreadable" } });
    system.hostAnswer = { socketPath: socketPathIn(home), identity: hostIdentity(HOST_PID), answering: true };
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, defaultHome, assumeYes: true },
        makeDeps(system, transcript, {
            requestStop: async () => {
                system.exit(HOST_PID);
                return { type: "accepted" } as const;
            },
        }),
    );

    expect(code).toBe(0);
    const out = transcript.out.join("");
    expect(out).toContain("proof: answers on this home's host socket");
    expect(out).toContain(`Stopped host PID ${HOST_PID}.`);
    expect(system.signals).toEqual([]);
});

test("host is proven by the default-home rule when its launch environment has no VERA_HOME", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset" } });
    const transcript = newTranscript();

    const code = await runHostReset({ home, defaultHome: home, assumeYes: true }, makeDeps(system, transcript));

    expect(code).toBe(0);
    expect(transcript.out.join("")).toContain("proof: default home, no VERA_HOME in its environment");
    expect(system.signalLog()).toEqual([`${HOST_PID} SIGTERM`]);
});

test("a process whose VERA_HOME names another home is never signalled", async () => {
    const { home, defaultHome } = await setupRoots();
    const otherHome = join(home, "..", "other-home");
    const system = new FakeResetSystem();
    system.add(7001, "bun /opt/vera/src/host/worker/entry.ts", { launch: { state: "set", home: otherHome } });
    system.add(7002, WORKER_COMMAND, { launch: { state: "set", home } });
    const transcript = newTranscript();

    const code = await runHostReset({ home, defaultHome, assumeYes: true }, makeDeps(system, transcript));

    expect(code).toBe(0);
    expect(system.signalLog()).toEqual(["7002 SIGTERM"]);
    expect(transcript.out.join("")).not.toContain("PID 7001");
    expect(system.isAlive(7001)).toBe(true);
});

test("a reused pid is not signalled when its start time changes after discovery", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset" } });
    system.add(ANNEX_PID, `${ANNEX_COMMAND} ${home}`, { launch: { state: "unset" } });
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, defaultHome: home, assumeYes: false },
        makeDeps(system, transcript, {
            confirm: async () => {
                system.setStartedAt(HOST_PID, START_MS + 3 * 60 * 60 * 1000);
                return true;
            },
        }),
    );

    expect(code).toBe(0);
    expect(system.signalLog()).toEqual([`${ANNEX_PID} SIGTERM`]);
    expect(transcript.out.join("")).not.toContain(`Stopped host PID ${HOST_PID}`);
});

test("signals go by the pinned pid and start time when the host socket stops answering", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset" } });
    system.hostAnswer = { socketPath: socketPathIn(home), identity: hostIdentity(HOST_PID), answering: true };
    const identities: { pid: number; started_at: string }[] = [];
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, defaultHome: home, assumeYes: false },
        makeDeps(system, transcript, {
            confirm: async () => {
                if (system.hostAnswer !== undefined) system.hostAnswer.answering = false;
                return true;
            },
            requestStop: async (_socketPath, identity) => {
                identities.push({ pid: identity.pid, started_at: identity.started_at });
                throw new Error("socket closed");
            },
        }),
    );

    expect(code).toBe(0);
    expect(identities).toEqual([{ pid: HOST_PID, started_at: START }]);
    expect(transcript.out.join("")).toContain("The host stop request failed: socket closed.");
    expect(system.signalLog()).toEqual([`${HOST_PID} SIGTERM`]);
});

test("a host that accepts the graceful stop and exits receives no SIGTERM", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    addDailyStack(system, home, [5001]);
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, defaultHome: home, assumeYes: true },
        makeDeps(system, transcript, {
            requestStop: async () => {
                system.exit(HOST_PID);
                return { type: "accepted" } as const;
            },
        }),
    );

    expect(code).toBe(0);
    expect(system.signals.some((entry) => entry.pid === HOST_PID)).toBe(false);
    expect(system.signalLog()).toEqual(expect.arrayContaining(["5001 SIGTERM", `${ANNEX_PID} SIGTERM`]));
    expect(transcript.out.join("")).toContain(`Stopped host PID ${HOST_PID}.`);
});

test("a host that refuses the graceful stop falls back to SIGTERM on the pinned host", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset" } });
    system.hostAnswer = { socketPath: socketPathIn(home), identity: hostIdentity(HOST_PID), answering: true };
    const transcript = newTranscript();
    let requests = 0;

    const code = await runHostReset(
        { home, defaultHome: home, assumeYes: true },
        makeDeps(system, transcript, {
            requestStop: async () => {
                requests++;
                return { type: "refused", reason: "stop_pending", message: "Turns are still running" } as const;
            },
        }),
    );

    expect(code).toBe(0);
    expect(requests).toBe(1);
    expect(transcript.out.join("")).toContain(
        "The host refused the stop: Turns are still running. Falling back to SIGTERM and SIGKILL.",
    );
    expect(system.signalLog()).toEqual([`${HOST_PID} SIGTERM`]);
});

test("an unproven live worker record stops the reset before any signal or backup", async () => {
    const { home, defaultHome } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(8001, "bun /opt/vera/src/host/worker/entry.ts", { launch: { state: "unreadable" } });
    await writeWorkerRecords(home, [8001]);
    const transcript = newTranscript();

    const code = await runHostReset({ home, defaultHome, assumeYes: true }, makeDeps(system, transcript));

    expect(code).toBe(1);
    expect(transcript.err.join("")).toContain("PID 8001 could not be proven to belong to this home");
    expect(system.signals).toEqual([]);
    expect(existsSync(join(home, "runtime", "backups"))).toBe(false);
});

test("an empty home reports nothing to reset and exits 0", async () => {
    const { home, defaultHome } = await setupRoots();
    const system = new FakeResetSystem();
    const transcript = newTranscript();

    const code = await runHostReset({ home, defaultHome, assumeYes: false }, makeDeps(system, transcript));

    expect(code).toBe(0);
    expect(transcript.out.join("")).toContain("Nothing to reset");
    expect(transcript.questions).toEqual([]);
    expect(system.signals).toEqual([]);
});

test("a declined confirmation signals nothing and writes no backup", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    addDailyStack(system, home, [5001]);
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, defaultHome: home, assumeYes: false },
        makeDeps(system, transcript, { confirm: async (question) => {
            transcript.questions.push(question);
            return false;
        } }),
    );

    expect(code).toBe(0);
    expect(transcript.questions).toEqual([RESET_CONFIRM_QUESTION]);
    expect(transcript.out.join("")).toContain("Vera host reset was not run.");
    expect(system.signals).toEqual([]);
    expect(existsSync(join(home, "runtime", "backups"))).toBe(false);
});

test("the backup keeps runtime records and the host log tail, and copies no sessions", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset" } });
    await writeHostLock(home, HOST_PID);
    await writeWorkerRecords(home, [5001]);
    system.add(5001, WORKER_COMMAND, { launch: { state: "set", home } });
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "s1.jsonl"), "SESSION BODY\n");
    await mkdir(join(home, "runtime", "logs"), { recursive: true });
    const logLines: string[] = [];
    for (let index = 0; index < 5000; index++) {
        logLines.push(`line-${String(index).padStart(5, "0")} ${"x".repeat(80)}`);
    }
    const logPath = join(home, "runtime", "logs", "host.jsonl");
    await writeFile(logPath, `${logLines.join("\n")}\n`);
    const transcript = newTranscript();

    const code = await runHostReset({ home, defaultHome: home, assumeYes: true }, makeDeps(system, transcript));

    expect(code).toBe(0);
    const [backupName] = await backupDirs(home);
    expect(backupName).toBeDefined();
    const backup = join(home, "runtime", "backups", backupName!);
    expect(await filesUnder(backup)).toEqual([
        "host.json",
        "logs/host.jsonl",
        "processes.json",
        "workers/worker-0.json",
    ]);

    const tail = await readFile(join(backup, "logs", "host.jsonl"), "utf8");
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(HOST_LOG_TAIL_BYTES);
    expect(tail.endsWith(`line-04999 ${"x".repeat(80)}\n`)).toBe(true);
    expect(tail.split("\n")[0]).toMatch(/^line-\d{5} x{80}$/);
    expect((await stat(logPath)).size).toBeGreaterThan(HOST_LOG_TAIL_BYTES);

    const processes = JSON.parse(await readFile(join(backup, "processes.json"), "utf8")) as {
        home: string;
        candidates: { pid: number }[];
    };
    expect(processes.home).toBe(home);
    expect(processes.candidates.map((candidate) => candidate.pid).sort()).toEqual([5001, HOST_PID].sort());
    expect(await readFile(join(home, "sessions", "s1.jsonl"), "utf8")).toBe("SESSION BODY\n");
});

test("runtime paths resolve under the home, both for the default home and for another home", async () => {
    const { home, defaultHome } = await setupRoots();

    for (const options of [{ home, defaultHome: home }, { home, defaultHome }]) {
        const discovery = await discoverResetProcesses(new FakeResetSystem(), options);
        expect(discovery.home).toBe(home);
        expect(discovery.runtime).toBe(join(home, "runtime"));
        expect(discovery.socketPath).toBe(join(home, "runtime", "host.sock"));
        expect(discovery.runtime).not.toBe(join(home, ".vera", "runtime"));
    }
});

test("discovery skips the reset's own process", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(7001, "bun clients/cli/main.ts host reset --yes --vera-role=cli", { launch: { state: "unset" } });
    system.add(7002, "vera --vera-role=tui", { launch: { state: "unset" } });

    const discovery = await discoverResetProcesses(system, { home, defaultHome: home, selfPid: 7001 });
    expect(discovery.candidates.map((candidate) => candidate.pid)).toEqual([7002]);
});

test("the default graceful stop deadline is 30 seconds", () => {
    expect(GRACEFUL_STOP_DEADLINE_MS).toBe(30_000);
});

test("vera host reset refuses without a terminal or --yes and runs nothing", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls: { assumeYes: boolean }[] = [];

    const code = await runCli(["host", "reset"], {
        hostResetInteractive: false,
        stdout: { write: (text: string) => { stdout.push(text); return true; } },
        stderr: { write: (text: string) => { stderr.push(text); return true; } },
        hostReset: async (options) => {
            calls.push({ assumeYes: options.assumeYes });
            return 0;
        },
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(stderr.join("")).toContain("--yes");
});

test("vera host reset --yes runs the reset with assumeYes", async () => {
    const calls: { assumeYes: boolean }[] = [];

    const code = await runCli(["host", "reset", "--yes"], {
        hostResetInteractive: false,
        stdout: { write: () => true },
        stderr: { write: () => true },
        hostReset: async (options) => {
            calls.push({ assumeYes: options.assumeYes });
            return 0;
        },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ assumeYes: true }]);
});

test("vera host reset in a terminal asks instead of assuming yes", async () => {
    const calls: { assumeYes: boolean }[] = [];

    const code = await runCli(["host", "reset"], {
        hostResetInteractive: true,
        stdout: { write: () => true },
        stderr: { write: () => true },
        hostReset: async (options) => {
            calls.push({ assumeYes: options.assumeYes });
            return 0;
        },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ assumeYes: false }]);
});
