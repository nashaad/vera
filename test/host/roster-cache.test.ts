import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentRegistry, type RegisteredAgentEntry } from "../../src/host/agent-registry.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { PreimageStash, defaultStashRoot } from "../../src/store/preimage-stash.ts";
import { veraHomeDirectory } from "../../src/profile-paths.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { startHostServer } from "../../src/host/server.ts";
import { HOST_CAPABILITY_SESSION_TITLE, HOST_CAPABILITY_WORK_INDEX } from "../../src/host/capabilities.ts";
import { buildWorkIndex } from "../../src/host/work-index.ts";
import * as reference from "../support/roster-reference.ts";

async function fixture() {
    const root = await mkdtemp(join(veraHomeDirectory(), "roster-"));
    const registry = new AgentRegistry({
        model: "faux/test",
        approvalMode: "ask",
        createAdapter: () => { throw new Error("No turn adapter required"); },
    });
    const ids: string[] = [];
    async function add(id: string, parentId?: string): Promise<RegisteredAgentEntry> {
        ids.push(id);
        const store = await SessionStore.create(join(root, `${id}.jsonl`), { sessionId: id, cwd: root });
        const agent = new ResidentAgent(id, root, { onRunStateChanged: () => registry.notifyRosterChanged() });
        const entry: RegisteredAgentEntry = {
            agent, store, kind: parentId === undefined ? "interactive" : "background",
            ephemeral: false, pendingPublication: false, parentId,
            events: new EngineEventBus(), modelSettings: { model: "faux/test" },
            approvalMode: "ask", loopReady: Promise.resolve(), markLoopReady: () => {},
            peerHop: 0, peerWakes: [], run: Promise.resolve(), completed: false,
            pendingAsyncTurns: 0, pendingCompletionDeliveries: 0, completionSequence: 0,
        };
        registry.agents.set(id, entry);
        registry.notifyRosterChanged();
        return entry;
    }
    const servers: Awaited<ReturnType<typeof startHostServer>>[] = [];
    const clients: AttachedAgentClient[] = [];
    async function connect(id: string, original = false): Promise<AttachedAgentClient> {
        const serverIndex = original ? 1 : 0;
        const socketPath = join(root, `host-${serverIndex}.sock`);
        if (servers[serverIndex] === undefined) {
            const server = await startHostServer({
                socketPath, lockPath: join(root, `host-${serverIndex}.json`),
                capabilities: [HOST_CAPABILITY_WORK_INDEX, HOST_CAPABILITY_SESSION_TITLE],
                findAgent: (id) => registry.find(id),
                listBackgroundAgents: () => original ? reference.list(registry) : registry.list(),
                readWorkIndex: () => buildWorkIndex(original ? reference.workFacts(registry) : registry.workFacts()),
                onRosterChanged: (listener) => registry.onRosterChanged(listener),
            });
            servers[serverIndex] = server;
        }
        const client = await attachAgent({
            socketPath, agentId: id,
            requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX, HOST_CAPABILITY_SESSION_TITLE],
        });
        clients.push(client);
        await Bun.sleep(20);
        return client;
    }
    async function close(): Promise<void> {
        for (const client of clients) client.close();
        for (const entry of registry.agents.values()) entry.agent.close();
        for (const server of servers) await server?.close();
        for (const id of ids) await rm(join(defaultStashRoot(), id), { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
    return { root, registry, add, connect, close };
}

test("a run-state change builds the affected summary once across clients", async () => {
    const f = await fixture();
    try {
        const parent = await f.add("crow-parent");
        const child = await f.add("crow-child", parent.agent.id);
        const idle = await f.add("crow-idle");
        const clients: AttachedAgentClient[] = [];
        for (let index = 0; index < 4; index += 1) clients.push(await f.connect(parent.agent.id));
        f.registry.workFacts();
        const spies = [parent, child, idle].map((entry) => spyOn(entry.store, "activeEntries"));
        try {
            child.agent.engine.send({ type: "status", state: "working", seq: 1 });
            expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 1, 0]);
            await Bun.sleep(20);
            expect(clients.map((client) => client.backgroundAgents.running)).toEqual([1, 1, 1, 1]);
            for (const spy of spies) spy.mockClear();
            child.agent.engine.send({ type: "turn_finished", seq: 2 });
            expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 1, 0]);
            await Bun.sleep(20);
            expect(clients.map((client) => client.backgroundAgents.running)).toEqual([0, 0, 0, 0]);
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
    } finally {
        await f.close();
    }
});

test("clients receive the uncached roster sequence through create, turns, rename, stash and close", async () => {
    const f = await fixture();
    try {
        const parent = await f.add("crow-parent");
        await f.add("crow-idle");
        const clients = [await f.connect(parent.agent.id), await f.connect(parent.agent.id, true)];
        const traces = clients.map((client) => {
            const trace: unknown[] = [];
            client.onBackgroundAgents((value) => trace.push({ background: value }));
            client.onWorkIndex((value) => trace.push({ work: value }));
            client.onSessionTitle((value) => trace.push({ title: value }));
            return trace;
        });
        async function check(): Promise<void> {
            await Bun.sleep(20);
            expect(traces[0]).toEqual(traces[1]);
            expect(clients[0]!.backgroundAgents).toEqual(clients[1]!.backgroundAgents);
            expect(clients[0]!.workIndex).toEqual(clients[1]!.workIndex);
            expect(clients[0]!.sessionTitle).toEqual(clients[1]!.sessionTitle);
            expect(f.registry.list()).toEqual(reference.list(f.registry));
            expect(f.registry.workFacts()).toEqual(reference.workFacts(f.registry));
        }
        await check();
        const child = await f.add("crow-child", parent.agent.id);
        await check();
        await child.store.appendMessage({ role: "user", content: [{ type: "text", text: "Find the pirate crow" }] });
        child.agent.engine.send({ type: "status", state: "working", seq: 1 });
        await check();
        const edited = join(f.root, "crow.txt");
        await writeFile(edited, "pirate crow");
        await new PreimageStash(child.agent.id).capture(edited, "pirate crow");
        await writeFile(edited, "pirate crow returns");
        await check();
        child.agent.engine.send({ type: "turn_finished", seq: 2 });
        await check();
        expect(clients[0]?.workIndex?.rows.find((row) => row.session_id === child.agent.id)?.changed_files).toBe(1);
        await f.registry.updateSessionName(parent.agent.id, "Pirate crow");
        await f.registry.updateSessionName(child.agent.id, "Crow lookout");
        await check();
        child.agent.engine.send({ type: "status", state: "working", seq: 3 });
        await check();
        child.agent.engine.send({ type: "ui_request", requestId: "question", request: { type: "user_question", question: "Where is the crow?", choices: [] }, seq: 4 });
        await check();
        child.agent.engine.send({ type: "turn_finished", seq: 5 });
        await check();
        child.agent.close();
        f.registry.agents.delete(child.agent.id);
        f.registry.notifyRosterChanged();
        await check();
        expect(traces[0]!.length).toBeGreaterThan(8);
    } finally {
        await f.close();
    }
});


test("nested roster changes and a failed listener leave later readers current", async () => {
    const f = await fixture();
    try {
        const child = await f.add("crow-child");
        let nested = false;
        f.registry.onRosterChanged(() => {
            f.registry.list();
            if (!nested) {
                nested = true;
                child.agent.close();
            }
        });
        f.registry.onRosterChanged(() => { throw new Error("Disconnected listener"); });
        const states: string[] = [];
        f.registry.onRosterChanged(() => states.push(f.registry.list()[0]!.status));
        f.registry.notifyRosterChanged();
        expect(states).toEqual(["closed", "closed"]);
        expect(f.registry.list()).toEqual(reference.list(f.registry));
    } finally {
        await f.close();
    }
});


test("delivery receipts and rewinds refresh unread results from the real store", async () => {
    const f = await fixture();
    try {
        const parent = await f.add("crow-parent");
        const child = await f.add("crow-child", parent.agent.id);
        child.completed = true;
        const unread = () => f.registry.workFacts().find((row) => row.id === child.agent.id)?.unread_result;
        expect(unread()).toBeUndefined();
        await parent.store.recordDelivery({ id: "crow-result", sourceAgentId: child.agent.id, content: "Crow found", kind: "completion" });
        expect(unread()).toBe(true);
        const boundary = await parent.store.appendMessage({ role: "user", content: [{ type: "text", text: "Find the crow" }] });
        await parent.store.appendDeliveryMessage("crow-result", { role: "user", internal: true, content: [{ type: "text", text: "Crow found" }] });
        expect(unread()).toBeUndefined();
        await parent.store.rewindBefore(boundary.id);
        expect(unread()).toBe(true);
        expect(f.registry.workFacts()).toEqual(reference.workFacts(f.registry));
    } finally {
        await f.close();
    }
});

test("unchanged failed sessions reuse their summary", async () => {
    const f = await fixture();
    try {
        const entry = await f.add("crow-failed");
        await entry.store.appendAgentFailure("crow-failure", "The crow lost its connection");
        entry.failure = new Error("The crow lost its connection");
        f.registry.list();
        const spy = spyOn(entry.store, "activeEntries");
        try {
            const summary = f.registry.list()[0];
            expect(f.registry.list()[0]).toBe(summary);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
        expect(f.registry.list()).toEqual(reference.list(f.registry));
    } finally {
        await f.close();
    }
});
