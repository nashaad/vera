import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    AgentAttachError,
    attachAgent,
    type AttachedAgentClient,
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
            agent.engine.send({
                type: "task_notification",
                deliveryId: "completion:child-1",
                sourceAgentId: "child-1",
                content: "The tests pass.",
                seq: 2,
            });
            expect(await client.receive()).toEqual({
                type: "task_notification",
                deliveryId: "completion:child-1",
                sourceAgentId: "child-1",
                content: "The tests pass.",
                seq: 2,
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
    "two socket clients receive the same resident update stream",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
        });
        const first = await attachAgent({ socketPath, agentId: agent.id });
        const second = await attachAgent({ socketPath, agentId: agent.id });
        try {
            expect(await first.receive()).toEqual(await second.receive());
            await first.send({ type: "prompt", content: "hello" });
            expect(await agent.engine.receive()).toEqual({
                type: "prompt",
                content: "hello",
            });
            const updates = [
                { type: "user_prompt" as const, content: "hello", seq: 1 },
                { type: "assistant_delta" as const, text: "hi", seq: 2 },
                { type: "turn_finished" as const, seq: 3 },
            ];
            for (const update of updates) {
                agent.engine.send(update);
            }

            const firstUpdates = await receiveUpdates(first, updates.length);
            const secondUpdates = await receiveUpdates(second, updates.length);
            expect(firstUpdates).toEqual(updates);
            expect(secondUpdates).toEqual(firstUpdates);
        } finally {
            first.close();
            second.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client receives a resident failure before disconnect",
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
            await client.receive();
            agent.engine.send({
                type: "assistant_delta",
                text: "partial",
                seq: 1,
            });
            agent.fail("failure-1", "Resident agent stopped unexpectedly");

            expect(await client.receive()).toEqual({
                type: "assistant_delta",
                text: "partial",
                seq: 1,
            });
            expect(await client.receive()).toEqual({
                type: "agent_failed",
                failureId: "failure-1",
                detail: "Resident agent stopped unexpectedly",
                seq: 2,
            });
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
                socket.write('{"type":"history","entries":[],"seq":0}\n');
                socket.write(
                    '{"type":"assistant_delta","text":"one","seq":1}\n',
                );
                socket.write('{"type":"assistant_delta","seq":2}\n');
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
                type: "history",
                entries: [],
                seq: 0,
            });
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

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client rejects a gap after its replay checkpoint",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, [
            { type: "history", entries: [], seq: 4 },
            { type: "timeline", requestId: "timeline-1", boundaries: [] },
            { type: "history", entries: [], seq: 4 },
            { type: "assistant_delta", text: "lost an update", seq: 6 },
        ]);
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            expect(await client.receive()).toMatchObject({
                type: "history",
                seq: 4,
            });
            expect(await client.receive()).toMatchObject({ type: "timeline" });
            expect(await client.receive()).toMatchObject({
                type: "history",
                seq: 4,
            });
            await expect(client.receive()).rejects.toThrow(
                "Host sent a non-contiguous agent update sequence",
            );
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client requires history before sequenced updates",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, [
            { type: "assistant_delta", text: "orphaned", seq: 1 },
        ]);
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            await expect(client.receive()).rejects.toThrow(
                "Host sent an agent update before its history checkpoint",
            );
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client rejects duplicate and regressing update sequences",
    async () => {
        for (const invalidSequence of [4, 3]) {
            const directory = temporaryDirectory();
            const socketPath = join(directory, `host-${invalidSequence}.sock`);
            const server = await scriptedHost(socketPath, [
                { type: "history", entries: [], seq: 4 },
                {
                    type: "assistant_delta",
                    text: "out of order",
                    seq: invalidSequence,
                },
            ]);
            const client = await attachAgent({
                socketPath,
                agentId: "agent-1",
            });
            try {
                expect(await client.receive()).toMatchObject({
                    type: "history",
                    seq: 4,
                });
                await expect(client.receive()).rejects.toThrow(
                    "Host sent a non-contiguous agent update sequence",
                );
            } finally {
                client.close();
                await closeServer(server);
            }
        }
    },
);

function temporaryDirectory(): string {
    const directory = mkdtempSync(join("/private/tmp", "vera-attached-client-"));
    temporaryDirectories.push(directory);
    return directory;
}

async function receiveUpdates(
    client: AttachedAgentClient,
    count: number,
): Promise<AgentUpdate[]> {
    const updates: AgentUpdate[] = [];
    while (updates.length < count) {
        updates.push(await client.receive());
    }
    return updates;
}

async function scriptedHost(
    socketPath: string,
    updates: readonly AgentUpdate[],
): Promise<ReturnType<typeof createServer>> {
    const server = createServer((socket) => {
        socket.once("data", () => {
            socket.write(`${JSON.stringify({
                type: "attached",
                agent_id: "agent-1",
                workspace: "/work/one",
            })}\n`);
            for (const update of updates) {
                socket.write(`${JSON.stringify(update)}\n`);
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    return server;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });
}
