import { afterEach, expect, test } from "bun:test";
import {
    mkdtempSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

import { createHostLockfile } from "../../src/host/lockfile.ts";
import { connectHost } from "../../src/host/connection.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import {
    HOST_PROTOCOL_VERSION,
    requestHostShutdownIfIdle,
} from "../../src/host/protocol.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "shutdown-if-idle is identity-bound, fences work, and refuses busy hosts",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        let idle = false;
        let shutdownAccepted = false;
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            pid: 101,
            startedAt: "2026-07-17T12:00:00.123Z",
            canShutdown: () => idle,
            onShutdownAccepted: () => {
                shutdownAccepted = true;
            },
        });
        try {
            expect(await requestHostShutdownIfIdle(socketPath, {
                pid: 999,
                started_at: server.identity.started_at,
            })).toEqual({
                type: "shutdown_if_idle_refused",
                reason: "identity_mismatch",
            });
            expect(await requestHostShutdownIfIdle(
                socketPath,
                server.identity,
            )).toEqual({
                type: "shutdown_if_idle_refused",
                reason: "requester_not_newer",
            });
            expect(await requestHostShutdownIfIdle(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toEqual({
                type: "shutdown_if_idle_refused",
                reason: "busy",
            });

            idle = true;
            expect(await requestHostShutdownIfIdle(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toEqual({
                type: "shutdown_if_idle_accepted",
                pid: 101,
                started_at: server.identity.started_at,
            });
            await Bun.sleep(0);
            expect(shutdownAccepted).toBeTrue();

            const blocked = await connectHost({ socketPath });
            try {
                await blocked.send({
                    type: "create_agent",
                    workspace: "/work/blocked",
                });
                await expect(blocked.receive()).rejects.toThrow();
            } finally {
                blocked.close();
            }
        } finally {
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "shutdown-if-idle refuses while a client is attached",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            canShutdown: () => true,
        });
        const attached = await connectHost({ socketPath });
        try {
            await attached.send({ type: "attach", agent_id: agent.id });
            await attached.receive();
            await attached.receive();
            expect(await requestHostShutdownIfIdle(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toEqual({
                type: "shutdown_if_idle_refused",
                reason: "busy",
            });

            await attached.send({ type: "detach" });
            await attached.receive();
            attached.close();
            await Bun.sleep(0);
            expect(await requestHostShutdownIfIdle(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toMatchObject({ type: "shutdown_if_idle_accepted" });
        } finally {
            attached.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host listens privately, publishes its identity, and becomes stale on close",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const lockPath = join(directory, "host.json");
        const lockfile = createHostLockfile({ socketPath, path: lockPath });
        const server = await startHostServer({
            socketPath,
            lockPath,
            pid: 101,
            startedAt: "2026-07-17T12:00:00.123Z",
        });

        try {
            expect(statSync(directory).mode & 0o777).toBe(0o700);
            expect(statSync(socketPath).mode & 0o777).toBe(0o600);
            expect(await lockfile.read()).toEqual(server.lock);
        } finally {
            await server.close();
        }

        expect(await lockfile.read()).toBeUndefined();
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host replaces a stale socket left by an unclean exit",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        writeFileSync(socketPath, "stale socket placeholder");

        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
        });
        try {
            const connection = await connectHost({ socketPath });
            await connection.send({ type: "host_identity" });
            expect(await connection.receive()).toEqual({
                type: "host_identity",
                pid: server.identity.pid,
                started_at: server.identity.started_at,
                protocol_version: HOST_PROTOCOL_VERSION,
            });
            connection.close();
        } finally {
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host reports an invalid attached command before closing",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: agent.id });
            await connection.receive();
            await connection.receive();
            await connection.send({ type: "future_command" });
            expect(await connection.receive()).toEqual({
                type: "protocol_error",
                reason: "unsupported_or_invalid_command",
            });
        } finally {
            connection.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "two concurrent starters produce one live host",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const attempts = await Promise.allSettled([
            startHostServer({
                socketPath,
                lockPath: join(directory, "first.json"),
            }),
            startHostServer({
                socketPath,
                lockPath: join(directory, "second.json"),
            }),
        ]);
        const started = attempts.filter(
            (result) => result.status === "fulfilled",
        );
        expect(attempts.map((result) => result.status).sort()).toEqual([
            "fulfilled",
            "rejected",
        ]);
        if (started[0]?.status !== "fulfilled") {
            throw new Error("Expected one host to start");
        }

        try {
            const connection = await connectHost({ socketPath });
            await connection.send({ type: "host_identity" });
            expect(await connection.receive()).toMatchObject({
                type: "host_identity",
                pid: process.pid,
            });
            connection.close();
        } finally {
            await started[0].value.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host times out incomplete requests",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
        });
        const socket = createConnection(socketPath);
        let drip: ReturnType<typeof setInterval> | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", () => {
                    socket.write("{\"type\":");
                    drip = setInterval(() => socket.write(" "), 100);
                });
                socket.once("close", () => {
                    clearInterval(drip);
                    resolve();
                });
                socket.once("error", reject);
            });
        } finally {
            clearInterval(drip);
            socket.destroy();
            await server.close();
        }
    },
    2_000,
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host lists resident agents without attaching",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            listAgents: () => [{
                id: "agent-1",
                workspace: "/work/one",
                session_path: "/sessions/agent-1.jsonl",
                kind: "background",
                status: "waiting",
            }],
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "list_agents" });
            expect(await connection.receive()).toEqual({
                type: "agent_list",
                agents: [{
                    id: "agent-1",
                    workspace: "/work/one",
                    session_path: "/sessions/agent-1.jsonl",
                    kind: "background",
                    status: "waiting",
                }],
            });
        } finally {
            connection.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host creates and resumes agents through one ready response shape",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const created = new ResidentAgent("created", "/work/created");
        const resumed = new ResidentAgent("resumed", "/work/resumed");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            createAgent: async (workspace) => {
                expect(workspace).toBe("/work/created");
                return created;
            },
            resumeAgent: async (sessionPath) => {
                expect(sessionPath).toBe("/sessions/resumed.jsonl");
                return resumed;
            },
        });
        try {
            const createConnection = await connectHost({ socketPath });
            try {
                await createConnection.send({
                    type: "create_agent",
                    workspace: "/work/created",
                });
                expect(await createConnection.receive()).toEqual({
                    type: "agent_ready",
                    agent_id: "created",
                    workspace: "/work/created",
                });
            } finally {
                createConnection.close();
            }

            const resumeConnection = await connectHost({ socketPath });
            try {
                await resumeConnection.send({
                    type: "resume_agent",
                    session_path: "/sessions/resumed.jsonl",
                });
                expect(await resumeConnection.receive()).toEqual({
                    type: "agent_ready",
                    agent_id: "resumed",
                    workspace: "/work/resumed",
                });
            } finally {
                resumeConnection.close();
            }
        } finally {
            created.close();
            resumed.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host reports an agent startup failure without exposing internals",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            createAgent: () => Promise.reject(new Error("private failure")),
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({
                type: "create_agent",
                workspace: "/missing",
            });
            expect(await connection.receive()).toEqual({
                type: "agent_start_failed",
                operation: "create",
            });
        } finally {
            connection.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host attaches a socket to one resident agent until detach",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: (agentId) => agentId === agent.id ? agent : undefined,
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: agent.id });
            expect(await connection.receive()).toEqual({
                type: "attached",
                agent_id: agent.id,
                workspace: "/work/one",
            });
            expect(await connection.receive()).toEqual({
                type: "history",
                entries: [],
                seq: 0,
            });

            await connection.send({ type: "prompt", content: "hello" });
            expect(await agent.engine.receive()).toEqual({
                type: "prompt",
                content: "hello",
            });
            agent.engine.send({
                type: "assistant_delta",
                text: "hi",
                seq: 1,
            });
            expect(await connection.receive()).toEqual({
                type: "assistant_delta",
                text: "hi",
                seq: 1,
            });

            await connection.send({ type: "detach" });
            expect(await connection.receive()).toEqual({ type: "detached" });
            connection.close();

            const reattached = await connectHost({ socketPath });
            try {
                await reattached.send({
                    type: "attach",
                    agent_id: agent.id,
                });
                expect(await reattached.receive()).toMatchObject({
                    type: "attached",
                    agent_id: agent.id,
                });
                expect(await reattached.receive()).toEqual({
                    type: "history",
                    entries: [],
                    seq: 0,
                });
                expect(await reattached.receive()).toEqual({
                    type: "assistant_delta",
                    text: "hi",
                    seq: 1,
                });
            } finally {
                reattached.close();
            }
        } finally {
            connection.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host routes extension commands privately without forwarding to the engine",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const calls: unknown[] = [];
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: (agentId) => agentId === agent.id ? agent : undefined,
            listExtensionCommands: () => [{
                name: "hello",
                description: "Say hello",
                usage: "/hello [name]",
                source: "test.extension",
            }],
            runExtensionCommand: async (
                name,
                argumentsText,
                workspace,
                signal,
            ) => {
                calls.push({ name, argumentsText, workspace, signal });
                return {
                    version: 1,
                    source: "test.extension/hello",
                    body: { kind: "text", text: `Hello ${argumentsText}` },
                };
            },
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: agent.id });
            await connection.receive();
            await connection.receive();

            await connection.send({
                type: "list_extension_commands",
                request_id: "list-1",
            });
            expect(await connection.receive()).toEqual({
                type: "extension_command_list",
                request_id: "list-1",
                commands: [{
                    name: "hello",
                    description: "Say hello",
                    usage: "/hello [name]",
                    source: "test.extension",
                }],
            });

            await connection.send({
                type: "run_extension_command",
                request_id: "run-1",
                command: "hello",
                arguments_text: "Nash",
            });
            expect(await connection.receive()).toEqual({
                type: "extension_command_result",
                request_id: "run-1",
                result: {
                    version: 1,
                    source: "test.extension/hello",
                    body: { kind: "text", text: "Hello Nash" },
                },
            });
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
                name: "hello",
                argumentsText: "Nash",
                workspace: "/work/one",
            });
        } finally {
            connection.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host keeps an attachment usable when extension discovery fails",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            listExtensionCommands: () => {
                throw new Error("broken registry");
            },
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: agent.id });
            await connection.receive();
            await connection.receive();

            await connection.send({
                type: "list_extension_commands",
                request_id: "list-1",
            });
            expect(await connection.receive()).toEqual({
                type: "extension_command_failed",
                request_id: "list-1",
                failure: {
                    source: "vera.extensions",
                    reason: "unavailable",
                    message: "Extension commands are unavailable",
                },
            });

            await connection.send({ type: "prompt", content: "still here" });
            expect(await agent.engine.receive()).toEqual({
                type: "prompt",
                content: "still here",
            });
        } finally {
            connection.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host disconnects a client that floods extension requests",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const signals: AbortSignal[] = [];
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            listExtensionCommands: () => [],
            runExtensionCommand: (_name, _arguments, _workspace, signal) => {
                signals.push(signal);
                return new Promise(() => undefined);
            },
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: agent.id });
            await connection.receive();
            await connection.receive();

            for (let index = 0; index < 17; index += 1) {
                await connection.send({
                    type: "run_extension_command",
                    request_id: `run-${index}`,
                    command: "wait",
                    arguments_text: "",
                });
            }
            await expect(connection.receive()).rejects.toThrow();
            await Bun.sleep(0);
            expect(signals).toHaveLength(16);
            expect(signals.every((signal) => signal.aborted)).toBeTrue();
        } finally {
            connection.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host rejects an unknown agent without affecting known agents",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: (agentId) => agentId === agent.id ? agent : undefined,
        });
        const missing = await connectHost({ socketPath });
        try {
            await missing.send({ type: "attach", agent_id: "missing" });
            expect(await missing.receive()).toEqual({
                type: "attach_failed",
                agent_id: "missing",
                reason: "not_found",
            });
            missing.close();

            const known = await connectHost({ socketPath });
            try {
                await known.send({ type: "attach", agent_id: agent.id });
                expect(await known.receive()).toMatchObject({
                    type: "attached",
                    workspace: "/work/one",
                });
                await known.receive();
                await known.send({ type: "detach" });
                expect(await known.receive()).toEqual({ type: "detached" });
            } finally {
                known.close();
            }
        } finally {
            missing.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "socket loss detaches the timeline owner",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one", {
            createAttachmentId: () => "owner-a",
        });
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: agent.id });
            await connection.receive();
            await connection.receive();
            connection.close();

            expect(await Promise.race([
                agent.engine.receive(),
                Bun.sleep(500).then(() => ({ type: "timed_out" as const })),
            ])).toEqual({
                type: "timeline_owner_detached",
                ownerId: "owner-a",
            });
        } finally {
            connection.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host reports a closed resident agent as unavailable",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        agent.close();
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: agent.id });
            expect(await connection.receive()).toEqual({
                type: "attach_failed",
                agent_id: agent.id,
                reason: "unavailable",
            });
            connection.close();
        } finally {
            connection.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host disconnects a client that fills an agent command queue",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one", {
            maxPendingCommands: 1,
        });
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: agent.id });
            await connection.receive();
            await connection.receive();
            await connection.send({ type: "prompt", content: "first" });
            await connection.send({ type: "prompt", content: "overflow" });
            await expect(connection.receive()).rejects.toThrow();

            expect(await agent.engine.receive()).toEqual({
                type: "prompt",
                content: "first",
            });
            const survivingClient = agent.attach();
            await survivingClient.receive();
            survivingClient.send({ type: "prompt", content: "still alive" });
            expect(await agent.engine.receive()).toEqual({
                type: "timeline_owner_detached",
                ownerId: expect.any(String),
            });
            expect(await agent.engine.receive()).toEqual({
                type: "prompt",
                content: "still alive",
            });
            survivingClient.detach();
        } finally {
            connection.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "closing an old host does not unlink a replacement socket",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const oldHost = await startHostServer({
            socketPath,
            lockPath: join(directory, "old.json"),
        });
        unlinkSync(socketPath);
        const replacement = createServer();
        await new Promise<void>((resolve, reject) => {
            replacement.once("error", reject);
            replacement.listen(socketPath, resolve);
        });
        try {
            await oldHost.close();
            expect(statSync(socketPath).isSocket()).toBeTrue();
        } finally {
            await new Promise<void>((resolve, reject) => {
                replacement.close((error) => error === undefined
                    ? resolve()
                    : reject(error));
            });
        }
    },
);

function temporaryHostDirectory(): string {
    const directory = mkdtempSync(join("/private/tmp", "vera-host-server-"));
    temporaryDirectories.push(directory);
    return directory;
}
