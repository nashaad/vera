import { expect, test } from "bun:test";

import { StopWaitRelay } from "../../src/host/pool/stop-wait-relay.ts";
import type { StopWaitEvent } from "../../src/host/stop-when-idle.ts";

const waiting: StopWaitEvent = {
    type: "wait", kind: "update", target_build_id: "build-2",
    waiting_on: [{ session_id: "a", name: null, status: "working" }],
};

test("a relay sends waits, clears and restarts to every attachment", async () => {
    const relay = new StopWaitRelay();
    const first: StopWaitEvent[] = [];
    const second: StopWaitEvent[] = [];
    relay.observe((event) => { first.push(event); });
    await relay.publish(waiting);
    relay.observe((event) => { second.push(event); });
    const cleared: StopWaitEvent = { type: "wait_cleared", reason: "stopped" };
    const restarting: StopWaitEvent = { type: "restarting", build_id: "build-2" };
    await relay.publish(cleared);
    await relay.publish(restarting);
    expect(first).toEqual([waiting, cleared, restarting]);
    expect(second).toEqual([waiting, cleared, restarting]);
    const later: StopWaitEvent[] = [];
    relay.observe((event) => { later.push(event); });
    expect(later).toEqual([]);
});

test("publishing waits for asynchronous attachment delivery", async () => {
    const relay = new StopWaitRelay();
    const delivery = Promise.withResolvers<void>();
    let complete = false;
    relay.observe(async () => { await delivery.promise; });
    const published = relay.publish(waiting).then(() => { complete = true; });
    await Bun.sleep(10);
    expect(complete).toBe(false);
    delivery.resolve();
    await published;
    expect(complete).toBe(true);
});
