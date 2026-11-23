import { mkdirSync } from "node:fs";
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentPageThroughHost, listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { HostRouter, type SessionEndpoint } from "../../src/host/pool/router.ts";
import { startHostServer } from "../../src/host/server.ts";
import { socketTest } from "../support/socket-probe.ts";

socketTest(
    "agent list client validates host summaries",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-list-client-"));
        const socketPath = join(root, "host.sock");
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            listAgents: () => [{
                id: "agent-1",
                workspace: "/work/one",
                session_path: "/sessions/agent-1.jsonl",
                kind: "background",
                status: "working",
                live: true,
                title: "Background audit",
                updated_at: "2026-07-20T20:00:00.000Z",
                parent_id: "parent-1",
            }, {
                id: "agent-2",
                workspace: "/work/one",
                session_path: "/sessions/agent-2.jsonl",
                kind: "interactive",
                status: "idle",
                live: false,
                title: "Forked audit",
                updated_at: "2026-07-20T20:05:00.000Z",
                forked_from: "agent-1",
                chat: true,
            }],
        });
        try {
            const agents = await listAgentsThroughHost(socketPath);
            expect(agents[0]).toEqual({
                archived: false,
                id: "agent-1",
                workspace: "/work/one",
                session_path: "/sessions/agent-1.jsonl",
                kind: "background",
                status: "working",
                live: true,
                title: "Background audit",
                updated_at: "2026-07-20T20:00:00.000Z",
                parent_id: "parent-1",
            });
            expect(agents[1]?.forked_from).toBe("agent-1");
            expect(agents[1]?.chat).toBe(true);
            expect("chat" in agents[0]!).toBe(false);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

socketTest("agent list reports a worker whose router roster misses its deadline", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const root = await mkdtemp(join(tmpdir(), "vera-dev", "hs9-list-slow-"));
    const hostRows = [{
        id: "responsive", workspace: "/work", session_path: "/sessions/responsive.jsonl",
        kind: "interactive" as const, status: "idle" as const, live: true,
    }];
    const hostEndpoint = {
        list: async () => hostRows,
        residents: async () => [],
    } as unknown as SessionEndpoint;
    const stalled = new Promise<never>(() => {});
    const workerEndpoint = {
        list: () => stalled,
        residents: () => stalled,
    } as unknown as SessionEndpoint;
    const router = new HostRouter({
        host: hostEndpoint,
        worker: workerEndpoint,
        hostSocket: join(root, "host.sock"),
        workerSocket: join(root, "worker.sock"),
        buildId: "test",
    });
    const host = await startHostServer({
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        listAgents: () => [],
        listAgentsWithAvailability: () => router.listWithAvailability(),
    });
    try {
        expect(await listAgentPageThroughHost(host.socketPath)).toMatchObject({
            agents: [{ id: "responsive" }], unavailableWorkers: ["w0"],
        });
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

socketTest("agent listing carries unavailable session process ids", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const root = await mkdtemp(join(tmpdir(), "vera-dev", "hs9-list-"));
    const host = await startHostServer({
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        listAgents: () => [],
        readUnavailableWorkers: () => ["w1"],
    });
    try {
        expect(await listAgentPageThroughHost(host.socketPath)).toMatchObject({ agents: [], unavailableWorkers: ["w1"] });
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

socketTest(
    "agent list client rejects an unusable parent id",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-list-parent-"));
        const socketPath = join(root, "host.sock");
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            listAgents: () => [{
                id: "agent-1",
                workspace: "/work/one",
                session_path: "/sessions/agent-1.jsonl",
                kind: "interactive",
                status: "idle",
                live: false,
                // An empty parent threads a row under nothing, so it is a
                // malformed summary rather than a row without a parent.
                forked_from: "",
            } as never],
        });
        try {
            await expect(listAgentsThroughHost(socketPath)).rejects.toThrow(
                "Host returned an invalid agent list",
            );
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

socketTest(
    "agent list client rejects a chat flag that is not true",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-list-chat-"));
        const socketPath = join(root, "host.sock");
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            listAgents: () => [{
                id: "agent-1",
                workspace: "/work/one",
                session_path: "/sessions/agent-1.jsonl",
                kind: "interactive",
                status: "idle",
                live: false,
                chat: false,
            } as never],
        });
        try {
            await expect(listAgentsThroughHost(socketPath)).rejects.toThrow(
                "Host returned an invalid agent list",
            );
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

socketTest(
    "agent listing stops waiting when a host does not answer",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-list-timeout-"));
        const socketPath = join(root, "host.sock");
        const server = createServer((socket) => { socket.resume(); });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });

        try {
            await expect(listAgentsThroughHost(socketPath, 10)).rejects.toThrow(
                "Host agent list deadline exceeded",
            );
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
        }
    },
);
