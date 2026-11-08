import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { createConfiguredTuiAgentClients } from "../../clients/tui/configured-agent-client.ts";

test("the configured client does not attach to a worker from another build", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs5-tui-build-");
    const masterPath = join(root, "host.sock");
    const workerPath = join(root, "worker.sock");
    const masterRequests: string[] = [];
    const workerRequests: string[] = [];
    const master = await listen(masterPath, (request) => {
        masterRequests.push(request.type as string);
        return request.type === "host_identity"
            ? { type: "host_identity", pid: process.pid, started_at: "2026-11-08T00:00:00.000Z", build_id: "crow", role: "host", workers_ready: 1 }
            : { type: "agent_location", socket_path: workerPath, worker_id: "w0", worker_generation: 1, build_id: "crow" };
    });
    const worker = await listen(workerPath, (request) => {
        workerRequests.push(request.type as string);
        return { type: "host_identity", pid: process.pid, started_at: "2026-11-08T00:00:00.000Z", build_id: "other", role: "worker", worker_id: "w0", worker_generation: 1 };
    });
    try {
        const clients = createConfiguredTuiAgentClients(() => masterPath, "crow");
        await expect(clients.attach("crow")).rejects.toThrow("The session worker is unavailable");
        expect(masterRequests).toEqual(["host_identity", "locate_agent", "locate_agent"]);
        expect(workerRequests).toEqual(["host_identity", "host_identity"]);
    } finally {
        await Promise.all([close(master), close(worker)]);
        await rm(root, { recursive: true, force: true });
    }
});

async function listen(path: string, respond: (request: Record<string, unknown>) => object): Promise<Server> {
    const server = createServer((socket) => {
        let input = "";
        socket.on("data", (chunk: Buffer) => {
            input += chunk.toString("utf8");
            const newline = input.indexOf("\n");
            if (newline < 0) return;
            const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
            socket.end(`${JSON.stringify(respond(request))}\n`);
        });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    return server;
}

async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
