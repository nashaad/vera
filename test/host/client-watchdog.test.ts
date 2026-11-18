import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clientFlightPaths } from "../../src/client-flight-paths.ts";
import { heartbeatAge, startClientWatchdog, type ClientWatchdog } from "../../src/host/client-watchdog.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { dropLiveProcessIn, liveProcessDirectoryIn, postLiveProcessIn } from "../../src/live-process.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const homes: string[] = [];
const watchdogs: ClientWatchdog[] = [];
const epoch = Date.parse("2026-11-18T00:00:00.000Z");

afterEach(() => {
    for (const watchdog of watchdogs.splice(0)) watchdog.close();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
    const directory = join(tmpdir(), "vera-dev");
    mkdirSync(directory, { recursive: true });
    const home = mkdtempSync(join(directory, "client-watchdog-"));
    homes.push(home);
    return home;
}

function instance(index: number): string {
    return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function seed(home: string, pid: number, id: string, startedAt = epoch): ReturnType<typeof clientFlightPaths> {
    const runtimeDir = join(home, "runtime");
    const paths = clientFlightPaths(runtimeDir, id);
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.logPath, `${JSON.stringify({ type: "client_started", pid, instanceId: id })}\n`);
    writeFileSync(paths.heartbeatPath, new Date(epoch).toISOString());
    postLiveProcessIn(home, "tui", {
        pid, startedAt: new Date(startedAt).toISOString(), runtimeDir, clientInstanceId: id,
    });
    return paths;
}

function entries(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("@core host records stalled, recovered and unavailable heartbeats once per transition", () => {
    const home = tempHome();
    const paths = seed(home, 12_345, instance(1));
    let time = epoch;
    let identityChecks = 0;
    const watchdog = startClientWatchdog(home, {
        now: () => time,
        isAlive: () => true,
        identity: () => { identityChecks += 1; return "match"; },
        intervalMs: 1_000_000,
    });
    watchdogs.push(watchdog);
    time += 6_000;
    watchdog.scan();
    watchdog.scan();
    writeFileSync(paths.heartbeatPath, new Date(time).toISOString());
    watchdog.scan();
    rmSync(paths.heartbeatPath);
    watchdog.scan();
    watchdog.scan();
    writeFileSync(paths.heartbeatPath, new Date(time).toISOString());
    watchdog.scan();
    time += 5_000;
    watchdog.scan();

    expect(entries(paths.logPath).map((entry) => entry.type)).toEqual([
        "client_started", "client_heartbeat_stalled", "client_heartbeat_recovered",
        "client_heartbeat_unavailable", "client_heartbeat_recovered",
    ]);
    expect(entries(paths.logPath)[1]).toMatchObject({ pid: 12_345, instanceId: instance(1), ageMs: 6_000 });
    expect(identityChecks).toBe(1);
});

test("@core host records a killed client and removes its real live record", async () => {
    const home = tempHome();
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, VERA_HOME: home },
    });
    const paths = seed(home, child.pid, instance(2), Date.now());
    writeFileSync(paths.heartbeatPath, new Date().toISOString());
    const watchdog = startClientWatchdog(home, { intervalMs: 1_000_000 });
    watchdogs.push(watchdog);
    try {
        child.kill("SIGKILL");
        await child.exited;
        watchdog.scan();
        watchdog.scan();
        expect(entries(paths.logPath).map((entry) => entry.type)).toEqual(["client_started", "client_process_lost"]);
        expect(existsSync(join(liveProcessDirectoryIn(home), `${child.pid}.json`))).toBe(false);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
    }
});

test("host startup finds a client that died while the host was down", () => {
    const home = tempHome();
    const paths = seed(home, 999_999_999, instance(3));
    const watchdog = startClientWatchdog(home, { now: () => epoch, isAlive: () => false, intervalMs: 1_000_000 });
    watchdogs.push(watchdog);
    expect(entries(paths.logPath).map((entry) => entry.type)).toEqual(["client_started", "client_process_lost"]);
    expect(existsSync(join(liveProcessDirectoryIn(home), "999999999.json"))).toBe(false);
});

test("a reused PID records the original client as lost without signalling the new process", () => {
    const home = tempHome();
    const paths = seed(home, 12_350, instance(6));
    const watchdog = startClientWatchdog(home, {
        now: () => epoch, isAlive: () => true, identity: () => "mismatch", intervalMs: 1_000_000,
    });
    watchdogs.push(watchdog);
    expect(entries(paths.logPath).map((entry) => entry.type)).toEqual(["client_started", "client_process_lost"]);
    expect(existsSync(join(liveProcessDirectoryIn(home), "12350.json"))).toBe(false);
});

test("an unverified live PID keeps its record and is not watched", () => {
    const home = tempHome();
    const paths = seed(home, 12_351, instance(7));
    const watchdog = startClientWatchdog(home, {
        now: () => epoch + 10_000, isAlive: () => true, identity: () => "unknown", intervalMs: 1_000_000,
    });
    watchdogs.push(watchdog);
    expect(entries(paths.logPath).map((entry) => entry.type)).toEqual(["client_started"]);
    expect(existsSync(join(liveProcessDirectoryIn(home), "12351.json"))).toBe(true);
});

test("@core resident host startup recovers a vanished client's real diagnostics", async () => {
    const home = tempHome();
    const paths = seed(home, 999_999_999, instance(5));
    const host = await startResidentHost({
        home,
        config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
        createAdapter: () => new FauxAdapter([]),
        socketPath: join(home, "host.sock"),
        lockPath: join(home, "host.json"),
        sessionDirectory: join(home, "sessions"),
        skipStartupDiscovery: true,
        processWorker: false,
    });
    try {
        expect(entries(paths.logPath).map((entry) => entry.type)).toEqual(["client_started", "client_process_lost"]);
        expect(existsSync(join(liveProcessDirectoryIn(home), "999999999.json"))).toBe(false);
    } finally {
        await host.close();
    }
}, 15_000);

test("normal exit and old clients do not produce host watchdog events", () => {
    const home = tempHome();
    const paths = seed(home, 12_345, instance(4));
    postLiveProcessIn(home, "tui", { pid: 12_346, startedAt: new Date(epoch).toISOString(), runtimeDir: join(home, "runtime") });
    let alive = true;
    let probes = 0;
    const watchdog = startClientWatchdog(home, {
        now: () => epoch,
        isAlive: (pid) => { expect(pid).toBe(12_345); probes += 1; return alive; },
        identity: () => "match",
        intervalMs: 1_000_000,
    });
    watchdogs.push(watchdog);
    dropLiveProcessIn(home, 12_345);
    alive = false;
    watchdog.scan();
    expect(probes).toBeGreaterThan(0);
    expect(entries(paths.logPath).map((entry) => entry.type)).toEqual(["client_started"]);
});

test("watchdog tracks the 64 oldest clients and logs the capacity once", () => {
    const home = tempHome();
    const paths = Array.from({ length: 65 }, (_, index) => seed(home, 20_000 + index, instance(index + 10), epoch + index));
    let time = epoch + 10_000;
    const logs: Array<Record<string, unknown>> = [];
    const watchdog = startClientWatchdog(home, {
        now: () => time,
        isAlive: () => true,
        identity: () => "match",
        intervalMs: 1_000_000,
        log: (entry) => { logs.push(entry); },
    });
    watchdogs.push(watchdog);
    time += 5_000;
    watchdog.scan();
    expect(paths.slice(0, 64).every((path) => entries(path.logPath).filter((entry) => entry.type === "client_heartbeat_stalled").length === 1)).toBe(true);
    expect(entries(paths[64]!.logPath).map((entry) => entry.type)).toEqual(["client_started"]);
    expect(logs).toEqual([{ type: "client_watchdog_capacity_reached", cap: 64 }]);
});

test("heartbeat age rejects malformed timestamps", () => {
    expect(heartbeatAge("bad", 10_000)).toBeUndefined();
    expect(heartbeatAge("1970-01-01T00:00:05.000Z", 10_000)).toBe(5_000);
});
