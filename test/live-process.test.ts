import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { fileURLToPath } from "node:url";
import { processIsAlive } from "../src/host/process-identity.ts";
import {
    dropLiveProcess,
    installLiveProcess,
    listLiveProcesses,
    liveProcessDirectory,
    postLiveProcess,
    renderVeraPrune,
    stopLivePid,
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

test("stopLivePid kills a real child and drops its row", async () => {
    const home = tempHome();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(home, ".vera");
    let pid: number | undefined;
    try {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
            detached: true,
        });
        pid = child.pid;
        expect(pid).toBeGreaterThan(0);
        child.unref();
        postLiveProcess("worker", {
            home,
            pid,
            startedAt: new Date(Date.now() - 1_000).toISOString(),
            runtimeDir: "/tmp/vera-daily",
        });
        expect(stopLivePid(pid)).toBe(true);
        const until = Date.now() + 2_000;
        while (Date.now() < until && processIsAlive(pid)) {
            await Bun.sleep(25);
        }
        expect(processIsAlive(pid)).toBe(false);
        expect(listLiveProcesses(home)).toEqual([]);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
        if (pid !== undefined) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // Already gone.
            }
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
