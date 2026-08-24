import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachAgent } from "../../src/host/attached-client.ts";
import {
    HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
} from "../../src/host/capabilities.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";

const temporaryDirectories: string[] = [];
let nextClientId = 1;
const socketTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

socketTest(
    "ordinary release keeps a multiply-attached agent and stops the last viewer",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        let closes = 0;
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            findAgent: (agentId) => agentId === agent.id ? agent : undefined,
            closeAgent: async (agentId) => {
                if (agentId !== agent.id) return { status: "not_found" };
                closes += 1;
                agent.close();
                return { status: "closed", sessionRetained: true };
            },
        });
        const first = await interactiveClient(socketPath, agent.id);
        const second = await interactiveClient(socketPath, agent.id);
        try {
            expect((await first.receive()).type).toBe("history");
            expect((await second.receive()).type).toBe("history");

            expect(await first.release?.("stop_if_last")).toEqual({
                outcome: "detached",
                remainingInteractiveClients: 1,
            });
            expect(closes).toBe(0);
            await second.send({ type: "prompt", content: "still here" });
            expect(await agent.engine.receive()).toMatchObject({
                type: "timeline_owner_detached",
            });
            expect(await agent.engine.receive()).toEqual({
                type: "prompt",
                content: "still here",
            });

            expect(await second.release?.("stop_if_last")).toEqual({
                outcome: "stopped",
                remainingInteractiveClients: 0,
                sessionRetained: true,
            });
            expect(closes).toBe(1);
            expect(agent.closed).toBeTrue();
        } finally {
            first.close();
            second.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "simultaneous ordinary releases close exactly once",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        let closes = 0;
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            findAgent: () => agent,
            closeAgent: async () => {
                closes += 1;
                agent.close();
                return { status: "closed", sessionRetained: true };
            },
        });
        const first = await interactiveClient(socketPath, agent.id);
        const second = await interactiveClient(socketPath, agent.id);
        try {
            await first.receive();
            await second.receive();
            const outcomes = await Promise.all([
                first.release?.("stop_if_last"),
                second.release?.("stop_if_last"),
            ]);
            expect(outcomes.map((result) => result?.outcome).sort()).toEqual([
                "detached",
                "stopped",
            ]);
            expect(closes).toBe(1);
        } finally {
            first.close();
            second.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "force release stops the shared agent for every viewer",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        let closes = 0;
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            findAgent: () => agent,
            closeAgent: async () => {
                closes += 1;
                agent.close();
                return { status: "closed", sessionRetained: true };
            },
        });
        const first = await interactiveClient(socketPath, agent.id);
        const second = await interactiveClient(socketPath, agent.id);
        try {
            await first.receive();
            await second.receive();
            expect(await first.release?.("force_stop")).toEqual({
                outcome: "stopped",
                remainingInteractiveClients: 1,
                sessionRetained: true,
            });
            expect(closes).toBe(1);
            await expect(second.receive()).rejects.toThrow();
        } finally {
            first.close();
            second.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "service attachments do not negotiate interactive release",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            findAgent: () => agent,
        });
        const service = await attachAgent({
            socketPath,
            agentId: agent.id,
            requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
        });
        try {
            expect(service.capabilities).toEqual([]);
            await expect(service.release?.("stop_if_last")).rejects.toThrow(
                "Host does not support attachment release",
            );
        } finally {
            await service.detach();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "a child watched by another client defers its root close until that viewer leaves",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const root = new ResidentAgent("root", "/work/one");
        const child = new ResidentAgent("child", "/work/one");
        const closedRoots: string[] = [];
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            findAgent: (agentId) => agentId === root.id ? root
                : agentId === child.id ? child
                : undefined,
            readAgentTree: (agentId) => agentId === root.id
                ? [root.id, child.id]
                : agentId === child.id ? [child.id] : [],
            closeAgent: async (agentId) => {
                closedRoots.push(agentId);
                if (agentId === root.id) {
                    root.close();
                    child.close();
                } else if (agentId === child.id) {
                    child.close();
                }
                return { status: "closed", sessionRetained: true };
            },
        });
        const rootClient = await interactiveClient(
            socketPath,
            root.id,
            "root-viewer",
        );
        const childClient = await interactiveClient(
            socketPath,
            child.id,
            "child-viewer",
        );
        try {
            await rootClient.receive();
            await childClient.receive();
            expect(await rootClient.release?.("stop_if_last")).toMatchObject({
                outcome: "detached",
                remainingInteractiveClients: 1,
            });
            expect(closedRoots).toEqual([]);
            expect(await childClient.release?.("stop_if_last")).toMatchObject({
                outcome: "stopped",
                remainingInteractiveClients: 0,
            });
            expect(closedRoots).toEqual([root.id]);
        } finally {
            rootClient.close();
            childClient.close();
            root.close();
            child.close();
            await server.close();
        }
    },
);

socketTest(
    "the same TUI's preattached child does not veto its root close",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const root = new ResidentAgent("root", "/work/one");
        const child = new ResidentAgent("child", "/work/one");
        const closedRoots: string[] = [];
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            findAgent: (agentId) => agentId === root.id ? root : child,
            readAgentTree: (agentId) => agentId === root.id
                ? [root.id, child.id]
                : [child.id],
            closeAgent: async (agentId) => {
                closedRoots.push(agentId);
                root.close();
                child.close();
                return { status: "closed", sessionRetained: true };
            },
        });
        const rootClient = await interactiveClient(
            socketPath,
            root.id,
            "same-tui",
        );
        const childClient = await interactiveClient(
            socketPath,
            child.id,
            "same-tui",
        );
        try {
            await rootClient.receive();
            await childClient.receive();
            expect(await rootClient.release?.("stop_if_last")).toMatchObject({
                outcome: "stopped",
                remainingInteractiveClients: 0,
            });
            expect(closedRoots).toEqual([root.id]);
            await expect(childClient.receive()).rejects.toThrow();
        } finally {
            rootClient.close();
            childClient.close();
            root.close();
            child.close();
            await server.close();
        }
    },
);

socketTest(
    "explicit keep-running from a child cancels a deferred root stop",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const root = new ResidentAgent("root", "/work/one");
        const child = new ResidentAgent("child", "/work/one");
        const closedRoots: string[] = [];
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            findAgent: (agentId) => agentId === root.id ? root : child,
            readAgentTree: (agentId) => agentId === root.id
                ? [root.id, child.id]
                : [child.id],
            closeAgent: async (agentId) => {
                closedRoots.push(agentId);
                return { status: "closed", sessionRetained: true };
            },
        });
        const rootClient = await interactiveClient(
            socketPath,
            root.id,
            "root-viewer",
        );
        const childClient = await interactiveClient(
            socketPath,
            child.id,
            "child-viewer",
        );
        try {
            await rootClient.receive();
            await childClient.receive();
            expect(await rootClient.release?.("stop_if_last")).toMatchObject({
                outcome: "detached",
            });
            expect(await childClient.release?.("keep_running")).toMatchObject({
                outcome: "detached",
            });
            expect(closedRoots).toEqual([]);
            expect(root.closed).toBeFalse();
            expect(child.closed).toBeFalse();
        } finally {
            rootClient.close();
            childClient.close();
            root.close();
            child.close();
            await server.close();
        }
    },
);

socketTest(
    "an abandoned last viewer closes after the reconnect grace",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        let closes = 0;
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            limits: { interactiveDisconnectGraceMs: 10 },
            findAgent: () => agent,
            closeAgent: async () => {
                closes += 1;
                agent.close();
                return { status: "closed", sessionRetained: true };
            },
        });
        const abandoned = await interactiveClient(socketPath, agent.id);
        try {
            await abandoned.receive();
            abandoned.close();
            await waitFor(() => closes === 1);
            expect(agent.closed).toBeTrue();
        } finally {
            abandoned.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "a reconnect during the grace prevents abandoned-viewer close",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        let closes = 0;
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            limits: { interactiveDisconnectGraceMs: 30 },
            findAgent: () => agent,
            closeAgent: async () => {
                closes += 1;
                agent.close();
                return { status: "closed", sessionRetained: true };
            },
        });
        const first = await interactiveClient(
            socketPath,
            agent.id,
            "reconnecting-client",
        );
        let replacement;
        try {
            await first.receive();
            first.close();
            replacement = await interactiveClient(
                socketPath,
                agent.id,
                "reconnecting-client",
            );
            await replacement.receive();
            await Bun.sleep(60);
            expect(closes).toBe(0);
            await replacement.release?.("stop_if_last");
            expect(closes).toBe(1);
        } finally {
            first.close();
            replacement?.close();
            agent.close();
            await server.close();
        }
    },
);

async function interactiveClient(
    socketPath: string,
    agentId: string,
    clientId = `client-${nextClientId++}`,
) {
    return attachAgent({
        socketPath,
        agentId,
        interactive: true,
        clientId,
        requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
    });
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error("condition was not reached");
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-attachment-release-"));
    temporaryDirectories.push(directory);
    return directory;
}
