import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";

socketTest("a client retries a starting session location once", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h8b-locate-"));
    const socketPath = join(home, "host.sock");
    let locations = 0;
    const server = createServer((socket) => socket.once("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString("utf8")) as { type: string };
        if (request.type === "host_identity") {
            socket.end(`${JSON.stringify({ type: "host_identity", pid: process.pid, started_at: new Date().toISOString(),
                build_id: "local-build", workers_ready: 0 })}\n`);
            return;
        }
        if (request.type === "locate_agent") {
            locations += 1;
            socket.end(`${JSON.stringify({ type: "agent_location_failed", reason: "starting",
                message: "The session processes are starting." })}\n`);
        }
    }));
    try {
        await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
        await expect(attachReconnectingAgent({ socketPath: () => socketPath, agentId: "crow", buildId: "local-build" }))
            .rejects.toThrow("The session processes are starting.");
        expect(locations).toBe(2);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
        await rm(home, { recursive: true, force: true });
    }
});
