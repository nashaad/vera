import { expect, test } from "bun:test";

import { HostConnectionClosedError } from "../../src/host/connection.ts";
import type { ControlPeer } from "../../src/host/pool/control.ts";
import { WorkerControlLink } from "../../src/host/pool/worker-link.ts";

test("@core observation requests reconnect only to an accepting peer and clean up waiters", async () => {
    const link = new WorkerControlLink();
    const waiters = (link as unknown as { readonly connectionWaiters: ReadonlySet<unknown> }).connectionWaiters;
    const first = {
        setHandler() {}, setEventHandler() {},
        async request() { throw new HostConnectionClosedError(false); },
    } as unknown as ControlPeer;
    const second = {
        setHandler() {}, setEventHandler() {},
        async request() { return "crow saved"; },
    } as unknown as ControlPeer;
    link.bind(first);
    const pending = link.requestReconnecting("process.observationSettled", [], AbortSignal.timeout(1_000));
    await Bun.sleep(5);
    link.unbind(first);
    link.bind(second, false);
    await Bun.sleep(5);
    expect(waiters.size).toBe(1);
    link.activate();
    expect(await pending).toBe("crow saved");
    expect(waiters.size).toBe(0);
    link.unbind(second);
    for (let index = 0; index < 100; index += 1) {
        const controller = new AbortController();
        const waiting = link.requestReconnecting("process.observationStart", [], controller.signal);
        controller.abort(new Error("crow cancelled"));
        await expect(waiting).rejects.toThrow("crow cancelled");
    }
    expect(waiters.size).toBe(0);
    await expect(link.requestReconnecting("process.observationStart", [], AbortSignal.timeout(10))).rejects.toThrow();
    expect(waiters.size).toBe(0);
});
