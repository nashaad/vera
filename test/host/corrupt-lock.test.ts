import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    forceStopResidentHost,
    gracefulStopResidentHost,
    unverifiedHostMessage,
    type ForceStopOptions,
    type ForceStopOutcome,
} from "../../src/host/force-stop.ts";
import {
    HostLockUnreadableError,
    inspectHostLockFile,
} from "../../src/host/lockfile.ts";

const veraHostCommand = "bun /opt/vera/share/vera/current/clients/host/main.ts";

const complete = {
    schema_version: 3,
    pid: 101,
    started_at: "2026-08-20T12:00:00.000Z",
    socket_path: "/tmp/vera-test.sock",
    build_id: "vera-abc",
};

interface Damage {
    readonly name: string;
    readonly source: string;
}

// Each keeps a readable PID but cannot be parsed as a whole lock. The start
// time is not trusted in any of them.
const damagedWithPid: readonly Damage[] = [
    {
        name: "no socket_path",
        source: JSON.stringify({ ...complete, socket_path: undefined }),
    },
    {
        name: "an empty socket_path",
        source: JSON.stringify({ ...complete, socket_path: "" }),
    },
    {
        name: "no build_id on a schema 3 lock",
        source: JSON.stringify({ ...complete, build_id: undefined }),
    },
    {
        name: "a build_id that is not a string",
        source: JSON.stringify({ ...complete, build_id: 7 }),
    },
    {
        name: "a project_root that is not a string",
        source: JSON.stringify({ ...complete, project_root: 7 }),
    },
    {
        name: "a schema_version this build does not know",
        source: JSON.stringify({ ...complete, schema_version: 9 }),
    },
    {
        name: "JSON cut off after the pid",
        source: '{\n  "schema_version": 3,\n  "pid": 101,\n  "started_at": "2026-08',
    },
];

// No PID can be read from any of these.
const damagedWithoutPid: readonly Damage[] = [
    { name: "an empty file", source: "" },
    { name: "JSON cut off inside the pid", source: '{ "schema_version": 3, "pid": 10' },
    { name: "text that is not JSON", source: "garbage" },
    { name: "a JSON array", source: "[]" },
    { name: "a JSON null", source: "null" },
    { name: "an object with no pid", source: JSON.stringify({ ...complete, pid: undefined }) },
    { name: "a pid that is a string", source: JSON.stringify({ ...complete, pid: "101" }) },
    { name: "a pid that is zero", source: JSON.stringify({ ...complete, pid: 0 }) },
    { name: "a negative pid", source: JSON.stringify({ ...complete, pid: -4 }) },
];

type Stop = (options?: ForceStopOptions) => Promise<ForceStopOutcome | undefined>;

const stops: readonly (readonly [string, Stop])[] = [
    ["force stop", forceStopResidentHost],
    ["graceful stop", gracefulStopResidentHost],
];

async function withLock<T>(
    source: string,
    run: (path: string) => Promise<T>,
): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "vera-corrupt-lock-"));
    try {
        const path = join(root, "host.json");
        await writeFile(path, source);
        return await run(path);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("a lock that does not parse is reported as damaged, with its pid when one can be read", async () => {
    for (const damage of damagedWithPid) {
        const read = await withLock(damage.source, inspectHostLockFile);
        expect(read, damage.name).toMatchObject({ state: "damaged", pid: 101 });
    }
    for (const damage of damagedWithoutPid) {
        const read = await withLock(damage.source, inspectHostLockFile);
        expect(read.state, damage.name).toBe("damaged");
        expect("pid" in read, damage.name).toBe(false);
    }
    const complete3 = await withLock(JSON.stringify(complete), inspectHostLockFile);
    expect(complete3.state).toBe("valid");
    expect(await inspectHostLockFile(join(tmpdir(), "vera-no-such-lock.json")))
        .toEqual({ state: "absent" });
});

for (const [label, stop] of stops) {
    test(`${label} signals nothing for a Vera-looking pid in a damaged lock and keeps the lock`, async () => {
        for (const damage of damagedWithPid) {
            await withLock(damage.source, async (path) => {
                const signals: string[] = [];
                const outcome = await stop({
                    lockPath: path,
                    kill: (pid, signal) => signals.push(`${signal}:${pid}`),
                    isProcessAlive: () => true,
                    readStartedAt: () => Date.parse(complete.started_at),
                    readCommand: () => veraHostCommand,
                });

                expect(outcome, damage.name).toEqual({
                    pid: 101,
                    endedBy: "unverified",
                    lockDamaged: true,
                });
                expect(signals, damage.name).toEqual([]);
                expect(existsSync(path), damage.name).toBe(true);
            });
        }
    });

    test(`${label} keeps a damaged lock when the command line of its pid is unreadable`, async () => {
        await withLock(damagedWithPid[0]!.source, async (path) => {
            const signals: string[] = [];
            const outcome = await stop({
                lockPath: path,
                kill: (pid, signal) => signals.push(`${signal}:${pid}`),
                isProcessAlive: () => true,
                readStartedAt: () => Date.parse(complete.started_at),
                readCommand: () => undefined,
            });

            expect(outcome?.endedBy).toBe("unverified");
            expect(signals).toEqual([]);
            expect(existsSync(path)).toBe(true);
        });
    });

    test(`${label} clears a damaged lock whose pid is not Vera, without signalling it`, async () => {
        for (const damage of damagedWithPid) {
            await withLock(damage.source, async (path) => {
                const signals: string[] = [];
                const outcome = await stop({
                    lockPath: path,
                    kill: (pid, signal) => signals.push(`${signal}:${pid}`),
                    isProcessAlive: () => true,
                    readStartedAt: () => Date.parse(complete.started_at),
                    readCommand: () => "/usr/sbin/syslogd",
                });

                expect(outcome, damage.name).toEqual({
                    pid: 101,
                    endedBy: "not_ours",
                    lockDamaged: true,
                });
                expect(signals, damage.name).toEqual([]);
                expect(existsSync(path), damage.name).toBe(false);
            });
        }
    });

    test(`${label} clears a damaged lock whose pid is dead`, async () => {
        for (const damage of damagedWithPid) {
            await withLock(damage.source, async (path) => {
                const outcome = await stop({
                    lockPath: path,
                    kill: () => {},
                    isProcessAlive: () => false,
                });

                expect(outcome, damage.name).toEqual({
                    pid: 101,
                    endedBy: "already_dead",
                    lockDamaged: true,
                });
                expect(existsSync(path), damage.name).toBe(false);
            });
        }
    });

    test(`${label} does not say no host is recorded when the lock has no readable pid`, async () => {
        for (const damage of damagedWithoutPid) {
            await withLock(damage.source, async (path) => {
                const signals: string[] = [];
                const error = await stop({
                    lockPath: path,
                    kill: (pid, signal) => signals.push(`${signal}:${pid}`),
                    isProcessAlive: () => true,
                }).then(() => undefined, (thrown: unknown) => thrown);

                expect(error, damage.name).toBeInstanceOf(HostLockUnreadableError);
                expect((error as HostLockUnreadableError).lockPath).toBe(path);
                expect((error as Error).message).toContain(path);
                expect(signals, damage.name).toEqual([]);
                expect(existsSync(path), damage.name).toBe(true);
            });
        }
    });

    test(`${label} still treats a missing lock as no host`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-corrupt-lock-"));
        try {
            expect(await stop({ lockPath: join(root, "host.json") }))
                .toBeUndefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("the damaged-lock messages name the pid or the path and say what to do", () => {
    expect(
        unverifiedHostMessage(
            { pid: 101, lockDamaged: true },
            "/tmp/vera/runtime/host.json",
        ),
    ).toBe(
        "Could not confirm PID 101 is the Vera host (its lockfile is damaged);"
            + " left it running and kept its lockfile. Check that PID 101 is a"
            + " Vera host before you stop it. If it is not, deleting"
            + " /tmp/vera/runtime/host.json is safe.",
    );
    const message = new HostLockUnreadableError("/tmp/vera/runtime/host.json").message;
    expect(message).toContain("/tmp/vera/runtime/host.json");
    expect(message).toContain("cannot tell whether a Vera host is running");
    expect(message).not.toContain("No resident Vera host");
});
