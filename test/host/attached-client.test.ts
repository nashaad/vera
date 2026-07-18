import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import {
    AgentAttachError,
    attachAgent,
} from "../../src/host/attached-client.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client exchanges typed commands and updates until detach",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
        });
        const client = await attachAgent({ socketPath, agentId: agent.id });
        try {
            expect(client.agentId).toBe("agent-1");
            expect(client.workspace).toBe("/work/one");
            expect(await client.receive()).toEqual({
                type: "history",
                entries: [],
                seq: 0,
            });

            await client.send({ type: "prompt", content: "hello" });
            expect(await agent.engine.receive()).toEqual({
                type: "prompt",
                content: "hello",
            });
            agent.engine.send({
                type: "assistant_delta",
                text: "hi",
                seq: 1,
            });
            expect(await client.receive()).toEqual({
                type: "assistant_delta",
                text: "hi",
                seq: 1,
            });

            await client.detach();
            expect(client.closed).toBe(true);
            expect(agent.closed).toBe(false);
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client reports a typed missing-agent failure",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
        });
        try {
            await expect(attachAgent({
                socketPath,
                agentId: "missing",
            })).rejects.toMatchObject({
                name: AgentAttachError.name,
                reason: "not_found",
            });
        } finally {
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client rejects malformed host updates",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = createServer((socket) => {
            socket.once("data", () => {
                socket.write(`${JSON.stringify({
                    type: "attached",
                    agent_id: "agent-1",
                    workspace: "/work/one",
                })}\n`);
                socket.write(
                    '{"type":"assistant_delta","text":"one","seq":1}\n',
                );
                socket.write('{"type":"assistant_delta","seq":1}\n');
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        const client = await attachAgent({
            socketPath,
            agentId: "agent-1",
            maxPendingUpdates: 1,
        });
        try {
            await Bun.sleep(10);
            expect(client.closed).toBe(false);
            expect(await client.receive()).toEqual({
                type: "assistant_delta",
                text: "one",
                seq: 1,
            });
            await expect(client.receive()).rejects.toThrow(
                "Host sent an invalid agent update",
            );
        } finally {
            client.close();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined
                    ? resolve()
                    : reject(error));
            });
        }
    },
);

function temporaryDirectory(): string {
    const directory = mkdtempSync(join("/private/tmp", "vera-attached-client-"));
    temporaryDirectories.push(directory);
    return directory;
}
