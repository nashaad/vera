import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSweepArgs, sweepDevInstances } from "../../scripts/dev-sweep.ts";
import { registerDevInstance } from "../../src/dev-instances.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { listLiveProcessesIn, postLiveProcess } from "../../src/live-process.ts";

const temporaryDirectories: string[] = [];
const spawned: Bun.Subprocess[] = [];

// kill() on a handle is a no-op once Bun has seen the child exit, so a PID the
// sweep stopped and the system reused is never signalled here.
afterAll(async () => {
    for (const child of spawned) child.kill("SIGKILL");
    await Promise.all(spawned.map((child) => child.exited));
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

/** A real process, so the sweep signals something that can refuse to die. */
function longRunningProcess(): number {
    const child = Bun.spawn(["sleep", "300"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    child.unref();
    spawned.push(child);
    return child.pid;
}

function instanceWithOneProcess(
    root: string,
    parent = tempDir("vera-sweep-"),
): {
    readonly veraHome: string;
    readonly pid: number;
} {
    const veraHome = join(parent, ".vera");
    mkdirSync(veraHome, { recursive: true });
    const pid = longRunningProcess();
    postLiveProcess("host", {
        home: parent,
        pid,
        startedAt: new Date().toISOString(),
        runtimeDir: join(veraHome, "runtime"),
    });
    registerDevInstance({
        source: fileURLToPath(import.meta.url),
        home: veraHome,
        root,
    });
    return { veraHome, pid };
}

async function sweep(
    request: Parameters<typeof sweepDevInstances>[0],
    seams?: Parameters<typeof sweepDevInstances>[2],
): Promise<string> {
    let written = "";
    const code = await sweepDevInstances(request, (line) => {
        written += line;
    }, seams);
    expect(code).toBe(0);
    return written;
}

test("--days and --dry-run are read, anything else is refused", () => {
    expect(parseSweepArgs([])).toEqual({
        maxAgeMs: 2 * 24 * 60 * 60 * 1_000,
        dryRun: false,
    });
    expect(parseSweepArgs(["--dry-run", "--days", "5"])).toEqual({
        maxAgeMs: 5 * 24 * 60 * 60 * 1_000,
        dryRun: true,
    });
    expect(parseSweepArgs(["--days"])).toBe("invalid --days: (missing)");
    expect(parseSweepArgs(["--days", "-1"])).toBe("invalid --days: -1");
    expect(parseSweepArgs(["--weeks"])).toBe("unknown argument: --weeks");
});

test("an empty registry is said out loud, not swept in silence", async () => {
    const root = tempDir("vera-sweep-root-");
    const written = await sweep({ maxAgeMs: 0, dryRun: false, root });
    expect(written).toContain("No development instances are registered.");
});

test("a process younger than the cutoff is left running", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);

    const written = await sweep({
        maxAgeMs: 2 * 24 * 60 * 60 * 1_000,
        dryRun: false,
        root,
    });

    expect(written).not.toContain(String(instance.pid));
    expect(written).toContain("Stopped 0 processes across 1 instance,");
    expect(processIsAlive(instance.pid)).toBe(true);
    expect(listLiveProcessesIn(instance.veraHome)).toHaveLength(1);
});

test("a dry run names what it would stop and stops nothing", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);

    const written = await sweep({ maxAgeMs: 0, dryRun: true, root });

    expect(written).toContain(instance.veraHome);
    expect(written).toContain(`would stop`);
    expect(written).toContain(String(instance.pid));
    expect(processIsAlive(instance.pid)).toBe(true);
    expect(listLiveProcessesIn(instance.veraHome)).toHaveLength(1);
});

test("a process past the cutoff is stopped and its record cleared", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root });

    expect(written).toContain(instance.veraHome);
    expect(written).toContain(`stopped`);
    expect(written).toContain("Stopped 1 process across 1 instance,");
    expect(processIsAlive(instance.pid)).toBe(false);
    expect(listLiveProcessesIn(instance.veraHome)).toEqual([]);
});

test("the sweep stops a recorded session process with its host", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);
    const workerPid = longRunningProcess();
    const directory = join(instance.veraHome, "runtime", "workers");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "w0.json"), JSON.stringify({
        id: "w0", pid: workerPid, started_at: new Date().toISOString(), master_pid: instance.pid,
    }));

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root });

    expect(written).toContain(`worker      pid ${workerPid}`);
    expect(processIsAlive(instance.pid)).toBe(false);
    expect(processIsAlive(workerPid)).toBe(false);
});

test("the sweep reaches every registered home, not just the first", async () => {
    const root = tempDir("vera-sweep-root-");
    const first = instanceWithOneProcess(root);
    const second = instanceWithOneProcess(root);

    await sweep({ maxAgeMs: 0, dryRun: false, root });

    expect(processIsAlive(first.pid)).toBe(false);
    expect(processIsAlive(second.pid)).toBe(false);
});

test("a registered entry for the default home is never swept", async () => {
    const root = tempDir("vera-sweep-root-");
    const daily = instanceWithOneProcess(root, root);
    expect(daily.veraHome).toBe(join(root, ".vera"));

    const dryRun = await sweep({ maxAgeMs: 0, dryRun: true, root });
    const real = await sweep({ maxAgeMs: 0, dryRun: false, root });

    expect(dryRun).toContain("No development instances are registered.");
    expect(real).toContain("No development instances are registered.");
    expect(processIsAlive(daily.pid)).toBe(true);
    expect(listLiveProcessesIn(daily.veraHome)).toHaveLength(1);
});

test("an entry whose home became a file is dropped and the sweep goes on", async () => {
    const root = tempDir("vera-sweep-root-");
    const replaced = instanceWithOneProcess(root);
    const trial = instanceWithOneProcess(root);
    rmSync(replaced.veraHome, { recursive: true, force: true });
    writeFileSync(replaced.veraHome, "not a directory\n");

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root });

    expect(written).toContain("Stopped 1 process across 1 instance,");
    expect(processIsAlive(trial.pid)).toBe(false);
});

test("the default home is skipped while another registered home is swept", async () => {
    const root = tempDir("vera-sweep-root-");
    const daily = instanceWithOneProcess(root, root);
    const trial = instanceWithOneProcess(root);

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root });

    expect(written).toContain("Stopped 1 process across 1 instance,");
    expect(processIsAlive(trial.pid)).toBe(false);
    expect(processIsAlive(daily.pid)).toBe(true);
});

// A start time inside and outside the tolerance of a process spawned just now.
const sameStart = (): number => Date.now() - 1_000;
const reusedStart = (): number => Date.now() - 3_600_000;

/** Ignores SIGTERM, so a sweep has to follow up with SIGKILL. Resolves once the handler is installed. */
async function stubbornProcess(detached = false): Promise<number> {
    const child = Bun.spawn(
        [
            process.execPath,
            "-e",
            'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
        ],
        { stdout: "pipe", stderr: "ignore", detached },
    );
    child.unref();
    spawned.push(child);
    const reader = child.stdout.getReader();
    await reader.read();
    reader.releaseLock();
    return child.pid;
}

function instanceWith(
    root: string,
    pid: number,
): { readonly veraHome: string; readonly pid: number } {
    const parent = tempDir("vera-sweep-");
    const veraHome = join(parent, ".vera");
    mkdirSync(veraHome, { recursive: true });
    postLiveProcess("host", {
        home: parent,
        pid,
        startedAt: new Date().toISOString(),
        runtimeDir: join(veraHome, "runtime"),
    });
    registerDevInstance({
        source: fileURLToPath(import.meta.url),
        home: veraHome,
        root,
    });
    return { veraHome, pid };
}

test("a sweep checks the real process group of a detached host", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWith(root, await stubbornProcess(true));
    const group = Bun.spawnSync(["ps", "-p", String(instance.pid), "-o", "pgid="], { stdout: "pipe" });
    expect(Number(group.stdout.toString().trim())).toBe(instance.pid);
    const signals: string[] = [];
    await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        graceMs: 0,
        reads: {
            kill: (pid, signal) => {
                signals.push(`${signal}:${pid}`);
                if (pid > 0) process.kill(pid, signal);
            },
        },
    });
    expect(signals).toContain(`SIGKILL:${-instance.pid}`);
    expect(signals).toContain(`SIGKILL:${instance.pid}`);
});

for (const pooled of [false, true]) {
    for (const scenario of ["leader", "nonleader", "unreadable", "replaced"] as const) {
        test(`a sweep checks ${scenario} before a group signal for a ${pooled ? "pooled" : "plain"} host`, async () => {
            const root = tempDir("vera-sweep-root-");
            const instance = instanceWith(root, await stubbornProcess());
            if (pooled) {
                const workerPid = longRunningProcess();
                const directory = join(instance.veraHome, "runtime", "workers");
                mkdirSync(directory, { recursive: true });
                writeFileSync(join(directory, "w0.json"), JSON.stringify({
                    id: "w0", pid: workerPid, started_at: new Date().toISOString(), master_pid: instance.pid,
                }));
            }
            let replaced = false;
            const signals: string[] = [];
            const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
                graceMs: 0,
                readProcessGroupSnapshot: (pid) => {
                    if (scenario === "replaced") replaced = true;
                    if (scenario === "unreadable") return undefined;
                    return [{ pid, group: scenario === "nonleader" ? pid + 1 : pid, state: "S",
                        startedAt: scenario === "replaced" ? reusedStart() : sameStart() }];
                },
                reads: {
                    readStartedAt: (pid) => replaced && pid === instance.pid ? reusedStart() : sameStart(),
                    kill: (pid, signal) => {
                        signals.push(`${signal}:${pid}`);
                        if (pid > 0) process.kill(pid, signal);
                    },
                },
            });
            if (scenario === "leader") expect(signals).toContain(`SIGKILL:${-instance.pid}`);
            else expect(signals).not.toContain(`SIGKILL:${-instance.pid}`);
            if (scenario === "replaced") {
                expect(signals).not.toContain(`SIGKILL:${instance.pid}`);
                expect(written).toContain(`signalled; the PID no longer belongs to the listed process`);
            } else {
                expect(signals).toContain(`SIGKILL:${instance.pid}`);
            }
        });
    }
}

test("a PID reused after the listing is not signalled, and the sweep says so", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);
    const signals: string[] = [];

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        reads: {
            readStartedAt: reusedStart,
            kill: (pid, signal) => {
                signals.push(`${signal}:${pid}`);
                process.kill(pid, signal);
            },
        },
    });

    expect(signals).toEqual([]);
    expect(processIsAlive(instance.pid)).toBe(true);
    expect(written).toContain(
        `skipped     host        pid ${instance.pid}`,
    );
    expect(written).toContain(
        "another process now holds this PID; not signalled",
    );
    expect(written).toContain("Stopped 0 processes across 1 instance,");
    expect(listLiveProcessesIn(instance.veraHome)).toEqual([]);
});

test("a PID with the same start time but another command line is not signalled", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);
    const signals: string[] = [];
    const commands = [
        "bun /work/vera/clients/host/main.ts",
        "/usr/sbin/syslogd",
    ];

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        reads: {
            readStartedAt: sameStart,
            // The first read is the one taken when the process is listed.
            readCommand: () => commands.shift() ?? "/usr/sbin/syslogd",
            kill: (pid, signal) => {
                signals.push(`${signal}:${pid}`);
                process.kill(pid, signal);
            },
        },
    });

    expect(signals).toEqual([]);
    expect(processIsAlive(instance.pid)).toBe(true);
    expect(written).toContain(
        "another process now holds this PID; not signalled",
    );
});

test("a process whose start time cannot be read at signal time is left running", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);
    const signals: string[] = [];

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        reads: {
            readStartedAt: () => undefined,
            kill: (pid, signal) => {
                signals.push(`${signal}:${pid}`);
                process.kill(pid, signal);
            },
        },
    });

    expect(signals).toEqual([]);
    expect(processIsAlive(instance.pid)).toBe(true);
    expect(written).toContain(
        "could not confirm it is still the listed process; not signalled",
    );
    expect(listLiveProcessesIn(instance.veraHome)).toHaveLength(1);
});

test("a PID reused while SIGTERM was pending is not sent SIGKILL", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWith(root, await stubbornProcess());
    const signals: string[] = [];
    let reused = false;

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        graceMs: 200,
        reads: {
            readStartedAt: () => reused ? reusedStart() : sameStart(),
            kill: (pid, signal) => {
                signals.push(`${signal}:${pid}`);
                if (signal === "SIGTERM") reused = true;
                process.kill(pid, signal);
            },
        },
    });

    expect(signals).toEqual([`SIGTERM:${instance.pid}`]);
    expect(processIsAlive(instance.pid)).toBe(true);
    expect(written).toContain(
        "signalled; the PID no longer belongs to the listed process",
    );
    expect(written).not.toContain("not signalled");
    expect(written).toContain("Stopped 1 process across 1 instance,");
});

test("a process that ignores SIGTERM is still sent SIGKILL while it is the listed process", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWith(root, await stubbornProcess());
    const signals: string[] = [];

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        graceMs: 200,
        reads: {
            kill: (pid, signal) => {
                signals.push(`${signal}:${pid}`);
                process.kill(pid, signal);
            },
        },
    });

    expect(signals[0]).toBe(`SIGTERM:${instance.pid}`);
    expect(signals).toContain(`SIGKILL:${instance.pid}`);
    expect(processIsAlive(instance.pid)).toBe(false);
    expect(written).toContain("Stopped 1 process across 1 instance,");
});

test("a skipped process does not stop the sweep from reaching the next one", async () => {
    const root = tempDir("vera-sweep-root-");
    const reused = instanceWithOneProcess(root);
    const genuine = instanceWithOneProcess(root);

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        reads: {
            readStartedAt: (pid) =>
                pid === reused.pid ? reusedStart() : sameStart(),
        },
    });

    expect(processIsAlive(reused.pid)).toBe(true);
    expect(processIsAlive(genuine.pid)).toBe(false);
    expect(written).toContain("Stopped 1 process across 2 instances,");
});

/** Records signals without delivering them, so the process stays up for the next read. */
function recordedSignals(
    signals: string[],
    onSignal: (pid: number, signal: NodeJS.Signals) => void,
): (pid: number, signal: NodeJS.Signals) => void {
    return (pid, signal) => {
        signals.push(`${signal}:${pid}`);
        onSignal(pid, signal);
    };
}

test("a process that cannot be confirmed gone after SIGKILL is not counted as stopped", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);
    const signals: string[] = [];
    let killed = false;

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        graceMs: 100,
        readProcessGroupSnapshot: (pid) => [{ pid, group: pid, state: "S", startedAt: sameStart() }],
        reads: {
            // The last read, after both SIGKILLs, comes back empty.
            readStartedAt: () => killed ? undefined : sameStart(),
            kill: recordedSignals(signals, (pid, signal) => {
                if (signal === "SIGKILL" && pid > 0) killed = true;
            }),
        },
    });

    expect(signals).toEqual([
        `SIGTERM:${instance.pid}`,
        `SIGKILL:-${instance.pid}`,
        `SIGKILL:${instance.pid}`,
    ]);
    expect(written).toContain(`unconfirmed host        pid ${instance.pid}`);
    expect(written).toContain("signalled; could not confirm it exited");
    expect(written).not.toContain("stopped     host");
    expect(written).toContain("Stopped 0 processes across 1 instance,");
    expect(listLiveProcessesIn(instance.veraHome)).toHaveLength(1);
});

test("a process that cannot be confirmed before SIGKILL says a signal already went out", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);
    const signals: string[] = [];
    let termSent = false;

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        graceMs: 100,
        reads: {
            readStartedAt: () => termSent ? undefined : sameStart(),
            kill: recordedSignals(signals, (_pid, signal) => {
                if (signal === "SIGTERM") termSent = true;
            }),
        },
    });

    expect(signals).toEqual([`SIGTERM:${instance.pid}`]);
    expect(written).toContain(`unconfirmed host        pid ${instance.pid}`);
    expect(written).toContain("signalled; could not confirm it exited");
    expect(written).not.toContain("not signalled");
    expect(written).toContain("Stopped 0 processes across 1 instance,");
    expect(listLiveProcessesIn(instance.veraHome)).toHaveLength(1);
});

test("a PID that stops matching after the group SIGKILL is not described as reused", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);
    const signals: string[] = [];
    let groupKilled = false;

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root }, {
        graceMs: 100,
        readProcessGroupSnapshot: (pid) => [{ pid, group: pid, state: "S", startedAt: sameStart() }],
        reads: {
            readStartedAt: () => groupKilled ? reusedStart() : sameStart(),
            kill: recordedSignals(signals, (pid, signal) => {
                if (signal === "SIGKILL" && pid < 0) groupKilled = true;
            }),
        },
    });

    expect(signals).toEqual([
        `SIGTERM:${instance.pid}`,
        `SIGKILL:-${instance.pid}`,
    ]);
    expect(written).toContain(
        "signalled; the PID no longer belongs to the listed process",
    );
    expect(written).not.toContain("another process now holds");
    expect(written).not.toContain("not signalled");
    expect(written).toContain("Stopped 1 process across 1 instance,");
    expect(listLiveProcessesIn(instance.veraHome)).toEqual([]);
});
