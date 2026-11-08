import { expect, test } from "bun:test";

import { InteractiveAttachmentCoordinator, type AttachmentTreeReader } from "../../src/host/attachment-coordinator.ts";

test("a stalled attachment tree lookup times out and lets the queue continue", async () => {
    const stalled = Promise.withResolvers<AttachmentTreeReader>();
    let reads = 0;
    const coordinator = new InteractiveAttachmentCoordinator(
        () => ++reads === 1 ? stalled.promise : Promise.resolve((id) => [id]),
        async () => ({ status: "closed", sessionRetained: true }),
        20,
    );
    const waiting = coordinator.ready("crow");
    const opening = coordinator.open("map", "viewer");
    await expect(waiting).rejects.toThrow("Session attachment tree timed out.");
    const lease = await opening;
    expect(typeof lease).toBe("string");
    stalled.resolve((id) => [id]);
    expect(await coordinator.detach(lease, "map")).toEqual([]);
});

test("a reconnect after the stop decision prevents the close", async () => {
    let closes = 0;
    const coordinator = new InteractiveAttachmentCoordinator(
        async () => (id) => [id],
        async () => { closes += 1; return { status: "closed", sessionRetained: true }; },
    );
    const first = await coordinator.open("crow", "viewer");
    await coordinator.abandon(first, "crow");
    expect(await coordinator.ready("crow")).toEqual(["crow"]);
    const reattached = await coordinator.open("crow", "viewer");
    expect(await coordinator.closeIfReady("crow")).toEqual({ status: "attached", remaining: 1 });
    expect(closes).toBe(0);
    expect(await coordinator.release(reattached, "crow", "viewer", "stop_if_last"))
        .toEqual({ remaining: 0, rootsToStop: ["crow"] });
    expect(await coordinator.closeIfReady("crow")).toEqual({ status: "closed", sessionRetained: true });
    expect(closes).toBe(1);
});

test("a new lease from the same viewer is counted after a stop decision", async () => {
    let closes = 0;
    const coordinator = new InteractiveAttachmentCoordinator(
        async () => (id) => id === "root" ? ["root", "child"] : [id],
        async () => { closes += 1; return { status: "closed" }; },
    );
    const root = await coordinator.open("root", "viewer");
    const child = await coordinator.open("child", "viewer");
    const decision = await coordinator.release(root, "root", "viewer", "stop_if_last");
    expect(decision.ignoredLeaseIds).toEqual([child]);
    const reattached = await coordinator.open("root", "viewer");
    expect(await coordinator.closeIfReady("root", false, decision.ignoredLeaseIds))
        .toEqual({ status: "attached", remaining: 1 });
    expect(closes).toBe(0);
    await coordinator.abandon(reattached, "root");
    await coordinator.abandon(child, "child");
});
