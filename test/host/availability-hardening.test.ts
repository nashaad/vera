import { expect, test } from "bun:test";

import { installHostCrashGuard } from "../../clients/host/crash-guard.ts";
import { ensureResidentHost } from "../../src/host/discovery.ts";
import {
    HostUnresponsiveError,
    type HostLockDiagnosis,
    type HostLockfile,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import { runResidentHostProcess } from "../../clients/host/process-lifecycle.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";

const record: HostLockRecord = {
    schema_version: 2,
    pid: 101,
    started_at: "2026-08-20T12:00:00.000Z",
    socket_path: "/tmp/vera-test.sock",
    build_id: thisProcessBuildId(),
};

function wedgedLockfile(started: () => boolean): HostLockfile {
    return {
        publish(): Promise<HostLockRecord> {
            throw new Error("not used");
        },
        async read(): Promise<HostLockRecord | undefined> {
            return started() ? record : undefined;
        },
        async diagnose(): Promise<HostLockDiagnosis> {
            return started() ? {} : { record, wedged: true };
        },
    };
}

test("a slow answer to the replacement prompt does not time out the start", async () => {
    // The question is put to a person, and people are slower than the deadline
    // that bounds waiting on machines.
    let clock = 0;
    let replaced = false;
    const host = await ensureResidentHost({
        lockfile: wedgedLockfile(() => replaced),
        startupTimeoutMs: 5_000,
        now: () => clock,
        wait: async () => {},
        confirmBusyUpgrade: async () => {
            clock += 60_000;
            return true;
        },
        terminateWedgedHost: () => {
            replaced = true;
        },
        startHost: () => {},
    });

    expect(host).toEqual(record);
});

test("the deadline still bounds the work after a slow answer", async () => {
    let clock = 0;
    await expect(ensureResidentHost({
        lockfile: wedgedLockfile(() => false),
        startupTimeoutMs: 5_000,
        now: () => clock,
        wait: async () => {},
        confirmBusyUpgrade: async () => {
            clock += 60_000;
            return true;
        },
        terminateWedgedHost: () => {},
        startHost: () => {
            clock += 10_000;
        },
    })).rejects.toThrow("did not start before its deadline");
});

test("a kill that does not take stops the replacement", async () => {
    let starts = 0;
    await expect(ensureResidentHost({
        lockfile: wedgedLockfile(() => false),
        wait: async () => {},
        confirmBusyUpgrade: () => true,
        terminateWedgedHost: () => {
            throw new Error(
                "Resident Vera host PID 101 did not stop, so a new one was not"
                    + " started.",
            );
        },
        startHost: () => {
            starts += 1;
        },
    })).rejects.toThrow("did not stop");
    expect(starts).toBe(0);
});

test("a declined replacement names the host that is not responding", async () => {
    await expect(ensureResidentHost({
        lockfile: wedgedLockfile(() => false),
        confirmBusyUpgrade: () => false,
        startHost: () => {},
    })).rejects.toBeInstanceOf(HostUnresponsiveError);
});

test("the crash guard stops absorbing once faults stop being occasional", () => {
    const entries: Record<string, unknown>[] = [];
    const exits: number[] = [];
    const uninstall = installHostCrashGuard(
        (entry) => entries.push(entry as Record<string, unknown>),
        (code) => exits.push(code),
    );
    try {
        for (let index = 0; index < 50; index += 1) {
            process.emit("uncaughtException", new Error(`fault ${index}`));
        }
    } finally {
        uninstall();
    }

    expect(exits).toEqual([1]);
    expect(entries.at(-1)?.type).toBe("host_fault_limit_reached");
    expect(entries[0]?.fault_count).toBe(1);
});

test("a host that cannot close exits rather than staying half alive", async () => {
    const exits: number[] = [];
    let stoppedAbsorbing = false;
    await runResidentHostProcess({
        shutdownRequested: Promise.resolve(),
        close: () => Promise.reject(new Error("socket teardown failed")),
    }, {
        waitForSignal: () => ({
            promise: new Promise<void>(() => {}),
            dispose: () => {},
        }),
        stopAbsorbingFaults: () => {
            stoppedAbsorbing = true;
        },
        exit: (code) => exits.push(code),
    });

    expect(stoppedAbsorbing).toBe(true);
    expect(exits[0]).toBe(1);
});
