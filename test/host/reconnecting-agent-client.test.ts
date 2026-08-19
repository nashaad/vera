import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";
import { HOST_CAPABILITY_AGENT_ATTACH_RESUME } from "../../src/host/capabilities.ts";
import {
    AgentAttachError,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import {
    attachReconnectingAgent,
    createReconnectingAgentClient,
} from "../../src/host/reconnecting-agent-client.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "reconnecting clients resume from the last update delivered to their caller",
    async () => {
        const directory = temporaryDirectory();
        const firstSocketPath = join(directory, "first.sock");
        const secondSocketPath = join(directory, "second.sock");
        const firstRequests: unknown[] = [];
        const secondRequests: unknown[] = [];
        const firstServer = await scriptedAttachHost(
            firstSocketPath,
            firstRequests,
            [
                { type: "history", entries: [], seq: 0 },
                { type: "assistant_delta", text: "first", seq: 1 },
            ],
        );
        const secondServer = await scriptedAttachHost(
            secondSocketPath,
            secondRequests,
            [{ type: "assistant_delta", text: "second", seq: 2 }],
        );
        let socketPath = firstSocketPath;
        const client = await attachReconnectingAgent({
            socketPath: () => socketPath,
            agentId: "agent-1",
        });
        socketPath = secondSocketPath;
        try {
            expect(await client.receive()).toMatchObject({ seq: 0 });
            expect(await client.receive()).toMatchObject({ seq: 1 });
            expect(client.lastSequence).toBe(1);
            expect(await client.receive()).toEqual({
                type: "assistant_delta",
                text: "second",
                seq: 2,
            });
            expect(secondRequests).toContainEqual(expect.objectContaining({
                type: "attach",
                agent_id: "agent-1",
                after_seq: 1,
            }));
        } finally {
            client.close();
            await Promise.all([closeServer(firstServer), closeServer(secondServer)]);
        }
    },
);

test(
    "reconnect exhaustion is visible and bounded",
    async () => {
        const initial = fakeClient([
            { type: "history", entries: [], seq: 0 },
        ]);
        let attempts = 0;
        const client = createReconnectingAgentClient(
            initial,
            async (cursor) => {
                expect(cursor).toBe(0);
                attempts += 1;
                throw new Error("host is unavailable");
            },
            { deadlineMs: 50, delaysMs: [0, 1, 1] },
        );
        expect(await client.receive()).toMatchObject({ seq: 0 });
        await expect(client.receive()).rejects.toThrow(
            "Could not reconnect agent before its deadline",
        );
        expect(attempts).toBe(3);
        client.close();
    },
);

test("attachment-private work makes a disconnect terminal", async () => {
    const initial = fakeClient([], 4);
    let reconnects = 0;
    const client = createReconnectingAgentClient(initial, async () => {
        reconnects += 1;
        return fakeClient([], 4);
    });
    await client.send({
        type: "consult",
        requestId: "consult-1",
        model: "test",
        messages: [],
    });
    await expect(client.receive()).rejects.toThrow(
        "attachment-private request was pending",
    );
    expect(reconnects).toBe(0);
});

test("a prompt remains private until its sequenced acceptance arrives", async () => {
    const initial = fakeClient([], 4);
    const client = createReconnectingAgentClient(initial, async () =>
        fakeClient([], 4));
    await client.send({ type: "prompt", content: "hello" });
    await expect(client.receive()).rejects.toThrow(
        "attachment-private request was pending",
    );
});

test("another attachment's prompt does not settle this client's prompts", async () => {
    const initial = fakeClient([
        { type: "user_prompt", content: "someone else", seq: 5 },
    ], 4);
    const client = createReconnectingAgentClient(initial, async () =>
        fakeClient([], 5));
    await client.send({ type: "prompt", content: "first" });
    await client.send({ type: "prompt", content: "second" });
    expect(await client.receive()).toMatchObject({ content: "someone else" });
    await expect(client.receive()).rejects.toThrow(
        "attachment-private request was pending",
    );
});

test("clients without resume support reconnect from a fresh checkpoint", async () => {
    const initial = fakeClient([], 4, false);
    const recovered = fakeClient([
        { type: "history", entries: [], seq: 5 },
    ], undefined, false);
    const cursors: Array<number | undefined> = [];
    const client = createReconnectingAgentClient(initial, async (cursor) => {
        cursors.push(cursor);
        return recovered;
    });
    expect(await client.receive()).toMatchObject({ seq: 5 });
    expect(cursors).toEqual([undefined]);
    client.close();
});

test("a replacement without resume support falls back to a fresh checkpoint", async () => {
    const initial = fakeClient([], 4);
    const recovered = fakeClient([
        { type: "history", entries: [], seq: 5 },
    ], undefined, false);
    const cursors: Array<number | undefined> = [];
    const client = createReconnectingAgentClient(initial, async (cursor) => {
        cursors.push(cursor);
        if (cursor !== undefined) {
            throw new AgentAttachError("resume unavailable", "unavailable");
        }
        return recovered;
    });
    expect(await client.receive()).toMatchObject({ seq: 5 });
    expect(cursors).toEqual([4, undefined]);
    client.close();
});

test("closing aborts an in-flight reconnect without another attempt", async () => {
    const initial = fakeClient([], 4);
    let attempts = 0;
    const started = Promise.withResolvers<void>();
    const client = createReconnectingAgentClient(initial, (_cursor, signal) => {
        attempts += 1;
        started.resolve();
        return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
            });
        });
    });
    const receiving = client.receive();
    await started.promise;
    client.close();
    await expect(receiving).rejects.toThrow("closed");
    expect(attempts).toBe(1);
});

test("commands wait for an in-flight reconnect", async () => {
    const initial = fakeClient([], 4);
    const attached = Promise.withResolvers<AttachedAgentClient>();
    const started = Promise.withResolvers<void>();
    const sent: ClientCommand[] = [];
    const recoveredBase = fakeClient([
        { type: "user_prompt", content: "after reconnect", seq: 5 },
    ], 4);
    const recovered: AttachedAgentClient = {
        ...recoveredBase,
        send: async (command) => {
            sent.push(command);
        },
    };
    const client = createReconnectingAgentClient(initial, async () => {
        started.resolve();
        return attached.promise;
    });
    const receiving = client.receive();
    await started.promise;
    const sending = client.send({ type: "prompt", content: "after reconnect" });
    attached.resolve(recovered);
    await sending;
    expect(await receiving).toMatchObject({ type: "user_prompt" });
    expect(sent).toEqual([{ type: "prompt", content: "after reconnect" }]);
    client.close();
});

test("a reconnect publishes the replacement background snapshot", async () => {
    const initial = fakeClient([], 4);
    const recovered = fakeClient([
        { type: "assistant_delta", text: "continued", seq: 5 },
    ], 4, true, { running: 1, children: ["worker"], has_parent: false });
    const client = createReconnectingAgentClient(initial, async () => recovered);
    const snapshots: unknown[] = [];
    client.onBackgroundAgents(() => {
        throw new Error("observer failed");
    });
    client.onBackgroundAgents((snapshot) => snapshots.push(snapshot));
    await client.receive();
    expect(snapshots).toEqual([
        { running: 1, children: ["worker"], has_parent: false },
    ]);
    client.close();
});

test("a second concurrent receive is rejected explicitly", async () => {
    const updates = new AsyncQueue<AgentUpdate>();
    const initial = fakeClientFromQueue(updates);
    const client = createReconnectingAgentClient(initial, async () => initial);
    const first = client.receive();
    await expect(client.receive()).rejects.toThrow("already has a pending receive");
    updates.push({ type: "history", entries: [], seq: 0 });
    expect(await first).toMatchObject({ seq: 0 });
    client.close();
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join("/private/tmp", "vera-reconnect-client-"));
    temporaryDirectories.push(directory);
    return directory;
}

async function scriptedAttachHost(
    socketPath: string,
    requests: unknown[],
    updates: readonly AgentUpdate[],
): Promise<Server> {
    const server = createServer((socket) => {
        let input = "";
        socket.on("data", (chunk: Buffer) => {
            input += chunk.toString("utf8");
            const newlineAt = input.indexOf("\n");
            if (newlineAt === -1) return;
            requests.push(JSON.parse(input.slice(0, newlineAt)));
            socket.write(`${JSON.stringify({
                type: "attached",
                agent_id: "agent-1",
                workspace: "/work/one",
                capabilities: [HOST_CAPABILITY_AGENT_ATTACH_RESUME],
                background_agents: {
                    running: 0,
                    children: [],
                    has_parent: false,
                },
            })}\n`);
            for (const update of updates) {
                socket.write(`${JSON.stringify(update)}\n`);
            }
            socket.end();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    return server;
}

function fakeClient(
    values: readonly AgentUpdate[],
    initialSequence?: number,
    supportsResume = true,
    backgroundAgents = { running: 0, children: [] as string[], has_parent: false },
): AttachedAgentClient {
    const updates = new AsyncQueue<AgentUpdate>();
    for (const value of values) updates.push(value);
    updates.fail(new Error("host connection closed"));
    return fakeClientFromQueue(
        updates,
        initialSequence,
        supportsResume,
        backgroundAgents,
    );
}

function fakeClientFromQueue(
    updates: AsyncQueue<AgentUpdate>,
    initialSequence?: number,
    supportsResume = true,
    backgroundAgents = { running: 0, children: [] as string[], has_parent: false },
): AttachedAgentClient {
    let lastSequence = initialSequence;
    return {
        agentId: "agent-1",
        workspace: "/work/one",
        get lastSequence() {
            return lastSequence;
        },
        capabilities: supportsResume ? [HOST_CAPABILITY_AGENT_ATTACH_RESUME] : [],
        supportsHostCapability: (capability) =>
            supportsResume && capability === HOST_CAPABILITY_AGENT_ATTACH_RESUME,
        backgroundAgents,
        onBackgroundAgents: () => () => undefined,
        workIndex: undefined,
        onWorkIndex: () => () => undefined,
        send: async () => undefined,
        async receive(signal) {
            const update = await updates.receive(signal);
            if ("seq" in update) lastSequence = update.seq;
            return update;
        },
        listExtensionCommands: async () => [],
        runExtensionCommand: async () => ({
            version: 1,
            source: "test",
            body: { kind: "text", text: "" },
        }),
        detach: async () => undefined,
        close: () => undefined,
        closed: false,
    };
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });
}
