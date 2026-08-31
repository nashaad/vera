import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import { attachAgent } from "../../src/host/attached-client.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a oneshot reply reaches the client that asked, through the host",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-oneshot-client-"));
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            findAgent: () => agent,
        });
        const client = await attachAgent({
            socketPath: server.socketPath,
            agentId: agent.id,
        });
        try {
            expect((await client.receive()).type).toBe("history");
            await client.send({
                type: "oneshot",
                requestId: "oneshot-1",
                model: "gpt-5.5",
                messages: [{ role: "user", content: "which way" }],
            });
            const command = await agent.engine.receive();
            expect(command.type).toBe("owned_oneshot_command");
            if (command.type !== "owned_oneshot_command") return;
            expect(command.command.requestId).toBe("oneshot-1");

            agent.sendOneshotReply(command.ownerId, {
                type: "oneshot_result",
                requestId: "oneshot-1",
                text: "that way",
                model: "gpt-5.5",
            });
            expect(await client.receive()).toEqual({
                type: "oneshot_result",
                requestId: "oneshot-1",
                text: "that way",
                model: "gpt-5.5",
            });
        } finally {
            client.close();
            agent.close();
            await server.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    5_000,
);
