import { expect, test } from "bun:test";
import { socketAndLoopbackTest, socketTest } from "../support/socket-probe.ts";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { branchAgentThroughHost, createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { listAgentPageThroughHost, listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { refreshCatalogsThroughHost } from "../../src/host/catalog-refresh-client.ts";
import { connectHost } from "../../src/host/connection.ts";
import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import { HOST_PROTOCOL_VERSION, requestHostIdentity, requestHostShutdownIfIdle } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { renameSessionThroughHost } from "../../src/host/session-rename-client.ts";
import { searchSessionsThroughHost } from "../../src/host/session-search-client.ts";
import { trashSessionThroughHost } from "../../src/host/session-trash-client.ts";
import { CRASHED_TOOL_RESULT, CRASH_CUT_MESSAGE, SessionStore, readSessionTurnState } from "../../src/store/session-store.ts";
import { emptyUsage, type AssistantMessage, type ModelRequest } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { installTransferHooks, transferHookEvents, waitForTransferHooks } from "../support/transfer-hooks.ts";

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "auto",
} as const;

async function locate(socketPath: string, id: string): Promise<unknown> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({ type: "locate_agent", agent_id: id });
        return await connection.receive();
    } finally {
        connection.close();
    }
}

async function finishTurn(client: AttachedAgentClient): Promise<void> {
    while ((await client.receive()).type !== "turn_finished") {}
}

async function sessionModelSettings(client: AttachedAgentClient, requestId: string) {
    await client.send({ type: "get_model_settings", requestId });
    while (true) {
        const update = await client.receive(AbortSignal.timeout(5_000));
        if (update.type === "model_settings" && update.requestId === requestId) {
            return update.settings;
        }
    }
}

socketAndLoopbackTest("a host catalog refresh reaches an existing worker session", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/gateway/v1/models") {
                return Response.json({
                    data: [{ id: "pirate/crow", context_window: 50_000 }],
                });
            }
            if (path === "/ollama/api/tags") return Response.json({ models: [] });
            return Response.json({ data: [] });
        },
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        const configPath = join(home, "config.json");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "test_gateway",
            model: "faux/test",
            approval_mode: "auto",
            providers: {
                test_gateway: {
                    protocol: "openai-chat",
                    base_url: `${endpoint}/gateway/v1`,
                    credential: "none",
                },
            },
            provider_endpoints: {
                ollama: `${endpoint}/ollama`,
                omlx: `${endpoint}/omlx/v1`,
                outrider: `${endpoint}/outrider/v1`,
            },
        }));
        host = await startResidentHost({
            home,
            configPath,
            config: loadVeraConfig({ path: configPath }),
            inProcessWorker: true,
            createAdapter: () => new FauxAdapter([]),
        });
        const worker = await createAgentThroughHost(host.server.socketPath, home);
        expect(await locate(host.server.socketPath, worker.id)).toMatchObject({
            socket_path: inProcessWorkerSocket(home), worker_id: "w0",
        });
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: worker.id });
        expect((await client.receive()).type).toBe("history");
        const before = await sessionModelSettings(client, "before-refresh");
        expect(before.availableModels?.some((model) =>
            model.provider === "test_gateway" && model.model === "pirate/crow"
        )).toBe(false);

        const outcomes = await refreshCatalogsThroughHost(host.server.socketPath);
        expect(outcomes).toContainEqual(expect.objectContaining({ provider: "test_gateway", models: 1 }));
        const after = await sessionModelSettings(client, "after-refresh");
        expect(after.availableModels).toContainEqual(expect.objectContaining({
            provider: "test_gateway", model: "pirate/crow", contextWindow: 50_000,
        }));
    } finally {
        client?.close();
        try {
            await host?.close();
        } finally {
            server.stop(true);
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("create routes to the worker, two clients attach, and the host merges both rosters", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const host = await startResidentHost({
        home, config, inProcessWorker: true,
        createAdapter: () => new FauxAdapter([textResponse("A pirate crow found the map.")]),
    });
    const hostSocket = host.server.socketPath;
    const workerSocket = inProcessWorkerSocket(home);
    const annexPid = host.annexPid;
    let first: AttachedAgentClient | undefined;
    let second: AttachedAgentClient | undefined;
    let throughHost: AttachedAgentClient | undefined;
    try {
        const hostSession = await host.registry.create({ workspace: home });
        const worker = await createAgentThroughHost(hostSocket, home);
        expect(existsSync(hostSocket)).toBe(true);
        expect(existsSync(workerSocket)).toBe(true);
        expect(await requestHostIdentity(workerSocket)).toMatchObject({
            role: "worker", worker_id: "w0",
            pid: host.server.identity.pid, started_at: host.server.identity.started_at,
        });
        expect(await locate(hostSocket, worker.id)).toMatchObject({
            type: "agent_location", socket_path: workerSocket, worker_id: "w0",
        });
        const rows = await listAgentsThroughHost(hostSocket);
        expect(rows.filter((row) => row.id === hostSession.id)).toHaveLength(1);
        expect(rows.filter((row) => row.id === worker.id)).toHaveLength(1);
        expect(host.registry.find(worker.id)).toBeUndefined();
        const secondHostSession = await host.registry.create({ workspace: home });
        const secondPath = host.registry.list().find((row) => row.id === secondHostSession.id)!.session_path;
        await Promise.all([
            resumeAgentThroughHost(hostSocket, rows.find((row) => row.id === hostSession.id)!.session_path),
            resumeAgentThroughHost(hostSocket, secondPath),
        ]);
        for (const id of [hostSession.id, secondHostSession.id]) {
            expect(host.registry.agents.has(id)).toBe(false);
            expect(await locate(hostSocket, id)).toMatchObject({ socket_path: workerSocket });
        }

        first = await attachAgent({ socketPath: workerSocket, agentId: worker.id });
        second = await attachAgent({ socketPath: workerSocket, agentId: worker.id });
        throughHost = await attachAgent({ socketPath: hostSocket, agentId: worker.id });
        expect((await first.receive()).type).toBe("history");
        expect((await second.receive()).type).toBe("history");
        expect((await throughHost.receive()).type).toBe("history");
        expect(await requestHostShutdownIfIdle(hostSocket, host.server.identity, HOST_PROTOCOL_VERSION + 1))
            .toEqual({ type: "shutdown_if_idle_refused", reason: "busy" });
        const workerIdentity = await requestHostIdentity(workerSocket);
        expect(await requestHostShutdownIfIdle(workerSocket, workerIdentity!, HOST_PROTOCOL_VERSION + 1))
            .toEqual({ type: "shutdown_if_idle_refused", reason: "busy" });
        expect(existsSync(join(home, "runtime", "w0.json"))).toBe(false);
        const finished = Promise.all([finishTurn(first), finishTurn(second), finishTurn(throughHost)]);
        await first.send({ type: "prompt", content: "Where is the map?" });
        await finished;
        const page = await listAgentPageThroughHost(hostSocket, { include: ["usage"], limit: 10 });
        expect(page.agents.find((row) => row.id === worker.id)?.facts?.usage?.rows).toHaveLength(1);
        const found = await searchSessionsThroughHost(hostSocket, { query: "pirate crow", session_id: worker.id });
        expect(found.results.map((row) => row.session_id)).toEqual([worker.id]);
        const branched = await branchAgentThroughHost(hostSocket, worker.id, "at", undefined, { lifetime: "ephemeral" });
        expect(await locate(hostSocket, branched.id)).toMatchObject({ socket_path: workerSocket });
        const branchClient = await attachAgent({ socketPath: workerSocket, agentId: branched.id });
        expect((await branchClient.receive()).type).toBe("history");
        branchClient.close();
    } finally {
        first?.close();
        second?.close();
        throughHost?.close();
        await host.close();
        try {
            expect(existsSync(workerSocket)).toBe(false);
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 20_000);

socketTest("resume releases the host before the worker opens a session", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const host = await startResidentHost({
        home, config, inProcessWorker: true,
        createAdapter: () => new FauxAdapter([]),
    });
    const hostSocket = host.server.socketPath;
    const workerSocket = inProcessWorkerSocket(home);
    const originalOpen = SessionStore.open;
    let activeClient: AttachedAgentClient | undefined;
    let releaseStore: () => void = () => {};
    try {
        const agent = await host.registry.create({ workspace: home });
        const path = host.registry.list().find((row) => row.id === agent.id)!.session_path;
        const canonicalPath = await realpath(path);
        expect(await locate(hostSocket, agent.id)).toMatchObject({
            type: "agent_location", socket_path: hostSocket,
        });

        activeClient = await attachAgent({ socketPath: hostSocket, agentId: agent.id });
        await activeClient.receive();
        expect((await resumeAgentThroughHost(hostSocket, path)).id).toBe(agent.id);
        expect(host.registry.find(agent.id)).toBe(agent);
        activeClient.close();
        activeClient = undefined;
        await waitUntil(() => !agent.attached);
        const entry = host.registry.agents.get(agent.id)!;
        entry.pendingCompletionDeliveries = 1;
        expect((await resumeAgentThroughHost(hostSocket, path)).id).toBe(agent.id);
        expect(host.registry.agents.has(agent.id)).toBe(true);
        entry.pendingCompletionDeliveries = 0;

        const opens: boolean[] = [];
        SessionStore.open = async (openedPath, options) => {
            if (await realpath(openedPath) === canonicalPath) {
                opens.push(!host.registry.agents.has(agent.id));
            }
            return await originalOpen(openedPath, options);
        };
        let storeStarted: () => void = () => {};
        const storeStartedPromise = new Promise<void>((resolve) => { storeStarted = resolve; });
        const storeHeld = new Promise<void>((resolve) => { releaseStore = resolve; });
        const pendingStore = entry.store.exclusively(async () => {
            storeStarted();
            await storeHeld;
        });
        await storeStartedPromise;
        const resuming = Promise.all([
            resumeAgentThroughHost(hostSocket, path),
            resumeAgentThroughHost(hostSocket, path),
        ]);
        await waitUntil(() => !host.registry.agents.has(agent.id));
        expect(opens).toEqual([]);
        releaseStore();
        await pendingStore;
        const resumed = await resuming;
        expect(resumed.map((item) => item.id)).toEqual([agent.id, agent.id]);
        expect(opens).toEqual([true]);
        expect(host.registry.find(agent.id)).toBeUndefined();
        expect(await locate(hostSocket, agent.id)).toMatchObject({
            type: "agent_location", socket_path: workerSocket, worker_id: "w0",
        });
        const workerClient = await attachAgent({ socketPath: workerSocket, agentId: agent.id });
        expect((await workerClient.receive()).type).toBe("history");
        workerClient.close();
    } finally {
        releaseStore();
        SessionStore.open = originalOpen;
        activeClient?.close();
        await host.close();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

socketTest("an ownership transfer does not fire lifecycle hooks or add context", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const { config: hookedConfig, log, updates } = await installTransferHooks(home);
    const requests: ModelRequest[] = [];
    const host = await startResidentHost({
        home, config: hookedConfig, inProcessWorker: true,
        createAdapter: () => ({ stream(request) {
            requests.push(request);
            return new FauxAdapter([textResponse("The map is safe.")]).stream(request);
        } }),
    });
    let client: AttachedAgentClient | undefined;
    try {
        const agent = await host.registry.create({ workspace: home });
        const entry = host.registry.agents.get(agent.id)!;
        const path = entry.store.path;
        await waitForTransferHooks(log, 2);
        await waitUntil(() => entry.store.messages().some((message) => message.role === "user" && message.contextSource === "session_start"));
        const before = (await SessionStore.open(path)).messages();
        const beforeFile = await readFile(path, "utf8");
        await writeFile(log, "");
        await writeFile(updates, "");

        await resumeAgentThroughHost(host.server.socketPath, path);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        expect(await transferHookEvents(log)).toEqual([]);
        expect(await readFile(updates, "utf8")).toBe("");
        expect((await SessionStore.open(path)).messages()).toEqual(before);
        expect(await readFile(path, "utf8")).toBe(beforeFile);
        await client.send({ type: "prompt", content: "Where is the map?" });
        await finishTurn(client);
        expect(requests).toHaveLength(1);
        const sent = JSON.stringify(requests[0]!.messages);
        expect(sent).toContain("command: start");
        expect(sent).not.toContain("command: resume");
        expect(sent).not.toContain("extension: resume");
        client.close();
        client = undefined;

        const ordinary = await host.registry.create({ workspace: home });
        const ordinaryEntry = host.registry.agents.get(ordinary.id)!;
        await waitForTransferHooks(log, 2);
        await waitUntil(() => ordinaryEntry.store.messages().some((message) => message.role === "user" && message.contextSource === "session_start"));
        await writeFile(log, "");
        expect((await host.registry.closeAgentTree(ordinary.id, "idle")).status).toBe("closed");
        const ended = await waitForTransferHooks(log, 2);
        expect(ended.map(({ source, type, reason }) => ({ source, type, reason })).sort((a, b) => a.source.localeCompare(b.source)))
            .toEqual([
                { source: "command", type: "session_end", reason: "idle" },
                { source: "extension", type: "session_end", reason: "idle" },
            ]);
        await writeFile(log, "");
        await resumeAgentThroughHost(host.server.socketPath, ordinaryEntry.store.path);
        const resumed = await waitForTransferHooks(log, 2);
        expect(resumed.every((event) => event.type === "session_start" && event.reason === "resume")).toBe(true);
    } finally {
        client?.close();
        await host.close();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

socketTest("an ownership transfer moves a resident session tree without a crash cut", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const parentPath = join(home, "parent.jsonl");
    const childPath = join(home, "child.jsonl");
    const host = await startResidentHost({
        home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]),
    });
    let childClient: AttachedAgentClient | undefined;
    try {
        await host.registry.create({ id: "parent", workspace: home, sessionPath: parentPath });
        await host.registry.agents.get("parent")!.store.appendMessage({
            role: "user", internal: true, content: [{ type: "text", text: "Reference map" }],
        });
        await SessionStore.create(childPath, { sessionId: "child", cwd: home, parentId: "parent" });
        await host.registry.resume({ sessionPath: childPath });
        await waitUntil(() => host.registry.agents.get("parent")?.agent.idleForShutdown() === true
            && host.registry.agents.get("child")?.agent.idleForShutdown() === true);
        for (const id of ["parent", "child"]) {
            await host.registry.agents.get(id)!.store.appendMessage({
                role: "user", content: [{ type: "text", text: "Inspect the map" }],
            }, { turnStart: true });
        }
        expect((await readSessionTurnState(parentPath)).turnOpen).toBe(true);
        expect((await readSessionTurnState(childPath)).turnOpen).toBe(true);
        const before = await Promise.all([readFile(parentPath, "utf8"), readFile(childPath, "utf8")]);

        await resumeAgentThroughHost(host.server.socketPath, parentPath);
        expect(host.registry.agents.has("parent")).toBe(false);
        expect(host.registry.agents.has("child")).toBe(false);
        for (const id of ["parent", "child"]) {
            expect(await locate(host.server.socketPath, id)).toMatchObject({ worker_id: "w0" });
        }
        childClient = await attachAgent({ socketPath: host.server.socketPath, agentId: "child" });
        expect((await childClient.receive()).type).toBe("history");
        expect(await Promise.all([readFile(parentPath, "utf8"), readFile(childPath, "utf8")])).toEqual(before);
        expect((await readSessionTurnState(parentPath)).turnOpen).toBe(true);
        expect((await readSessionTurnState(childPath)).turnOpen).toBe(true);
    } finally {
        childClient?.close();
        await host.close();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

socketTest("a worker repairs an interrupted session when it opens without a crash scan", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const path = join(home, "crow.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: home });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map" }] }, { turnStart: true });
    await store.appendMessage({
        role: "assistant", content: [{ type: "tool_call", id: "read-map", name: "read", input: { path: "map" } }],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
    });
    const host = await startResidentHost({
        home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]),
    });
    let client: AttachedAgentClient | undefined;
    try {
        expect((await resumeAgentThroughHost(host.server.socketPath, path)).id).toBe("crow");
        expect(await locate(host.server.socketPath, "crow")).toMatchObject({ worker_id: "w0" });
        expect((await readSessionTurnState(path)).turnOpen).toBe(false);
        expect((await SessionStore.open(path)).messages().at(-1)).toMatchObject({
            role: "tool_result", toolCallId: "read-map", isError: true,
            content: [{ type: "text", text: CRASHED_TOOL_RESULT }],
        });
        const repaired = await readFile(path, "utf8");
        expect(repaired.split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: "crow" });
        expect((await client.receive()).type).toBe("history");
        await resumeAgentThroughHost(host.server.socketPath, path);
        expect(await readFile(path, "utf8")).toBe(repaired);
    } finally {
        client?.close();
        await host.close();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

socketTest("stored parent completions are serialized before recovery starts a delivery turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const path = join(home, "runtime", "sessions", "parent.jsonl");
    const store = await SessionStore.create(path, { sessionId: "parent", cwd: home });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map" }] }, { turnStart: true });
    const host = await startResidentHost({
        home, config, inProcessWorker: true,
        createAdapter: () => new FauxAdapter([textResponse("The crow has the map.")]),
    });
    const original = SessionStore.prototype.recordDelivery;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    let first: Promise<unknown> | undefined;
    let duplicate: Promise<unknown> | undefined;
    try {
        SessionStore.prototype.recordDelivery = async function (delivery) {
            if (this.header.id === "parent") {
                calls += 1;
                if (calls === 1) {
                    entered.resolve();
                    await release.promise;
                }
            }
            return await original.call(this, delivery);
        };
        const services = host.registry.subagentSessions!;
        const delivery = { id: "completion:child", sourceAgentId: "child", content: "Found the map" };
        first = services.deliverCompletion("parent", delivery);
        await entered.promise;
        duplicate = services.deliverCompletion("parent", delivery);
        await Bun.sleep(20);
        expect(calls).toBe(1);
        release.resolve();
        expect(await first).toBe("recorded");
        expect(await duplicate).toBe("duplicate");
        expect((await SessionStore.open(path)).pendingDeliveries()).toHaveLength(1);

        await resumeAgentThroughHost(host.server.socketPath, path);
        const deadline = Date.now() + 10_000;
        let lines: string[] = [];
        while (Date.now() < deadline) {
            lines = (await readFile(path, "utf8")).trimEnd().split("\n");
            if (lines.some((line) => line.includes('"deliveryId":"completion:child"'))) break;
            await Bun.sleep(10);
        }
        const cutIndex = lines.findIndex((line) => line.includes(CRASH_CUT_MESSAGE));
        const deliveryIndex = lines.findIndex((line) => line.includes('"deliveryId":"completion:child"'));
        expect(cutIndex).toBeGreaterThanOrEqual(0);
        expect(deliveryIndex).toBeGreaterThan(cutIndex);
    } finally {
        release.resolve();
        await Promise.allSettled([first, duplicate].filter((promise) => promise !== undefined));
        SessionStore.prototype.recordDelivery = original;
        await host.close();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

socketTest("session mutations follow the worker and remove stale roster entries", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const path = join(home, "runtime", "sessions", "saved.jsonl");
    await SessionStore.create(path, { sessionId: "saved", cwd: home });
    const host = await startResidentHost({
        home, config, inProcessWorker: true,
        createAdapter: () => new FauxAdapter([]),
        trashSessionArtifacts: async (artifacts) => { await rm(artifacts.sessionPath); },
    });
    try {
        expect((await listAgentsThroughHost(host.server.socketPath)).map((row) => row.id)).toContain("saved");
        await resumeAgentThroughHost(host.server.socketPath, path);
        expect(await renameSessionThroughHost(host.server.socketPath, "saved", "crow map"))
            .toEqual({ status: "renamed", name: "crow map" });
        expect(host.registry.agents.has("saved")).toBe(false);
        expect(await closeAgentThroughHost(host.server.socketPath, "saved"))
            .toEqual({ status: "closed", sessionRetained: true });
        expect(await trashSessionThroughHost(host.server.socketPath, "saved")).toEqual({ status: "trashed" });
        expect((await listAgentsThroughHost(host.server.socketPath)).some((row) => row.id === "saved")).toBe(false);
        expect(await locate(host.server.socketPath, "saved")).toMatchObject({ type: "agent_location_failed", reason: "not_found" });
    } finally {
        await host.close();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

socketTest("a missing worker socket returns an unavailable attachment", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const host = await startResidentHost({
        home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]),
    });
    try {
        const agent = await createAgentThroughHost(host.server.socketPath, home);
        await unlink(inProcessWorkerSocket(home));
        await expect(attachAgent({ socketPath: host.server.socketPath, agentId: agent.id }))
            .rejects.toMatchObject({ reason: "unavailable" });
        expect(await requestHostIdentity(host.server.socketPath)).toBeDefined();
    } finally {
        await host.close();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

test("worker socket paths enforce the macOS byte limit", () => {
    const prefix = "/private/tmp/";
    const suffix = "/runtime/w0.sock";
    const home = prefix + "a".repeat(103 - Buffer.byteLength(prefix + suffix));
    expect(Buffer.byteLength(inProcessWorkerSocket(home))).toBe(103);
    expect(() => inProcessWorkerSocket(`${home}a`)).toThrow("103-byte limit");
    expect(() => inProcessWorkerSocket(`${home}é`)).toThrow("103-byte limit");
});

socketTest("a 103-byte worker socket path listens successfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "vhs-"));
    const prefix = `${root}/`;
    const home = prefix + "x".repeat(103 - Buffer.byteLength(`${prefix}/runtime/w0.sock`));
    const workerSocket = inProcessWorkerSocket(home);
    expect(Buffer.byteLength(workerSocket)).toBe(103);
    const host = await startResidentHost({
        home, config, inProcessWorker: true,
        socketPath: join(root, "h.sock"), lockPath: join(root, "h.json"),
        createAdapter: () => new FauxAdapter([]),
    });
    try {
        expect(await requestHostIdentity(workerSocket)).toMatchObject({ role: "worker", worker_id: "w0" });
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

test("an overlong worker socket path fails before listening", async () => {
    const root = await mkdtemp(join(tmpdir(), "vhs-"));
    const home = join(root, "x".repeat(90));
    try {
        await expect(startResidentHost({
            home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]),
        })).rejects.toThrow("103-byte limit");
        expect(existsSync(join(home, "runtime", "host.sock"))).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

socketTest("the default host does not start a worker socket", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhs-"));
    const host = await startResidentHost({ home, config, createAdapter: () => new FauxAdapter([]) });
    try {
        expect(existsSync(inProcessWorkerSocket(home))).toBe(false);
    } finally {
        await host.close();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the attachment to close");
        await Bun.sleep(5);
    }
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        source: { provider: "faux", model: "test", api: "scripted" },
        usage: emptyUsage(),
    };
}
