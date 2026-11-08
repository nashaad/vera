import { expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { connectHost } from "../../src/host/connection.ts";
import { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";
import { MasterInboxBridge } from "../../src/host/master/inbox.ts";
import * as supervisor from "../../src/host/master/supervisor.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost, type StartResidentHostOptions } from "../../src/host/runtime.ts";
import { defaultInboxPath, Inbox } from "../../src/store/inbox.ts";
import { readSessionTurnState, WORKER_EXIT_TURN_MESSAGE } from "../../src/store/session-store.ts";
import type { WatchRuntimeContext } from "../../src/watch/source.ts";
import { startScheduleWakeProvider } from "../support/schedule-wake-provider.ts";

interface FixtureOptions {
    readonly heartbeatMs?: number;
    readonly beforeStart?: (options: supervisor.SessionWorkerSupervisorOptions) => Promise<void>;
    readonly spawnSpec?: (options: supervisor.SessionWorkerSupervisorOptions) => supervisor.WorkerSpawnSpec | undefined;
    readonly provider?: { readonly port: number; readonly requests: number; close(): void };
    readonly prepare?: (home: string) => Promise<{ readonly extension?: string; readonly watch?: StartResidentHostOptions["watchConnectors"] }>;
}

async function fixture(options: FixtureOptions = {}) {
    const home = await mkdtemp("/private/tmp/vera-dev/h8s-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const prepared = await options.prepare?.(home);
    const stub = options.provider ?? startScheduleWakeProvider(true);
    const pids = new Set<number>();
    const start = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (workerOptions) => {
        await options.beforeStart?.(workerOptions);
        const spawnSpec = options.spawnSpec?.(workerOptions);
        return await start({
            ...workerOptions,
            ...(spawnSpec === undefined ? {} : { spawnSpec }),
            onSpawn(pid) { pids.add(pid); workerOptions.onSpawn?.(pid); },
        });
    });
    let host: ResidentHost;
    try {
        host = await startResidentHost({
            home, webRoot, processWorker: true, processWorkerCount: 2, skipStartupDiscovery: true,
            ...(options.heartbeatMs === undefined ? {} : { processWorkerHeartbeatDeadlineMs: options.heartbeatMs }),
            ...(prepared?.watch === undefined ? {} : { watchConnectors: prepared.watch }),
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                inbox: { admit: ["arc"] },
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                ...(prepared?.extension === undefined ? {} : { extensions: [{ path: prepared.extension, enabled: true, config: {} }] }),
            },
        });
    } catch (error) {
        probe.mockRestore();
        stub.close();
        await rm(home, { recursive: true, force: true });
        throw error;
    }
    if (host.annexPid !== undefined) pids.add(host.annexPid);
    return {
        home, host, pids, stub,
        async close() {
            try { await host.close(); }
            finally {
                stub.close();
                probe.mockRestore();
                try {
                    await waitFor(() => [...pids].every((pid) => !alive(pid)), "child processes to exit");
                    expect([...pids].filter(alive)).toEqual([]);
                } finally { await rm(home, { recursive: true, force: true }); }
            }
        },
    };
}

test("a hard-looping worker misses its heartbeat while identity and locate remain responsive", async () => {
    let marker = "";
    const harness = await fixture({
        heartbeatMs: 900,
        async prepare(home) {
            const extension = join(home, "blocker");
            marker = join(home, "blocked");
            await mkdir(extension);
            await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
                id: "test.blocker", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: ["requests.handle"],
            }));
            await writeFile(join(extension, "extension.ts"), `import { writeFileSync } from "node:fs";
export function activate(vera) { vera.requests.handle("block", () => { writeFileSync(${JSON.stringify(marker)}, "blocked"); while (true) {} }); }
`);
            return { extension };
        },
    });
    let request: Promise<unknown> | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const first = await createAgentThroughHost(socket, harness.home);
        const second = await createAgentThroughHost(socket, harness.home);
        const oldPid = (await requestHostIdentity(first.location!.socket_path))!.pid;
        request = requestExtensionThroughHost(first.location!.socket_path, "test.blocker", "block", {}, AbortSignal.timeout(8_000)).catch(() => undefined);
        await waitFor(() => existsSync(marker), "worker hard loop");
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const started = performance.now();
            expect(await requestHostIdentity(socket)).toBeDefined();
            expect((await locate(socket, first.id)).type).toBeDefined();
            expect((await locate(socket, second.id)).type).toBe("agent_location");
            expect((await locate(socket, `unknown-crow-${attempt}`)).type).toBe("agent_location_failed");
            expect(performance.now() - started).toBeLessThan(1_000);
            await Bun.sleep(100);
        }
        const index = Number(first.location!.worker_id.slice(1));
        await waitFor(() => harness.host.health.workers?.[index]?.state === "replaced", "heartbeat replacement");
        expect(harness.host.health.workers?.[index]).toMatchObject({ reason: "heartbeat_timeout" });
        expect(alive(oldPid)).toBe(false);
        expect((await requestHostIdentity(first.location!.socket_path))?.pid).not.toBe(oldPid);
    } finally {
        await harness.close();
        await request;
    }
}, 30_000);

test("three worker deaths trip the breaker while another worker keeps serving", async () => {
    const harness = await fixture();
    try {
        const socket = harness.host.server.socketPath;
        const first = await createAgentThroughHost(socket, harness.home);
        const second = await createAgentThroughHost(socket, harness.home);
        const index = Number(first.location!.worker_id.slice(1));
        for (let count = 0; count < 3; count += 1) {
            const pid = (await requestHostIdentity(first.location!.socket_path))!.pid;
            process.kill(pid, "SIGKILL");
            await waitFor(() => !alive(pid), "worker exit");
            if (count < 2) await waitFor(() => {
                const worker = harness.host.health.workers?.[index];
                return worker?.state === "replaced" && worker.pid !== pid;
            }, "replacement");
        }
        await waitFor(() => harness.host.health.workers?.[index]?.reason === "crash_loop", "crash breaker");
        expect(await locate(socket, first.id)).toMatchObject({ type: "agent_location_failed", reason: "worker_unavailable" });
        expect(await locate(socket, second.id)).toMatchObject({ type: "agent_location", worker_id: second.location?.worker_id });
        expect(await requestHostIdentity(socket)).toBeDefined();
    } finally { await harness.close(); }
}, 30_000);

test("repeated startup failures trip one slot without stopping the host", async () => {
    const harness = await fixture({
        spawnSpec: (options) => options.index === 0 ? { command: process.execPath, args: ["-e", "process.exit(7)"] } : undefined,
    });
    try {
        await waitFor(() => harness.host.health.workers?.[0]?.reason === "crash_loop", "startup crash breaker");
        expect((await requestHostIdentity(harness.host.server.socketPath))?.workers_ready).toBe(1);
        const session = await createAgentThroughHost(harness.host.server.socketPath, harness.home);
        expect(session.location?.worker_id).toBe("w1");
        expect(harness.host.health.workers?.[0]).toMatchObject({ generation: 3, state: "unavailable", reason: "crash_loop" });
    } finally { await harness.close(); }
}, 30_000);

test("closing the host while a replacement is starting reaps the replacement", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = await fixture({ beforeStart: async (options) => {
        if (options.generation === 2) { entered.resolve(); await release.promise; }
    } });
    let closing: Promise<void> | undefined;
    try {
        const session = await createAgentThroughHost(harness.host.server.socketPath, harness.home);
        const pid = (await requestHostIdentity(session.location!.socket_path))!.pid;
        process.kill(pid, "SIGKILL");
        await entered.promise;
        closing = harness.close();
        release.resolve();
        await closing;
    } finally {
        release.resolve();
        if (closing === undefined) await harness.close();
    }
}, 30_000);

test("a live process answering at the worker socket is not displaced", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = await fixture({ beforeStart: async (options) => {
        if (options.generation === 2) { entered.resolve(); await release.promise; }
    } });
    let server: Server | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const session = await createAgentThroughHost(socket, harness.home);
        const path = session.location!.socket_path;
        const oldPid = (await requestHostIdentity(path))!.pid;
        process.kill(oldPid, "SIGKILL");
        await waitFor(() => !alive(oldPid), "worker exit");
        await entered.promise;
        const other = await createAgentThroughHost(socket, harness.home);
        expect(other.location?.worker_id).not.toBe(session.location?.worker_id);
        expect(await requestHostIdentity(path)).toBeUndefined();
        await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        server = createServer((connection) => connection.once("data", () => connection.end(`${JSON.stringify({
            type: "host_identity", pid: process.pid, started_at: new Date().toISOString(),
        })}\n`)));
        await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(path, resolve); });
        expect((await requestHostIdentity(path))?.pid).toBe(process.pid);
        release.resolve();
        const index = Number(session.location!.worker_id.slice(1));
        await waitFor(() => harness.host.health.workers?.[index]?.reason === "worker_socket_busy", "socket refusal");
        expect((await requestHostIdentity(path))?.pid).toBe(process.pid);
        expect(await locate(socket, session.id)).toMatchObject({ type: "agent_location_failed", reason: "worker_unavailable" });
    } finally {
        release.resolve();
        if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await harness.close();
    }
}, 30_000);

test("an inbox entry held during worker replacement is delivered once", async () => {
    const watching = Promise.withResolvers<WatchRuntimeContext>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let address = "";
    const harness = await fixture({
        beforeStart: async (options) => { if (options.generation === 2) { entered.resolve(); await release.promise; } },
        async prepare(home) {
            const extension = join(home, "watch");
            await mkdir(extension);
            await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
                id: "test.watch", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: [],
                contributes: { watches: [{ id: "main", source_family: "arc" }] },
            }));
            await writeFile(join(extension, "extension.ts"), "export function activate() {}\n");
            return { extension, watch: [{ sourceFamily: "arc" as const, run: (context: WatchRuntimeContext) => {
                watching.resolve(context);
                return new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
            } }] };
        },
    });
    let client: AttachedAgentClient | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const session = await createAgentThroughHost(socket, harness.home);
        address = session.id;
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        const oldPid = (await requestHostIdentity(session.location!.socket_path))!.pid;
        process.kill(oldPid, "SIGKILL");
        await waitFor(() => !alive(oldPid), "worker exit");
        await entered.promise;
        const context = await watching.promise;
        await context.admit([{ id: "arc:held", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout", session: null,
            payload: { text: "A map arrived." } }]);
        expect(inboxState(harness.home, address)).toEqual({ offset: 0, unread: 1 });
        expect(harness.stub.requests).toBe(0);
        release.resolve();
        await waitFor(async () => (await locate(socket, session.id)).type === "agent_location", "session location");
        client.close();
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(inboxState(harness.home, address)).toEqual({ offset: 1, unread: 0 });
        expect(harness.stub.requests).toBe(2);
    } finally {
        release.resolve();
        client?.close();
        await harness.close();
    }
}, 30_000);

for (const savedMessage of [false, true]) test(`an inbox wake interrupted by a worker exit stays held (${savedMessage ? "saved message" : "no saved message"})`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const watching = Promise.withResolvers<WatchRuntimeContext>();
    let requests = 0;
    const interruptedRequest = savedMessage ? 2 : 1;
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests += 1;
            const current = requests;
            if (current === interruptedRequest) { entered.resolve(); await release.promise; }
            const tool = savedMessage && current === 1 ? "missing_tool"
                : current > interruptedRequest && current <= interruptedRequest + 2 ? "agent_inbox" : undefined;
            const delta = tool === undefined ? { role: "assistant", content: "The map is aboard." } : {
                role: "assistant", tool_calls: [{ index: 0, id: `call-${current}`, type: "function",
                    function: { name: tool, arguments: "{}" } }],
            };
            const chunk = { id: "x", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: tool === undefined ? "stop" : "tool_calls" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
    });
    const provider = { port: server.port!, get requests() { return requests; }, close() { server.stop(true); } };
    const harness = await fixture({
        provider,
        async prepare(home) {
            const extension = join(home, "watch");
            await mkdir(extension);
            await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
                id: "test.watch", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: [],
                contributes: { watches: [{ id: "main", source_family: "arc" }] },
            }));
            await writeFile(join(extension, "extension.ts"), "export function activate() {}\n");
            return { extension, watch: [{ sourceFamily: "arc" as const, run: (context: WatchRuntimeContext) => {
                watching.resolve(context);
                return new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
            } }] };
        },
    });
    let client: AttachedAgentClient | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const session = await createAgentThroughHost(socket, harness.home);
        const path = join(harness.home, "runtime", "sessions", `${session.id}.jsonl`);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        const context = await watching.promise;
        await context.admit([{ id: "arc:cut", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout", session: null,
            payload: { text: "The first map arrived." } }]);
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Wake did not start"); })]);
        const before = await readSessionTurnState(path);
        expect(before.turnOpen).toBe(savedMessage);
        const oldPid = (await requestHostIdentity(session.location!.socket_path))!.pid;
        process.kill(oldPid, "SIGKILL");
        const index = Number(session.location!.worker_id.slice(1));
        await waitFor(() => harness.host.health.workers?.[index]?.state === "replaced", "replacement");
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 0, unread: 1 });
        expect(requests).toBe(interruptedRequest);
        client.close();
        await waitFor(async () => (await locate(socket, session.id)).type === "agent_location", "session location");
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        const history = await client.receive();
        expect(history.type).toBe("history");
        let noticeCount = 0;
        const noticeDeadline = AbortSignal.timeout(1_500);
        try {
            while (true) {
                const update = await client.receive(noticeDeadline);
                if (update.type === "notice" && update.key === "inbox" && update.count === 1) noticeCount += 1;
            }
        } catch {
            if (!noticeDeadline.aborted) throw new Error("Client closed before the held entry was delivered");
        }
        expect(noticeCount).toBe(1);
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 0, unread: 1 });
        const log = await readFile(path, "utf8");
        const failedTurnRecords = log.split(WORKER_EXIT_TURN_MESSAGE).length - 1;
        expect(requests).toBe(interruptedRequest);
        expect(failedTurnRecords).toBe(savedMessage ? 1 : 0);
        if (history.type === "history") {
            expect(history.entries.filter((entry) => entry.kind === "error" && entry.detail === WORKER_EXIT_TURN_MESSAGE))
                .toHaveLength(savedMessage ? 1 : 0);
        }
        await context.admit([{ id: "arc:fresh", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout", session: null,
            payload: { text: "The second map arrived." } }]);
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(requests).toBe(interruptedRequest + 3);
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 2, unread: 0 });
        const delivered = await readFile(path, "utf8");
        expect(delivered.split("The first map arrived.")).toHaveLength(2);
        expect(delivered.split("The second map arrived.")).toHaveLength(2);
    } finally {
        release.resolve();
        client?.close();
        await harness.close();
    }
}, 30_000);

test("an extension inbox wake interrupted before acknowledgement remains held", async () => {
    const recording = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = await fixture({
        async prepare(home) {
            const extension = join(home, "sender");
            await mkdir(extension);
            await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
                id: "test.sender", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
                capabilities: ["requests.handle", "sessions.send"],
            }));
            await writeFile(join(extension, "extension.ts"), `export function activate(api) {
    api.requests.handle("send", (value) => api.sessions.send(value.id, value.text));
}\n`);
            return { extension };
        },
    });
    const original = MasterInboxBridge.prototype.handle;
    const probe = spyOn(MasterInboxBridge.prototype, "handle").mockImplementation(async function (this: MasterInboxBridge, method, args, signal) {
        if (method === "noteDelivered") {
            recording.resolve();
            await release.promise;
            throw new Error("Delivery interrupted");
        }
        return await original.call(this, method, args, signal);
    });
    let client: AttachedAgentClient | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const session = await createAgentThroughHost(socket, harness.home);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        expect(await harness.host.extensions.handleRequest("test.sender", "send", { id: session.id, text: "The first map is aboard." }, new AbortController().signal)).toBe("queued");
        await Promise.race([recording.promise, Bun.sleep(10_000).then(() => { throw new Error("Delivery was not recorded"); })]);
        expect(harness.stub.requests).toBe(0);
        const oldPid = (await requestHostIdentity(session.location!.socket_path))!.pid;
        process.kill(oldPid, "SIGKILL");
        const index = Number(session.location!.worker_id.slice(1));
        await waitFor(() => harness.host.health.workers?.[index]?.state === "replaced", "replacement");
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 0, unread: 1 });
        client.close();
        await waitFor(async () => (await locate(socket, session.id)).type === "agent_location", "session location");
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await Bun.sleep(1_500);
        expect(harness.stub.requests).toBe(0);
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 0, unread: 1 });
        probe.mockRestore();
        expect(await harness.host.extensions.handleRequest("test.sender", "send", { id: session.id, text: "The second map is aboard." }, new AbortController().signal)).toBe("queued");
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(harness.stub.requests).toBe(2);
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 2, unread: 0 });
    } finally {
        release.resolve();
        client?.close();
        probe.mockRestore();
        await harness.close();
    }
}, 30_000);

function inboxState(home: string, id: string) {
    const inbox = Inbox.open(defaultInboxPath(home));
    try {
        const consumer = { nodeId: hostname(), label: id };
        return { offset: inbox.offsetOf(consumer), unread: inbox.unreadStats(consumer, { limit: 10, addresses: [id] }).count };
    } finally { inbox.close(); }
}

async function locate(socketPath: string, id: string): Promise<Record<string, unknown>> {
    const connection = await connectHost({ socketPath, signal: AbortSignal.timeout(2_000) });
    try {
        await connection.send({ type: "locate_agent", agent_id: id });
        return await connection.receiveWithin(2_000, "locate timed out") as Record<string, unknown>;
    } finally { connection.close(); }
}

async function waitFor(check: () => boolean | Promise<boolean>, name: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!await check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name}`);
        await Bun.sleep(20);
    }
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}
