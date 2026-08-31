import { expect, test } from "bun:test";

import {
    ensureResidentHost,
    HostProjectMismatchError,
    HostReplacementBusyError,
} from "../../src/host/discovery.ts";
import type {
    HostLockfile,
    HostLockRecord,
} from "../../src/host/lockfile.ts";
import { HostProtocolMismatchError } from "../../src/host/lockfile.ts";
import { HOST_PROTOCOL_VERSION } from "../../src/host/protocol.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";

const runningHost: HostLockRecord = {
    schema_version: 1,
    pid: 101,
    started_at: "2026-07-17T12:00:00.000Z",
    socket_path: "/tmp/vera-host.sock",
    build_id: thisProcessBuildId(),
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

test("host discovery gracefully replaces a host without project identity", async () => {
    const replacementHost: HostLockRecord = {
        ...runningHost,
        pid: 202,
        project_root: "/checkouts/current",
    };
    let starts = 0;
    let shutdownIfIdleRequests = 0;
    const host = await ensureResidentHost({
        projectRoot: "/checkouts/current",
        lockfile: scriptedLockfile([
            runningHost,
            undefined,
            undefined,
            replacementHost,
        ]),
        startHost: () => {
            starts += 1;
        },
        shutdownForReplacement: async (socketPath, identity, requester) => {
            expect(socketPath).toBe(runningHost.socket_path);
            expect(identity).toEqual({
                pid: runningHost.pid,
                started_at: runningHost.started_at,
                protocol_version: HOST_PROTOCOL_VERSION,
            });
            expect(requester).toBe(HOST_PROTOCOL_VERSION);
            return {
                type: "shutdown_for_replacement_accepted",
                pid: runningHost.pid,
                started_at: runningHost.started_at,
            };
        },
        shutdownIfIdle: async () => {
            shutdownIfIdleRequests += 1;
            return undefined;
        },
        wait: async () => {},
    });

    expect(host).toEqual(replacementHost);
    expect(starts).toBe(1);
    expect(shutdownIfIdleRequests).toBe(0);
});

test("a host that wins the startup race is also checked for project identity", async () => {
    const wrongHost: HostLockRecord = {
        ...runningHost,
        project_root: "/checkouts/other",
    };
    const replacementHost: HostLockRecord = {
        ...runningHost,
        pid: 202,
        project_root: "/checkouts/current",
    };
    let starts = 0;
    const host = await ensureResidentHost({
        projectRoot: "/checkouts/current",
        lockfile: scriptedLockfile([
            undefined,
            wrongHost,
            wrongHost,
            undefined,
            undefined,
            replacementHost,
        ]),
        startHost: () => {
            starts += 1;
        },
        shutdownForReplacement: async () => ({
            type: "shutdown_for_replacement_accepted",
            pid: wrongHost.pid,
            started_at: wrongHost.started_at,
        }),
        wait: async () => {},
    });

    expect(host).toEqual(replacementHost);
    expect(starts).toBe(2);
});

test("a busy project mismatch stays fail closed when replacement is declined", async () => {
    let starts = 0;
    const attempt = ensureResidentHost({
        projectRoot: "/checkouts/current",
        lockfile: scriptedLockfile([{
            ...runningHost,
            project_root: "/checkouts/other",
        }]),
        startHost: () => {
            starts += 1;
        },
        shutdownForReplacement: async () => ({
            type: "shutdown_for_replacement_refused",
            reason: "busy",
        }),
        shutdownIfIdle: async () => ({
            type: "shutdown_if_idle_refused",
            reason: "busy",
        }),
    });

    await expect(attempt).rejects.toBeInstanceOf(HostProjectMismatchError);
    await expect(attempt).rejects.toThrow(
        "Resident host is bound to /checkouts/other, not /checkouts/current",
    );
    expect(starts).toBe(0);
});

test("a busy project mismatch can be confirmed and replaced", async () => {
    const mismatchedHost: HostLockRecord = {
        ...runningHost,
        project_root: "/checkouts/other",
    };
    const replacementHost: HostLockRecord = {
        ...runningHost,
        pid: 202,
        project_root: "/checkouts/current",
    };
    let starts = 0;
    let terminated: number | undefined;
    const host = await ensureResidentHost({
        projectRoot: "/checkouts/current",
        lockfile: scriptedLockfile([
            mismatchedHost,
            mismatchedHost,
            undefined,
            undefined,
            replacementHost,
        ]),
        startHost: () => {
            starts += 1;
        },
        shutdownForReplacement: async () => ({
            type: "shutdown_for_replacement_refused",
            reason: "busy",
        }),
        shutdownIfIdle: async () => ({
            type: "shutdown_if_idle_refused",
            reason: "busy",
        }),
        confirmBusyUpgrade: async (error) => {
            expect(error).toBeInstanceOf(HostProjectMismatchError);
            return true;
        },
        terminateHost: async (pid) => {
            terminated = pid;
        },
        wait: async () => {},
    });

    expect(host).toEqual(replacementHost);
    expect(terminated).toBe(mismatchedHost.pid);
    expect(starts).toBe(1);
});

test("replaceExisting on a busy project-mismatched host does not terminate", async () => {
    const mismatchedHost: HostLockRecord = {
        ...runningHost,
        project_root: "/checkouts/other",
    };
    let terminated = 0;
    await expect(ensureResidentHost({
        projectRoot: "/checkouts/current",
        lockfile: scriptedLockfile([mismatchedHost]),
        replaceExisting: true,
        startHost: () => {
            throw new Error("must not start");
        },
        shutdownForReplacement: async () => ({
            type: "shutdown_for_replacement_refused",
            reason: "busy",
        }),
        shutdownIfIdle: async () => ({
            type: "shutdown_if_idle_refused",
            reason: "busy",
        }),
        confirmBusyUpgrade: () => true,
        terminateHost: () => {
            terminated += 1;
        },
        wait: async () => {},
    })).rejects.toBeInstanceOf(HostReplacementBusyError);
    expect(terminated).toBe(0);
});

test("a gracefully closing project host is not mistaken for wedged", async () => {
    const mismatchedHost: HostLockRecord = {
        ...runningHost,
        project_root: "/checkouts/other",
    };
    const replacementHost: HostLockRecord = {
        ...runningHost,
        pid: 202,
        project_root: "/checkouts/current",
    };
    const readings = [
        mismatchedHost,
        undefined,
        undefined,
        undefined,
        replacementHost,
    ];
    let diagnoses = 0;
    let starts = 0;
    const host = await ensureResidentHost({
        projectRoot: "/checkouts/current",
        lockfile: {
            ...scriptedLockfile(readings),
            diagnose: async () => {
                diagnoses += 1;
                return diagnoses === 1
                    ? { record: mismatchedHost, wedged: true }
                    : {};
            },
        },
        startHost: () => {
            starts += 1;
        },
        shutdownForReplacement: async () => ({
            type: "shutdown_for_replacement_accepted",
            pid: mismatchedHost.pid,
            started_at: mismatchedHost.started_at,
        }),
        confirmBusyUpgrade: () => {
            throw new Error("graceful shutdown must not require confirmation");
        },
        wait: async () => {},
    });

    expect(host).toEqual(replacementHost);
    expect(diagnoses).toBe(3);
    expect(starts).toBe(1);
});

test("an older-protocol handoff rechecks the winning host's project", async () => {
    const protocolMismatch = new HostProtocolMismatchError(
        runningHost.pid,
        HOST_PROTOCOL_VERSION - 1,
        runningHost.started_at,
        runningHost.socket_path,
    );
    const foreignHost: HostLockRecord = {
        ...runningHost,
        pid: 202,
        project_root: "/checkouts/other",
    };
    let reads = 0;
    let replacementRequests = 0;
    const attempt = ensureResidentHost({
        projectRoot: "/checkouts/current",
        lockfile: {
            publish(): Promise<HostLockRecord> {
                throw new Error("not used");
            },
            read(): Promise<HostLockRecord | undefined> {
                reads += 1;
                return reads === 1
                    ? Promise.reject(protocolMismatch)
                    : Promise.resolve(foreignHost);
            },
        },
        startHost: () => {
            throw new Error("must not start");
        },
        shutdownForReplacement: async () => {
            replacementRequests += 1;
            return replacementRequests === 1
                ? {
                    type: "shutdown_for_replacement_refused",
                    reason: "identity_mismatch",
                }
                : {
                    type: "shutdown_for_replacement_refused",
                    reason: "requester_not_newer",
                };
        },
        shutdownIfIdle: async () => ({
            type: "shutdown_if_idle_refused",
            reason: "requester_not_newer",
        }),
    });

    await expect(attempt).rejects.toBeInstanceOf(HostProjectMismatchError);
    expect(replacementRequests).toBe(2);
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

test("host discovery never asks an unknown or newer host to shut down", async () => {
    for (const actualVersion of [undefined, HOST_PROTOCOL_VERSION + 1]) {
        const mismatch = new HostProtocolMismatchError(
            101,
            actualVersion,
            runningHost.started_at,
            runningHost.socket_path,
        );
        let shutdownRequests = 0;
        await expect(ensureResidentHost({
            lockfile: {
                publish(): Promise<HostLockRecord> {
                    throw new Error("not used");
                },
                read(): Promise<HostLockRecord | undefined> {
                    return Promise.reject(mismatch);
                },
            },
            startHost(): void {
                throw new Error("must not start");
            },
            shutdownIfIdle: async () => {
                shutdownRequests += 1;
                return undefined;
            },
        })).rejects.toBe(mismatch);
        expect(shutdownRequests).toBe(0);
    }
});

test("host discovery replaces an incompatible host only after idle shutdown", async () => {
    const mismatch = new HostProtocolMismatchError(
        101,
        2,
        runningHost.started_at,
        runningHost.socket_path,
    );
    let reads = 0;
    let starts = 0;
    const lockfile: HostLockfile = {
        publish(): Promise<HostLockRecord> {
            throw new Error("not used");
        },
        read(): Promise<HostLockRecord | undefined> {
            reads += 1;
            if (reads <= 2) {
                return Promise.reject(mismatch);
            }
            return Promise.resolve(reads === 3 ? undefined : runningHost);
        },
    };

    const host = await ensureResidentHost({
        lockfile,
        startHost: () => {
            starts += 1;
        },
        shutdownIfIdle: async (socketPath, identity) => {
            expect(socketPath).toBe(runningHost.socket_path);
            expect(identity).toMatchObject({
                pid: 101,
                started_at: runningHost.started_at,
                protocol_version: 2,
            });
            return {
                type: "shutdown_if_idle_accepted",
                pid: 101,
                started_at: runningHost.started_at,
            };
        },
        shutdownForReplacement: async () => undefined,
        wait: async () => {},
    });

    expect(host).toEqual(runningHost);
    expect(starts).toBe(1);
});

test("host discovery prefers graceful replacement over attachment-free shutdown", async () => {
    const mismatch = new HostProtocolMismatchError(
        101,
        31,
        runningHost.started_at,
        runningHost.socket_path,
    );
    let reads = 0;
    let idleRequests = 0;
    let starts = 0;
    const host = await ensureResidentHost({
        lockfile: {
            publish(): Promise<HostLockRecord> {
                throw new Error("not used");
            },
            read(): Promise<HostLockRecord | undefined> {
                reads += 1;
                if (reads <= 2) return Promise.reject(mismatch);
                return Promise.resolve(reads === 3 ? undefined : runningHost);
            },
        },
        startHost: () => {
            starts += 1;
        },
        shutdownForReplacement: async (socketPath, identity, requester) => {
            expect(socketPath).toBe(runningHost.socket_path);
            expect(identity).toMatchObject({ pid: 101 });
            expect(requester).toBe(HOST_PROTOCOL_VERSION);
            return {
                type: "shutdown_for_replacement_accepted",
                pid: 101,
                started_at: runningHost.started_at,
            };
        },
        shutdownIfIdle: async () => {
            idleRequests += 1;
            return undefined;
        },
        wait: async () => {},
    });

    expect(host).toEqual(runningHost);
    expect(idleRequests).toBe(0);
    expect(starts).toBe(1);
});

test("host discovery leaves a busy incompatible host running", async () => {
    const mismatch = new HostProtocolMismatchError(
        101,
        2,
        runningHost.started_at,
        runningHost.socket_path,
    );
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
        startHost(): void {
            throw new Error("must not start");
        },
        shutdownIfIdle: async () => ({
            type: "shutdown_if_idle_refused",
            reason: "busy",
        }),
        shutdownForReplacement: async () => undefined,
    })).rejects.toBe(mismatch);
});

test("host discovery can confirm and replace a busy older host", async () => {
    const mismatch = new HostProtocolMismatchError(
        101,
        2,
        runningHost.started_at,
        runningHost.socket_path,
    );
    let reads = 0;
    let terminated: number | undefined;
    let starts = 0;
    const host = await ensureResidentHost({
        lockfile: {
            publish(): Promise<HostLockRecord> {
                throw new Error("not used");
            },
            read(): Promise<HostLockRecord | undefined> {
                reads += 1;
                if (reads === 1) return Promise.reject(mismatch);
                if (reads === 2) return Promise.reject(mismatch);
                if (reads === 3 || reads === 4) {
                    return Promise.resolve(undefined);
                }
                return Promise.resolve(runningHost);
            },
        },
        startHost: () => {
            starts += 1;
        },
        shutdownIfIdle: async () => ({
            type: "shutdown_if_idle_refused",
            reason: "busy",
        }),
        shutdownForReplacement: async () => undefined,
        confirmBusyUpgrade: async () => true,
        terminateHost: async (pid) => {
            terminated = pid;
        },
        wait: async () => {},
    });

    expect(host).toEqual(runningHost);
    expect(terminated).toBe(101);
    expect(starts).toBe(1);
});

test("replaceExisting on a busy older-protocol host does not terminate", async () => {
    const mismatch = new HostProtocolMismatchError(
        101,
        2,
        runningHost.started_at,
        runningHost.socket_path,
    );
    let terminated = 0;
    await expect(ensureResidentHost({
        lockfile: {
            publish(): Promise<HostLockRecord> {
                throw new Error("not used");
            },
            read(): Promise<HostLockRecord | undefined> {
                return Promise.reject(mismatch);
            },
        },
        replaceExisting: true,
        startHost: () => {
            throw new Error("must not start");
        },
        shutdownIfIdle: async () => ({
            type: "shutdown_if_idle_refused",
            reason: "busy",
        }),
        shutdownForReplacement: async () => undefined,
        confirmBusyUpgrade: () => true,
        terminateHost: () => {
            terminated += 1;
        },
        wait: async () => {},
    })).rejects.toBeInstanceOf(HostReplacementBusyError);
    expect(terminated).toBe(0);
});

test("replaceExisting shuts down a healthy host and starts another", async () => {
    const replacementHost: HostLockRecord = {
        ...runningHost,
        pid: 202,
        started_at: "2026-08-30T12:00:00.000Z",
    };
    let starts = 0;
    let terminated = 0;
    const host = await ensureResidentHost({
        lockfile: scriptedLockfile([
            runningHost,
            undefined,
            undefined,
            replacementHost,
        ]),
        replaceExisting: true,
        startHost: () => {
            starts += 1;
        },
        shutdownForReplacement: async (socketPath, identity, requester) => {
            expect(socketPath).toBe(runningHost.socket_path);
            expect(identity).toEqual({
                pid: runningHost.pid,
                started_at: runningHost.started_at,
                protocol_version: HOST_PROTOCOL_VERSION,
            });
            expect(requester).toBe(HOST_PROTOCOL_VERSION);
            return {
                type: "shutdown_for_replacement_accepted",
                pid: runningHost.pid,
                started_at: runningHost.started_at,
            };
        },
        terminateHost: () => {
            terminated += 1;
        },
        wait: async () => {},
    });

    expect(host).toEqual(replacementHost);
    expect(starts).toBe(1);
    expect(terminated).toBe(0);
});

test("replaceExisting on a busy host does not terminate the pid", async () => {
    let starts = 0;
    let terminated = 0;
    await expect(ensureResidentHost({
        lockfile: scriptedLockfile([runningHost]),
        replaceExisting: true,
        startHost: () => {
            starts += 1;
        },
        shutdownForReplacement: async () => ({
            type: "shutdown_for_replacement_refused",
            reason: "busy",
        }),
        shutdownIfIdle: async () => ({
            type: "shutdown_if_idle_refused",
            reason: "busy",
        }),
        confirmBusyUpgrade: () => true,
        terminateHost: () => {
            terminated += 1;
        },
        wait: async () => {},
    })).rejects.toBeInstanceOf(HostReplacementBusyError);
    expect(starts).toBe(0);
    expect(terminated).toBe(0);
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

test("replacement shutdown and startup share one fixed deadline", async () => {
    const mismatch = new HostProtocolMismatchError(
        101,
        31,
        runningHost.started_at,
        runningHost.socket_path,
    );
    let reads = 0;
    let now = 0;
    let starts = 0;
    const waits: number[] = [];
    await expect(ensureResidentHost({
        lockfile: {
            publish(): Promise<HostLockRecord> {
                throw new Error("not used");
            },
            read(): Promise<HostLockRecord | undefined> {
                reads += 1;
                if (reads <= 2) return Promise.reject(mismatch);
                return Promise.resolve(undefined);
            },
        },
        startHost: () => {
            starts += 1;
        },
        shutdownForReplacement: async () => ({
            type: "shutdown_for_replacement_accepted",
            pid: 101,
            started_at: runningHost.started_at,
        }),
        startupTimeoutMs: 50,
        pollIntervalMs: 30,
        now: () => now,
        wait: async (delayMs) => {
            waits.push(delayMs);
            now += delayMs;
        },
    })).rejects.toThrow("Resident host did not start before its deadline");
    expect(starts).toBe(1);
    expect(waits).toEqual([30, 20]);
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
