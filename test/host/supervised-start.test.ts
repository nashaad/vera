import { expect, test } from "bun:test";

import {
    isSupervisedHost,
    startWaitingOutRivals,
} from "../../clients/host/supervised-start.ts";
import { HostLockUnreadableError } from "../../src/host/lockfile.ts";
import { HostSocketHeldError } from "../../src/host/server.ts";
import { HostStartupInProgressError } from "../../src/host/startup-claim.ts";
import { SUPERVISED_HOST_ENV } from "../../src/host/supervision.ts";

test("only a host launchd started counts as supervised", () => {
    expect(isSupervisedHost({})).toBe(false);
    expect(isSupervisedHost({ [SUPERVISED_HOST_ENV]: "1" })).toBe(true);
});

test("a supervised host waits for the rival instead of exiting", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const host = await startWaitingOutRivals(() => {
        attempts += 1;
        if (attempts < 3) {
            return Promise.reject(new HostStartupInProgressError(99));
        }
        return Promise.resolve("serving");
    }, {
        intervalMs: 5,
        sleep: (ms) => {
            waits.push(ms);
            return Promise.resolve();
        },
    });

    expect(host).toBe("serving");
    expect(attempts).toBe(3);
    expect(waits).toEqual([5, 5]);
});

test("a held socket is a rival too", async () => {
    let attempts = 0;
    await startWaitingOutRivals(() => {
        attempts += 1;
        if (attempts === 1) {
            return Promise.reject(
                new HostSocketHeldError(42, "/tmp/host.sock", true),
            );
        }
        return Promise.resolve(undefined);
    }, { intervalMs: 0, sleep: () => Promise.resolve() });

    expect(attempts).toBe(2);
});

test("a broken build is thrown rather than waited out", async () => {
    let attempts = 0;
    await expect(startWaitingOutRivals(() => {
        attempts += 1;
        return Promise.reject(new SyntaxError("unexpected token"));
    }, { sleep: () => Promise.resolve() })).rejects.toThrow("unexpected token");
    expect(attempts).toBe(1);
});

test("a damaged lockfile is waited out and reported once", async () => {
    const lockPath = "/tmp/vera/runtime/host.json";
    const reported: Error[] = [];
    const waits: number[] = [];
    let attempts = 0;
    const host = await startWaitingOutRivals(() => {
        attempts += 1;
        if (attempts < 4) {
            return Promise.reject(new HostLockUnreadableError(lockPath));
        }
        return Promise.resolve("serving");
    }, {
        intervalMs: 5,
        lockIntervalMs: 7,
        onWait: (error) => reported.push(error),
        sleep: (ms) => {
            waits.push(ms);
            return Promise.resolve();
        },
    });

    expect(host).toBe("serving");
    expect(attempts).toBe(4);
    expect(waits).toEqual([7, 7, 7]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(HostLockUnreadableError);
});

test("a damaged lockfile is reported again after a rival came and went", async () => {
    const lockPath = "/tmp/vera/runtime/host.json";
    const reported: Error[] = [];
    const waits: number[] = [];
    const failures = [
        new HostLockUnreadableError(lockPath),
        new HostStartupInProgressError(99),
        new HostLockUnreadableError(lockPath),
    ];
    await startWaitingOutRivals(() => {
        const next = failures.shift();
        return next === undefined
            ? Promise.resolve(undefined)
            : Promise.reject(next);
    }, {
        intervalMs: 5,
        lockIntervalMs: 7,
        onWait: (error) => reported.push(error),
        sleep: (ms) => {
            waits.push(ms);
            return Promise.resolve();
        },
    });

    expect(waits).toEqual([7, 5, 7]);
    expect(reported.map((error) => error.constructor)).toEqual([
        HostLockUnreadableError,
        HostStartupInProgressError,
        HostLockUnreadableError,
    ]);
});

test("a damaged lockfile still ends a bounded wait", async () => {
    const lockPath = "/tmp/vera/runtime/host.json";
    let attempts = 0;
    await expect(startWaitingOutRivals(() => {
        attempts += 1;
        return Promise.reject(new HostLockUnreadableError(lockPath));
    }, { maxAttempts: 3, sleep: () => Promise.resolve() }))
        .rejects.toBeInstanceOf(HostLockUnreadableError);
    expect(attempts).toBe(3);
});
