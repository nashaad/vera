import { mkdirSync } from "node:fs";
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { abortAgentThroughHost, abortPoolAgentThroughHost } from "../../src/host/agent-abort-client.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import { socketTest } from "../support/socket-probe.ts";

socketTest(
    "one-shot abort reaches a resident agent and detaches",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-abort-client-"));
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            findAgent: () => agent,
        });
        const command = agent.engine.receive();
        try {
            await abortAgentThroughHost(server.socketPath, agent.id);
            expect(await command).toEqual({ type: "abort" });
            expect(agent.closed).toBe(false);
        } finally {
            agent.close();
            await server.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

socketTest("pool abort reports no turn only after the owning process has exited", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const root = await mkdtemp(join(tmpdir(), "vera-dev", "hs9-abort-"));
    let ownerPid = 2_147_483_646;
    const server = await startHostServer({
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        locateAgent: async () => ({
            type: "agent_location_failed", reason: "worker_unavailable", message: "The session process is unavailable.",
        }),
        listAgents: () => [{
            id: "crow", workspace: "/work", session_path: "/sessions/crow.jsonl", kind: "interactive",
            status: "working", live: true, worker_pid: ownerPid,
        }],
    });
    try {
        expect(await abortPoolAgentThroughHost(server.socketPath, "crow")).toBe("no_turn");
        ownerPid = process.pid;
        const failure = await abortPoolAgentThroughHost(server.socketPath, "crow")
            .then(() => undefined, (error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe("The session process is unavailable.");
    } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
});
