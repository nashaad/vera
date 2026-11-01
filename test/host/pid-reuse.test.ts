import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    forceStopResidentHost,
    gracefulStopResidentHost,
    unverifiedHostMessage,
} from "../../src/host/force-stop.ts";
import {
    createHostLockfile,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import {
    checkRecordIdentity,
    parseElapsedTime,
    processStartedAt,
} from "../../src/host/process-identity.ts";

const record: HostLockRecord = {
    schema_version: 2,
    pid: 101,
    started_at: "2026-08-20T12:00:00.000Z",
    socket_path: "/tmp/vera-test.sock",
};

test("this process matches its own recorded start time", () => {
    const startedAt = new Date(Date.now() - process.uptime() * 1_000)
        .toISOString();
    expect(checkRecordIdentity({
        pid: process.pid,
        started_at: startedAt,
    })).toBe("match");
    expect(processStartedAt(process.pid)).toBeGreaterThan(0);
});

test("elapsed time parses at every width ps prints", () => {
    expect(parseElapsedTime("00:07")).toBe(7_000);
    expect(parseElapsedTime("01:23")).toBe(83_000);
    expect(parseElapsedTime("10:01:23")).toBe(36_083_000);
    expect(parseElapsedTime(" 2-10:01:23\n")).toBe(208_883_000);
    expect(parseElapsedTime("")).toBeUndefined();
    expect(parseElapsedTime("not a duration")).toBeUndefined();
});

test("elapsed time that is out of range or not finite does not parse", () => {
    expect(parseElapsedTime(`${"9".repeat(400)}-00:00:00`)).toBeUndefined();
    expect(parseElapsedTime("00:60")).toBeUndefined();
    expect(parseElapsedTime("60:00")).toBeUndefined();
    expect(parseElapsedTime("1-24:00:00")).toBeUndefined();
});

test("a start time that is not a usable date is unknown, not a mismatch", () => {
    for (const startedAt of [Number.NaN, Infinity, -Infinity, 1e20, -1e20]) {
        expect(checkRecordIdentity(record, () => startedAt)).toBe("unknown");
    }
});

test("the identity check does not depend on the reader's timezone", () => {
    // ps prints local time with no zone, so a start timestamp read back under
    // a different TZ lands hours away and a live host reads as a stranger.
    const previous = process.env.TZ;
    try {
        const startedAt = new Date(Date.now() - process.uptime() * 1_000)
            .toISOString();
        for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
            process.env.TZ = zone;
            expect(checkRecordIdentity({
                pid: process.pid,
                started_at: startedAt,
            })).toBe("match");
        }
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
});

test("a pid that started long after the record is a different process", () => {
    expect(checkRecordIdentity(
        record,
        () => Date.parse("2026-08-20T18:00:00.000Z"),
    )).toBe("mismatch");
});

test("a start time within the clock tolerance still matches", () => {
    expect(checkRecordIdentity(
        record,
        () => Date.parse(record.started_at) + 1_000,
    )).toBe("match");
});

test("an unreadable start time is unknown, neither a match nor a mismatch", () => {
    expect(checkRecordIdentity(record, () => undefined)).toBe("unknown");
    expect(processStartedAt(2_147_483_646)).toBeUndefined();
});

test("a recorded start time that does not parse is unknown", () => {
    expect(checkRecordIdentity(
        { pid: record.pid, started_at: "not a timestamp" },
        () => Date.parse(record.started_at),
    )).toBe("unknown");
});

test("force stop signals a pid whose start time it measured", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const signals: string[] = [];
        let alive = true;
        const outcome = await forceStopResidentHost({
            lockPath: path,
            kill: (pid, signal) => {
                signals.push(`${signal}:${pid}`);
                alive = false;
            },
            isProcessAlive: () => alive,
            readStartedAt: () => Date.parse(record.started_at),
        });

        expect(outcome).toEqual({ pid: 101, endedBy: "sigterm" });
        expect(signals).toEqual(["SIGTERM:101"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("force stop does not signal a pid whose start time differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const signals: string[] = [];
        const outcome = await forceStopResidentHost({
            lockPath: path,
            kill: (pid, signal) => signals.push(`${signal}:${pid}`),
            isProcessAlive: () => true,
            readStartedAt: () => Date.parse("2026-08-20T18:00:00.000Z"),
        });

        expect(outcome).toEqual({ pid: 101, endedBy: "not_ours" });
        expect(signals).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("force stop leaves a pid whose start time it cannot read running, with its lockfile", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const signals: string[] = [];
        const outcome = await forceStopResidentHost({
            lockPath: path,
            kill: (pid, signal) => signals.push(`${signal}:${pid}`),
            isProcessAlive: () => true,
            readStartedAt: () => undefined,
        });

        expect(outcome).toEqual({ pid: 101, endedBy: "unverified" });
        expect(signals).toEqual([]);
        expect(existsSync(path)).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a graceful stop of a pid it cannot identify signals nothing and keeps the lockfile", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const signals: string[] = [];
        const outcome = await gracefulStopResidentHost({
            lockPath: path,
            kill: (pid, signal) => signals.push(`${signal}:${pid}`),
            isProcessAlive: () => true,
            readStartedAt: () => undefined,
        });

        expect(outcome).toEqual({ pid: 101, endedBy: "unverified" });
        expect(signals).toEqual([]);
        expect(existsSync(path)).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("force stop keeps the lockfile of an unverified pid that exits during the check", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const signals: string[] = [];
        let checks = 0;
        const outcome = await forceStopResidentHost({
            lockPath: path,
            kill: (pid, signal) => signals.push(`${signal}:${pid}`),
            isProcessAlive: () => {
                checks += 1;
                return checks === 1;
            },
            readStartedAt: () => undefined,
        });

        expect(outcome).toEqual({ pid: 101, endedBy: "unverified" });
        expect(signals).toEqual([]);
        expect(existsSync(path)).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a graceful stop keeps the lockfile of an unverified pid that exits during the check", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        let checks = 0;
        const outcome = await gracefulStopResidentHost({
            lockPath: path,
            kill: () => {},
            isProcessAlive: () => {
                checks += 1;
                return checks === 1;
            },
            readStartedAt: () => undefined,
        });

        expect(outcome).toEqual({ pid: 101, endedBy: "unverified" });
        expect(existsSync(path)).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the unverified message names the pid and says the lockfile was kept", () => {
    expect(unverifiedHostMessage(101)).toBe(
        "Could not confirm PID 101 is the Vera host (process start time"
            + " unreadable); left it running and kept its lockfile. Try again.",
    );
});

test("a lock whose pid start time cannot be read still diagnoses as wedged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const lockfile = createHostLockfile({
            path,
            socketPath: record.socket_path,
            inspectSocket: async () => undefined,
            isProcessAlive: () => true,
            readStartedAt: () => undefined,
        });

        expect(await lockfile.diagnose?.()).toEqual({ record, wedged: true });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a lock whose pid started at another time diagnoses as stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const lockfile = createHostLockfile({
            path,
            socketPath: record.socket_path,
            inspectSocket: async () => undefined,
            isProcessAlive: () => true,
            readStartedAt: () => Date.parse("2026-08-20T18:00:00.000Z"),
        });

        expect(await lockfile.diagnose?.()).toEqual({});
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("force stop refuses to signal a pid that belongs to a stranger", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const signals: string[] = [];
        const outcome = await forceStopResidentHost({
            lockPath: path,
            kill: (pid, signal) => signals.push(`${signal}:${pid}`),
            isProcessAlive: () => true,
            matchesRecord: () => false,
        });

        expect(outcome).toEqual({ pid: 101, endedBy: "not_ours" });
        expect(signals).toEqual([]);
        // The record described a host that is gone, so it goes too.
        expect(existsSync(path)).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a reused pid diagnoses as stale rather than wedged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const lockfile = createHostLockfile({
            path,
            socketPath: record.socket_path,
            inspectSocket: async () => undefined,
            isProcessAlive: () => true,
            matchesRecord: () => false,
        });

        expect(await lockfile.diagnose?.()).toEqual({});
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a host that outlives SIGKILL is reported, not claimed as stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const outcome = await forceStopResidentHost({
            lockPath: path,
            sigtermGraceMs: 10,
            sigkillGraceMs: 10,
            pollIntervalMs: 1,
            kill: () => {},
            isProcessAlive: () => true,
            matchesRecord: () => true,
            wait: async () => {},
        });

        expect(outcome).toEqual({ pid: 101, endedBy: "survived" });
        // A live host keeps its record; clearing it would let a second start.
        expect(existsSync(path)).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
