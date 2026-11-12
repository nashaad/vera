import { expect, test } from "bun:test";

import { workBuckets, finishedDetail, runningDetail } from "../../clients/ui/src/pages/WorkPage.tsx";
import { statusPhrase, workspaceStats } from "../../clients/ui/src/pages/WorkspacePage.tsx";
import {
    FINISHED_LIMIT,
    FINISHED_WINDOW_MS,
    FinishedSessions,
} from "../../clients/ui/src/state/finished.ts";
import type { SessionRow, SessionStatus } from "../../clients/ui/src/protocol/sessions.ts";

const MINUTE = 60_000;
const T0 = 1_000_000_000_000;

function row(id: string, status: SessionStatus, extra: Partial<SessionRow> = {}): SessionRow {
    return { id, name: `name ${id}`, workspace: "/p/crow", status, live: false, ...extra };
}

test("@core a session that finishes while unseen lands in Finished", () => {
    const store = new FinishedSessions();
    store.observe([row("a", "working")], T0, undefined);
    expect(store.observe([row("a", "idle")], T0 + MINUTE, undefined)).toBe(true);
    expect(store.list(T0 + MINUTE)).toEqual([
        { agentId: "a", name: "name a", workspace: "/p/crow", status: "idle", finishedAt: T0 + MINUTE },
    ]);
});

test("waiting and working sessions that settle are recorded with their settled status", () => {
    const store = new FinishedSessions();
    store.observe([row("a", "waiting"), row("b", "working")], T0, undefined);
    store.observe([row("a", "completed"), row("b", "other")], T0 + MINUTE, undefined);
    expect(store.list(T0 + MINUTE).map((entry) => [entry.agentId, entry.status])).toEqual([
        ["a", "completed"],
        ["b", "other"],
    ]);
});

test("a session already idle when first observed is not recorded", () => {
    const store = new FinishedSessions();
    store.observe([row("a", "idle")], T0, undefined);
    store.observe([row("a", "idle")], T0 + MINUTE, undefined);
    expect(store.list(T0 + MINUTE)).toEqual([]);
});

test("a session that moves between active states is not recorded as finished", () => {
    const store = new FinishedSessions();
    store.observe([row("a", "working")], T0, undefined);
    store.observe([row("a", "waiting")], T0 + MINUTE, undefined);
    expect(store.list(T0 + MINUTE)).toEqual([]);
});

test("the session on screen is not recorded when it finishes", () => {
    const store = new FinishedSessions();
    store.observe([row("a", "working")], T0, "a");
    expect(store.observe([row("a", "idle")], T0 + MINUTE, "a")).toBe(false);
    expect(store.list(T0 + MINUTE)).toEqual([]);
});

test("seen drops a finished session", () => {
    const store = new FinishedSessions();
    store.observe([row("a", "working"), row("b", "working")], T0, undefined);
    store.observe([row("a", "idle"), row("b", "idle")], T0 + MINUTE, undefined);
    expect(store.seen("a")).toBe(true);
    expect(store.seen("a")).toBe(false);
    expect(store.list(T0 + MINUTE).map((entry) => entry.agentId)).toEqual(["b"]);
});

test("an entry is listed for one hour and then forgotten", () => {
    const store = new FinishedSessions();
    store.observe([row("a", "working")], T0, undefined);
    store.observe([row("a", "idle")], T0, undefined);
    expect(store.list(T0 + FINISHED_WINDOW_MS - 1).map((entry) => entry.agentId)).toEqual(["a"]);
    expect(store.list(T0 + FINISHED_WINDOW_MS)).toEqual([]);
    expect(store.list(T0 + FINISHED_WINDOW_MS - 1)).toEqual([]);
});

test("a row that drops out of a later observe keeps its finished entry", () => {
    const store = new FinishedSessions();
    store.observe([row("a", "working")], T0, undefined);
    store.observe([row("a", "idle")], T0 + MINUTE, undefined);
    store.observe([], T0 + 2 * MINUTE, undefined);
    expect(store.list(T0 + 2 * MINUTE).map((entry) => entry.agentId)).toEqual(["a"]);
});

test("finished entries are listed newest first", () => {
    const store = new FinishedSessions();
    store.observe([row("a", "working"), row("b", "working")], T0, undefined);
    store.observe([row("a", "idle"), row("b", "working")], T0 + MINUTE, undefined);
    store.observe([row("a", "idle"), row("b", "idle")], T0 + 2 * MINUTE, undefined);
    expect(store.list(T0 + 2 * MINUTE).map((entry) => entry.agentId)).toEqual(["b", "a"]);
});

test("the store keeps at most FINISHED_LIMIT entries and drops the oldest", () => {
    const store = new FinishedSessions();
    const total = FINISHED_LIMIT + 1;
    const working = Array.from({ length: total }, (_, index) => row(`s${index}`, "working"));
    const idle = working.map((item) => ({ ...item, status: "idle" as const }));
    store.observe(working, T0, undefined);
    for (let index = 0; index < total; index += 1) {
        store.observe(idle.slice(index, index + 1).map((item) => item), T0 + index * 1000, undefined);
        store.observe(working.slice(index + 1), T0 + index * 1000, undefined);
    }
    const listed = store.list(T0 + total * 1000).map((entry) => entry.agentId);
    expect(listed).toHaveLength(FINISHED_LIMIT);
    expect(listed).not.toContain("s0");
    expect(listed).toContain(`s${total - 1}`);
});

test("Work buckets keep their order and show each session once", () => {
    const rows = [
        row("waiting", "waiting", { updatedAt: T0 }),
        row("running", "working", { updatedAt: T0 - 5 * MINUTE }),
        row("idle", "idle"),
    ];
    const finished = [
        { agentId: "running", name: "name running", workspace: "/p/crow", status: "idle" as const, finishedAt: T0 - MINUTE },
        { agentId: "done", name: "name done", workspace: "/p/crow", status: "completed" as const, finishedAt: T0 - 2 * MINUTE },
    ];
    const buckets = workBuckets(rows, finished, T0);
    expect(buckets.map((bucket) => [bucket.id, bucket.warn, bucket.rows.map((item) => item.id)])).toEqual([
        ["needs-you", true, ["waiting"]],
        ["running", false, ["running"]],
        ["finished", false, ["done"]],
    ]);
    expect(buckets[0]?.rows[0]?.detail).toBe("Waiting on you");
    expect(buckets[1]?.rows[0]?.detail).toBe("Running · active 5m ago");
    expect(buckets[2]?.rows[0]?.detail).toBe("Finished 2m ago");
});

test("empty buckets are left out", () => {
    expect(workBuckets([row("a", "idle")], [], T0)).toEqual([]);
});

test("running and finished detail text", () => {
    expect(runningDetail(undefined, T0)).toBe("Running");
    expect(runningDetail(T0, T0)).toBe("Running · active now");
    expect(runningDetail(T0 - 5 * MINUTE, T0)).toBe("Running · active 5m ago");
    expect(finishedDetail(T0, T0)).toBe("Finished just now");
    expect(finishedDetail(T0 - 5 * MINUTE, T0)).toBe("Finished 5m ago");
});

test("workspace stats count the folder and mark a partial load", () => {
    const folder = [
        row("a", "working", { updatedAt: T0 - 3 * MINUTE }),
        row("b", "waiting", { updatedAt: T0 - MINUTE }),
        row("c", "idle"),
    ];
    expect(workspaceStats(folder, true, T0)).toEqual({
        sessions: "3+",
        running: "1",
        needsYou: "1",
        lastActive: "1m ago",
    });
    expect(workspaceStats([], false, T0)).toEqual({ sessions: "0", running: "0", needsYou: "0", lastActive: "Never" });
    expect(workspaceStats([row("a", "idle", { updatedAt: T0 })], false, T0).lastActive).toBe("Now");
});

test("workspace row phrases", () => {
    expect(statusPhrase("waiting")).toBe("Waiting on you");
    expect(statusPhrase("working")).toBe("Running");
    expect(statusPhrase("completed")).toBe("Idle");
});
