import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { fileURLToPath } from "node:url";
import { veraHomeDirectory } from "../src/profile-paths.ts";
import { processIsAlive } from "../src/host/process-identity.ts";
import {
    checkListedProcess,
    claimListedProcess,
    dropLiveProcess,
    installLiveProcess,
    listLiveProcesses,
    listLiveProcessesIn,
    liveProcessDirectory,
    liveProcessPath,
    postLiveProcess,
    renderVeraPrune,
    signalListedProcess,
    stopListedLiveProcess,
    type LiveProcessReads,
    type LiveProcessRecord,
} from "../src/live-process.ts";

function tempHome(): string {
    return mkdtempSync(join(tmpdir(), "vera-live-"));
}

test("a posted live process is listed until it is dropped", () => {
    const home = tempHome();
    const record = postLiveProcess("host", {
        home,
        pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        runtimeDir: "/tmp/vera-daily",
    });

    expect(listLiveProcesses(home)).toEqual([record]);
    dropLiveProcess(record.pid, home);
    expect(listLiveProcesses(home)).toEqual([]);
});

test("installLiveProcess titles, posts, and the disposer unlinks", () => {
    const home = tempHome();
    const previous = process.env.VERA_HOME;
    const previousTitle = process.title;
    process.env.VERA_HOME = join(home, ".vera");
    try {
        const dispose = installLiveProcess("tui");
        const listed = listLiveProcesses(home);
        expect(listed).toHaveLength(1);
        expect(listed[0]?.kind).toBe("tui");
        expect(listed[0]?.pid).toBe(process.pid);
        expect(process.title).toBe("vera-tui");
        dispose();
        expect(listLiveProcesses(home)).toEqual([]);
    } finally {
        process.title = previousTitle;
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
    }
});

test("a dead pid is unlinked rather than listed", () => {
    const home = tempHome();
    postLiveProcess("worker", {
        home,
        pid: 999_999_999,
        startedAt: new Date().toISOString(),
        runtimeDir: "/tmp/vera-daily",
    });

    expect(listLiveProcesses(home)).toEqual([]);
    expect(readdirSync(liveProcessDirectory(home))).toEqual([]);
});

test("a live pid whose start time does not match is treated as reuse", () => {
    const home = tempHome();
    postLiveProcess("host", {
        home,
        pid: process.pid,
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        runtimeDir: "/tmp/vera-daily",
    });

    expect(listLiveProcesses(home)).toEqual([]);
});

test("a live pid whose start time cannot be read is not listed and keeps its record", () => {
    const home = tempHome();
    const startedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
    postLiveProcess("host", {
        home,
        pid: process.pid,
        startedAt,
        runtimeDir: "/tmp/vera-daily",
    });

    expect(listLiveProcessesIn(veraHomeDirectory(home), () => undefined)).toEqual([]);
    expect(readdirSync(liveProcessDirectory(home))).toEqual([`${process.pid}.json`]);
    expect(listLiveProcesses(home)).toHaveLength(1);
});

test("a live pid whose measured start time matches is listed", () => {
    const home = tempHome();
    const startedAt = "2026-08-20T12:00:00.000Z";
    const record = postLiveProcess("host", {
        home,
        pid: process.pid,
        startedAt,
        runtimeDir: "/tmp/vera-daily",
    });

    expect(listLiveProcessesIn(
        veraHomeDirectory(home),
        () => Date.parse(startedAt) + 2_000,
    )).toEqual([record]);
});

test("an unreadable live file is dropped so the rest of the board still lists", () => {
    const home = tempHome();
    const directory = liveProcessDirectory(home);
    postLiveProcess("watchdog", {
        home,
        pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        runtimeDir: "/tmp/vera-daily",
    });
    writeFileSync(join(directory, "12.json"), "not json\n");

    const listed = listLiveProcesses(home);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.kind).toBe("watchdog");
    expect(readdirSync(directory).sort()).toEqual([`${process.pid}.json`]);
});

test("renderVeraPrune names origin and the current host", () => {
    const text = renderVeraPrune([
        {
            schema_version: 1,
            pid: 10,
            kind: "host",
            started_at: "2026-08-29T12:00:00.000Z",
            runtime_dir: "/tmp/vera-daily",
        },
        {
            schema_version: 1,
            pid: 11,
            kind: "tui",
            started_at: "2026-08-29T12:00:01.000Z",
            runtime_dir: "/tmp/vera-work",
        },
    ], 10);

    expect(text).toContain("Vera prune");
    expect(text).toContain("PID 10  host          /tmp/vera-daily  current host for this shell");
    expect(text).toContain("PID 11  tui           /tmp/vera-work");
});

test("stopListedLiveProcess kills a real child and drops its row", async () => {
    const home = tempHome();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(home, ".vera");
    let child: ChildProcess | undefined;
    try {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
            detached: true,
        });
        const childPid = child.pid;
        if (childPid === undefined) {
            throw new Error("expected spawn() to assign a pid");
        }
        expect(childPid).toBeGreaterThan(0);
        child.unref();
        postLiveProcess("worker", {
            home,
            pid: childPid,
            startedAt: new Date(Date.now() - 1_000).toISOString(),
            runtimeDir: "/tmp/vera-daily",
        });
        const listed = listLiveProcesses(home);
        expect(listed).toHaveLength(1);
        expect(stopListedLiveProcess(claimListedProcess(listed[0]!))).toBe("stopped");
        const until = Date.now() + 2_000;
        while (Date.now() < until && processIsAlive(childPid)) {
            await Bun.sleep(25);
        }
        expect(processIsAlive(childPid)).toBe(false);
        expect(listLiveProcesses(home)).toEqual([]);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
        const running = child;
        if (
            running !== undefined
            && running.exitCode === null
            && running.signalCode === null
        ) {
            const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
            running.kill("SIGKILL");
            await exited;
        }
    }
});

async function waitForKind(
    home: string,
    kind: "worker" | "supervisor",
    pid: number,
): Promise<void> {
    const until = Date.now() + 3_000;
    while (Date.now() < until) {
        const listed = listLiveProcesses(home);
        if (listed.some((record) => record.pid === pid && record.kind === kind)) {
            return;
        }
        await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${kind} ${pid} to post`);
}

test("a real worker process posts on creation", async () => {
    const home = tempHome();
    const entry = fileURLToPath(
        new URL("../src/host/worker/entry.ts", import.meta.url),
    );
    const child = spawn(process.execPath, [entry], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, VERA_HOME: join(home, ".vera") },
    });
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error("expected spawn() to assign a pid");
    }
    expect(pid).toBeGreaterThan(0);
    try {
        await waitForKind(home, "worker", pid);
        expect(listLiveProcesses(home).map((record) => record.kind)).toEqual([
            "worker",
        ]);
    } finally {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    expect(listLiveProcesses(home)).toEqual([]);
});

test("a real supervisor process posts on creation", async () => {
    const home = tempHome();
    const entry = fileURLToPath(
        new URL("../src/host/worker-supervisor.ts", import.meta.url),
    );
    const child = spawn(process.execPath, [entry], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, VERA_HOME: join(home, ".vera") },
    });
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error("expected spawn() to assign a pid");
    }
    expect(pid).toBeGreaterThan(0);
    try {
        await waitForKind(home, "supervisor", pid);
        expect(listLiveProcesses(home).map((record) => record.kind)).toEqual([
            "supervisor",
        ]);
    } finally {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    expect(listLiveProcesses(home)).toEqual([]);
});

const recordedAt = Date.parse("2026-08-29T12:00:00.000Z");
const hostCommand = "bun /work/vera/clients/host/main.ts";

function listedRecord(pid = 4242): LiveProcessRecord {
    return {
        schema_version: 1,
        pid,
        kind: "worker",
        started_at: new Date(recordedAt).toISOString(),
        runtime_dir: "/tmp/vera-daily",
    };
}

function reads(overrides: LiveProcessReads = {}): LiveProcessReads {
    return {
        isAlive: () => true,
        readStartedAt: () => recordedAt,
        readCommand: () => hostCommand,
        ...overrides,
    };
}

test("a listed process is the same one while its start time and command line still match", () => {
    const listed = claimListedProcess(listedRecord(), reads());
    expect(listed.command).toBe(hostCommand);
    expect(checkListedProcess(listed, reads())).toBe("same");
    expect(checkListedProcess(listed, reads({
        readStartedAt: () => recordedAt + 5_000,
    }))).toBe("same");
});

test("a listed process is gone, replaced or unverified once it stops matching", () => {
    const listed = claimListedProcess(listedRecord(), reads());

    expect(checkListedProcess(listed, reads({ isAlive: () => false }))).toBe("gone");
    expect(checkListedProcess(listed, reads({
        readStartedAt: () => recordedAt + 3_600_000,
    }))).toBe("replaced");
    // The same start time with another program is still a different process.
    expect(checkListedProcess(listed, reads({
        readCommand: () => "/usr/sbin/syslogd",
    }))).toBe("replaced");
    expect(checkListedProcess(listed, reads({
        readStartedAt: () => undefined,
    }))).toBe("unverified");
    expect(checkListedProcess(listed, reads({
        readCommand: () => undefined,
    }))).toBe("unverified");
});

test("a command line that could not be read when listed leaves the start time to decide", () => {
    const listed = claimListedProcess(
        listedRecord(),
        reads({ readCommand: () => undefined }),
    );
    expect(listed.command).toBeUndefined();
    expect(checkListedProcess(listed, reads({
        readCommand: () => "/usr/sbin/syslogd",
    }))).toBe("same");
    expect(checkListedProcess(listed, reads({
        readStartedAt: () => recordedAt + 3_600_000,
    }))).toBe("replaced");
});

function signalLog(): { readonly sent: string[]; readonly kill: LiveProcessReads["kill"] } {
    const sent: string[] = [];
    return { sent, kill: (pid, signal) => { sent.push(`${signal}:${pid}`); } };
}

test("a signal is not sent to a PID that now belongs to another process", () => {
    const listed = claimListedProcess(listedRecord(), reads());
    const log = signalLog();

    expect(signalListedProcess(listed, "SIGTERM", {
        reads: reads({ kill: log.kill, readStartedAt: () => recordedAt + 3_600_000 }),
    })).toBe("replaced");
    expect(signalListedProcess(listed, "SIGKILL", {
        group: true,
        reads: reads({ kill: log.kill, readCommand: () => "/usr/sbin/syslogd" }),
    })).toBe("replaced");
    expect(signalListedProcess(listed, "SIGTERM", {
        reads: reads({ kill: log.kill, readStartedAt: () => undefined }),
    })).toBe("unverified");
    expect(log.sent).toEqual([]);

    expect(signalListedProcess(listed, "SIGTERM", {
        reads: reads({ kill: log.kill }),
    })).toBe("sent");
    expect(signalListedProcess(listed, "SIGKILL", {
        group: true,
        reads: reads({ kill: log.kill }),
    })).toBe("sent");
    expect(log.sent).toEqual(["SIGTERM:4242", "SIGKILL:-4242"]);
});

test("stopListedLiveProcess checks again before the signal to the PID after the one to the group", () => {
    const home = tempHome();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(home, ".vera");
    try {
        postLiveProcess("worker", {
            home,
            pid: 4242,
            startedAt: new Date(recordedAt).toISOString(),
            runtimeDir: "/tmp/vera-daily",
        });
        const listed = claimListedProcess(listedRecord(), reads());
        const sent: string[] = [];
        let reused = false;

        const result = stopListedLiveProcess(listed, reads({
            kill: (pid, signal) => {
                sent.push(`${signal}:${pid}`);
                reused = true;
            },
            readStartedAt: () => reused ? recordedAt + 3_600_000 : recordedAt,
        }));

        expect(result).toBe("stopped");
        expect(sent).toEqual(["SIGKILL:-4242"]);
        expect(existsSync(liveProcessPath(4242, home))).toBe(false);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
    }
});

test("stopListedLiveProcess signals nothing for a replaced PID and drops its stale row", () => {
    const home = tempHome();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(home, ".vera");
    try {
        postLiveProcess("worker", {
            home,
            pid: 4242,
            startedAt: new Date(recordedAt).toISOString(),
            runtimeDir: "/tmp/vera-daily",
        });
        const listed = claimListedProcess(listedRecord(), reads());
        const log = signalLog();

        const result = stopListedLiveProcess(listed, reads({
            kill: log.kill,
            readStartedAt: () => recordedAt + 3_600_000,
        }));

        expect(result).toBe("replaced");
        expect(log.sent).toEqual([]);
        expect(existsSync(liveProcessPath(4242, home))).toBe(false);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
    }
});

test("stopListedLiveProcess keeps the row of a process it could not confirm", () => {
    const home = tempHome();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(home, ".vera");
    try {
        postLiveProcess("worker", {
            home,
            pid: 4242,
            startedAt: new Date(recordedAt).toISOString(),
            runtimeDir: "/tmp/vera-daily",
        });
        const listed = claimListedProcess(listedRecord(), reads());
        const log = signalLog();

        const result = stopListedLiveProcess(listed, reads({
            kill: log.kill,
            readStartedAt: () => undefined,
        }));

        expect(result).toBe("unverified");
        expect(log.sent).toEqual([]);
        expect(existsSync(liveProcessPath(4242, home))).toBe(true);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
    }
});
