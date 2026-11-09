import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { AgentLocationChangedError, attachAgent } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_SESSION_ROUTING } from "../../src/host/capabilities.ts";
import { forwardSessionConnection } from "../../src/host/pool/forward.ts";
import { HOST_MIN_COMPATIBLE_PROTOCOL_VERSION, HOST_PROTOCOL_VERSION, type AgentLocationResponse } from "../../src/host/protocol.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { startHostServer } from "../../src/host/server.ts";

const BUILD = "routing-test-build";
const STARTED = "2026-11-08T00:00:00.000Z";

interface WorkerProcess {
    readonly child: ChildProcess;
    readonly exited: Promise<void>;
}

socketTest("pool-off create, resume, and identity replies keep their existing bytes", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs5-wire-");
    const socketPath = join(root, "host.sock");
    const host = await startHostServer({
        socketPath, lockPath: join(root, "host.json"), buildId: BUILD, pid: process.pid, startedAt: STARTED,
        createAgent: async () => ({ id: "created", workspace: "/work" }),
        resumeAgent: async () => ({ id: "resumed", workspace: "/work" }),
    });
    try {
        expect(await rawRequest(socketPath, { type: "create_agent", workspace: "/work" }))
            .toBe('{"type":"agent_ready","agent_id":"created","workspace":"/work"}\n');
        expect(await rawRequest(socketPath, { type: "resume_agent", session_path: "/work/session.jsonl" }))
            .toBe('{"type":"agent_ready","agent_id":"resumed","workspace":"/work"}\n');
        expect(await rawRequest(socketPath, { type: "host_identity" })).toBe(`${JSON.stringify({
            type: "host_identity", pid: process.pid, started_at: STARTED,
            protocol_version: HOST_PROTOCOL_VERSION,
            minimum_compatible_protocol_version: HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
            build_id: BUILD, role: "host",
        })}\n`);
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

socketTest("a client without a returned worker socket attaches to the host", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs5-old-");
    const socketPath = join(root, "host.sock");
    const requests: string[] = [];
    const host = await listen(socketPath, (request, socket) => {
        requests.push(request.type as string);
        if (request.type === "host_identity") {
            socket.end(`${JSON.stringify({ type: "host_identity", pid: process.pid, started_at: STARTED, build_id: BUILD })}\n`);
        } else if (request.type === "create_agent") {
            socket.end('{"type":"agent_ready","agent_id":"crow","workspace":"/work"}\n');
        } else if (request.type === "attach") {
            socket.write(`${JSON.stringify({
                type: "attached", agent_id: "crow", workspace: "/work", capabilities: [],
                background_agents: { running: 0, children: [], has_parent: false },
            })}\n`);
            socket.write('{"type":"history","entries":[],"seq":0}\n');
        }
    });
    let client: Awaited<ReturnType<typeof attachReconnectingAgent>> | undefined;
    try {
        const ready = await createAgentThroughHost(socketPath, "/work");
        expect(ready.location).toBeUndefined();
        client = await attachReconnectingAgent({
            socketPath: () => socketPath, agentId: ready.id, buildId: BUILD,
            initialLocation: ready.location,
        });
        expect((await client.receive()).type).toBe("history");
        expect(requests).toEqual(["create_agent", "host_identity", "attach"]);
        client.close();
        client = await attachReconnectingAgent({
            socketPath: () => socketPath, agentId: ready.id, buildId: BUILD, requestedCapabilities: [],
            initialLocation: workerLocation(join(root, "unused.sock"), "w0", 1),
        });
        expect((await client.receive()).type).toBe("history");
        expect(requests).toEqual(["create_agent", "host_identity", "attach", "host_identity", "attach"]);
    } finally {
        client?.close();
        await closeServer(host);
        await rm(root, { recursive: true, force: true });
    }
});

socketTest("a partial worker location in an agent-ready reply is rejected", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs5-bad-ready-");
    const socketPath = join(root, "host.sock");
    const host = await listen(socketPath, (_request, socket) => {
        socket.end('{"type":"agent_ready","agent_id":"crow","workspace":"/work","socket_path":"/tmp/w0.sock","worker_id":"w0"}\n');
    });
    try {
        await expect(createAgentThroughHost(socketPath, "/work")).rejects.toThrow("invalid agent startup response");
    } finally {
        await closeServer(host);
        await rm(root, { recursive: true, force: true });
    }
});

socketTest("a restarted worker is located again and an unavailable replay falls back to history", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs5-reconnect-");
    const hostPath = join(root, "host.sock");
    const workerPath = join(root, "worker.sock");
    const log = join(root, "worker.log");
    let location: AgentLocationResponse | undefined = workerLocation(workerPath, "w0", 1);
    const hostRequests: string[] = [];
    const host = await hostServer(hostPath, () => location, hostRequests);
    const workers: WorkerProcess[] = [];
    let client: Awaited<ReturnType<typeof attachReconnectingAgent>> | undefined;
    try {
        const first = await startWorker(workerPath, "w0", 1, log);
        workers.push(first);
        client = await attachReconnectingAgent({
            socketPath: () => hostPath, agentId: "crow", buildId: BUILD,
            initialLocation: location, failOnDisconnect: true,
        });
        expect(await client.receive()).toMatchObject({ type: "history", seq: 5 });
        const replay = client.receive(AbortSignal.timeout(10_000));
        location = undefined;
        await stopWorker(first);
        await rm(workerPath, { force: true });
        const second = await startWorker(workerPath, "w0", 2, log);
        workers.push(second);
        location = workerLocation(workerPath, "w0", 2);
        expect(await replay).toMatchObject({ type: "history", seq: 2 });
        const attaches = readRequests(log).filter((request) => request.type === "attach");
        expect(attaches.some((request) => request.after_seq === 5)).toBe(true);
        expect(attaches.at(-1)?.after_seq).toBeUndefined();
        expect(hostRequests).toContain("locate_agent");
    } finally {
        client?.close();
        for (const worker of workers) await stopWorker(worker);
        await closeServer(host);
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

socketTest("a real stale worker redirects once to the owner resolved by the host", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs5-redirect-");
    const hostPath = join(root, "host.sock");
    const stalePath = join(root, "stale.sock");
    const ownerPath = join(root, "owner.sock");
    const staleLog = join(root, "stale.log");
    const ownerLog = join(root, "owner.log");
    const requests: string[] = [];
    const host = await hostServer(hostPath, () => workerLocation(ownerPath, "w1", 1), requests);
    const workers: WorkerProcess[] = [];
    let client: Awaited<ReturnType<typeof attachReconnectingAgent>> | undefined;
    try {
        workers.push(await startWorker(ownerPath, "w1", 1, ownerLog));
        workers.push(await startWorker(stalePath, "w0", 1, staleLog, ownerPath));
        client = await attachReconnectingAgent({
            socketPath: () => hostPath, agentId: "crow", buildId: BUILD,
            initialLocation: workerLocation(stalePath, "w0", 1),
        });
        expect((await client.receive()).type).toBe("history");
        expect(readRequests(staleLog).filter((request) => request.type === "attach")).toHaveLength(1);
        expect(readRequests(ownerLog).filter((request) => request.type === "attach")).toHaveLength(1);
        expect(requests.filter((request) => request === "locate_agent")).toHaveLength(1);
        client.close();
        client = undefined;
        await stopWorker(workers[0]!);
        await rm(ownerPath, { force: true });
        workers.push(await startWorker(ownerPath, "w1", 1, ownerLog, stalePath));
        requests.length = 0;
        await expect(attachReconnectingAgent({
            socketPath: () => hostPath, agentId: "crow", buildId: BUILD,
            initialLocation: workerLocation(stalePath, "w0", 1),
        })).rejects.toBeInstanceOf(AgentLocationChangedError);
        expect(requests.filter((request) => request === "locate_agent")).toHaveLength(1);
    } finally {
        client?.close();
        for (const worker of workers) await stopWorker(worker);
        await closeServer(host);
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

socketTest("a generation mismatch is resolved again before attaching", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs5-generation-");
    const hostPath = join(root, "host.sock");
    const workerPath = join(root, "worker.sock");
    const log = join(root, "worker.log");
    const requests: string[] = [];
    let locations = 0;
    const host = await hostServer(hostPath, () => {
        locations += 1;
        return locations < 2 ? undefined : workerLocation(workerPath, "w0", 2);
    }, requests);
    let worker: WorkerProcess | undefined;
    let client: Awaited<ReturnType<typeof attachReconnectingAgent>> | undefined;
    try {
        worker = await startWorker(workerPath, "w0", 2, log);
        client = await attachReconnectingAgent({
            socketPath: () => hostPath, agentId: "crow", buildId: BUILD,
            initialLocation: workerLocation(workerPath, "w0", 1),
        });
        expect((await client.receive()).type).toBe("history");
        expect(requests.filter((request) => request === "locate_agent")).toHaveLength(2);
        expect(readRequests(log).map((request) => request.type)).toEqual(["host_identity", "host_identity", "attach"]);
    } finally {
        client?.close();
        if (worker !== undefined) await stopWorker(worker);
        await closeServer(host);
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

socketTest("a starting location gets one retry after the worker has time to report", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs5-starting-");
    const hostPath = join(root, "host.sock");
    const workerPath = join(root, "worker.sock");
    const requests: string[] = [];
    let firstLocate = 0;
    const host = await hostServer(hostPath, () => {
        if (firstLocate === 0) firstLocate = Date.now();
        return Date.now() - firstLocate >= 300 ? workerLocation(workerPath, "w0", 1) : undefined;
    }, requests);
    let worker: WorkerProcess | undefined;
    let client: Awaited<ReturnType<typeof attachReconnectingAgent>> | undefined;
    try {
        worker = await startWorker(workerPath, "w0", 1, join(root, "worker.log"));
        client = await attachReconnectingAgent({ socketPath: () => hostPath, agentId: "crow", buildId: BUILD });
        expect((await client.receive()).type).toBe("history");
        expect(requests.filter((request) => request === "locate_agent")).toHaveLength(2);
    } finally {
        client?.close();
        if (worker !== undefined) await stopWorker(worker);
        await closeServer(host);
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

socketTest("a host-forwarded legacy attachment heals a worker redirect", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs5-legacy-redirect-");
    const hostPath = join(root, "host.sock");
    const stalePath = join(root, "stale.sock");
    const ownerPath = join(root, "owner.sock");
    const workers: WorkerProcess[] = [];
    const host = createServer((socket) => {
        socket.once("data", (chunk: Buffer) => {
            const line = chunk.toString("utf8").split("\n")[0]!;
            void forwardSessionConnection(socket, stalePath, line, true).catch(() => socket.destroy());
        });
    });
    await new Promise<void>((resolve, reject) => { host.once("error", reject); host.listen(hostPath, resolve); });
    let client: Awaited<ReturnType<typeof attachAgent>> | undefined;
    try {
        workers.push(await startWorker(ownerPath, "w1", 1, join(root, "owner.log")));
        workers.push(await startWorker(stalePath, "w0", 1, join(root, "stale.log"), ownerPath));
        client = await attachAgent({ socketPath: hostPath, agentId: "crow", requestedCapabilities: [HOST_CAPABILITY_SESSION_ROUTING] });
        expect((await client.receive()).type).toBe("history");
        expect(readRequests(join(root, "stale.log")).filter((request) => request.type === "attach")).toHaveLength(1);
        expect(readRequests(join(root, "owner.log")).filter((request) => request.type === "attach")).toHaveLength(1);
    } finally {
        client?.close();
        for (const worker of workers) await stopWorker(worker);
        await closeServer(host);
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

function workerLocation(socketPath: string, workerId: string, generation: number): AgentLocationResponse {
    return { type: "agent_location", socket_path: socketPath, worker_id: workerId, worker_generation: generation, build_id: BUILD };
}

async function hostServer(path: string, location: () => AgentLocationResponse | undefined, requests: string[]): Promise<Server> {
    return await listen(path, (request, socket) => {
        requests.push(request.type as string);
        const response = request.type === "host_identity"
            ? { type: "host_identity", pid: process.pid, started_at: STARTED, build_id: BUILD, role: "host", workers_ready: 1 }
            : location() ?? { type: "agent_location_failed", reason: "starting", message: "The worker is starting." };
        socket.end(`${JSON.stringify(response)}\n`);
    });
}

async function listen(path: string, respond: (request: Record<string, unknown>, socket: import("node:net").Socket) => void): Promise<Server> {
    const server = createServer((socket) => {
        let input = "";
        socket.on("data", (chunk: Buffer) => {
            input += chunk.toString("utf8");
            const newline = input.indexOf("\n");
            if (newline < 0) return;
            const line = input.slice(0, newline);
            input = input.slice(newline + 1);
            respond(JSON.parse(line) as Record<string, unknown>, socket);
        });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    return server;
}

async function startWorker(path: string, id: string, generation: number, log: string, redirect?: string): Promise<WorkerProcess> {
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/direct-routing-worker.ts"), path, id, String(generation), BUILD, log,
        ...(redirect === undefined ? [] : [redirect])], { cwd: process.cwd(), stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const worker = { child, exited };
    const deadline = Date.now() + 5_000;
    while (!existsSync(path)) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
            await stopWorker(worker);
            throw new Error("Worker did not start");
        }
        await Bun.sleep(10);
    }
    return worker;
}

async function stopWorker(worker: WorkerProcess): Promise<void> {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    await worker.exited;
    if (worker.child.pid !== undefined) expect(() => process.kill(worker.child.pid!, 0)).toThrow();
}

function readRequests(path: string): Record<string, unknown>[] {
    return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function rawRequest(path: string, request: object): Promise<string> {
    return await new Promise((resolve, reject) => {
        const socket = createConnection(path);
        let response = "";
        socket.setEncoding("utf8");
        socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk: string) => { response += chunk; });
        socket.once("end", () => resolve(response));
        socket.once("error", reject);
    });
}
