import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, spyOn } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { abortAgentThroughHost } from "../../src/host/agent-abort-client.ts";
import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { createAgentThroughHost, resumeAgentThroughHost, type ReadyAgent } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_AGENT_HISTORY_PAGING, HOST_CAPABILITY_SESSION_ROUTING } from "../../src/host/capabilities.ts";
import { connectHost } from "../../src/host/connection.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { HOST_PROTOCOL_VERSION, requestHostIdentity } from "../../src/host/protocol.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { trashSessionThroughHost } from "../../src/host/session-trash-client.ts";
import { SessionStore } from "../../src/store/session-store.ts";

socketAndLoopbackTest("locate and create wait while resume refuses a starting worker", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs5-starting-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const startWorker = supervisor.startSessionWorkerSupervisor;
    const delayed = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
        entered.resolve();
        await release.promise;
        return await startWorker(options);
    });
    const stub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let starting: Promise<Awaited<ReturnType<typeof startResidentHost>>> | undefined;
    let creating: Promise<ReadyAgent> | undefined;
    let resuming: Promise<ReadyAgent> | undefined;
    let workerPid: number | undefined;
    try {
        const sessionPath = join(home, "runtime", "sessions", "crow.jsonl");
        await SessionStore.create(sessionPath, { sessionId: "crow", cwd: home });
        starting = startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            },
        });
        void starting.catch(() => {});
        await within(entered.promise);
        const hostPath = join(home, "runtime", "host.sock");
        expect(await requestHostIdentity(hostPath)).toMatchObject({ workers_ready: 0 });
        expect(await request(hostPath, { type: "locate_agent", agent_id: "crow" }))
            .toMatchObject({ type: "agent_location_failed", reason: "starting" });
        let createFinished = false;
        let resumeFinished = false;
        creating = createAgentThroughHost(hostPath, home).finally(() => { createFinished = true; });
        resuming = resumeAgentThroughHost(hostPath, sessionPath).finally(() => { resumeFinished = true; });
        void creating.catch(() => {});
        void resuming.catch(() => {});
        await Bun.sleep(100);
        expect(createFinished).toBe(false);
        expect(resumeFinished).toBe(true);
        const unavailable = await resuming.then(() => undefined, (error: unknown) => error);
        expect(unavailable).toMatchObject({ name: "AgentStartError", message: "The session process is unavailable." });
        release.resolve();
        host = await starting;
        resuming = resumeAgentThroughHost(hostPath, sessionPath);
        const [created, resumed] = await Promise.all([creating, resuming]);
        expect(created.location).toMatchObject({ worker_id: "w0", socket_path: join(home, "runtime", "w0.sock") });
        expect(resumed.location).toEqual(created.location);
        const location = await request(hostPath, { type: "locate_agent", agent_id: "crow" });
        expect(location).toMatchObject({ type: "agent_location", worker_id: "w0", socket_path: join(home, "runtime", "w0.sock") });
        expect(host.registry.agents.has("crow")).toBe(false);
        workerPid = (await requestHostIdentity(join(home, "runtime", "w0.sock")))!.pid;
    } finally {
        release.resolve();
        host ??= await starting?.catch(() => undefined);
        await Promise.allSettled([creating, resuming].filter((value) => value !== undefined));
        delayed.mockRestore();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

socketAndLoopbackTest("a real pool routes direct attachments and worker requests through the host", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs5-pool-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            entered.resolve();
            await release.promise;
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let workerPid: number | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            },
        });
        const hostPath = host.server.socketPath;
        const hostIdentity = await requestHostIdentity(hostPath);
        expect(hostIdentity?.workers_ready).toBe(1);
        const created = await within(createAgentThroughHost(hostPath, home));
        expect(created.location).toMatchObject({ worker_id: "w0", worker_generation: 1 });
        const workerPath = created.location!.socket_path;
        const worker = await requestHostIdentity(workerPath);
        workerPid = worker!.pid;
        expect(worker).toMatchObject({ role: "worker", worker_id: "w0", worker_generation: 1, build_id: hostIdentity?.build_id });
        expect(workerPid).not.toBe(process.pid);

        const throughWorker = await within(createAgentThroughHost(workerPath, home));
        expect(throughWorker.location).toEqual(created.location);
        const resumed = await within(resumeAgentThroughHost(workerPath, join(home, "runtime", "sessions", `${throughWorker.id}.jsonl`)));
        expect(resumed.location).toEqual(created.location);
        expect((await listAgentsThroughHost(hostPath)).map((row) => row.id)).toContain(created.id);
        expect(await listAgentsThroughHost(workerPath)).toEqual(await listAgentsThroughHost(hostPath));
        expect(await request(workerPath, { type: "model_settings", workspace: home }))
            .toEqual(await request(hostPath, { type: "model_settings", workspace: home }));
        const operation = await connectHost({ socketPath: workerPath });
        try {
            await operation.send({ type: "model_operation", operation: "keep", models: [{ provider: "stub", model: "missing" }] });
            expect(await operation.receiveWithin(8_000, "Timed out waiting for model result"))
                .toMatchObject({ type: "model_operation_result", result: { status: "failed" } });
            expect(await operation.receiveWithin(8_000, "Timed out waiting for model settings"))
                .toMatchObject({ type: "model_operation_complete" });
        } finally {
            operation.close();
        }
        const shutdown = { type: "shutdown_if_idle", pid: hostIdentity!.pid + 1, started_at: hostIdentity!.started_at, requester_protocol_version: HOST_PROTOCOL_VERSION };
        expect(await request(workerPath, shutdown)).toEqual(await request(hostPath, shutdown));

        const hostOwned = await host.registry.create({ workspace: home });
        const redirect = await request(workerPath, {
            type: "attach", agent_id: hostOwned.id, requested_capabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING, HOST_CAPABILITY_SESSION_ROUTING],
        });
        expect(redirect).toEqual({ type: "agent_location_changed", socket_path: hostPath });
        client = await attachReconnectingAgent({
            socketPath: () => hostPath, agentId: hostOwned.id, buildId: hostIdentity!.build_id!,
            initialLocation: created.location,
        });
        expect((await client.receive()).type).toBe("history");
        client.close();
        client = await attachAgent({ socketPath: workerPath, agentId: hostOwned.id, requestedCapabilities: [] });
        expect((await client.receive()).type).toBe("history");
        client.close();

        client = await attachReconnectingAgent({
            socketPath: () => hostPath, agentId: created.id, buildId: hostIdentity!.build_id!,
            initialLocation: created.location,
        });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Find the map." });
        await within(entered.promise);
        await within(abortAgentThroughHost(hostPath, created.id));
        release.resolve();
        let finished;
        do { finished = await client.receive(AbortSignal.timeout(8_000)); }
        while (finished.type !== "turn_finished");
        expect(finished.outcome).toBe("aborted");
        expect(await closeAgentThroughHost(hostPath, throughWorker.id)).toMatchObject({ status: "closed" });
        expect(await trashSessionThroughHost(hostPath, throughWorker.id)).toEqual({ status: "trashed" });
    } finally {
        release.resolve();
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 40_000);

socketAndLoopbackTest("a shutdown accepted on a worker socket reaches the client before the pool exits", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs5-stop-"));
    const stub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let workerPid: number | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            },
        });
        const hostIdentity = await requestHostIdentity(host.server.socketPath);
        const workerPath = join(home, "runtime", "w0.sock");
        workerPid = (await requestHostIdentity(workerPath))!.pid;
        expect(await request(workerPath, {
            type: "shutdown_if_idle", pid: hostIdentity!.pid, started_at: hostIdentity!.started_at,
            requester_protocol_version: HOST_PROTOCOL_VERSION,
        })).toMatchObject({ type: "shutdown_if_idle_accepted", pid: hostIdentity!.pid, started_at: hostIdentity!.started_at });
        await host.close();
        expect(() => process.kill(workerPid!, 0)).toThrow();
    } finally {
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

socketAndLoopbackTest("a reconnecting client reaches a replacement worker without restarting the host", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs5-real-reconnect-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const start = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
        if (options.generation > 1) { entered.resolve(); await release.promise; }
        return await start(options);
    });
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const options = {
        home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
        config: {
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        },
    } as const;
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let pending: Promise<import("../../src/engine/protocol.ts").AgentUpdate> | undefined;
    const pids: number[] = [];
    try {
        host = await startResidentHost(options);
        if (host.annexPid !== undefined) pids.push(host.annexPid);
        const hostPath = host.server.socketPath;
        const ready = await createAgentThroughHost(hostPath, home);
        const first = await requestHostIdentity(ready.location!.socket_path);
        expect(first).toMatchObject({ role: "worker", worker_id: "w0", worker_generation: 1 });
        pids.push(first!.pid);
        client = await attachReconnectingAgent({
            socketPath: () => hostPath, agentId: ready.id, buildId: host.server.identity.build_id!,
            initialLocation: ready.location,
        });
        expect((await client.receive()).type).toBe("history");
        expect(await requestHostIdentity(ready.location!.socket_path)).toMatchObject({ pid: first!.pid, role: "worker" });
        process.kill(first!.pid, "SIGKILL");
        await waitForExit(first!.pid);
        await within(entered.promise);
        const deadline = Date.now() + 5_000;
        while ((await requestHostIdentity(hostPath))?.workers_ready !== 0) {
            if (Date.now() >= deadline) throw new Error("Host did not observe the worker exit");
            await Bun.sleep(10);
        }
        expect(await request(hostPath, { type: "locate_agent", agent_id: ready.id }))
            .toMatchObject({ type: "agent_location_failed", reason: "worker_unavailable" });
        expect(await request(hostPath, {
            type: "resume_agent", session_path: join(home, "runtime", "sessions", `${ready.id}.jsonl`),
        })).toMatchObject({ type: "agent_start_failed", reason: "The session process is unavailable." });
        release.resolve();
        let second = await requestHostIdentity(ready.location!.socket_path);
        while (second === undefined || second.pid === first!.pid) {
            if (Date.now() >= deadline) throw new Error("Replacement did not become ready");
            await Bun.sleep(10);
            second = await requestHostIdentity(ready.location!.socket_path);
        }
        pids.push(second!.pid);
        expect(second!.pid).not.toBe(first!.pid);
        pending = client.receive(AbortSignal.timeout(15_000));
        void pending.catch(() => {});
        await Bun.sleep(0);
        await within(client.send({ type: "prompt", content: "Find the map again." }));
        let update = await pending;
        pending = undefined;
        while (update.type !== "turn_finished") update = await client.receive(AbortSignal.timeout(8_000));
        expect(update.outcome).toBeUndefined();
        expect(await request(hostPath, { type: "locate_agent", agent_id: ready.id }))
            .toMatchObject({ type: "agent_location", worker_id: "w0", socket_path: ready.location!.socket_path });
    } finally {
        release.resolve();
        client?.close();
        await pending?.catch(() => {});
        await host?.close();
        probe.mockRestore();
        stub.stop(true);
        try {
            for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 40_000);

async function request(socketPath: string, message: object): Promise<unknown> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send(message);
        return await connection.receiveWithin(8_000, "Timed out waiting for the host");
    } finally {
        connection.close();
    }
}

async function within<T>(promise: Promise<T>): Promise<T> {
    return await Promise.race([promise, Bun.sleep(8_000).then(() => { throw new Error("Timed out waiting for the host"); })]);
}

async function waitForExit(pid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (true) {
        try { process.kill(pid, 0); }
        catch { return; }
        if (Date.now() >= deadline) throw new Error("Worker did not exit");
        await Bun.sleep(10);
    }
}
