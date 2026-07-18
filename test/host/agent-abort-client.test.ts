import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { abortAgentThroughHost } from "../../src/host/agent-abort-client.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
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
