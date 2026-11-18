import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runCli } from "../../clients/cli/main.ts";
import { defaultVeraHomeDirectory, veraHomeDirectory } from "../../src/profile-paths.ts";
import { HOST_LOG_TAIL_BYTES } from "../../src/host/reset-backup.ts";
import { clientOwnedWatchdog, discoverResetProcesses, stoppableResetCandidates, veraRoleOf, type ResetProcessSample } from "../../src/host/reset-discovery.ts";
import {
    GRACEFUL_STOP_DEADLINE_MS,
    RESET_CONFIRM_QUESTION,
    runHostReset,
    type ResetDependencies,
    type ResetSystem,
} from "../../src/host/reset.ts";
import { clientLaunchHome, readLaunchVeraHome, type LaunchVeraHome } from "../../src/host/launch-environment.ts";
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

async function setupRoots(): Promise<{ readonly home: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vera-reset-test-")));
    roots.push(root);
    const home = veraHomeDirectory(join(root, "a"));
    await mkdir(home, { recursive: true });
    return { home };
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
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset", userHome: dirname(home) } });
    system.hostAnswer = { socketPath: socketPathIn(home), identity: hostIdentity(HOST_PID), answering: true };
    for (const pid of workerPids) system.add(pid, WORKER_COMMAND, { launch: { state: "set", home } });
    system.add(ANNEX_PID, `${ANNEX_COMMAND} ${home}`, { launch: { state: "unset", userHome: dirname(home) } });
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

test("@core boot and reset leave a live client's old watchdog alone", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    const launch = { state: "set" as const, home };
    system.add(7101, "vera-tui --vera-role=tui", { launch });
    system.add(7102, "vera-watchdog --vera-role=watchdog", { launch });
    system.add(7103, "vera-watchdog --vera-role=watchdog", { launch });
    const isAncestor: NonNullable<ResetDependencies["isAncestor"]> = (pid, options) => pid === 7101 && options.currentPid === 7102;
    const discovery = await discoverResetProcesses(system, { home });
    expect(stoppableResetCandidates(discovery.candidates, isAncestor).map((candidate) => candidate.pid)).toEqual([7103]);
    expect(stoppableResetCandidates(discovery.candidates, () => undefined)).toEqual([]);
    const transcript = newTranscript();
    const result = await runHostReset({ home, assumeYes: true }, makeDeps(system, transcript, { isAncestor }));
    expect(result).toBe(0);
    expect(system.signalLog()).toEqual(["7103 SIGTERM"]);
    expect(system.isAlive(7101)).toBe(true);
    expect(system.isAlive(7102)).toBe(true);
    expect(transcript.out.join("\n")).toContain("client PID 7101, started 2026-11-01T10:00:00.000Z (attached client, left running)");
    expect(transcript.out.join("\n")).toContain("watchdog PID 7102, started 2026-11-01T10:00:00.000Z (watchdog of an attached TUI, left running)");
});

test("@core host reset leaves a watchdog running when client ancestry is unknown", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    const launch = { state: "set" as const, home };
    system.add(7201, "vera-tui --vera-role=tui", { launch });
    system.add(7202, "vera-watchdog --vera-role=watchdog", { launch });
    const isAncestor: NonNullable<ResetDependencies["isAncestor"]> = (pid) => pid === process.pid ? false : undefined;
    const discovery = await discoverResetProcesses(system, { home });
    const watchdog = discovery.candidates.find((candidate) => candidate.pid === 7202);
    if (watchdog === undefined) throw new Error("watchdog was not discovered");
    expect(clientOwnedWatchdog(watchdog, [7201], isAncestor)).toBe(true);
    expect(stoppableResetCandidates(discovery.candidates, isAncestor)).toEqual([]);

    const transcript = newTranscript();
    const result = await runHostReset({ home, assumeYes: true }, makeDeps(system, transcript, { isAncestor }));
    expect(result).toBe(0);
    expect(system.signalLog()).toEqual([]);
    expect(system.isAlive(7201)).toBe(true);
    expect(system.isAlive(7202)).toBe(true);
    expect(transcript.out.join("\n")).toContain("watchdog PID 7202, started 2026-11-01T10:00:00.000Z (watchdog of an attached TUI, left running)");
});

test("@core host reset stops a stuck daily home when the graceful stop never settles", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    addDailyStack(system, home);
    await writeWorkerRecords(home, WORKER_PIDS);
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "s1.jsonl"), "keep\n");
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, assumeYes: true },
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
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(HOST_PID, "bun /opt/vera/clients/host/main.ts", { launch: { state: "unreadable" } });
    system.hostAnswer = { socketPath: socketPathIn(home), identity: hostIdentity(HOST_PID), answering: true };
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, assumeYes: true },
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
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset", userHome: dirname(home) } });
    const transcript = newTranscript();

    const code = await runHostReset({ home, assumeYes: true }, makeDeps(system, transcript));

    expect(code).toBe(0);
    expect(transcript.out.join("")).toContain("proof: default home, no VERA_HOME in its environment");
    expect(system.signalLog()).toEqual([`${HOST_PID} SIGTERM`]);
});

test("default-home proof follows each process HOME, including aliases", async () => {
    const { home } = await setupRoots();
    const userHome = dirname(home);
    const alias = join(dirname(userHome), "alias");
    await symlink(userHome, alias);
    const system = new FakeResetSystem();
    system.add(7101, HOST_COMMAND, { launch: { state: "unset", userHome } });
    system.add(7102, HOST_COMMAND, { launch: { state: "unset", userHome: `${userHome}/` } });
    system.add(7103, HOST_COMMAND, { launch: { state: "unset", userHome: alias } });
    system.add(7104, HOST_COMMAND, { launch: { state: "unset" } });
    system.add(7105, HOST_COMMAND, { launch: { state: "unset" }, sockets: [socketPathIn(home)] });
    system.add(7106, HOST_COMMAND, { launch: { state: "unset", userHome: "" } });
    system.add(7107, HOST_COMMAND, { launch: { state: "unreadable" }, sockets: [socketPathIn(home)] });

    for (const selectedHome of [home, veraHomeDirectory(alias)]) {
        const discovery = await discoverResetProcesses(system, { home: selectedHome });
        expect(discovery.candidates.map(({ pid, proof }) => ({ pid, proof }))).toEqual([
            { pid: 7101, proof: "default_home" },
            { pid: 7102, proof: "default_home" },
            { pid: 7103, proof: "default_home" },
            { pid: 7105, proof: "socket_holder" },
            { pid: 7107, proof: "socket_holder" },
        ]);
    }
});

test("@core launch home reads the child environment and preserves the client raw value", async () => {
    const { home } = await setupRoots();
    const userHome = dirname(home);
    const cases: Array<{
        env: Record<string, string>;
        expected: LaunchVeraHome;
        clientHome?: string;
    }> = [
        { env: { HOME: userHome }, expected: { state: "unset", userHome } },
        { env: { HOME: userHome, VERA_HOME: home }, expected: { state: "set", home }, clientHome: home },
        { env: { HOME: userHome, VERA_HOME: "   " }, expected: { state: "unset", userHome }, clientHome: "   " },
        { env: { HOME: userHome, VERA_HOME: "" }, expected: { state: "unset", userHome }, clientHome: "" },
        { env: {}, expected: { state: "unset" } },
        { env: { HOME: "" }, expected: { state: "unset" } },
    ];

    for (const scenario of cases) {
        // macOS can return an empty launch environment for platform binaries.
        const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
            env: scenario.env, stdout: "ignore", stderr: "ignore",
        });
        try {
            await Bun.sleep(30);
            expect(child.exitCode).toBeNull();
            const launch = readLaunchVeraHome(child.pid);
            expect(launch).toEqual(scenario.expected);
            expect(clientLaunchHome(child.pid)).toBe(scenario.clientHome);
            if (scenario.env.VERA_HOME === "   ") {
                const system = new FakeResetSystem();
                system.add(HOST_PID, HOST_COMMAND, { launch });
                const discovery = await discoverResetProcesses(system, { home });
                expect(discovery.candidates.map(({ pid, proof }) => ({ pid, proof }))).toEqual([
                    { pid: HOST_PID, proof: "default_home" },
                ]);
            }
        } finally {
            if (child.exitCode === null) child.kill();
            await child.exited;
        }
    }
});

test("@core reset does not claim or signal a process with another HOME and no VERA_HOME", async () => {
    const probeRoot = process.env.VERA_RESET_HOME_PROBE;
    if (probeRoot === undefined) {
        const root = await realpath(await mkdtemp(join(tmpdir(), "vera-reset-other-home-")));
        roots.push(root);
        const selectedUserHome = join(root, "a");
        const home = veraHomeDirectory(selectedUserHome);
        await mkdir(home, { recursive: true });
        const child = Bun.spawn([
            process.execPath, "test", import.meta.path, "--test-name-pattern",
            "reset does not claim or signal a process with another HOME",
        ], {
            env: { ...process.env, HOME: selectedUserHome, VERA_HOME: home, VERA_RESET_HOME_PROBE: root },
            stdout: "pipe", stderr: "pipe",
        });
        try {
            const [code, stdout, stderr] = await Promise.all([
                child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
            ]);
            expect(code, `${stdout}\n${stderr}`).toBe(0);
        } finally {
            if (child.exitCode === null) child.kill();
            await child.exited;
        }
        return;
    }

    const selectedUserHome = join(probeRoot, "a");
    const otherUserHome = join(probeRoot, "b");
    const home = veraHomeDirectory(selectedUserHome);
    const system = new FakeResetSystem();
    const launch = { state: "unset" as const, userHome: otherUserHome };
    system.add(HOST_PID, HOST_COMMAND, { launch });
    const transcript = newTranscript();

    expect(defaultVeraHomeDirectory()).toBe(home);
    const discovery = await discoverResetProcesses(system, { home });
    const code = await runHostReset({ home, assumeYes: true }, makeDeps(system, transcript));

    expect(system.signals).toEqual([]);
    expect(discovery.candidates).toEqual([]);
    expect(code).toBe(0);
    expect(transcript.out.join("")).not.toContain(`PID ${HOST_PID}`);
    expect(system.isAlive(HOST_PID)).toBe(true);
});

test("a process whose VERA_HOME names another home is never signalled", async () => {
    const { home } = await setupRoots();
    const otherHome = join(home, "..", "other-home");
    const system = new FakeResetSystem();
    system.add(7001, "bun /opt/vera/src/host/worker/entry.ts", { launch: { state: "set", home: otherHome } });
    system.add(7002, WORKER_COMMAND, { launch: { state: "set", home } });
    const transcript = newTranscript();

    const code = await runHostReset({ home, assumeYes: true }, makeDeps(system, transcript));

    expect(code).toBe(0);
    expect(system.signalLog()).toEqual(["7002 SIGTERM"]);
    expect(transcript.out.join("")).not.toContain("PID 7001");
    expect(system.isAlive(7001)).toBe(true);
});

test("a reused pid is not signalled when its start time changes after discovery", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset", userHome: dirname(home) } });
    system.add(ANNEX_PID, `${ANNEX_COMMAND} ${home}`, { launch: { state: "unset", userHome: dirname(home) } });
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, assumeYes: false },
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
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset", userHome: dirname(home) } });
    system.hostAnswer = { socketPath: socketPathIn(home), identity: hostIdentity(HOST_PID), answering: true };
    const identities: { pid: number; started_at: string }[] = [];
    const requester = { pid: 123, client_kind: "cli", command: "host reset" };
    let receivedRequester: unknown;
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, assumeYes: false, requester },
        makeDeps(system, transcript, {
            confirm: async () => {
                if (system.hostAnswer !== undefined) system.hostAnswer.answering = false;
                return true;
            },
            requestStop: async (_socketPath, identity, _waiting, origin) => {
                identities.push({ pid: identity.pid, started_at: identity.started_at });
                receivedRequester = origin;
                throw new Error("socket closed");
            },
        }),
    );

    expect(code).toBe(0);
    expect(identities).toEqual([{ pid: HOST_PID, started_at: START }]);
    expect(receivedRequester).toEqual(requester);
    expect(transcript.out.join("")).toContain("The host stop request failed: socket closed.");
    expect(system.signalLog()).toEqual([`${HOST_PID} SIGTERM`]);
});

test("a host that accepts the graceful stop and exits receives no SIGTERM", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    addDailyStack(system, home, [5001]);
    const transcript = newTranscript();

    const code = await runHostReset(
        { home, assumeYes: true },
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
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset", userHome: dirname(home) } });
    system.hostAnswer = { socketPath: socketPathIn(home), identity: hostIdentity(HOST_PID), answering: true };
    const transcript = newTranscript();
    let requests = 0;

    const code = await runHostReset(
        { home, assumeYes: true },
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
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(8001, "bun /opt/vera/src/host/worker/entry.ts", { launch: { state: "unreadable" } });
    await writeWorkerRecords(home, [8001]);
    const transcript = newTranscript();

    const code = await runHostReset({ home, assumeYes: true }, makeDeps(system, transcript));

    expect(code).toBe(1);
    expect(transcript.err.join("")).toContain("PID 8001 could not be proven to belong to this home");
    expect(system.signals).toEqual([]);
    expect(existsSync(join(home, "runtime", "backups"))).toBe(false);
});

test("an empty home reports nothing to reset and exits 0", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    const transcript = newTranscript();

    const code = await runHostReset({ home, assumeYes: false }, makeDeps(system, transcript));

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
        { home, assumeYes: false },
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
    system.add(HOST_PID, HOST_COMMAND, { launch: { state: "unset", userHome: dirname(home) } });
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

    const code = await runHostReset({ home, assumeYes: true }, makeDeps(system, transcript));

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

test("runtime paths resolve under the selected home", async () => {
    const { home } = await setupRoots();
    const homes = [home, join(dirname(home), "other-home")];

    for (const selectedHome of homes) {
        const discovery = await discoverResetProcesses(new FakeResetSystem(), { home: selectedHome });
        expect(discovery.home).toBe(selectedHome);
        expect(discovery.runtime).toBe(join(selectedHome, "runtime"));
        expect(discovery.socketPath).toBe(join(selectedHome, "runtime", "host.sock"));
        expect(discovery.runtime).not.toBe(join(selectedHome, ".vera", "runtime"));
    }
});

test("discovery skips the reset's own process", async () => {
    const { home } = await setupRoots();
    const system = new FakeResetSystem();
    system.add(7001, "bun clients/cli/main.ts host reset --yes --vera-role=cli", { launch: { state: "unset", userHome: dirname(home) } });
    system.add(7002, "vera --vera-role=tui", { launch: { state: "unset", userHome: dirname(home) } });

    const discovery = await discoverResetProcesses(system, { home, selfPid: 7001 });
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

test("a host or worker started under its argv0 name is recognised", () => {
    expect(veraRoleOf("vera-host /Users/a/vera/clients/host/main.ts")).toBe("host");
    expect(veraRoleOf("vera-host --pool")).toBe("host");
    expect(veraRoleOf("vera-worker --worker-index 0")).toBe("worker");
    expect(veraRoleOf("grep vera-host")).toBeUndefined();
});
