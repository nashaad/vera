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
    HostBuildChangedError,
} from "../../src/host/reconnecting-agent-client.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";

const CROW_BUILD = "vera-crow-1";
const KRAKEN_BUILD = "vera-kraken-2";

// A host that reports a build ID, one that answers without one, or one that never answers.
type ScriptedIdentity = { readonly buildId: string } | "no_build_id" | "silent";

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
            buildId: CROW_BUILD,
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

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a reattach refuses a host that came back as another build, without retrying",
    async () => {
        const directory = temporaryDirectory();
        const firstSocketPath = join(directory, "first.sock");
        const secondSocketPath = join(directory, "second.sock");
        const secondRequests: unknown[] = [];
        const firstServer = await scriptedAttachHost(
            firstSocketPath,
            [],
            [{ type: "history", entries: [], seq: 0 }],
        );
        const secondServer = await scriptedAttachHost(
            secondSocketPath,
            secondRequests,
            [{ type: "assistant_delta", text: "kraken", seq: 1 }],
            { buildId: KRAKEN_BUILD },
        );
        let socketPath = firstSocketPath;
        const client = await attachReconnectingAgent({
            socketPath: () => socketPath,
            agentId: "agent-1",
            buildId: CROW_BUILD,
        });
        socketPath = secondSocketPath;
        try {
            expect(await client.receive()).toMatchObject({ seq: 0 });
            const startedAt = Date.now();
            const failure = await client.receive().then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(HostBuildChangedError);
            expect(failure).toMatchObject({
                clientBuildId: CROW_BUILD,
                hostBuildId: KRAKEN_BUILD,
            });
            expect(Date.now() - startedAt).toBeLessThan(2_000);
            expect(secondRequests).toEqual([]);
        } finally {
            client.close();
            await Promise.all([closeServer(firstServer), closeServer(secondServer)]);
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a first attach refuses a host of another build or one that reports none",
    async () => {
        const directory = temporaryDirectory();
        for (const identity of [{ buildId: KRAKEN_BUILD }, "no_build_id"] as const) {
            const socketPath = join(directory, "host.sock");
            const requests: unknown[] = [];
            const server = await scriptedAttachHost(socketPath, requests, [], identity);
            try {
                const failure = await attachReconnectingAgent({
                    socketPath: () => socketPath,
                    agentId: "agent-1",
                    buildId: CROW_BUILD,
                }).then(() => undefined, (error: unknown) => error);
                expect(failure).toBeInstanceOf(HostBuildChangedError);
                expect(failure).toMatchObject({
                    clientBuildId: CROW_BUILD,
                    hostBuildId: identity === "no_build_id" ? undefined : KRAKEN_BUILD,
                });
                expect(requests).toEqual([]);
            } finally {
                await closeServer(server);
            }
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a host that never confirms its build is not attached",
    async () => {
        const socketPath = join(temporaryDirectory(), "host.sock");
        const requests: unknown[] = [];
        const server = await scriptedAttachHost(socketPath, requests, [], "silent");
        try {
            const failure = await attachReconnectingAgent({
                socketPath: () => socketPath,
                agentId: "agent-1",
                buildId: CROW_BUILD,
            }).then(() => undefined, (error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain("did not report its build");
            expect(requests).toEqual([]);
        } finally {
            await closeServer(server);
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
        type: "oneshot",
        requestId: "oneshot-1",
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

test("sequenced skill replies survive a dropped connection without resubmission", async () => {
    const initial = fakeClient([], 4);
    const recovered = fakeClient([{
        type: "skill_invocation_accepted",
        requestId: "invoke-1",
        name: "deploy",
        prompt: "/deploy staging",
        queued: false,
        seq: 5,
    }], 4);
    const cursors: Array<number | undefined> = [];
    const sent: ClientCommand[] = [];
    const initialWithSend: AttachedAgentClient = {
        ...initial,
        send: async (command) => {
            sent.push(command);
        },
    };
    const client = createReconnectingAgentClient(
        initialWithSend,
        async (cursor) => {
            cursors.push(cursor);
            return recovered;
        },
    );
    const command: ClientCommand = {
        type: "invoke_skill",
        requestId: "invoke-1",
        name: "deploy",
        argumentsText: "staging",
    };

    await client.send(command);
    expect(await client.receive()).toEqual({
        type: "skill_invocation_accepted",
        requestId: "invoke-1",
        name: "deploy",
        prompt: "/deploy staging",
        queued: false,
        seq: 5,
    });
    expect(sent).toEqual([command]);
    expect(cursors).toEqual([4]);
    client.close();
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

test("reconnecting clients release through their current attachment", async () => {
    let releasedWith: string | undefined;
    const initial: AttachedAgentClient = {
        ...fakeClient([], 0),
        release: async (policy) => {
            releasedWith = policy;
            return {
                outcome: "detached",
                remainingInteractiveClients: 1,
            };
        },
    };
    const client = createReconnectingAgentClient(initial, async () => initial);

    expect(await client.release?.("stop_if_last")).toEqual({
        outcome: "detached",
        remainingInteractiveClients: 1,
    });
    expect(releasedWith).toBe("stop_if_last");
    expect(client.closed).toBeTrue();
});

test("closing during an unanswered release closes the attachment", async () => {
    let attachmentClosed = false;
    const initial: AttachedAgentClient = {
        ...fakeClient([], 0),
        release: () => new Promise(() => {}),
        close: () => {
            attachmentClosed = true;
        },
    };
    const client = createReconnectingAgentClient(initial, async () => initial);

    void client.release?.("stop_if_last");
    client.close();

    expect(attachmentClosed).toBeTrue();
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

test("a reconnect publishes a replacement work index already received", async () => {
    const initialIndex: WorkIndexSnapshot = {
        rows: [],
        needs_you: 0,
        working: 0,
    };
    const replacementIndex: WorkIndexSnapshot = {
        rows: [{
            id: "agent-2",
            session_id: "agent-2",
            session_path: "/sessions/agent-2.jsonl",
            title: "Review changes",
            section: "needs_you",
            reason: "approval",
            summary: "Approve bash",
            workspace: "/work/one",
            updated_at: "2026-08-22T12:00:00.000Z",
        }],
        needs_you: 1,
        working: 0,
    };
    const background = {
        running: 0,
        children: [] as string[],
        has_parent: false,
    };
    const initial = fakeClient([], 4, true, background, initialIndex);
    const recovered = fakeClient([
        { type: "assistant_delta", text: "continued", seq: 5 },
    ], 4, true, background, replacementIndex);
    const client = createReconnectingAgentClient(initial, async () => recovered);
    const snapshots: WorkIndexSnapshot[] = [];
    client.onWorkIndex(() => {
        throw new Error("observer failed");
    });
    client.onWorkIndex((snapshot) => snapshots.push(snapshot));

    await client.receive();

    expect(client.workIndex).toEqual(replacementIndex);
    expect(snapshots).toEqual([replacementIndex]);
    client.close();
});

test("session titles come from the current attachment only", async () => {
    const initialListeners = new Set<(title: string | undefined) => void>();
    const recoveredListeners = new Set<(title: string | undefined) => void>();
    const initial: AttachedAgentClient = {
        ...fakeClient([], 4),
        onSessionTitle(listener) {
            initialListeners.add(listener);
            return () => initialListeners.delete(listener);
        },
    };
    const recovered: AttachedAgentClient = {
        ...fakeClient([
            { type: "assistant_delta", text: "continued", seq: 5 },
        ], 4),
        onSessionTitle(listener) {
            recoveredListeners.add(listener);
            return () => recoveredListeners.delete(listener);
        },
    };
    const client = createReconnectingAgentClient(initial, async () => recovered);
    const titles: (string | undefined)[] = [];
    client.onSessionTitle(() => {
        throw new Error("observer failed");
    });
    client.onSessionTitle((title) => titles.push(title));

    for (const listener of initialListeners) listener("Crow's nest");
    await client.receive();
    for (const listener of initialListeners) listener("Stale");
    for (const listener of recoveredListeners) listener("Buried treasure map");
    for (const listener of recoveredListeners) listener(undefined);

    expect(initialListeners.size).toBe(0);
    expect(titles).toEqual(["Crow's nest", "Buried treasure map", undefined]);
    expect(client.sessionTitle).toBeUndefined();
    client.close();
    expect(recoveredListeners.size).toBe(0);
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

test("a paging client retries a page on its replacement attachment", async () => {
    const response = {
        type: "history_page" as const,
        request_id: "history-page-1",
        before: "older#0",
        entries: [{
            kind: "assistant" as const,
            id: "older#0",
            text: "older",
        }],
        page: {
            pageVersion: 1,
            hasMore: false,
            headId: "message-4",
            tailId: "older#0",
        },
    };
    const initial: AttachedAgentClient = {
        ...fakeClient([], 4),
        requestHistoryPage: async () => {
            throw new Error("host connection closed");
        },
    };
    let retried: string | undefined;
    const recovered: AttachedAgentClient = {
        ...fakeClient([{
            type: "assistant_delta",
            text: "continued",
            seq: 5,
        }], 4),
        requestHistoryPage: async (before) => {
            retried = before;
            return response;
        },
    };
    const cursors: Array<number | undefined> = [];
    const client = createReconnectingAgentClient(initial, async (cursor) => {
        cursors.push(cursor);
        return recovered;
    });
    await expect(client.requestHistoryPage("older#0")).rejects
        .toThrow("closed");
    expect(await client.receive()).toMatchObject({ seq: 5 });
    expect(cursors).toEqual([4]);

    const page = await client.requestHistoryPage("older#0");
    expect(page.entries[0]!.id).toBe("older#0");
    expect(retried).toBe("older#0");
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
    identity: ScriptedIdentity = { buildId: CROW_BUILD },
): Promise<Server> {
    const server = createServer((socket) => {
        let input = "";
        socket.on("data", (chunk: Buffer) => {
            input += chunk.toString("utf8");
            const newlineAt = input.indexOf("\n");
            if (newlineAt === -1) return;
            const request = JSON.parse(input.slice(0, newlineAt)) as { readonly type?: string };
            if (request.type === "host_identity") {
                if (identity === "silent") return;
                socket.end(`${JSON.stringify({
                    type: "host_identity",
                    pid: process.pid,
                    started_at: new Date().toISOString(),
                    ...(identity === "no_build_id" ? {} : { build_id: identity.buildId }),
                })}\n`);
                return;
            }
            requests.push(request);
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
    workIndex?: WorkIndexSnapshot,
): AttachedAgentClient {
    const updates = new AsyncQueue<AgentUpdate>();
    for (const value of values) updates.push(value);
    updates.fail(new Error("host connection closed"));
    return fakeClientFromQueue(
        updates,
        initialSequence,
        supportsResume,
        backgroundAgents,
        workIndex,
    );
}

function fakeClientFromQueue(
    updates: AsyncQueue<AgentUpdate>,
    initialSequence?: number,
    supportsResume = true,
    backgroundAgents = { running: 0, children: [] as string[], has_parent: false },
    workIndex?: WorkIndexSnapshot,
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
        workIndex,
        onWorkIndex: () => () => undefined,
        sessionTitle: undefined,
        onSessionTitle: () => () => undefined,
        send: async () => undefined,
        async receive(signal) {
            const update = await updates.receive(signal);
            if ("seq" in update) lastSequence = update.seq;
            return update;
        },
        requestHistoryPage: async () => {
            throw new Error("History paging is not supported by this fake");
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
