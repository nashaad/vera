import { expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostRouter, SessionTransferReservationsChanged, type RoutedSession, type SessionEndpoint, type SessionResumeOptions } from "../../src/host/pool/router.ts";
import { RoutedSnapshots } from "../../src/host/pool/snapshots.ts";
import { mergeRoster } from "../../src/host/pool/roster.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { withSessionReservation, type RestoringSessions } from "../../src/host/session-host/storage.ts";
import { CRASH_CUT_MESSAGE, SessionStore, openSessionForRecovery, readSessionTurnState } from "../../src/store/session-store.ts";
import { sessionShardIndex } from "../../src/host/shard.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function endpoint(sessions: Map<string, RoutedSession>): SessionEndpoint {
    return {
        canonicalPath: async (path) => path,
        setSessionTitle: async () => "not_found",
        sendToSession: async () => "not_found",
        askSession: async () => { throw new Error("unused"); },
        investigate: async () => { throw new Error("unused"); },
        peerRoster: async () => [],
        peerSend: async () => { throw new Error("unused"); },
        peerLabel: async () => undefined,
        messageSubagent: async () => { throw new Error("unused"); },
        closeSubagent: async () => ({ status: "not_found" }),
        notifyParent: async () => false,
        deliverCompletion: async () => "unavailable",
        completionFailure: async () => {},
        childApproval: async () => "deny",
        parentClosing: async () => false,
        inspect: async (path) => ({ id: "one", sessionPath: path }),
        residentAt: async (path) => [...sessions.values()].find((session) => session.sessionPath === path),
        resident: async (id) => sessions.get(id),
        residents: async () => [...sessions.values()],
        tree: async (id) => sessions.has(id) ? [id] : [],
        find: async (id) => sessions.get(id),
        create: async () => { throw new Error("unused"); },
        resume: async () => { throw new Error("unused"); },
        release: async () => [],
        list: async () => [],
        rememberStored: async () => {},
        forgetStored: async () => {},
        rename: async () => ({ status: "not_found" }),
        trash: async () => "not_found",
        reserveTrash: async () => ({ status: "busy" }),
        quiesceClose: async () => [],
        waitClose: async () => {},
        finishCloseMember: async () => undefined,
        forgetClose: async () => {},
        canClose: async () => true,
        recordClosedMembers: async () => {},
        moveTrashArtifact: async () => false,
        restartTrashMember: async () => false,
        abandonTrashRestart: async () => {},
        recordTrashOutcome: async () => {},
        releaseTrash: async () => {},
        close: async () => ({ status: "not_found" }),
        block: async () => ({ status: "rejected", reason: "not_found" }),
        unblock: async () => ({ status: "rejected", reason: "not_found" }),
        sync: async () => ({ status: "not_found", turns: 0 }),
        branchSyncInfo: async () => undefined,
        branchSourceReady: async () => undefined,
        branchSyncDelta: async () => ({ status: "not_found" }),
        applyBranchSync: async () => ({ status: "not_found", turns: 0 }),
        facts: async (rows) => rows,
        search: async () => ({ results: [], truncated: false }),
        searchShard: async () => ({ results: [], truncated: false }),
        flush: async () => {},
        pumpInbox: async () => {},
        snapshot: async () => ({ residents: [...sessions.values()], summaries: [], work: [], unreadSources: [] }),
        workSchedules: async () => [],
        importSession: async () => { throw new Error("unused"); },
        listImportableSessions: async () => ({ sessions: [], truncated: false }),
        importedSourceHash: async () => undefined,
        suppressCompletion: async () => {},
        cut: async () => false,
        stopWaitTargets: async () => [],
        runningSubagents: async () => 0,
        parkFacts: async () => [],
        blockHasSession: async () => false,
        blockTreeShard: async () => [],
        blockAbort: async () => {},
        blockConfirm: async () => {},
        blockWrite: async () => true,
        blockedIds: async () => [],
        blockRemove: async () => [],
        blockRelease: async () => [],
    };
}

test("an opening worker session survives an older roster snapshot until a fresh one settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-recovery-open-"));
    const path = join(root, "crow.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
    const session = { id: "crow", workspace: root, sessionPath: path };
    const host = endpoint(new Map());
    const worker = endpoint(new Map());
    const entered = deferred();
    const release = deferred();
    worker.find = async () => { entered.resolve(); await release.promise; return session; };
    const router = new HostRouter({
        host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test", keepResidentOwner: true,
    });
    const stale = router.snapshotRevision();
    let locating: ReturnType<HostRouter["locate"]> | undefined;
    try {
        locating = router.locate("crow", false, path);
        await entered.promise;
        router.observe("w0", [], stale);
        expect(router.workerSessions("w0")).toMatchObject([{ id: "crow", path, baseline: null }]);
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map." }] }, { turnStart: true });
        release.resolve();
        expect(await locating).toMatchObject({ type: "agent_location", worker_id: "w0" });
        router.observe("w0", [], stale);
        expect(router.workerSessions("w0")).toMatchObject([{ id: "crow", path, baseline: null }]);
        router.observe("w0", [session], router.snapshotRevision());
        expect(router.workerSessions("w0")).toEqual([{ id: "crow", path }]);
        router.observe("w0", [], router.snapshotRevision());
        expect(router.workerSessions("w0")).toEqual([]);
    } finally {
        release.resolve();
        await locating?.catch(() => {});
        await rm(root, { recursive: true, force: true });
    }
});

test("@core overlapping roster refreshes share a trailing snapshot without delaying earlier waiters", async () => {
    const host = endpoint(new Map());
    const worker = endpoint(new Map());
    const first = deferred();
    const second = deferred();
    let calls = 0;
    worker.snapshot = async () => {
        calls += 1;
        const current = calls;
        if (current === 1) await first.promise;
        if (current === 2) await second.promise;
        return { residents: [{ id: `crow-${current}`, workspace: "/work", sessionPath: `/sessions/${current}.jsonl` }],
            summaries: [], work: [], unreadSources: [] };
    };
    const observed: string[] = [];
    const snapshots = new RoutedSnapshots(host, [{
        id: "w0", endpoint: worker, socket: "/w0.sock", generation: () => 1, ready: () => true,
    }], () => 0, (owner, snapshot) => {
        if (owner === "w0") observed.push(...snapshot.residents.map((session) => session.id));
    });
    try {
        snapshots.refresh();
        const early = snapshots.wait();
        for (let index = 0; index < 20; index += 1) snapshots.refresh();
        const trailing = snapshots.wait();
        expect(calls).toBe(1);
        first.resolve();
        await early;
        expect(calls).toBe(2);
        let done = false;
        void trailing.then(() => { done = true; });
        await Bun.sleep(0);
        expect(done).toBe(false);
        second.resolve();
        await trailing;
        expect(calls).toBe(2);
        expect(observed).toEqual(["crow-1", "crow-2"]);
    } finally {
        first.resolve();
        second.resolve();
        await snapshots.wait();
    }
});

test("a roster change during a trailing pass publishes the latest state", async () => {
    const host = endpoint(new Map());
    const worker = endpoint(new Map());
    const first = deferred();
    const second = deferred();
    let title = "initial";
    let calls = 0;
    worker.snapshot = async () => {
        calls += 1;
        const current = calls;
        const captured = title;
        if (current === 1) await first.promise;
        if (current === 2) await second.promise;
        const summary: RegisteredAgentSummary = {
            id: "crow", title: captured, live: true, workspace: "/work", session_path: "/sessions/crow.jsonl",
            kind: "interactive", status: "working",
        };
        return {
            residents: [{ id: "crow", workspace: "/work", sessionPath: "/sessions/crow.jsonl" }],
            summaries: [summary],
            work: [{ id: "crow", title: captured, workspace: "/work", session_path: "/sessions/crow.jsonl",
                kind: "interactive", status: "working", live: true, updated_at: "2026-11-09T00:00:00.000Z" }],
            unreadSources: [],
        };
    };
    const snapshots = new RoutedSnapshots(host, [{
        id: "w0", endpoint: worker, socket: "/w0.sock", generation: () => 1, ready: () => true,
    }], () => 0, () => {});
    const delivered: Array<{ roster?: string; work?: string }> = [];
    snapshots.onChanged(() => delivered.push({ roster: snapshots.list()[0]?.title, work: snapshots.workIndex().rows[0]?.title }));
    try {
        snapshots.refresh();
        const initial = snapshots.wait();
        for (let index = 0; index < 20; index += 1) {
            title = `burst-${index}`;
            snapshots.refresh();
        }
        first.resolve();
        await initial;
        expect(calls).toBe(2);
        title = "last";
        snapshots.refresh();
        const trailing = snapshots.wait();
        second.resolve();
        await trailing;
        expect(calls).toBe(3);
        expect(delivered.at(-1)).toEqual({ roster: "last", work: "last" });
        expect(snapshots.list()[0]?.title).toBe("last");
        expect(snapshots.workIndex().rows[0]?.title).toBe("last");
    } finally {
        first.resolve();
        second.resolve();
        await snapshots.wait();
    }
});

test("a delayed roster from a lost worker cannot replace its successor's snapshot", async () => {
    const host = endpoint(new Map());
    const worker = endpoint(new Map());
    const old = deferred();
    let generation = 1;
    let calls = 0;
    worker.snapshot = async () => {
        calls += 1;
        const current = calls;
        if (current === 1) await old.promise;
        const session = { id: current === 1 ? "old" : "new", workspace: "/work", sessionPath: `/sessions/${current}.jsonl` };
        return { residents: [session], summaries: [], work: [], unreadSources: [] };
    };
    const observed: string[] = [];
    const snapshots = new RoutedSnapshots(host, [{
        id: "w0", endpoint: worker, socket: "/w0.sock", generation: () => generation, ready: () => true,
    }], () => 0, (owner, snapshot) => {
        if (owner === "w0") observed.push(...snapshot.residents.map((session) => session.id));
    });
    snapshots.refresh();
    generation = 2;
    snapshots.refresh();
    old.resolve();
    await snapshots.wait();
    expect(observed).toEqual(["new"]);
});

test("a lost session process keeps its last roster without restoring its lease", async () => {
    const host = endpoint(new Map());
    const worker = endpoint(new Map());
    const summary: RegisteredAgentSummary = {
        id: "crow", live: true, workspace: "/work", session_path: "/sessions/crow.jsonl",
        kind: "interactive", status: "working",
    };
    worker.snapshot = async () => ({ residents: [], summaries: [summary], work: [], unreadSources: [] });
    let ready = true;
    const observed: string[] = [];
    const snapshots = new RoutedSnapshots(host, [{
        id: "w0", endpoint: worker, socket: "/w0.sock", generation: () => 1,
        ready: () => ready, pid: () => 123,
    }], () => 0, (owner) => observed.push(owner));

    snapshots.refresh();
    await snapshots.wait();
    ready = false;
    snapshots.refresh();
    await snapshots.wait();

    expect(snapshots.list()).toEqual([{ ...summary, worker_pid: 123 }]);
    expect(observed.filter((owner) => owner === "w0")).toHaveLength(1);
});

test("a lost create reply must not let another worker open the same session", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const path = `/sessions/${id}.jsonl`;
    const random = spyOn(crypto, "randomUUID").mockReturnValue(id);
    const hostSessions = new Map<string, RoutedSession>();
    const firstSessions = new Map<string, RoutedSession>();
    const secondSessions = new Map<string, RoutedSession>();
    const thirdSessions = new Map<string, RoutedSession>();
    const host = endpoint(hostSessions);
    const first = endpoint(firstSessions);
    const second = endpoint(secondSessions);
    const third = endpoint(thirdSessions);
    let firstReady = true;
    host.inspect = async (sessionPath) => ({ id, sessionPath });
    first.create = async (options) => {
        firstSessions.set(id, { id, workspace: options.workspace ?? "/work", sessionPath: path });
        firstReady = false;
        throw new Error("control connection closed before the create reply");
    };
    for (const [worker, sessions] of [[first, firstSessions], [second, secondSessions], [third, thirdSessions]] as const) {
        worker.resume = async (sessionPath) => {
            const session = { id, workspace: "/work", sessionPath };
            sessions.set(id, session);
            return session;
        };
    }
    const router = new HostRouter({
        host, worker: first, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
        workerReady: () => firstReady,
        extraWorkers: [
            { id: "w1", endpoint: second, socket: "/w1.sock", generation: () => 1, ready: () => true },
            { id: "w2", endpoint: third, socket: "/w2.sock", generation: () => 1, ready: () => true },
        ],
        keepResidentOwner: true,
    });
    try {
        expect(sessionShardIndex(id, 3)).toBe(2);
        const failure = await router.create({ workspace: "/work" }).then(() => undefined, (error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(firstSessions.has(id)).toBe(true);
        const unavailable = await router.resume(path).then(() => undefined, (error: unknown) => error);
        expect(unavailable).toMatchObject({ message: "The session process is unavailable." });
        expect([firstSessions, secondSessions, thirdSessions].filter((sessions) => sessions.has(id))).toHaveLength(1);
        firstSessions.clear();
        router.workerExited("w0");
        firstReady = true;
        await router.resume(path);
        expect([firstSessions, secondSessions, thirdSessions].filter((sessions) => sessions.has(id))).toHaveLength(1);
        expect(firstSessions.has(id)).toBe(true);
    } finally {
        random.mockRestore();
    }
});

for (const operation of ["resume", "locate", "import", "delivery"] as const) {
    test(`an uncertain ${operation} keeps the worker as owner`, async () => {
        const id = operation === "import"
            ? "00000000-0000-4000-8000-000000000001"
            : "00000000-0000-4000-8000-000000000002";
        const path = `/sessions/${id}.jsonl`;
        const random = operation === "import" ? spyOn(crypto, "randomUUID").mockReturnValue(id) : undefined;
        const host = endpoint(new Map());
        const sessions = [new Map<string, RoutedSession>(), new Map<string, RoutedSession>(), new Map<string, RoutedSession>()];
        const [first, second, third] = sessions.map(endpoint) as [SessionEndpoint, SessionEndpoint, SessionEndpoint];
        let firstReady = true;
        host.inspect = async (sessionPath) => ({ id, sessionPath });
        const loseReply = async (): Promise<never> => {
            sessions[0]!.set(id, { id, workspace: "/work", sessionPath: path });
            firstReady = false;
            throw new Error("control connection closed before the reply");
        };
        first.resume = loseReply;
        first.find = loseReply;
        first.importSession = loseReply;
        first.deliverCompletion = loseReply;
        for (const [worker, owned] of [[second, sessions[1]!], [third, sessions[2]!]] as const) {
            worker.resume = async (sessionPath) => {
                const session = { id, workspace: "/work", sessionPath };
                owned.set(id, session);
                return session;
            };
        }
        const router = new HostRouter({
            host, worker: first, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
            workerReady: () => firstReady,
            extraWorkers: [
                { id: "w1", endpoint: second, socket: "/w1.sock", generation: () => 1, ready: () => true },
                { id: "w2", endpoint: third, socket: "/w2.sock", generation: () => 1, ready: () => true },
            ],
            keepResidentOwner: true,
        });
        try {
            if (operation === "resume") await router.resume(path).catch(() => {});
            if (operation === "locate") await router.locate(id);
            if (operation === "import") await router.importSession("/source.jsonl").catch(() => {});
            if (operation === "delivery") {
                await router.deliverCompletion(id, { id: "delivery", sourceAgentId: "child", content: "The map" }).catch(() => {});
            }
            expect(sessions[0]!.has(id)).toBe(true);
            const unavailable = await router.resume(path).then(() => undefined, (error: unknown) => error);
            expect(unavailable).toMatchObject({ message: "The session process is unavailable." });
            expect(sessions.filter((owned) => owned.has(id))).toHaveLength(1);
        } finally {
            random?.mockRestore();
        }
    });
}

test("an uncertain subagent open keeps its worker as owner", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const path = `/sessions/${id}.jsonl`;
    const firstSessions = new Map<string, RoutedSession>();
    const host = endpoint(new Map());
    host.inspect = async (sessionPath) => ({ id, sessionPath });
    let firstReady = true;
    const router = new HostRouter({
        host, worker: endpoint(firstSessions), hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
        workerReady: () => firstReady,
        extraWorkers: [
            { id: "w1", endpoint: endpoint(new Map()), socket: "/w1.sock", generation: () => 1, ready: () => true },
            { id: "w2", endpoint: endpoint(new Map()), socket: "/w2.sock", generation: () => 1, ready: () => true },
        ],
        keepResidentOwner: true,
    });
    await router.beginWorkerCreate("w0", id, path, "parent");
    firstSessions.set(id, { id, workspace: "/work", sessionPath: path });
    firstReady = false;
    const unavailable = await router.resume(path).then(() => undefined, (error: unknown) => error);
    expect(unavailable).toMatchObject({ message: "The session process is unavailable." });
    expect(firstSessions.has(id)).toBe(true);
    firstSessions.clear();
    router.workerExited("w0");
});

test("closing a cross-owner tree quiesces it before ordered lifecycle events", async () => {
    const parent = { id: "parent", workspace: "/work", sessionPath: "/sessions/parent.jsonl" };
    const child = { id: "child", workspace: "/work", sessionPath: "/sessions/child.jsonl", parentId: "parent" };
    const grandchild = { id: "grandchild", workspace: "/work", sessionPath: "/sessions/grandchild.jsonl", parentId: "child" };
    const hostSessions = new Map([[parent.id, parent], [grandchild.id, grandchild]]);
    const workerSessions = new Map([[child.id, child]]);
    const host = endpoint(hostSessions);
    const worker = endpoint(workerSessions);
    const events: string[] = [];
    for (const [label, target, sessions] of [["host", host, hostSessions], ["worker", worker, workerSessions]] as const) {
        target.quiesceClose = async (ids) => {
            events.push(`quiesce ${label}`);
            return ids.map((id) => ({ id, token: id }));
        };
        target.waitClose = async () => { events.push(`wait ${label}`); };
        target.finishCloseMember = async (ticket, reason) => {
            events.push(`${reason} ${ticket.id}`);
            const session = sessions.get(ticket.id);
            sessions.delete(ticket.id);
            return session === undefined ? undefined : { id: ticket.id, sessionPath: session.sessionPath };
        };
    }
    const router = new HostRouter({ host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    expect(await router.close(parent.id, "idle")).toEqual({ status: "closed", sessionRetained: true });
    expect(events.slice(0, 2)).toEqual(["quiesce host", "quiesce worker"]);
    expect(events.slice(4)).toEqual(["idle parent", "idle grandchild", "idle child"]);
});

test("blocking aborts a session that becomes resident during the block", async () => {
    const root = { id: "root", workspace: "/work", sessionPath: "/sessions/root.jsonl" };
    const late = { id: "late", workspace: "/work", sessionPath: "/sessions/late.jsonl", parentId: root.id };
    const host = endpoint(new Map([[root.id, root]]));
    const workerSessions = new Map<string, RoutedSession>();
    const worker = endpoint(workerSessions);
    const writing = deferred();
    const resume = deferred();
    let aborted = false;
    host.blockHasSession = async () => true;
    host.blockWrite = async () => {
        writing.resolve();
        await resume.promise;
        return true;
    };
    worker.blockAbort = async (ids) => {
        if (ids.includes(late.id) && workerSessions.has(late.id)) aborted = true;
    };
    const router = new HostRouter({ host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    const blocking = router.block({ type: "block_session", target_agent_id: root.id, session_ids: [late.id], reason: null });
    try {
        await writing.promise;
        workerSessions.set(late.id, late);
        resume.resolve();
        expect(await blocking).toEqual({ status: "blocked", sessionIds: [root.id, late.id] });
        expect(aborted).toBe(true);
    } finally {
        resume.resolve();
        await blocking.catch(() => {});
    }
});

for (const childOwner of ["host", "worker"] as const) {
    test(`blocking includes late descendants on the ${childOwner}`, async () => {
        const root = { id: "root", workspace: "/work", sessionPath: "/sessions/root.jsonl" };
        const child = { id: "late", workspace: "/work", sessionPath: "/sessions/late.jsonl", parentId: root.id };
        const grandchild = { id: "later", workspace: "/work", sessionPath: "/sessions/later.jsonl", parentId: child.id };
        const hostSessions = new Map<string, RoutedSession>([[root.id, root]]);
        const workerSessions = new Map<string, RoutedSession>();
        const host = endpoint(hostSessions);
        const worker = endpoint(workerSessions);
        const rootWritten = deferred();
        const writes: string[][] = [];
        const aborted = new Set<string>();
        host.blockHasSession = async () => true;
        host.blockWrite = async (_request, ids) => {
            writes.push([...ids]);
            if (writes.length === 1) rootWritten.resolve();
            if (ids.includes(child.id)) {
                (childOwner === "host" ? workerSessions : hostSessions).set(grandchild.id, grandchild);
            }
            return true;
        };
        for (const [target, owned] of [[host, hostSessions], [worker, workerSessions]] as const) {
            target.blockAbort = async (ids) => {
                for (const id of ids) if (owned.has(id)) aborted.add(id);
            };
        }
        const router = new HostRouter({ host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
        expect(await router.reserveSubagentStart(root.id, 1)).toBe(true);
        const blocking = router.block({ type: "block_session", target_agent_id: root.id, session_ids: [], reason: null });
        try {
            await rootWritten.promise;
            expect(await Promise.race([blocking.then(() => "finished"), Bun.sleep(20).then(() => "waiting")])).toBe("waiting");
            (childOwner === "host" ? hostSessions : workerSessions).set(child.id, child);
            await router.releaseSubagentStart(root.id);
            expect(await blocking).toEqual({ status: "blocked", sessionIds: [root.id, child.id, grandchild.id] });
            expect(writes).toEqual([[root.id], [child.id], [grandchild.id]]);
            expect([...aborted].sort()).toEqual([root.id, child.id, grandchild.id].sort());
        } finally {
            await router.releaseSubagentStart(root.id);
            await blocking.catch(() => {});
        }
    });
}

test("trash records closed members when another owner cannot quiesce", async () => {
    const root = { id: "root", workspace: "/work", sessionPath: "/sessions/root.jsonl" };
    const child = { id: "child", workspace: "/work", sessionPath: "/sessions/child.jsonl", parentId: root.id };
    const hostSessions = new Map([[root.id, root]]);
    const host = endpoint(hostSessions);
    const worker = endpoint(new Map([[child.id, child]]));
    const recorded: string[] = [];
    for (const target of [host, worker]) {
        target.reserveTrash = async () => ({ status: "reserved", plans: [] });
    }
    host.quiesceClose = async () => [{ id: root.id, token: "root-ticket" }];
    worker.quiesceClose = async () => { throw new Error("worker unavailable"); };
    host.finishCloseMember = async () => {
        hostSessions.delete(root.id);
        return { id: root.id, sessionPath: root.sessionPath };
    };
    host.recordTrashOutcome = async (_id, closed, trashed) => {
        expect(trashed).toBe(false);
        recorded.push(...closed.map((member) => member.id));
    };
    const router = new HostRouter({ host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    await expect(router.trash(root.id)).rejects.toThrow("worker unavailable");
    expect(recorded).toEqual([root.id]);
    expect(hostSessions.has(root.id)).toBe(false);
});

test("session facts for stored sessions go to the worker", async () => {
    const host = endpoint(new Map());
    const worker = endpoint(new Map());
    const seen: string[] = [];
    host.facts = async (rows) => { seen.push(...rows.map((row) => `host:${row.id}`)); return rows; };
    worker.facts = async (rows) => { seen.push(...rows.map((row) => `worker:${row.id}`)); return rows; };
    const router = new HostRouter({ host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    const stored: RegisteredAgentSummary = {
        id: "stored", live: false, workspace: "/work", session_path: "/sessions/stored.jsonl", kind: "interactive", status: "closed",
    };
    expect(await router.facts([stored], [])).toEqual([stored]);
    expect(seen).toEqual(["worker:stored"]);
});

test("a stored parent completion waits for crash repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-delivery-reservation-"));
    const path = join(root, "parent.jsonl");
    const reservations: RestoringSessions = new Map();
    const entered = deferred();
    const release = deferred();
    let scanning: Promise<void> | undefined;
    let sending: Promise<unknown> | undefined;
    try {
        const store = await SessionStore.create(path, { sessionId: "parent", cwd: root });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map" }] }, { turnStart: true });
        const stored: RegisteredAgentSummary = {
            id: "parent", live: false, workspace: root, session_path: path, kind: "interactive", status: "closed",
        };
        const host = endpoint(new Map());
        const worker = endpoint(new Map());
        worker.list = async () => [stored];
        let delivered = false;
        worker.deliverCompletion = async (_id, delivery, parentPath) => {
            delivered = true;
            expect(parentPath).toBe(path);
            return await (await SessionStore.open(path)).recordDelivery(delivery) ? "recorded" : "duplicate";
        };
        const router = new HostRouter({
            host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
            reserveDelivery: (_id, run) => withSessionReservation(path, reservations, run),
        });
        scanning = withSessionReservation(path, reservations, async () => {
            entered.resolve();
            await release.promise;
            await openSessionForRecovery(path);
        });
        await entered.promise;
        const delivery = { id: "completion:child", sourceAgentId: "child", content: "Found the map" };
        sending = router.deliverCompletion("parent", delivery);
        await Bun.sleep(20);
        expect(delivered).toBe(false);
        release.resolve();
        expect(await sending).toBe("recorded");
        await scanning;
        expect((await readSessionTurnState(path)).turnOpen).toBe(false);
        const repaired = await SessionStore.open(path);
        expect(repaired.projectedHarnessMessages()).toEqual([
            { afterMessage: 1, id: "harness:0", text: CRASH_CUT_MESSAGE, tone: "soft" },
        ]);
        expect(repaired.pendingDeliveries()).toContainEqual(expect.objectContaining(delivery));
        expect(await router.deliverCompletion("parent", delivery)).toBe("duplicate");
    } finally {
        release.resolve();
        await Promise.allSettled([scanning, sending].filter((promise) => promise !== undefined));
        await rm(root, { recursive: true, force: true });
    }
}, 10_000);

test("a move waits for an ongoing write and for the old host to release", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const hostSessions = new Map([[session.id, session]]);
    const workerSessions = new Map<string, RoutedSession>();
    const write = deferred();
    const writeStarted = deferred();
    const release = deferred();
    const releaseStarted = deferred();
    const events: string[] = [];
    const host = endpoint(hostSessions);
    const worker = endpoint(workerSessions);
    host.rename = async () => {
        events.push("write started");
        writeStarted.resolve();
        await write.promise;
        events.push("write finished");
        return { status: "renamed", name: "map" };
    };
    host.release = async (id) => {
        events.push("release started");
        releaseStarted.resolve();
        await release.promise;
        hostSessions.delete(id);
        events.push("release finished");
        return [id];
    };
    worker.resume = async () => {
        expect(hostSessions.has(session.id)).toBe(false);
        events.push("worker opened");
        workerSessions.set(session.id, session);
        return session;
    };
    const router = new HostRouter({
        host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
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
    const host = endpoint(new Map([[session.id, session]]));
    const worker = endpoint(new Map());
    host.release = async () => { throw new Error("busy"); };
    const router = new HostRouter({
        host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    await expect(router.resume(session.sessionPath)).rejects.toThrow("busy");
    expect(await router.locate(session.id)).toMatchObject({ type: "agent_location", socket_path: "/host.sock" });
});

test("a tree move reserves every member and preserves transfer resumes", async () => {
    const parent = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const child = { id: "child", workspace: "/work", sessionPath: "/sessions/child.jsonl" };
    const hostSessions = new Map([[parent.id, parent], [child.id, child]]);
    const workerSessions = new Map<string, RoutedSession>();
    const host = endpoint(hostSessions);
    const worker = endpoint(workerSessions);
    const inspect = async (path: string) => ({ id: path === child.sessionPath ? child.id : parent.id, sessionPath: path });
    host.inspect = inspect;
    worker.inspect = inspect;
    host.tree = async () => [parent.id, child.id];
    host.release = async () => {
        hostSessions.clear();
        return [parent.id, child.id];
    };
    const resumed: Array<{ path: string; options?: SessionResumeOptions }> = [];
    worker.resume = async (path, options) => {
        resumed.push({ path, options });
        const session = path === child.sessionPath ? child : parent;
        workerSessions.set(session.id, session);
        return session;
    };
    const router = new HostRouter({
        host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });

    await expect(router.resume(parent.sessionPath, new Set([parent.sessionPath])))
        .rejects.toBeInstanceOf(SessionTransferReservationsChanged);
    expect([...hostSessions.keys()]).toEqual([parent.id, child.id]);
    expect(resumed).toEqual([]);
    expect(await router.resume(parent.sessionPath, new Set([parent.sessionPath, child.sessionPath]))).toEqual(parent);
    expect(resumed).toEqual([
        { path: parent.sessionPath, options: { reserved: true, ownershipTransfer: true } },
        { path: child.sessionPath, options: { reserved: true, ownershipTransfer: true } },
    ]);
});

test("a branch in progress keeps its source on the current host", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const hostSessions = new Map([[session.id, session]]);
    const workerSessions = new Map<string, RoutedSession>();
    const host = endpoint(hostSessions);
    const worker = endpoint(workerSessions);
    host.release = async (id) => { hostSessions.delete(id); return [id]; };
    worker.resume = async () => { workerSessions.set(session.id, session); return session; };
    const router = new HostRouter({
        host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    expect(await router.beginBranch("host", session.id)).toBe(true);
    expect(await router.resume(session.sessionPath)).toEqual(session);
    expect(hostSessions.has(session.id)).toBe(true);
    expect(workerSessions.has(session.id)).toBe(false);
    router.endBranch(session.id);
    expect(await router.resume(session.sessionPath)).toEqual(session);
});

test("an in-flight extension request leaves other sessions available and prevents a move", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const other = { id: "two", workspace: "/work", sessionPath: "/sessions/two.jsonl" };
    const hostSessions = new Map([[session.id, session], [other.id, other]]);
    const workerSessions = new Map<string, RoutedSession>();
    const host = endpoint(hostSessions);
    const worker = endpoint(workerSessions);
    const started = deferred();
    let ownerSawAbort = false;
    host.askSession = async (_call, signal) => {
        started.resolve();
        await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => { ownerSawAbort = true; resolve(); }, { once: true });
        });
        signal.throwIfAborted();
        throw new Error("unreachable");
    };
    host.release = async (id) => { hostSessions.delete(id); return [id]; };
    worker.resume = async () => { workerSessions.set(session.id, session); return session; };
    const router = new HostRouter({
        host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    const controller = new AbortController();
    const pending = router.askSession({ sessionId: session.id, question: "Where is the map?" }, controller.signal);
    await started.promise;
    try {
        const location = await Promise.race([
            router.locate(other.id),
            Bun.sleep(1_000).then(() => undefined),
        ]);
        expect(location).toMatchObject({ type: "agent_location", socket_path: "/host.sock" });
        expect(await router.resume(session.sessionPath)).toEqual(session);
        expect(hostSessions.has(session.id)).toBe(true);
        expect(workerSessions.has(session.id)).toBe(false);
    } finally {
        controller.abort();
    }
    await expect(pending).rejects.toThrow();
    expect(ownerSawAbort).toBe(true);
    expect(await router.resume(session.sessionPath)).toEqual(session);
});

test("a closed session is not reopened on another owner until its write completes", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const other = { id: "two", workspace: "/work", sessionPath: "/sessions/two.jsonl" };
    const hostSessions = new Map([[session.id, session], [other.id, other]]);
    const workerSessions = new Map<string, RoutedSession>();
    const host = endpoint(hostSessions);
    const worker = endpoint(workerSessions);
    const started = deferred();
    const release = deferred();
    let reopened = false;
    host.setSessionTitle = async () => {
        started.resolve();
        await release.promise;
        return "set";
    };
    worker.find = async (id) => {
        reopened = true;
        workerSessions.set(id, session);
        return session;
    };
    const router = new HostRouter({ host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    const write = router.setSessionTitle(session.id, "Crow map");
    await started.promise;
    hostSessions.delete(session.id);
    const location = router.locate(session.id);
    try {
        expect(await Promise.race([location.then(() => "finished"), Bun.sleep(30).then(() => "waiting")])).toBe("waiting");
        expect(reopened).toBe(false);
        expect(await router.locate(other.id)).toMatchObject({ type: "agent_location", worker_id: "host" });
    } finally {
        release.resolve();
    }
    expect(await write).toBe("set");
    expect(await location).toMatchObject({ type: "agent_location", worker_id: "w0" });
    expect(reopened).toBe(true);
});

test("peer delivery can finish if its sender closes during delivery", async () => {
    const sender = { id: "sender", workspace: "/work", sessionPath: "/sessions/sender.jsonl" };
    const recipient = { id: "recipient", workspace: "/work", sessionPath: "/sessions/recipient.jsonl" };
    const hostSessions = new Map([[sender.id, sender]]);
    const host = endpoint(hostSessions);
    const worker = endpoint(new Map([[recipient.id, recipient]]));
    const router = new HostRouter({ host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    worker.peerSend = async () => {
        hostSessions.delete(sender.id);
        expect(await router.peerLabel(sender.id)).toBeUndefined();
        return { kind: "output", output: "delivered", isError: false };
    };
    const delivery = router.peerSend(
        { id: sender.id, workspace: sender.workspace, label: "Crow", hop: 0, readThrough: 0 },
        { type: "agent_send", to: recipient.id, text: "Map found." },
    );
    expect(await Promise.race([delivery, Bun.sleep(1_000).then(() => undefined)]))
        .toMatchObject({ output: "delivered", isError: false });
});

test("closing a child that disappears during the request returns not found", async () => {
    const parent = { id: "parent", workspace: "/work", sessionPath: "/sessions/parent.jsonl" };
    const child = { id: "child", workspace: "/work", sessionPath: "/sessions/child.jsonl", parentId: parent.id };
    const host = endpoint(new Map([[parent.id, parent]]));
    const workerSessions = new Map([[child.id, child]]);
    const worker = endpoint(workerSessions);
    worker.suppressCompletion = async (_id, suppress) => { if (suppress) workerSessions.delete(child.id); };
    const router = new HostRouter({ host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    expect(await Promise.race([router.closeSubagent(parent.id, child.id), Bun.sleep(1_000).then(() => undefined)]))
        .toEqual({ status: "not_found" });
});

test("a duplicate resident session is rejected", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const host = endpoint(new Map([[session.id, session]]));
    const worker = endpoint(new Map([[session.id, session]]));
    const router = new HostRouter({
        host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    await expect(router.resume(session.sessionPath)).rejects.toThrow("both hosts");
    expect(await router.locate(session.id)).toMatchObject({
        type: "agent_location_failed", reason: "worker_unavailable",
    });
});

test("a slow search does not block session location", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const host = endpoint(new Map([[session.id, session]]));
    const worker = endpoint(new Map());
    const started = deferred();
    const release = deferred();
    worker.searchShard = async () => {
        started.resolve();
        await release.promise;
        return { results: [], truncated: false };
    };
    const router = new HostRouter({
        host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
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

test("a search fails when either owner cannot answer", async () => {
    const host = endpoint(new Map());
    const worker = endpoint(new Map());
    worker.searchShard = async () => { throw new Error("worker unavailable"); };
    const router = new HostRouter({
        host, worker, hostSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    const error = await router.search({ query: "map" }).then(() => undefined, (failure: Error) => failure.message);
    expect(error).toBe("worker unavailable");
});

test("the roster prefers each owner and omits stale copies", () => {
    const row = (id: string, live: boolean): RegisteredAgentSummary => ({
        id, live, workspace: "/work", session_path: `/sessions/${id}.jsonl`, kind: "interactive", status: "idle",
    });
    const merged = mergeRoster(
        [row("host", true), row("worker", false), row("trashed", false)],
        [row("host", false), row("worker", true)],
        (id) => id === "host" ? "host" : "w0",
    );
    expect(merged.map((item) => [item.id, item.live])).toEqual([["host", true], ["worker", true]]);
});
