import { expect, test } from "bun:test";

import { ensureResidentHost } from "../../src/host/discovery.ts";
import type {
    HostLockfile,
    HostLockRecord,
} from "../../src/host/lockfile.ts";
import { HostProtocolMismatchError } from "../../src/host/lockfile.ts";

const runningHost: HostLockRecord = {
    schema_version: 1,
    pid: 101,
    started_at: "2026-07-17T12:00:00.000Z",
    socket_path: "/tmp/vera-host.sock",
};

test("host discovery reuses an already verified resident host", async () => {
    let starts = 0;
    const host = await ensureResidentHost({
        lockfile: scriptedLockfile([runningHost]),
        startHost: () => {
            starts += 1;
        },
    });

    expect(host).toEqual(runningHost);
    expect(starts).toBe(0);
});

test("host discovery starts once and waits for a verified lock record", async () => {
    let starts = 0;
    let now = 0;
    const waits: number[] = [];
    const host = await ensureResidentHost({
        lockfile: scriptedLockfile([undefined, undefined, runningHost]),
        startHost: () => {
            starts += 1;
        },
        startupTimeoutMs: 100,
        pollIntervalMs: 25,
        now: () => now,
        wait: async (delayMs) => {
            waits.push(delayMs);
            now += delayMs;
        },
    });

    expect(host).toEqual(runningHost);
    expect(starts).toBe(1);
    expect(waits).toEqual([25]);
});

test("host discovery does not start over an incompatible live host", async () => {
    let starts = 0;
    const mismatch = new HostProtocolMismatchError(101);
    const lockfile: HostLockfile = {
        publish(): Promise<HostLockRecord> {
            throw new Error("not used");
        },
        read(): Promise<HostLockRecord | undefined> {
            return Promise.reject(mismatch);
        },
    };

    await expect(ensureResidentHost({
        lockfile,
        startHost: () => {
            starts += 1;
        },
    })).rejects.toBe(mismatch);
    expect(starts).toBe(0);
});

test("host discovery stops at one fixed startup deadline", async () => {
    let now = 0;
    await expect(ensureResidentHost({
        lockfile: scriptedLockfile([undefined]),
        startHost(): void {},
        startupTimeoutMs: 50,
        pollIntervalMs: 30,
        now: () => now,
        wait: async (delayMs) => {
            now += delayMs;
        },
    })).rejects.toThrow("Resident host did not start before its deadline");
    expect(now).toBe(50);
});

test("host discovery requires positive timing limits", async () => {
    await expect(ensureResidentHost({
        lockfile: scriptedLockfile([]),
        startHost(): void {},
        startupTimeoutMs: 0,
    })).rejects.toThrow("host startup timeout must be a positive finite number");
    await expect(ensureResidentHost({
        lockfile: scriptedLockfile([]),
        startHost(): void {},
        pollIntervalMs: Number.POSITIVE_INFINITY,
    })).rejects.toThrow("host polling interval must be a positive finite number");
});

function scriptedLockfile(
    readings: Array<HostLockRecord | undefined>,
): HostLockfile {
    return {
        publish(): Promise<HostLockRecord> {
            throw new Error("not used");
        },
        async read(): Promise<HostLockRecord | undefined> {
            return readings.shift();
        },
    };
}
