import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureResidentHost } from "../../src/host/discovery.ts";
import {
    createHostLockfile,
    HostUnresponsiveError,
    readHostLockRecordFile,
    type HostLockDiagnosis,
    type HostLockfile,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import {
    forceStopResidentHost,
    gracefulStopResidentHost,
} from "../../src/host/force-stop.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";

const record: HostLockRecord = {
    schema_version: 2,
    pid: 101,
    started_at: "2026-08-20T12:00:00.000Z",
    socket_path: "/tmp/vera-test.sock",
    build_id: thisProcessBuildId(),
};

test("a silent socket with a live pid diagnoses as wedged, not absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-wedged-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const lockfile = createHostLockfile({
            path,
            socketPath: record.socket_path,
            inspectSocket: async () => undefined,
            isProcessAlive: () => true,
            matchesRecord: () => true,
        });
        expect(await lockfile.read()).toBeUndefined();
        expect(await lockfile.diagnose?.()).toEqual({ record, wedged: true });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a silent socket with a dead pid stays a plain stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-wedged-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const lockfile = createHostLockfile({
            path,
            socketPath: record.socket_path,
            inspectSocket: async () => undefined,
            isProcessAlive: () => false,
        });
        expect(await lockfile.diagnose?.()).toEqual({});
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the plain lock reader answers without a socket handshake", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-wedged-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        expect(await readHostLockRecordFile(path)).toEqual(record);
        expect(await readHostLockRecordFile(join(root, "missing.json")))
            .toBeUndefined();
        await writeFile(path, "not json");
        expect(await readHostLockRecordFile(path)).toBeUndefined();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("discovery offers replacement of a wedged host and starts fresh", async () => {
    let confirmedWith: unknown;
    let terminatedPid: number | undefined;
    let starts = 0;
    let wedged = true;
    const lockfile: HostLockfile = {
        publish(): Promise<HostLockRecord> {
            throw new Error("not used");
        },
        async read(): Promise<HostLockRecord | undefined> {
            if (wedged) return undefined;
            return starts > 0 ? record : undefined;
        },
        async diagnose(): Promise<HostLockDiagnosis> {
            return wedged ? { record, wedged: true } : {};
        },
    };
    const host = await ensureResidentHost({
        lockfile,
        startHost: () => {
            starts += 1;
        },
        confirmBusyUpgrade: (error) => {
            confirmedWith = error;
            return true;
        },
        terminateWedgedHost: (target) => {
            terminatedPid = target.pid;
            wedged = false;
        },
        wait: async () => {},
    });

    expect(confirmedWith).toBeInstanceOf(HostUnresponsiveError);
    expect(terminatedPid).toBe(101);
    expect(starts).toBe(1);
    expect(host).toEqual(record);
});

test("a declined wedged replacement surfaces the unresponsive host", async () => {
    const lockfile: HostLockfile = {
        publish(): Promise<HostLockRecord> {
            throw new Error("not used");
        },
        async read(): Promise<HostLockRecord | undefined> {
            return undefined;
        },
        async diagnose(): Promise<HostLockDiagnosis> {
            return { record, wedged: true };
        },
    };
    let starts = 0;
    await expect(ensureResidentHost({
        lockfile,
        startHost: () => {
            starts += 1;
        },
        confirmBusyUpgrade: () => false,
    })).rejects.toBeInstanceOf(HostUnresponsiveError);
    expect(starts).toBe(0);
});

test("force stop escalates to SIGKILL and clears the lockfile", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-wedged-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const signals: string[] = [];
        let alive = true;
        const outcome = await forceStopResidentHost({
            lockPath: path,
            sigtermGraceMs: 20,
            sigkillGraceMs: 200,
            pollIntervalMs: 5,
            kill: (pid, signal) => {
                signals.push(`${signal}:${pid}`);
                if (signal === "SIGKILL") alive = false;
            },
            isProcessAlive: () => alive,
            matchesRecord: () => true,
            wait: async () => {},
        });
        expect(outcome).toEqual({ pid: 101, endedBy: "sigkill" });
        expect(signals).toEqual(["SIGTERM:101", "SIGKILL:101"]);
        expect(existsSync(path)).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("force stop with no lockfile reports no host", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-wedged-"));
    try {
        expect(await forceStopResidentHost({
            lockPath: join(root, "host.json"),
        })).toBeUndefined();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("force stop of an already dead host only clears the lockfile", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-wedged-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const signals: string[] = [];
        const outcome = await forceStopResidentHost({
            lockPath: path,
            kill: (pid, signal) => signals.push(`${signal}:${pid}`),
            isProcessAlive: () => false,
        });
        expect(outcome).toEqual({ pid: 101, endedBy: "already_dead" });
        expect(signals).toEqual([]);
        expect(existsSync(path)).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("plain stop waits SIGTERM and does not SIGKILL a host that ignores it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-stop-"));
    const path = join(root, "host.json");
    try {
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const signals: string[] = [];
        const outcome = await gracefulStopResidentHost({
            lockPath: path,
            sigtermGraceMs: 40,
            pollIntervalMs: 5,
            kill: (pid, signal) => {
                signals.push(`${signal}:${pid}`);
            },
            isProcessAlive: () => true,
            matchesRecord: () => true,
            wait: async () => {},
        });
        expect(outcome).toEqual({ pid: 101, endedBy: "survived" });
        expect(signals).toEqual(["SIGTERM:101"]);
        expect(existsSync(path)).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
