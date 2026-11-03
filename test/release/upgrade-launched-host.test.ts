import { afterEach, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { activateRelease } from "../../src/release/activate.ts";
import {
    currentReleaseBuildId,
    upgradeJournalPath,
} from "../../src/release/layout.ts";
import { rollbackLocalInstall } from "../../src/release/rollback.ts";
import { readStampedRelease } from "../../src/release/stamp.ts";
import {
    StartedHostSurvivedError,
    defaultEnsureHost,
    type HostLaunchRecorder,
    readUpgradeJournal,
    recoverInterruptedUpgrade,
    upgradeLocalInstall,
    writeUpgradeJournal,
} from "../../src/release/upgrade.ts";
import {
    RUN_DEFAULT_UPGRADE_FIXTURE,
    type SurvivorSetup,
    interruptedStart,
    isAlive,
    killOnCleanup,
    makeRoot,
    readLockBuild,
    registerCleanup,
    runCleanups,
    spawnDisposable,
    spawnedPids,
    waitUntilGone,
    withVeraHome,
    writeLock,
    writeRelease,
} from "../support/fake-host-release.ts";

afterEach(runCleanups);

test("recovery restores the previous release when an install died before it wrote starting and the new host never publishes", async () => {
    const { home, prefix, old, next } = interruptedStart("activating");

    await withVeraHome(home, async () => {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: (releaseRoot) => defaultEnsureHost(releaseRoot, {
                publishTimeoutMs: releaseRoot === next.root ? 300 : 5_000,
                exitGraceMs: 2_000,
            }),
        });
        expect(recovered).toEqual({ recovered: true, buildId: "vera-old" });
    });

    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    expect(readLockBuild(home).build).toBe("vera-old");
    expect(spawnedPids(old)).toHaveLength(1);
    for (const pid of spawnedPids(next)) {
        expect(await waitUntilGone(pid), "the hung host was left running").toBe(true);
    }
}, 15_000);

test("rollback finishes an install that died before it wrote starting by restoring the previous release", async () => {
    const { home, prefix, next } = interruptedStart("activating");

    await withVeraHome(home, async () => {
        const outcome = await rollbackLocalInstall(prefix, {
            startHost: (releaseRoot) => defaultEnsureHost(releaseRoot, {
                operation: "rollback",
                publishTimeoutMs: releaseRoot === next.root ? 300 : 5_000,
                exitGraceMs: 2_000,
            }),
        });
        expect(outcome).toEqual({ kind: "finished_interrupted", prefix, activeBuildId: "vera-old" });
    });

    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
}, 15_000);

interface LaunchLog {
    readonly recorder: HostLaunchRecorder;
    readonly events: string[];
}

// The pid file is written by the fake host and can lag a quick stop; the event cannot.
function launchedPid(log: LaunchLog): number {
    const pid = Number(log.events[0]?.replace("launched ", ""));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    return pid;
}

function logLaunches(options: { readonly failLaunched?: boolean } = {}): LaunchLog {
    const events: string[] = [];
    return {
        events,
        recorder: {
            launched: async (host) => {
                events.push(`launched ${host.pid}`);
                killOnCleanup(host.pid);
                if (options.failLaunched === true) throw new Error("the journal is not writable");
            },
            resolved: async () => {
                events.push("resolved");
            },
        },
    };
}

test("ensure reports the launched host before the publish wait and resolves it once it publishes", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const next = writeRelease(prefix, "vera-new", home, "publish");
    const log = logLaunches();

    await withVeraHome(home, async () => {
        await defaultEnsureHost(next.root, { recorder: log.recorder });
    });

    const pid = launchedPid(log);
    expect(log.events).toEqual([`launched ${pid}`, "resolved"]);
});

test("ensure resolves the launched host when the process yielded to a same-build host", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const rival = spawnDisposable();
    const next = writeRelease(prefix, "vera-new", home, "yield-to-rival", rival.pid);
    const log = logLaunches();

    await withVeraHome(home, async () => {
        await defaultEnsureHost(next.root, { publishTimeoutMs: 5_000, recorder: log.recorder });
    });

    const pid = launchedPid(log);
    expect(log.events).toEqual([`launched ${pid}`, "resolved"]);
}, 15_000);

test("ensure resolves the launched host once it has been stopped", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const next = writeRelease(prefix, "vera-new", home, "silent");
    const log = logLaunches();

    await withVeraHome(home, async () => {
        await expect(defaultEnsureHost(next.root, {
            publishTimeoutMs: 200,
            recorder: log.recorder,
        })).rejects.toThrow(/was stopped/);
    });

    const pid = launchedPid(log);
    expect(log.events).toEqual([`launched ${pid}`, "resolved"]);
});

test("ensure leaves the launched host unresolved when it cannot be stopped", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const next = writeRelease(prefix, "vera-new", home, "silent");
    const log = logLaunches();

    let thrown: unknown;
    await withVeraHome(home, async () => {
        thrown = await defaultEnsureHost(next.root, {
            publishTimeoutMs: 200,
            stopStartedHost: async () => false,
            recorder: log.recorder,
        }).catch((error: unknown) => error);
    });

    const pid = launchedPid(log);
    expect(thrown).toBeInstanceOf(StartedHostSurvivedError);
    expect((thrown as StartedHostSurvivedError).host?.pid).toBe(pid);
    expect(log.events).toEqual([`launched ${pid}`]);
});

test("ensure stops the host it launched when the journal cannot record it", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const next = writeRelease(prefix, "vera-new", home, "publish");
    const log = logLaunches({ failLaunched: true });

    await withVeraHome(home, async () => {
        await expect(defaultEnsureHost(next.root, { recorder: log.recorder }))
            .rejects.toThrow("the journal is not writable");
    });

    const pid = launchedPid(log);
    expect(await waitUntilGone(pid), "an unrecorded host was left running").toBe(true);
    expect(log.events).toEqual([`launched ${pid}`, "resolved"]);
});

test("ensure reports an unrecorded host it cannot stop as a survivor", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const next = writeRelease(prefix, "vera-new", home, "silent");
    const log = logLaunches({ failLaunched: true });

    let thrown: unknown;
    await withVeraHome(home, async () => {
        thrown = await defaultEnsureHost(next.root, {
            stopStartedHost: async () => false,
            recorder: log.recorder,
        }).catch((error: unknown) => error);
    });

    expect(thrown).toBeInstanceOf(StartedHostSurvivedError);
    expect((thrown as StartedHostSurvivedError).host?.pid).toBe(launchedPid(log));
    expect((thrown as Error).message).toContain("the journal is not writable");
});

interface JournalSnapshot {
    readonly stopStartedHost: (child: ChildProcess, graceMs: number) => Promise<boolean>;
    readonly taken: () => Array<Record<string, unknown>>;
    // The pid of each child that was stopped, read from the child and not a pid file.
    readonly pids: () => Array<number | undefined>;
}

// Reads the journal when the publish wait ends. That is the state an installer
// that died during the wait would have left behind.
function snapshotJournalWhenWaitEnds(prefix: string): JournalSnapshot {
    const taken: Array<Record<string, unknown>> = [];
    const pids: Array<number | undefined> = [];
    return {
        taken: () => taken,
        pids: () => pids,
        stopStartedHost: async (child) => {
            pids.push(child.pid);
            taken.push(JSON.parse(readFileSync(upgradeJournalPath(prefix), "utf8")));
            const exited = new Promise<void>((done) => child.once("exit", () => done()));
            child.kill("SIGKILL");
            await exited;
            return true;
        },
    };
}

// A stop hook for a host the test leaves running on purpose.
function cannotStop(): {
    readonly stopStartedHost: (child: ChildProcess) => Promise<boolean>;
    readonly pids: () => number[];
} {
    const pids: number[] = [];
    return {
        pids: () => pids,
        stopStartedHost: async (child) => {
            if (child.pid !== undefined) {
                pids.push(child.pid);
                killOnCleanup(child.pid);
            }
            return false;
        },
    };
}

function expectLaunchedHost(
    snapshot: Record<string, unknown>,
    pid: number | undefined,
): void {
    const launched = snapshot.launched_host as { pid: number; started_at: string } | undefined;
    expect(launched?.pid).toBe(pid as number);
    expect(Number.isNaN(Date.parse(launched?.started_at ?? ""))).toBe(false);
}

test("an install journals the host it launched while it waits for it to publish", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const old = writeRelease(prefix, "vera-old", home, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", home, "silent");
    const snapshot = snapshotJournalWhenWaitEnds(prefix);

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
            startHost: (releaseRoot, recorder) => defaultEnsureHost(releaseRoot, {
                publishTimeoutMs: releaseRoot === next.root ? 300 : 5_000,
                stopStartedHost: snapshot.stopStartedHost,
                recorder,
            }),
        })).rejects.toThrow(/did not publish/);
    });

    expect(snapshot.taken()).toHaveLength(1);
    expect(snapshot.taken()[0]?.phase).toBe("starting");
    expectLaunchedHost(snapshot.taken()[0] ?? {}, snapshot.pids()[0]);
    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
}, 15_000);

test("a rollback journals the host it launched while it waits for it to publish", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const pinned = writeRelease(prefix, "vera-old", home, "silent");
    activateRelease(pinned.root, prefix);
    const active = writeRelease(prefix, "vera-new", home, "publish");
    activateRelease(active.root, prefix);
    const snapshot = snapshotJournalWhenWaitEnds(prefix);

    await withVeraHome(home, async () => {
        await expect(rollbackLocalInstall(prefix, {
            drainHost: async () => "stopped",
            startHost: (releaseRoot, recorder) => defaultEnsureHost(releaseRoot, {
                operation: "rollback",
                publishTimeoutMs: releaseRoot === pinned.root ? 300 : 5_000,
                stopStartedHost: snapshot.stopStartedHost,
                recorder,
            }),
        })).rejects.toThrow(/did not publish/);
    });

    expect(snapshot.taken()).toHaveLength(1);
    expectLaunchedHost(snapshot.taken()[0] ?? {}, snapshot.pids()[0]);
    expect(currentReleaseBuildId(prefix)).toBe("vera-new");
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
}, 15_000);

test("recovery journals the host it launches while it waits for it to publish", async () => {
    const { home, prefix, old, next } = interruptedStart();
    const snapshot = snapshotJournalWhenWaitEnds(prefix);

    await withVeraHome(home, async () => {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: (releaseRoot, recorder) => defaultEnsureHost(releaseRoot, {
                publishTimeoutMs: releaseRoot === next.root ? 300 : 5_000,
                stopStartedHost: snapshot.stopStartedHost,
                recorder,
            }),
        });
        expect(recovered).toEqual({ recovered: true, buildId: "vera-old" });
    });

    expect(snapshot.taken()).toHaveLength(1);
    expectLaunchedHost(snapshot.taken()[0] ?? {}, snapshot.pids()[0]);
    expect(spawnedPids(old)).toHaveLength(1);
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
}, 15_000);

const PREVIOUS_RELEASE_STATES = [
    "draining",
    "activating before current moved",
    "restore after a failed start",
] as const;

// An interrupted install whose previous release has a host that never publishes.
function interruptedWithSilentPreviousHost(
    state: (typeof PREVIOUS_RELEASE_STATES)[number],
): { readonly home: string; readonly prefix: string } {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const old = writeRelease(prefix, "vera-old", home, "silent");
    const next = writeRelease(prefix, "vera-new", home, "publish");
    const journal = {
        from_build_id: "vera-old",
        to_build_id: "vera-new",
        host_was_running: true,
    };
    if (state === "restore after a failed start") {
        activateRelease(next.root, prefix);
        writeUpgradeJournal({ phase: "starting", ...journal, start_failed: true }, prefix);
    } else {
        activateRelease(old.root, prefix);
        writeUpgradeJournal({
            phase: state === "draining" ? "draining" : "activating",
            ...journal,
        }, prefix);
    }
    return { home, prefix };
}

for (const state of PREVIOUS_RELEASE_STATES) {
    test(`recovery (${state}) journals the previous host it launches, then clears the journal when that host never publishes`, async () => {
        const { home, prefix } = interruptedWithSilentPreviousHost(state);
        const snapshot = snapshotJournalWhenWaitEnds(prefix);

        await withVeraHome(home, async () => {
            await expect(recoverInterruptedUpgrade({
                prefix,
                startHost: (releaseRoot, recorder) => defaultEnsureHost(releaseRoot, {
                    publishTimeoutMs: 300,
                    stopStartedHost: snapshot.stopStartedHost,
                    recorder,
                }),
            })).rejects.toThrow(
                /did not publish.*The host it started was stopped\. The previous release stays active; the upgrade journal was cleared\.$/,
            );
        });

        expectLaunchedHost(snapshot.taken()[0] ?? {}, snapshot.pids()[0]);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    }, 15_000);
}

for (const state of PREVIOUS_RELEASE_STATES) {
    test(`recovery (${state}) records the previous host it launched and cannot stop as surviving_host only`, async () => {
        const { home, prefix } = interruptedWithSilentPreviousHost(state);
        const unstoppable = cannotStop();

        await withVeraHome(home, async () => {
            await expect(recoverInterruptedUpgrade({
                prefix,
                startHost: (releaseRoot, recorder) => defaultEnsureHost(releaseRoot, {
                    publishTimeoutMs: 300,
                    stopStartedHost: unstoppable.stopStartedHost,
                    recorder,
                }),
            })).rejects.toBeInstanceOf(StartedHostSurvivedError);
        });

        const journal = await readUpgradeJournal(prefix);
        expect(journal?.surviving_host?.pid).toBe(unstoppable.pids()[0] as number);
        expect(journal?.launched_host, "the survivor is also recorded as a pending launch").toBeUndefined();
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    }, 15_000);
}

test("an install whose restore fails keeps its journal without the launch record of the host it stopped", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const old = writeRelease(prefix, "vera-old", home, "silent");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", home, "silent");
    const snapshot = snapshotJournalWhenWaitEnds(prefix);

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
            startHost: (releaseRoot, recorder) => defaultEnsureHost(releaseRoot, {
                publishTimeoutMs: 300,
                stopStartedHost: snapshot.stopStartedHost,
                recorder,
            }),
        })).rejects.toThrow(/Restore of the previous release also failed/);
    });

    expect(snapshot.taken()).toHaveLength(2);
    expectLaunchedHost(snapshot.taken()[1] ?? {}, snapshot.pids()[1]);
    const journal = await readUpgradeJournal(prefix);
    expect(journal?.start_failed).toBe(true);
    expect(journal?.launched_host, "a stopped host is still recorded as launched").toBeUndefined();
}, 15_000);

test("a launched host that cannot be stopped moves from launched_host to surviving_host", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const old = writeRelease(prefix, "vera-old", home, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", home, "silent");
    const unstoppable = cannotStop();

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
            startHost: (releaseRoot, recorder) => defaultEnsureHost(releaseRoot, {
                publishTimeoutMs: 300,
                stopStartedHost: unstoppable.stopStartedHost,
                recorder,
            }),
        })).rejects.toBeInstanceOf(StartedHostSurvivedError);
    });

    const journal = await readUpgradeJournal(prefix);
    expect(journal?.surviving_host?.pid).toBe(unstoppable.pids()[0] as number);
    expect(journal?.launched_host).toBeUndefined();
});

// An interrupted install whose launched host is still running: the journal names it
// and the installer is gone.
async function journalWithLaunched(
    startedAt: string = new Date().toISOString(),
): Promise<SurvivorSetup & { readonly home: string }> {
    const root = makeRoot();
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const old = writeRelease(prefix, "vera-old", home, "publish");
    const next = writeRelease(prefix, "vera-new", home, "publish");
    activateRelease(next.root, prefix);
    const survivor = spawnDisposable();
    writeUpgradeJournal({
        phase: "starting",
        from_build_id: "vera-old",
        to_build_id: "vera-new",
        host_was_running: true,
        launched_host: { pid: survivor.pid, started_at: startedAt },
    }, prefix);
    return { home, prefix, old, next, survivor };
}

test("recovery stops a launched host that does not hold the lock, then starts the host again", async () => {
    const { home, prefix, next, survivor } = await journalWithLaunched();
    const started: string[] = [];

    await withVeraHome(home, async () => {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: async (releaseRoot) => {
                started.push(releaseRoot);
            },
        });
        expect(recovered).toEqual({ recovered: true, buildId: "vera-new" });
    });

    expect(await waitUntilGone(survivor.pid), "the launched host was left running").toBe(true);
    expect(started).toEqual([next.root]);
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
});

test("recovery leaves a launched host alone when it holds the lock", async () => {
    const { home, prefix, next, survivor } = await journalWithLaunched();
    writeLock(home, { pid: survivor.pid, buildId: "vera-new" });

    await withVeraHome(home, async () => {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: (releaseRoot) => defaultEnsureHost(releaseRoot, { publishTimeoutMs: 300 }),
        });
        expect(recovered).toEqual({ recovered: true, buildId: "vera-new" });
    });

    expect(isAlive(survivor.pid), "the serving host was stopped").toBe(true);
    expect(spawnedPids(next), "a second host was started").toEqual([]);
    expect(readLockBuild(home)).toEqual({ pid: survivor.pid, build: "vera-new" });
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
});

test("recovery leaves a launched host alone when it takes the lock after the first check", async () => {
    const { home, prefix, next, survivor } = await journalWithLaunched();
    const signals: string[] = [];

    await withVeraHome(home, async () => {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: (releaseRoot) => defaultEnsureHost(releaseRoot, { publishTimeoutMs: 300 }),
            forceStop: {
                // The identity check runs after the lock was first read and before the signal.
                matchesRecord: (record) => {
                    writeLock(home, { pid: record.pid, buildId: "vera-new" });
                    return true;
                },
                kill: (pid, signal) => {
                    signals.push(`${signal} ${pid}`);
                },
                sigtermGraceMs: 20,
                sigkillGraceMs: 20,
            },
        });
        expect(recovered).toEqual({ recovered: true, buildId: "vera-new" });
    });

    expect(signals, "the serving host was signalled").toEqual([]);
    expect(isAlive(survivor.pid)).toBe(true);
    expect(spawnedPids(next), "a second host was started").toEqual([]);
    expect(readLockBuild(home)).toEqual({ pid: survivor.pid, build: "vera-new" });
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
});

test("recovery still sends SIGKILL to a launched host that takes the lock after SIGTERM and does not exit", async () => {
    const { home, prefix, next, survivor } = await journalWithLaunched();
    const signals: string[] = [];
    const started: string[] = [];

    await withVeraHome(home, async () => {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: async (releaseRoot) => {
                started.push(releaseRoot);
            },
            forceStop: {
                matchesRecord: () => true,
                kill: (pid, signal) => {
                    signals.push(`${signal} ${pid}`);
                    if (signal === "SIGTERM") {
                        writeLock(home, { pid, buildId: "vera-new" });
                        return;
                    }
                    process.kill(pid, signal);
                },
                sigtermGraceMs: 20,
                sigkillGraceMs: 2_000,
            },
        });
        expect(recovered).toEqual({ recovered: true, buildId: "vera-new" });
    });

    expect(signals).toEqual([`SIGTERM ${survivor.pid}`, `SIGKILL ${survivor.pid}`]);
    expect(await waitUntilGone(survivor.pid), "the stuck host was left running").toBe(true);
    expect(started).toEqual([next.root]);
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
});

test("recovery refuses a launched host it cannot identify, names its PID and changes nothing", async () => {
    const { home, prefix, survivor } = await journalWithLaunched();
    const started: string[] = [];
    const signals: string[] = [];

    await withVeraHome(home, async () => {
        await expect(recoverInterruptedUpgrade({
            prefix,
            operation: "rollback",
            startHost: async (releaseRoot) => {
                started.push(releaseRoot);
            },
            forceStop: {
                readStartedAt: () => undefined,
                kill: (pid, signal) => {
                    signals.push(`${signal} ${pid}`);
                },
            },
        })).rejects.toThrow(new RegExp(`Could not confirm PID ${survivor.pid}.*Nothing was changed`));
    });

    expect(signals, "an unidentified process was signalled").toEqual([]);
    expect(started, "a host was started next to the launched host").toEqual([]);
    expect(isAlive(survivor.pid)).toBe(true);
    expect(currentReleaseBuildId(prefix)).toBe("vera-new");
    expect((await readUpgradeJournal(prefix))?.launched_host?.pid).toBe(survivor.pid);
});

test("recovery refuses while a launched host still runs after SIGTERM and SIGKILL and keeps the journal", async () => {
    const { home, prefix, survivor } = await journalWithLaunched();
    const started: string[] = [];

    await withVeraHome(home, async () => {
        await expect(recoverInterruptedUpgrade({
            prefix,
            startHost: async (releaseRoot) => {
                started.push(releaseRoot);
            },
            forceStop: {
                kill: () => undefined,
                matchesRecord: () => true,
                sigtermGraceMs: 20,
                sigkillGraceMs: 20,
            },
        })).rejects.toThrow(new RegExp(`PID ${survivor.pid}.*still running`));
    });

    expect(started, "a host was started next to the launched host").toEqual([]);
    expect(isAlive(survivor.pid)).toBe(true);
    expect((await readUpgradeJournal(prefix))?.launched_host?.pid).toBe(survivor.pid);
});

test("recovery leaves a launched host alone when its pid now belongs to another process", async () => {
    const { home, prefix, next, survivor } = await journalWithLaunched(
        new Date(Date.now() - 86_400_000).toISOString(),
    );
    const started: string[] = [];

    await withVeraHome(home, async () => {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: async (releaseRoot) => {
                started.push(releaseRoot);
            },
        });
        expect(recovered).toEqual({ recovered: true, buildId: "vera-new" });
    });

    expect(isAlive(survivor.pid), "an unrelated process was stopped").toBe(true);
    expect(started).toEqual([next.root]);
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
});

test("recovery proceeds when the launched host has already exited", async () => {
    const { home, prefix, next, survivor } = await journalWithLaunched();
    process.kill(survivor.pid, "SIGKILL");
    expect(await waitUntilGone(survivor.pid)).toBe(true);
    const started: string[] = [];

    await withVeraHome(home, async () => {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: async (releaseRoot) => {
                started.push(releaseRoot);
            },
        });
        expect(recovered).toEqual({ recovered: true, buildId: "vera-new" });
    });

    expect(started).toEqual([next.root]);
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
});

test("an installer killed during the publish wait leaves its launched host in the journal, and the next run stops it", async () => {
    const root = makeRoot();
    const home = join(root, "private-home");
    const prefix = join(root, "prefix");
    const resident = spawnDisposable();
    writeLock(home, { pid: resident.pid, buildId: "vera-old" });
    const old = writeRelease(prefix, "vera-old", home, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", home, "silent");
    const installer = Bun.spawn(
        [process.execPath, RUN_DEFAULT_UPGRADE_FIXTURE, "upgrade", prefix, next.root],
        {
            cwd: root,
            env: {
                HOME: join(root, "home"),
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                VERA_FIXTURE_ROOT: root,
                VERA_HOME: home,
            },
            stdout: "ignore",
            stderr: "ignore",
        },
    );
    registerCleanup(async () => {
        installer.kill("SIGKILL");
        await installer.exited;
    });

    let journalled: { pid: number; started_at: string } | undefined;
    const deadline = Date.now() + 8_000;
    while (journalled === undefined && Date.now() < deadline) {
        try {
            const parsed = JSON.parse(readFileSync(upgradeJournalPath(prefix), "utf8"));
            journalled = parsed.launched_host;
        } catch {
            // The journal is not there yet, or is being replaced.
        }
        if (journalled === undefined) await new Promise((done) => setTimeout(done, 25));
    }
    installer.kill("SIGKILL");
    await installer.exited;

    const hung = journalled?.pid;
    expect(hung, "the launch was not journalled").toBeGreaterThan(0);
    killOnCleanup(hung as number);
    expect(isAlive(hung as number), "the launched host did not outlive its installer").toBe(true);
    const named = Date.now() + 3_000;
    while (!spawnedPids(next).includes(hung as number) && Date.now() < named) {
        await new Promise((done) => setTimeout(done, 25));
    }
    expect(spawnedPids(next), "the journal names a process that is not the new host").toContain(hung as number);

    await withVeraHome(home, async () => {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: (releaseRoot, recorder) => defaultEnsureHost(releaseRoot, {
                publishTimeoutMs: releaseRoot === next.root ? 300 : 5_000,
                exitGraceMs: 2_000,
                recorder,
            }),
        });
        expect(recovered).toEqual({ recovered: true, buildId: "vera-old" });
    });

    expect(await waitUntilGone(hung as number), "the hung host was left running").toBe(true);
    for (const pid of spawnedPids(next)) {
        expect(await waitUntilGone(pid), "a hung host was left running").toBe(true);
    }
    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    expect(readLockBuild(home).build).toBe("vera-old");
}, 30_000);
