import { expect, test } from "bun:test";

import {
    isSupervisedHost,
    startWaitingOutRivals,
} from "../../clients/host/supervised-start.ts";
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
