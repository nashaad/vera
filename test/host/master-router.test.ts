import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostRouter, SessionTransferReservationsChanged, type RoutedSession, type SessionEndpoint, type SessionResumeOptions } from "../../src/host/master/router.ts";
import { mergeRoster } from "../../src/host/master/roster.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { withSessionReservation, type RestoringSessions } from "../../src/host/session-host/storage.ts";
import { CRASH_CUT_MESSAGE, SessionStore, openSessionForRecovery, readSessionTurnState } from "../../src/store/session-store.ts";

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

test("closing a cross-owner tree quiesces it before ordered lifecycle events", async () => {
    const parent = { id: "parent", workspace: "/work", sessionPath: "/sessions/parent.jsonl" };
    const child = { id: "child", workspace: "/work", sessionPath: "/sessions/child.jsonl", parentId: "parent" };
    const grandchild = { id: "grandchild", workspace: "/work", sessionPath: "/sessions/grandchild.jsonl", parentId: "child" };
    const hostSessions = new Map([[parent.id, parent], [grandchild.id, grandchild]]);
    const workerSessions = new Map([[child.id, child]]);
    const master = endpoint(hostSessions);
    const worker = endpoint(workerSessions);
    const events: string[] = [];
    for (const [label, target, sessions] of [["host", master, hostSessions], ["worker", worker, workerSessions]] as const) {
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
    const router = new HostRouter({ master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    expect(await router.close(parent.id, "idle")).toEqual({ status: "closed", sessionRetained: true });
    expect(events.slice(0, 2)).toEqual(["quiesce host", "quiesce worker"]);
    expect(events.slice(4)).toEqual(["idle parent", "idle grandchild", "idle child"]);
});

test("session facts for stored sessions go to the worker", async () => {
    const master = endpoint(new Map());
    const worker = endpoint(new Map());
    const seen: string[] = [];
    master.facts = async (rows) => { seen.push(...rows.map((row) => `host:${row.id}`)); return rows; };
    worker.facts = async (rows) => { seen.push(...rows.map((row) => `worker:${row.id}`)); return rows; };
    const router = new HostRouter({ master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
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
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map" }] });
        const stored: RegisteredAgentSummary = {
            id: "parent", live: false, workspace: root, session_path: path, kind: "interactive", status: "closed",
        };
        const master = endpoint(new Map());
        const worker = endpoint(new Map());
        worker.list = async () => [stored];
        let delivered = false;
        worker.deliverCompletion = async (_id, delivery, parentPath) => {
            delivered = true;
            expect(parentPath).toBe(path);
            return await (await SessionStore.open(path)).recordDelivery(delivery) ? "recorded" : "duplicate";
        };
        const router = new HostRouter({
            master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
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
            { afterMessage: 1, text: CRASH_CUT_MESSAGE, tone: "soft" },
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

test("a tree move reserves every member and preserves transfer resumes", async () => {
    const parent = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const child = { id: "child", workspace: "/work", sessionPath: "/sessions/child.jsonl" };
    const masterSessions = new Map([[parent.id, parent], [child.id, child]]);
    const workerSessions = new Map<string, RoutedSession>();
    const master = endpoint(masterSessions);
    const worker = endpoint(workerSessions);
    const inspect = async (path: string) => ({ id: path === child.sessionPath ? child.id : parent.id, sessionPath: path });
    master.inspect = inspect;
    worker.inspect = inspect;
    master.tree = async () => [parent.id, child.id];
    master.release = async () => {
        masterSessions.clear();
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
        master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });

    await expect(router.resume(parent.sessionPath, new Set([parent.sessionPath])))
        .rejects.toBeInstanceOf(SessionTransferReservationsChanged);
    expect([...masterSessions.keys()]).toEqual([parent.id, child.id]);
    expect(resumed).toEqual([]);
    expect(await router.resume(parent.sessionPath, new Set([parent.sessionPath, child.sessionPath]))).toEqual(parent);
    expect(resumed).toEqual([
        { path: parent.sessionPath, options: { reserved: true, ownershipTransfer: true } },
        { path: child.sessionPath, options: { reserved: true, ownershipTransfer: true } },
    ]);
});

test("a branch in progress keeps its source on the current host", async () => {
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
    expect(await router.resume(session.sessionPath)).toEqual(session);
    expect(masterSessions.has(session.id)).toBe(true);
    expect(workerSessions.has(session.id)).toBe(false);
    router.endBranch(session.id);
    expect(await router.resume(session.sessionPath)).toEqual(session);
});

test("an in-flight extension request leaves other sessions available and prevents a move", async () => {
    const session = { id: "one", workspace: "/work", sessionPath: "/sessions/one.jsonl" };
    const other = { id: "two", workspace: "/work", sessionPath: "/sessions/two.jsonl" };
    const masterSessions = new Map([[session.id, session], [other.id, other]]);
    const workerSessions = new Map<string, RoutedSession>();
    const master = endpoint(masterSessions);
    const worker = endpoint(workerSessions);
    const started = deferred();
    let ownerSawAbort = false;
    master.askSession = async (_call, signal) => {
        started.resolve();
        await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => { ownerSawAbort = true; resolve(); }, { once: true });
        });
        signal.throwIfAborted();
        throw new Error("unreachable");
    };
    master.release = async (id) => { masterSessions.delete(id); return [id]; };
    worker.resume = async () => { workerSessions.set(session.id, session); return session; };
    const router = new HostRouter({
        master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
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
        expect(masterSessions.has(session.id)).toBe(true);
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
    const masterSessions = new Map([[session.id, session], [other.id, other]]);
    const workerSessions = new Map<string, RoutedSession>();
    const master = endpoint(masterSessions);
    const worker = endpoint(workerSessions);
    const started = deferred();
    const release = deferred();
    let reopened = false;
    master.setSessionTitle = async () => {
        started.resolve();
        await release.promise;
        return "set";
    };
    worker.find = async (id) => {
        reopened = true;
        workerSessions.set(id, session);
        return session;
    };
    const router = new HostRouter({ master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    const write = router.setSessionTitle(session.id, "Crow map");
    await started.promise;
    masterSessions.delete(session.id);
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
    const masterSessions = new Map([[sender.id, sender]]);
    const master = endpoint(masterSessions);
    const worker = endpoint(new Map([[recipient.id, recipient]]));
    const router = new HostRouter({ master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    worker.peerSend = async () => {
        masterSessions.delete(sender.id);
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
    const master = endpoint(new Map([[parent.id, parent]]));
    const workerSessions = new Map([[child.id, child]]);
    const worker = endpoint(workerSessions);
    worker.suppressCompletion = async (_id, suppress) => { if (suppress) workerSessions.delete(child.id); };
    const router = new HostRouter({ master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test" });
    expect(await Promise.race([router.closeSubagent(parent.id, child.id), Bun.sleep(1_000).then(() => undefined)]))
        .toEqual({ status: "not_found" });
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
    worker.searchShard = async () => {
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

test("a search fails when either owner cannot answer", async () => {
    const master = endpoint(new Map());
    const worker = endpoint(new Map());
    worker.searchShard = async () => { throw new Error("worker unavailable"); };
    const router = new HostRouter({
        master, worker, masterSocket: "/host.sock", workerSocket: "/w0.sock", buildId: "test",
    });
    const error = await router.search({ query: "map" }).then(() => undefined, (failure: Error) => failure.message);
    expect(error).toBe("worker unavailable");
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
