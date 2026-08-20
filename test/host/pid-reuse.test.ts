import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forceStopResidentHost } from "../../src/host/force-stop.ts";
import {
    createHostLockfile,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import {
    parseElapsedTime,
    processStartedAt,
    recordMatchesRunningProcess,
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
    expect(recordMatchesRunningProcess({
        pid: process.pid,
        started_at: startedAt,
    })).toBe(true);
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

test("the identity check does not depend on the reader's timezone", () => {
    // ps prints local time with no zone, so a start timestamp read back under
    // a different TZ lands hours away and a live host reads as a stranger.
    const previous = process.env.TZ;
    try {
        const startedAt = new Date(Date.now() - process.uptime() * 1_000)
            .toISOString();
        for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
            process.env.TZ = zone;
            expect(recordMatchesRunningProcess({
                pid: process.pid,
                started_at: startedAt,
            })).toBe(true);
        }
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
});

test("a pid that started long after the record is a different process", () => {
    expect(recordMatchesRunningProcess(
        record,
        () => Date.parse("2026-08-20T18:00:00.000Z"),
    )).toBe(false);
});

test("a start time within the clock tolerance still matches", () => {
    expect(recordMatchesRunningProcess(
        record,
        () => Date.parse(record.started_at) + 1_000,
    )).toBe(true);
});

test("an unreadable start time is not treated as proof of reuse", () => {
    expect(recordMatchesRunningProcess(record, () => undefined)).toBe(true);
    expect(processStartedAt(2_147_483_646)).toBeUndefined();
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
