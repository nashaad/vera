import { expect, test } from "bun:test";

import { HostRouter, type RoutedSession, type SessionEndpoint } from "../../src/host/master/router.ts";
import { mergeRoster } from "../../src/host/master/roster.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function endpoint(sessions: Map<string, RoutedSession>): SessionEndpoint {
    return {
        inspect: async (path) => ({ id: "one", sessionPath: path }),
        resident: async (id) => sessions.get(id),
        residents: async () => [...sessions.values()],
        tree: async (id) => sessions.has(id) ? [id] : [],
        find: async (id) => sessions.get(id),
        create: async () => { throw new Error("unused"); },
        resume: async () => { throw new Error("unused"); },
        release: async () => [],
        list: async () => [],
        rename: async () => ({ status: "not_found" }),
        trash: async () => "not_found",
        close: async () => ({ status: "not_found" }),
        block: async () => ({ status: "rejected", reason: "not_found" }),
        unblock: async () => ({ status: "rejected", reason: "not_found" }),
        sync: async () => ({ status: "not_found", turns: 0 }),
        facts: async (rows) => rows,
        search: async () => ({ results: [], truncated: false }),
    };
}

test("a move waits for an ongoing write and for the old host to release", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const masterSessions = new Map([[session.id, session]]);
    const workerSessions = new Map<string, RoutedSession>();
    const write = deferred();
    const writeStarted = deferred();
    const release = deferred();
    const releaseStarted = deferred();
    const events: string[] = [];
    const master = endpoint(masterSessions);
    const worker = endpoint(workerSessions);
    master.rename = async () => {
        events.push("write started");
        writeStarted.resolve();
        await write.promise;
        events.push("write finished");
        return { status: "renamed", name: "map" };
    };
    master.release = async (id) => {
        events.push("release started");
        releaseStarted.resolve();
        await release.promise;
        masterSessions.delete(id);
        events.push("release finished");
        return [id];
    };
    worker.resume = async () => {
        expect(masterSessions.has(session.id)).toBe(false);
        events.push("worker opened");
        workerSessions.set(session.id, session);
        return session;
    };
    const router = new HostRouter({
        master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    const rename = router.rename(session.id, "map");
    await writeStarted.promise;
    const move = router.resume(session.sessionPath);
    await Bun.sleep(0);
    expect(events).toEqual(["write started"]);
    write.resolve();
    await releaseStarted.promise;
    expect(events).toEqual(["write started", "write finished", "release started"]);
    release.resolve();
    expect(await rename).toEqual({ status: "renamed", name: "map" });
    expect(await move).toEqual(session);
    expect(events).toEqual(["write started", "write finished", "release started", "release finished", "worker opened"]);
});

test("a failed release leaves the old owner available for a retry", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const master = endpoint(new Map([[session.id, session]]));
    const worker = endpoint(new Map());
    master.release = async () => { throw new Error("busy"); };
    const router = new HostRouter({
        master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    await expect(router.resume(session.sessionPath)).rejects.toThrow("busy");
    expect(await router.locate(session.id)).toMatchObject({ type: "agent_location", socket_path: "/host.sock" });
});

test("a branch in progress prevents its source from moving", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const masterSessions = new Map([[session.id, session]]);
    const workerSessions = new Map<string, RoutedSession>();
    const master = endpoint(masterSessions);
    const worker = endpoint(workerSessions);
    master.release = async (id) => { masterSessions.delete(id); return [id]; };
    worker.resume = async () => { workerSessions.set(session.id, session); return session; };
    const router = new HostRouter({
        master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    expect(await router.beginBranch("host", session.id)).toBe(true);
    await expect(router.resume(session.sessionPath)).rejects.toThrow("branching");
    router.endBranch(session.id);
    expect(await router.resume(session.sessionPath)).toEqual(session);
});

test("a duplicate resident session is rejected", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const master = endpoint(new Map([[session.id, session]]));
    const worker = endpoint(new Map([[session.id, session]]));
    const router = new HostRouter({
        master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    await expect(router.resume(session.sessionPath)).rejects.toThrow("both hosts");
    expect(await router.locate(session.id)).toMatchObject({
        type: "agent_location_failed", reason: "worker_unavailable",
    });
});

test("a slow search does not block session location", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const master = endpoint(new Map([[session.id, session]]));
    const worker = endpoint(new Map());
    const started = deferred();
    const release = deferred();
    worker.search = async () => {
        started.resolve();
        await release.promise;
        return { results: [], truncated: false };
    };
    const router = new HostRouter({
        master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    const search = router.search({ query: "map" });
    await started.promise;
    try {
        const location = await Promise.race([
            router.locate(session.id),
            Bun.sleep(1_000).then(() => undefined),
        ]);
        expect(location).toMatchObject({ type: "agent_location", socket_path: "/host.sock" });
    } finally {
        release.resolve();
        await search;
    }
});

test("the roster prefers each owner and omits stale copies", () => {
    const row = (id: string, live: boolean): RegisteredAgentSummary => ({
        id, live, workspace: "/work", session_path: `/sessions/${id}.jsonl`, kind: "interactive", status: "idle",
    });
    const merged = mergeRoster(
        [row("master", true), row("worker", false), row("trashed", false)],
        [row("master", false), row("worker", true)],
        (id) => id === "master" ? "host" : "w0",
    );
    expect(merged.map((item) => [item.id, item.live])).toEqual([["master", true], ["worker", true]]);
});
