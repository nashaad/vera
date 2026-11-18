import { expect, test } from "bun:test";

import {
    ensureResidentHost,
    HostReplacementBusyError,
} from "../../src/host/discovery.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";
import { HostProtocolMismatchError } from "../../src/host/lockfile.ts";

const identity = { pid: 41, started_at: "2026-11-18T10:00:00.000Z" };
const otherIdentity = { pid: 42, started_at: "2026-11-18T10:01:00.000Z" };

function host(pid = identity.pid, startedAt = identity.started_at): HostLockRecord {
    return {
        schema_version: 3,
        pid,
        started_at: startedAt,
        socket_path: "/tmp/vera-test.sock",
        build_id: "vera-test",
    };
}

function healthyHarness(record = host()) {
    const calls: string[] = [];
    const options = {
        startHost: () => { calls.push("start"); },
        lockfile: {
            publish: async () => { throw new Error("unexpected publish"); },
            read: async (): Promise<HostLockRecord | undefined> => record,
            diagnose: async () => ({}),
        },
        shutdownForReplacement: async () => {
            calls.push("shutdown");
            return { type: "shutdown_for_replacement_accepted", pid: identity.pid, started_at: identity.started_at } as const;
        },
        shutdownIfIdle: async () => {
            calls.push("shutdown-if-idle");
            return { type: "shutdown_if_idle_accepted", pid: identity.pid, started_at: identity.started_at } as const;
        },
        terminateHost: () => { calls.push("kill"); },
        terminateWedgedHost: () => { calls.push("kill-wedged"); },
        wait: async () => {},
    };
    return { calls, options };
}

test("home reconnect replaces the matching healthy host gracefully", async () => {
    const { calls, options } = healthyHarness();
    let reads = 0;
    options.lockfile.read = async () => {
        reads += 1;
        if (reads === 1) return host();
        if (reads === 2) return undefined;
        return host(43, "2026-11-18T10:02:00.000Z");
    };
    options.startHost = () => { calls.push("start"); };
    const started = await ensureResidentHost({
        ...options,
        replaceExisting: true,
        replaceOnlyHost: identity,
    });
    expect(started).toEqual(host(43, "2026-11-18T10:02:00.000Z"));
    expect(calls).toEqual(["shutdown"]);
});

test("home reconnect attaches to a changed healthy identity without shutdown", async () => {
    const changed = host(otherIdentity.pid, otherIdentity.started_at);
    const { calls, options } = healthyHarness(changed);
    await expect(ensureResidentHost({
        ...options,
        replaceExisting: true,
        replaceOnlyHost: identity,
    })).resolves.toEqual(changed);
    expect(calls).toEqual([]);
});

test("home reconnect refuses a changed incompatible identity without shutdown", async () => {
    const changed = new HostProtocolMismatchError(
        otherIdentity.pid,
        0,
        otherIdentity.started_at,
        "/tmp/vera-test.sock",
    );
    const calls: string[] = [];
    const lockfile = {
        publish: async () => { throw new Error("unexpected publish"); },
        read: async () => { throw changed; },
        diagnose: async () => ({}),
    };
    await expect(ensureResidentHost({
        startHost: () => { calls.push("start"); },
        lockfile,
        replaceExisting: true,
        replaceOnlyHost: identity,
        shutdownForReplacement: async () => { calls.push("shutdown"); return undefined; },
        shutdownIfIdle: async () => { calls.push("shutdown-if-idle"); return undefined; },
    })).rejects.toBe(changed);
    expect(calls).toEqual([]);
});

test("busy replacement of the matching host propagates without killing it", async () => {
    const busy = healthyHarness();
    const busyOptions = {
        ...busy.options,
        shutdownForReplacement: async () => {
            busy.calls.push("shutdown");
            return { type: "shutdown_for_replacement_refused", reason: "busy" } as const;
        },
        shutdownIfIdle: async () => {
            busy.calls.push("shutdown-if-idle");
            return { type: "shutdown_if_idle_refused", reason: "busy" } as const;
        },
    };
    await expect(ensureResidentHost({
        ...busyOptions,
        replaceExisting: true,
        replaceOnlyHost: identity,
    })).rejects.toBeInstanceOf(HostReplacementBusyError);
    expect(busy.calls).toEqual(["shutdown", "shutdown-if-idle"]);
});

test("identity guard survives changed identity during refusal re-discovery", async () => {
    const calls: string[] = [];
    let reads = 0;
    const lockfile = {
        publish: async () => { throw new Error("unexpected publish"); },
        read: async () => {
            reads += 1;
            if (reads === 1) return host();
            return host(otherIdentity.pid, otherIdentity.started_at);
        },
        diagnose: async () => ({}),
    };
    const result = await ensureResidentHost({
        startHost: () => { calls.push("start"); },
        lockfile,
        replaceExisting: true,
        replaceOnlyHost: identity,
        shutdownForReplacement: async () => {
            calls.push("shutdown");
            return { type: "shutdown_for_replacement_refused", reason: "identity_mismatch" } as const;
        },
        shutdownIfIdle: async () => { calls.push("shutdown-if-idle"); return undefined; },
    });
    expect(result).toEqual(host(otherIdentity.pid, otherIdentity.started_at));
    expect(calls).toEqual(["shutdown"]);
});

test("home reconnect starts an absent host", async () => {
    const { calls, options } = healthyHarness();
    let reads = 0;
    options.lockfile.read = async () => ++reads === 1 ? undefined : host(43);
    const result = await ensureResidentHost({
        ...options,
        replaceExisting: true,
        replaceOnlyHost: identity,
    });
    expect(result).toEqual(host(43));
    expect(calls).toEqual(["start"]);
});

test("home reconnect force-stops a wedged host before starting", async () => {
    const { calls, options } = healthyHarness();
    let reads = 0;
    options.lockfile.read = async () => ++reads === 1 ? undefined : host(43);
    options.lockfile.diagnose = async () => ({ wedged: true, record: host() });
    const result = await ensureResidentHost({
        ...options,
        replaceExisting: true,
        replaceOnlyHost: identity,
        confirmBusyUpgrade: () => true,
    });
    expect(result).toEqual(host(43));
    expect(calls).toEqual(["kill-wedged", "start"]);
});

