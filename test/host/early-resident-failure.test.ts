import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";

import { runAttachedStdioBridge } from "../../clients/stdio/ndjson-bridge.ts";
import { CLIENT_CAPABILITIES } from "../../src/host/capabilities.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { createHostLogger } from "../../src/host/host-log.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

test("an early resident failure reaches stdio once and records the underlying error", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/early-failure-");
    const socketPath = join(home, "host.sock");
    const error = new Error("Injected context persistence failure");
    const failure = spyOn(SessionStore.prototype, "appendContextMeasurement")
        .mockImplementation(async () => { throw error; });
    let modelCalls = 0;
    const host = await startResidentHost({
        home,
        config: { schema_version: 1, provider: "faux", model: "faux/test", approval_mode: "auto" },
        createAdapter: () => {
            const adapter = new FauxAdapter([]);
            const stream = adapter.stream.bind(adapter);
            adapter.stream = (request) => { modelCalls += 1; return stream(request); };
            return adapter;
        },
        socketPath,
        lockPath: join(home, "host.json"),
        sessionDirectory: join(home, "sessions"),
        eventLogDirectory: join(home, "events"),
    });
    const proxyPath = join(home, "proxy.sock");
    const sockets = new Set<Socket>();
    let interrupted = false;
    const proxy = createServer((clientSocket) => {
        const hostSocket = createConnection(socketPath);
        sockets.add(clientSocket);
        sockets.add(hostSocket);
        clientSocket.on("error", () => {});
        hostSocket.on("error", () => {});
        clientSocket.on("close", () => { sockets.delete(clientSocket); hostSocket.destroy(); });
        hostSocket.on("close", () => { sockets.delete(hostSocket); clientSocket.destroy(); });
        clientSocket.pipe(hostSocket);
        let pending = "";
        hostSocket.setEncoding("utf8");
        hostSocket.on("data", (chunk: string) => {
            pending += chunk;
            let end = pending.indexOf("\n");
            while (end >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                if (!interrupted && JSON.parse(line).type === "agent_failed") {
                    interrupted = true;
                    clientSocket.destroy();
                    hostSocket.destroy();
                    return;
                }
                clientSocket.write(`${line}\n`);
                end = pending.indexOf("\n");
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(proxyPath, resolve);
    });
    try {
        await host.registry.create({ id: "early-failure", workspace: home });
        const client = await attachReconnectingAgent({
            socketPath: () => proxyPath,
            agentId: "early-failure",
            buildId: thisProcessBuildId(),
            requestedCapabilities: CLIENT_CAPABILITIES,
        });
        const other = await attachAgent({ socketPath, agentId: "early-failure" });
        expect((await other.receive(AbortSignal.timeout(5_000))).type).toBe("history");
        const input = new Readable({ read() {} });
        const frames: Record<string, unknown>[] = [];
        let backgrounds = 0;
        const terminal = Promise.withResolvers<void>();
        const run = runAttachedStdioBridge(input, {
            write(text) {
                const frame = JSON.parse(text) as Record<string, unknown>;
                if (frame.type === "background_agents") backgrounds += 1;
                if (frames.length < 100) frames.push(frame);
                if (frame.type === "agent_failed") terminal.resolve();
            },
        }, client).catch(() => {});
        try {
            input.push('{"type":"prompt","content":"Chart a course"}\n');
            await Promise.race([terminal.promise, Bun.sleep(3_000)]);
            await Bun.sleep(250);
            expect(frames.filter((frame) => frame.type === "agent_failed")).toMatchObject([{
                type: "agent_failed",
                detail: "Injected context persistence failure",
            }]);
            expect(interrupted).toBe(true);
            expect(backgrounds).toBeLessThan(10);
            expect(modelCalls).toBe(0);
            let otherUpdate;
            do { otherUpdate = await other.receive(AbortSignal.timeout(5_000)); } while (otherUpdate.type !== "agent_failed");
            expect(otherUpdate.detail).toBe(error.message);
            const store = await SessionStore.open(join(home, "sessions", "early-failure.jsonl"));
            expect(store.agentFailure()?.detail).toBe(error.message);
            const events = await readFile(join(home, "events", "early-failure.jsonl"), "utf8");
            expect(events).toContain('"type":"model_request"');
            const log = await readFile(join(home, "runtime", "logs", "host.jsonl"), "utf8");
            const logged = log.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
                .filter((entry) => entry.level === "error" && entry.message === error.message);
            expect(logged).toHaveLength(1);
            expect(logged[0]?.stack).toContain("Injected context persistence failure");
        } finally {
            input.push(null);
            client.close();
            other.close();
            await run;
        }
    } finally {
        failure.mockRestore();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await host.close();
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

test("a worker startup failure records the worker stack once", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/worker-failure-");
    const logPath = join(home, "runtime", "logs", "host.jsonl");
    const registry = new AgentRegistry({
        home,
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: () => ({ module: join(import.meta.dir, "fixtures", "failing-worker-adapter.ts"), export: "createAdapter" }),
        model: "faux/test",
        provider: "faux",
        approvalMode: "auto",
        hostLog: createHostLogger({ path: logPath }),
    });
    try {
        const agent = await registry.create({
            id: "worker-failure", workspace: home, sessionPath: join(home, "session.jsonl"),
        });
        const client = agent.attach();
        try {
            let update;
            do { update = await client.receive(AbortSignal.timeout(10_000)); } while (update.type !== "agent_failed");
            expect(update.detail).toBe("Injected worker startup failure");
            const entries = (await readFile(logPath, "utf8")).trim().split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>)
                .filter((entry) => entry.level === "error" && entry.type === "resident_agent_failed");
            expect(entries).toHaveLength(1);
            expect(entries[0]?.message).toBe("Injected worker startup failure");
            expect(entries[0]?.stack).toContain("failing-worker-adapter.ts");
        } finally {
            client.detach();
        }
    } finally {
        await registry.close();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);
