import { expect, test } from "bun:test";

import type { RestartRecord } from "../../src/store/restart-records.ts";
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

test("a stop holds turns while it checks remote owners", async () => {
    let waiting: StopWaitTarget[] = [working];
    const first = Promise.withResolvers<void>();
    let stopped = 0;
    let checks = 0;
    const events: StopWhenIdleEvent[] = [];
    const coordinator = new StopWhenIdle({
        waitingOn: () => [],
        waitingOnAsync: async () => {
            if (checks++ === 0) await first.promise;
            return waiting;
        },
        onStopped: () => { stopped += 1; },
        pollIntervalMs: 5,
    });
    coordinator.request((event) => { events.push(event); });
    expect(coordinator.holdsTurns).toBe(true);
    expect(stopped).toBe(0);
    first.resolve();
    await settle();
    expect(events).toContainEqual({ type: "waiting", waiting_on: [working] });
    expect(stopped).toBe(0);
    waiting = [];
    await settle();
    expect(events.at(-1)).toEqual({ type: "stopped" });
    expect(stopped).toBe(1);
});

test("a stop confirms remote holds before checking and clears them when abandoned", async () => {
    const holdReady = Promise.withResolvers<void>();
    const clearReady = Promise.withResolvers<void>();
    const changes: boolean[] = [];
    const events: StopWhenIdleEvent[] = [];
    let checks = 0;
    const coordinator = new StopWhenIdle({
        waitingOn: () => [],
        waitingOnAsync: async () => { checks += 1; return []; },
        setTurnsHeld: async (held) => {
            changes.push(held);
            await (held ? holdReady.promise : clearReady.promise);
        },
        prepare: () => "not available",
        onStopped: () => { throw new Error("Unexpected stop"); },
    });
    coordinator.request((event) => { events.push(event); });
    await settle();
    expect(changes).toEqual([true]);
    expect(checks).toBe(0);
    holdReady.resolve();
    await settle();
    expect(changes).toEqual([true, false]);
    expect(coordinator.holdsTurns).toBe(true);
    expect(events).toEqual([]);
    clearReady.resolve();
    await settle();
    expect(coordinator.holdsTurns).toBe(false);
    expect(events).toEqual([{ type: "abandoned", message: "not available" }]);
});

test("a pooled stop replies before remote holds and checks idle only after them", async () => {
    const held = Promise.withResolvers<void>();
    const events: StopWhenIdleEvent[] = [];
    let checks = 0;
    let stopped = false;
    const coordinator = new StopWhenIdle({
        waitingOn: () => [],
        waitingOnAsync: async () => { checks += 1; return []; },
        setTurnsHeld: async () => { await held.promise; },
        replyBeforeWorkerCheck: true,
        onStopped: () => { stopped = true; },
    });
    coordinator.request((event) => { events.push(event); });
    await settle();
    expect(events).toEqual([{ type: "waiting", waiting_on: [] }]);
    expect(checks).toBe(0);
    expect(stopped).toBe(false);
    held.resolve();
    await settle();
    expect(checks).toBe(1);
    expect(events.at(-1)).toEqual({ type: "stopped" });
    expect(stopped).toBe(true);
});

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

test("an idle stop tells observers before the host closes", async () => {
    const seen: string[] = [];
    const coordinator = new StopWhenIdle({
        waitingOn: () => [],
        onStopped: () => { seen.push("closed"); },
    });
    coordinator.observe(async (event) => {
        await Bun.sleep(10);
        seen.push(event.type === "wait_cleared" ? `${event.type}:${event.reason}` : event.type);
    });
    coordinator.request(() => undefined);
    await settle();
    expect(seen).toEqual(["wait_cleared:stopped", "closed"]);
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

test("stop-when-idle tells observers about a wait, its changes, and its clearing", async () => {
    let waiting: StopWaitTarget[] = [working];
    const coordinator = new StopWhenIdle({
        waitingOn: () => waiting,
        onStopped: () => undefined,
        pollIntervalMs: 5,
    });
    const seen: unknown[] = [];
    const unobserve = coordinator.observe((event) => {
        seen.push(event);
    });
    const request = coordinator.request(() => undefined, "build-2");
    expect(request.accepted).toBe(true);
    await settle();
    expect(seen).toEqual([{ type: "wait", kind: "update", target_build_id: "build-2", waiting_on: [working] }]);

    waiting = [working, queued];
    await settle();
    expect(seen.at(-1)).toEqual({
        type: "wait",
        kind: "update",
        target_build_id: "build-2",
        waiting_on: [working, queued],
    });

    unobserve();
    const countAfterUnobserve = seen.length;
    waiting = [];
    await settle();
    expect(seen.length).toBe(countAfterUnobserve);
});

test("stop-when-idle sends a late observer the open wait and a restart before stopping", async () => {
    let waiting: StopWaitTarget[] = [working];
    const coordinator = new StopWhenIdle({
        waitingOn: () => waiting,
        onStopped: () => undefined,
        pollIntervalMs: 5,
    });
    coordinator.request(() => undefined, "build-3");
    await settle();

    const late: unknown[] = [];
    coordinator.observe((event) => {
        late.push(event);
    });
    expect(late).toEqual([{ type: "wait", kind: "update", target_build_id: "build-3", waiting_on: [working] }]);

    const all: unknown[] = [];
    coordinator.observe((event) => {
        all.push(event);
    });
    waiting = [];
    await settle();
    expect(all).toEqual([
        { type: "wait", kind: "update", target_build_id: "build-3", waiting_on: [working] },
        { type: "wait_cleared", reason: "stopped" },
        { type: "restarting", build_id: "build-3" },
    ]);
});

test("stop-when-idle clears an observed plain stop when it is abandoned", async () => {
    let waiting: StopWaitTarget[] = [working];
    const coordinator = new StopWhenIdle({
        waitingOn: () => waiting,
        onStopped: () => undefined,
        pollIntervalMs: 5,
        prepare: () => "Could not move the update.",
    });
    const seen: unknown[] = [];
    coordinator.observe((event) => {
        seen.push(event);
    });
    coordinator.request(() => undefined);
    await settle();
    expect(seen).toEqual([{ type: "wait", kind: "stop", waiting_on: [working] }]);

    waiting = [];
    await settle();
    expect(seen.at(-1)).toEqual({
        type: "wait_cleared",
        reason: "abandoned",
        message: "Could not move the update.",
    });
});

test("cutWait refuses when no stop is waiting", async () => {
    const coordinator = new StopWhenIdle({
        waitingOn: () => [working],
        onStopped: () => undefined,
        cutSession: async () => true,
    });
    expect(await coordinator.cutWait()).toEqual({
        status: "refused",
        reason: "no_wait",
        message: "No stop is waiting, so there is nothing to cut.",
    });
});

test("cutWait cuts each waited session once and records the cut", async () => {
    const cuts: Array<[string, string]> = [];
    const records: RestartRecord[] = [];
    const coordinator = new StopWhenIdle({
        waitingOn: () => [working, queued],
        onStopped: () => undefined,
        cutSession: async (id, reason) => {
            cuts.push([id, reason]);
            return true;
        },
        recordCut: (record) => {
            records.push(record);
        },
        now: () => new Date("2026-11-07T10:00:00.000Z"),
    });
    coordinator.request(() => undefined);
    const result = await coordinator.cutWait();
    expect(result).toEqual({ status: "done", cut: ["s1", "s2"], failed: [] });
    expect(cuts).toEqual([
        ["s1", "Vera is stopping"],
        ["s2", "Vera is stopping"],
    ]);
    expect(records).toEqual([
        { session_id: "s1", cause: "stop", at: "2026-11-07T10:00:00.000Z" },
        { session_id: "s2", cause: "stop", at: "2026-11-07T10:00:00.000Z" },
    ]);
});

test("cutWait reports a session that did not confirm, and names the update build", async () => {
    const records: RestartRecord[] = [];
    const coordinator = new StopWhenIdle({
        waitingOn: () => [working, queued],
        onStopped: () => undefined,
        cutSession: async (id) => {
            if (id === "s2") throw new Error("worker gone");
            return false;
        },
        recordCut: (record) => {
            records.push(record);
        },
    });
    coordinator.request(() => undefined, "build-42");
    const result = await coordinator.cutWait();
    expect(result).toEqual({
        status: "done",
        cut: [],
        failed: [
            { session_id: "s1", message: "The session did not confirm the cut." },
            { session_id: "s2", message: "worker gone" },
        ],
    });
    expect(records).toEqual([]);
});

test("cutWait records an update cut with its target build", async () => {
    const records: RestartRecord[] = [];
    const coordinator = new StopWhenIdle({
        waitingOn: () => [working],
        onStopped: () => undefined,
        cutSession: async () => true,
        recordCut: (record) => {
            records.push(record);
        },
    });
    coordinator.request(() => undefined, "build-42", { cutFirst: true });
    await settle();
    expect(records).toEqual([
        expect.objectContaining({ session_id: "s1", cause: "update", target_build_id: "build-42" }),
    ]);
});

test("a throwing record writer does not stop the cut", async () => {
    const halts: string[] = [];
    const coordinator = new StopWhenIdle({
        waitingOn: () => [working],
        onStopped: () => undefined,
        cutSession: async (id) => {
            halts.push(id);
            return true;
        },
        recordCut: () => {
            throw new Error("disk full");
        },
    });
    coordinator.request(() => undefined);
    expect(await coordinator.cutWait()).toEqual({ status: "done", cut: ["s1"], failed: [] });
    expect(await coordinator.cutWait()).toEqual({ status: "done", cut: ["s1"], failed: [] });
    expect(halts).toEqual(["s1", "s1"]);
});

test("cutWait records one cut per session per wait, and a new wait after an abandon records again", async () => {
    let waiting: StopWaitTarget[] = [working];
    let problem: string | undefined;
    const halts: string[] = [];
    const records: RestartRecord[] = [];
    const coordinator = new StopWhenIdle({
        waitingOn: () => waiting,
        onStopped: () => undefined,
        prepare: () => problem,
        cutSession: async (id) => {
            halts.push(id);
            return true;
        },
        recordCut: (record) => {
            records.push(record);
        },
        pollIntervalMs: 5,
    });
    coordinator.request(() => undefined);
    await coordinator.cutWait();
    await coordinator.cutWait();
    expect(halts).toEqual(["s1", "s1"]);
    expect(records.map((record) => record.session_id)).toEqual(["s1"]);

    problem = "Vera cannot stop yet.";
    waiting = [];
    await settle();

    problem = undefined;
    waiting = [working];
    coordinator.request(() => undefined);
    await coordinator.cutWait();
    expect(records.map((record) => record.session_id)).toEqual(["s1", "s1"]);
});
