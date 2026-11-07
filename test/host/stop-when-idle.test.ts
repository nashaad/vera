import { expect, test } from "bun:test";

import {
    StopWhenIdle,
    type StopWaitTarget,
    type StopWhenIdleEvent,
} from "../../src/host/stop-when-idle.ts";

const working: StopWaitTarget = { session_id: "s1", name: "build", status: "working" };
const queued: StopWaitTarget = { session_id: "s2", name: null, status: "queued" };

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

test("stop-when-idle reports waiting targets, reprints only on change, then stops", async () => {
    let waiting: StopWaitTarget[] = [working];
    let stopped = 0;
    const coordinator = new StopWhenIdle({
        waitingOn: () => waiting,
        onStopped: () => {
            stopped += 1;
        },
        pollIntervalMs: 5,
    });
    const events: StopWhenIdleEvent[] = [];
    coordinator.request((event) => {
        events.push(event);
    });
    expect(coordinator.holdsTurns).toBe(true);
    await settle();
    expect(events).toEqual([{ type: "waiting", waiting_on: [working] }]);

    waiting = [working, queued];
    await settle();
    expect(events.at(-1)).toEqual({ type: "waiting", waiting_on: [working, queued] });

    const countAfterChange = events.length;
    await settle();
    expect(events.length).toBe(countAfterChange);

    waiting = [];
    await settle();
    expect(events.at(-1)).toEqual({ type: "stopped" });
    expect(stopped).toBe(1);
});

test("stop-when-idle finishes at once when nothing is waiting", async () => {
    let stopped = 0;
    const coordinator = new StopWhenIdle({
        waitingOn: () => [],
        onStopped: () => {
            stopped += 1;
        },
    });
    const events: StopWhenIdleEvent[] = [];
    coordinator.request((event) => {
        events.push(event);
    });
    await settle();
    expect(events).toEqual([{ type: "stopped" }]);
    expect(stopped).toBe(1);
});

test("stop-when-idle answers a late request with stopped and keeps one stop", async () => {
    let stopped = 0;
    const coordinator = new StopWhenIdle({
        waitingOn: () => [],
        onStopped: () => {
            stopped += 1;
        },
    });
    coordinator.request(() => undefined);
    await settle();
    const late: StopWhenIdleEvent[] = [];
    coordinator.request((event) => {
        late.push(event);
    });
    await settle();
    expect(late).toEqual([{ type: "stopped" }]);
    expect(stopped).toBe(1);
});

test("a disconnected requester does not cancel the stop", async () => {
    let waiting: StopWaitTarget[] = [working];
    let stopped = 0;
    const coordinator = new StopWhenIdle({
        waitingOn: () => waiting,
        onStopped: () => {
            stopped += 1;
        },
        pollIntervalMs: 5,
    });
    const requested = coordinator.request(() => undefined);
    if (!requested.accepted) throw new Error(requested.message);
    requested.unsubscribe();
    waiting = [];
    await settle();
    expect(stopped).toBe(1);
});

test("a request refuses an unusable update target and a second pending update", () => {
    const coordinator = new StopWhenIdle({
        waitingOn: () => [working],
        onStopped: () => undefined,
        targetProblem: (buildId) => (buildId === "bad" ? "no such build" : undefined),
        prepare: () => undefined,
    });
    expect(coordinator.request(() => undefined, "bad")).toMatchObject({
        accepted: false,
        reason: "target_unavailable",
        message: "no such build",
    });
    const first = coordinator.request(() => undefined, "vera-new");
    expect(first.accepted).toBe(true);
    expect(coordinator.request(() => undefined, "vera-other")).toMatchObject({
        accepted: false,
        reason: "stop_pending",
    });
});
