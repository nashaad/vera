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
import { HOST_PROTOCOL_VERSION } from "../../src/host/protocol.ts";
import {
    checkRecordIdentity,
    parseElapsedTime,
    processCommandLine,
    processStartedAt,
} from "../../src/host/process-identity.ts";

const record: HostLockRecord = {
    schema_version: 2,
    pid: 101,
    started_at: "2026-08-20T12:00:00.000Z",
    socket_path: "/tmp/vera-test.sock",
};

const veraHostCommand = "bun /opt/vera/share/vera/current/clients/host/main.ts";

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

test("a recorded start time that does not parse is unknown unless the command line rules the pid out", () => {
    const unparsable = { pid: record.pid, started_at: "not a timestamp" };
    const measured = () => Date.parse(record.started_at);
    expect(checkRecordIdentity(unparsable, measured, () => veraHostCommand))
        .toBe("unknown");
    expect(checkRecordIdentity(unparsable, measured, () => undefined))
        .toBe("unknown");
    expect(checkRecordIdentity(unparsable, measured, () => "sleep 60"))
        .toBe("mismatch");
    expect(checkRecordIdentity(unparsable, () => undefined, () => "sleep 60"))
        .toBe("unknown");
    expect(checkRecordIdentity(record, measured, () => "sleep 60")).toBe("match");
});

test("the command line of a live pid is read in full, and a gone pid has none", () => {
    expect(processCommandLine(process.pid)).toContain("bun");
    expect(processCommandLine(2_147_483_646)).toBeUndefined();
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

const unreadableStartTimes: readonly unknown[] = [
    "not a timestamp",
    "",
    42,
    null,
    undefined,
];

test("force stop signals nothing for a Vera-looking pid whose lockfile start time is not a time", async () => {
    for (const startedAt of unreadableStartTimes) {
        const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
        const path = join(root, "host.json");
        try {
            await writeFile(
                path,
                `${JSON.stringify({ ...record, started_at: startedAt })}\n`,
            );
            const signals: string[] = [];
            const outcome = await forceStopResidentHost({
                lockPath: path,
                kill: (pid, signal) => signals.push(`${signal}:${pid}`),
                isProcessAlive: () => true,
                readStartedAt: () => Date.parse(record.started_at),
                readCommand: () => veraHostCommand,
            });

            expect(outcome).toEqual({
                pid: 101,
                endedBy: "unverified",
                lockStartTimeInvalid: true,
            });
            expect(signals).toEqual([]);
            expect(existsSync(path)).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("a graceful stop signals nothing for a Vera-looking pid whose lockfile start time is not a time", async () => {
    for (const startedAt of unreadableStartTimes) {
        const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
        const path = join(root, "host.json");
        try {
            await writeFile(
                path,
                `${JSON.stringify({ ...record, started_at: startedAt })}\n`,
            );
            const signals: string[] = [];
            const outcome = await gracefulStopResidentHost({
                lockPath: path,
                kill: (pid, signal) => signals.push(`${signal}:${pid}`),
                isProcessAlive: () => true,
                readStartedAt: () => Date.parse(record.started_at),
                readCommand: () => veraHostCommand,
            });

            expect(outcome).toEqual({
                pid: 101,
                endedBy: "unverified",
                lockStartTimeInvalid: true,
            });
            expect(signals).toEqual([]);
            expect(existsSync(path)).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("a lockfile whose start time is not a time is stale when its pid is not Vera", async () => {
    for (const stop of [forceStopResidentHost, gracefulStopResidentHost]) {
        const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
        const path = join(root, "host.json");
        try {
            await writeFile(
                path,
                `${JSON.stringify({ ...record, started_at: "not a timestamp" })}\n`,
            );
            const signals: string[] = [];
            const outcome = await stop({
                lockPath: path,
                kill: (pid, signal) => signals.push(`${signal}:${pid}`),
                isProcessAlive: () => true,
                readStartedAt: () => Date.parse(record.started_at),
                readCommand: () => "/usr/sbin/syslogd",
            });

            expect(outcome).toEqual({ pid: 101, endedBy: "not_ours" });
            expect(signals).toEqual([]);
            expect(existsSync(path)).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("a lockfile whose start time is not a time keeps its refusal when the command line is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(
            path,
            `${JSON.stringify({ ...record, started_at: "not a timestamp" })}\n`,
        );
        const signals: string[] = [];
        const outcome = await forceStopResidentHost({
            lockPath: path,
            kill: (pid, signal) => signals.push(`${signal}:${pid}`),
            isProcessAlive: () => true,
            readStartedAt: () => Date.parse(record.started_at),
            readCommand: () => undefined,
        });

        expect(outcome?.endedBy).toBe("unverified");
        expect(signals).toEqual([]);
        expect(existsSync(path)).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a lockfile whose start time is not a time for a dead pid is cleared", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(
            path,
            `${JSON.stringify({ ...record, started_at: "not a timestamp" })}\n`,
        );
        const outcome = await forceStopResidentHost({
            lockPath: path,
            kill: () => {},
            isProcessAlive: () => false,
        });

        expect(outcome).toEqual({ pid: 101, endedBy: "already_dead" });
        expect(existsSync(path)).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a lockfile whose start time is not a time diagnoses as wedged only while its pid looks like Vera", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(
            path,
            `${JSON.stringify({ ...record, started_at: "not a timestamp" })}\n`,
        );
        const lockfile = createHostLockfile({
            path,
            socketPath: record.socket_path,
            inspectSocket: async () => undefined,
            isProcessAlive: () => true,
            readStartedAt: () => Date.parse(record.started_at),
            readCommand: () => veraHostCommand,
        });

        expect(await lockfile.diagnose?.()).toEqual({
            record: { ...record, started_at: "not a timestamp" },
            wedged: true,
        });

        const notVera = createHostLockfile({
            path,
            socketPath: record.socket_path,
            inspectSocket: async () => undefined,
            isProcessAlive: () => true,
            readStartedAt: () => Date.parse(record.started_at),
            readCommand: () => "sleep 60",
        });
        expect(await notVera.diagnose?.()).toEqual({});
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an answering host with the same pid supplies the start time the lockfile lacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reuse-"));
    const path = join(root, "host.json");
    try {
        await writeFile(
            path,
            `${JSON.stringify({ ...record, started_at: "not a timestamp" })}\n`,
        );
        const answer = {
            pid: record.pid,
            started_at: record.started_at,
            protocol_version: HOST_PROTOCOL_VERSION,
        };
        const lockfile = createHostLockfile({
            path,
            socketPath: record.socket_path,
            inspectSocket: async () => answer,
        });
        expect(await lockfile.read()).toEqual(record);

        const otherPid = createHostLockfile({
            path,
            socketPath: record.socket_path,
            inspectSocket: async () => ({ ...answer, pid: 202 }),
        });
        expect(await otherPid.read()).toBeUndefined();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the unverified message names the pid and says the lockfile was kept", () => {
    expect(unverifiedHostMessage({ pid: 101 })).toBe(
        "Could not confirm PID 101 is the Vera host (process start time"
            + " unreadable); left it running and kept its lockfile. Try again.",
    );
    expect(unverifiedHostMessage({ pid: 101, lockStartTimeInvalid: true })).toBe(
        "Could not confirm PID 101 is the Vera host (its lockfile has no valid"
            + " start time); left it running and kept its lockfile. Check that"
            + " PID 101 is a Vera host before you stop it. If it is not, deleting"
            + " runtime/host.json in the Vera home is safe.",
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
