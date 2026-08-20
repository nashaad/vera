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
import { attachAgent } from "../../src/host/attached-client.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import {
    HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
    HOST_PROTOCOL_VERSION,
    requestHostShutdownForReplacement,
    requestHostShutdownIfIdle,
} from "../../src/host/protocol.ts";
import { UserFacingError } from "../../src/user-facing-error.ts";

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
    "replacement evicts attached clients only when resident work is idle",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        let replaceable = false;
        let accepted = false;
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            canReplace: () => replaceable,
            onShutdownAccepted: () => {
                accepted = true;
            },
        });
        const attached = await connectHost({ socketPath });
        try {
            await attached.send({ type: "attach", agent_id: agent.id });
            await attached.receive();
            await attached.receive();
            expect(await requestHostShutdownForReplacement(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toEqual({
                type: "shutdown_for_replacement_refused",
                reason: "busy",
            });

            replaceable = true;
            expect(await requestHostShutdownForReplacement(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toMatchObject({
                type: "shutdown_for_replacement_accepted",
                pid: server.identity.pid,
            });
            await Bun.sleep(0);
            expect(accepted).toBeTrue();
            await attached.send({ type: "prompt", content: "too late" });
            await expect(attached.receive()).rejects.toThrow();
        } finally {
            attached.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "replacement preserves schedule and extension terminal outcomes",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        let finishSchedule: (() => void) | undefined;
        let finishExtension: (() => void) | undefined;
        const scheduleStarted = Promise.withResolvers<void>();
        const extensionStarted = Promise.withResolvers<void>();
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            canReplace: () => true,
            runScheduleOperation: async () => {
                scheduleStarted.resolve();
                await new Promise<void>((resolve) => {
                    finishSchedule = resolve;
                });
                return { schedule_id: "daily" };
            },
            listExtensionCommands: () => [{
                name: "wait",
                description: "Wait",
                usage: "/wait",
                source: "test.extension",
            }],
            runExtensionCommand: async () => {
                extensionStarted.resolve();
                await new Promise<void>((resolve) => {
                    finishExtension = resolve;
                });
                return {
                    version: 1,
                    source: "test.extension/wait",
                    body: { kind: "text", text: "done" },
                };
            },
        });
        const client = await attachAgent({ socketPath, agentId: agent.id });
        try {
            await client.receive();
            const scheduled = runScheduleOperationThroughHost(socketPath, {
                action: "show",
                id: "daily",
            });
            const extension = client.runExtensionCommand("wait", "");
            await Promise.all([
                scheduleStarted.promise,
                extensionStarted.promise,
            ]);
            expect(await requestHostShutdownForReplacement(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toEqual({
                type: "shutdown_for_replacement_refused",
                reason: "busy",
            });
            finishSchedule?.();
            expect(await scheduled).toEqual({ schedule_id: "daily" });
            expect(await requestHostShutdownForReplacement(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toEqual({
                type: "shutdown_for_replacement_refused",
                reason: "busy",
            });
            finishExtension?.();
            expect(await extension).toMatchObject({
                body: { kind: "text", text: "done" },
            });
            expect(await requestHostShutdownForReplacement(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toMatchObject({
                type: "shutdown_for_replacement_accepted",
                pid: server.identity.pid,
            });
        } finally {
            finishSchedule?.();
            finishExtension?.();
            client.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "replacement proceeds after an extension discovery failure is delivered",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const discoveryStarted = Promise.withResolvers<void>();
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            canReplace: () => true,
            listExtensionCommands: () => {
                discoveryStarted.resolve();
                throw new Error("broken registry");
            },
        });
        const client = await attachAgent({ socketPath, agentId: agent.id });
        try {
            await client.receive();
            const failed = client.runExtensionCommand("wait", "").then(
                () => undefined,
                (error: unknown) => error,
            );
            await discoveryStarted.promise;
            expect(await failed).toMatchObject({
                message: "Extension commands are unavailable",
                reason: "unavailable",
            });
            expect(await requestHostShutdownForReplacement(
                socketPath,
                server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toMatchObject({
                type: "shutdown_for_replacement_accepted",
                pid: server.identity.pid,
            });
        } finally {
            client.close();
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
                minimum_compatible_protocol_version:
                    HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
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
                live: true,
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
                    live: true,
                }],
                total: 1,
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
            createAgent: async (options) => {
                expect(options).toEqual({
                    workspace: "/work/created",
                    approvalMode: "readonly",
                });
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
                    approval_mode: "readonly",
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
        const failures: Array<{
            readonly operation: "create" | "resume";
            readonly error: unknown;
        }> = [];
        const failure = new Error("private failure");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            createAgent: () => Promise.reject(failure),
            onAgentStartFailure: (operation, error) => {
                failures.push({ operation, error });
            },
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
            expect(failures).toEqual([{
                operation: "create",
                error: failure,
            }]);
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
                background_agents: {
                    running: 0,
                    children: [],
                    has_parent: false,
                },
                capabilities: [],
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
    "host reports a lazy attach load failure as unavailable",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => Promise.reject(new Error("corrupt session")),
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: "broken" });
            expect(await connection.receive()).toEqual({
                type: "attach_failed",
                agent_id: "broken",
                reason: "unavailable",
            });
        } finally {
            connection.close();
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

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a startup failure written for a user keeps its words",
    async () => {
        // The generic line is right for internal failures and wrong for this
        // one: a missing credential is something only the user can fix, and the
        // message already says how.
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            createAgent: () =>
                Promise.reject(
                    new UserFacingError(
                        "No credentials for provider openrouter. Connect it from the model pane (ctrl+e).",
                    ),
                ),
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
                reason:
                    "No credentials for provider openrouter. Connect it from the model pane (ctrl+e).",
            });
        } finally {
            connection.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the host pushes background work on attach and on every change",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("main", "/work/one");
        let agents: RegisteredAgentSummary[] = [
            summary({ id: "main", kind: "interactive", status: "idle" }),
        ];
        const listeners = new Set<() => void>();
        const changeRoster = (next: RegisteredAgentSummary[]): void => {
            agents = next;
            for (const listener of listeners) {
                listener();
            }
        };
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: (agentId) => agentId === agent.id ? agent : undefined,
            listAgents: () => agents,
            onRosterChanged: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: "main" });
            expect(await connection.receive()).toMatchObject({
                type: "attached",
                background_agents: {
                    running: 0,
                    children: [],
                    has_parent: false,
                },
            });
            expect(await connection.receive()).toMatchObject({
                type: "history",
            });

            // Spawned.
            changeRoster([
                agents[0]!,
                summary({
                    id: "child",
                    parent_id: "main",
                    title: "research",
                    status: "working",
                }),
            ]);
            expect(await connection.receive()).toEqual({
                type: "background_agents",
                running: 1,
                children: ["research"],
                has_parent: false,
            });

            // A change that says nothing about background work sends nothing,
            // which the next assertion proves by reading the change after it.
            changeRoster([...agents]);

            // Finished its turn.
            changeRoster([
                agents[0]!,
                summary({
                    id: "child",
                    parent_id: "main",
                    title: "research",
                    status: "idle",
                }),
            ]);
            expect(await connection.receive()).toEqual({
                type: "background_agents",
                running: 0,
                children: [],
                has_parent: false,
            });

            // Adopted: the attached session is now somebody's child.
            changeRoster([
                summary({
                    id: "main",
                    kind: "interactive",
                    status: "idle",
                    parent_id: "other",
                }),
            ]);
            expect(await connection.receive()).toEqual({
                type: "background_agents",
                running: 0,
                children: [],
                has_parent: true,
            });

            // Trashed: the parent row went with it.
            changeRoster([
                summary({ id: "main", kind: "interactive", status: "idle" }),
            ]);
            expect(await connection.receive()).toEqual({
                type: "background_agents",
                running: 0,
                children: [],
                has_parent: false,
            });
        } finally {
            connection.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the host stops pushing background work once the client detaches",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("main", "/work/one");
        const listeners = new Set<() => void>();
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: (agentId) => agentId === agent.id ? agent : undefined,
            listAgents: () => [
                summary({ id: "main", kind: "interactive", status: "idle" }),
            ],
            onRosterChanged: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        });
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "attach", agent_id: "main" });
            await connection.receive();
            await connection.receive();
            expect(listeners.size).toBe(1);
            await connection.send({ type: "detach" });
            expect(await connection.receive()).toEqual({ type: "detached" });
            expect(listeners.size).toBe(0);
        } finally {
            connection.close();
            await server.close();
        }
    },
);

function summary(
    fields: {
        readonly id: string;
        readonly status: RegisteredAgentSummary["status"];
        readonly kind?: RegisteredAgentSummary["kind"];
        readonly parent_id?: string;
        readonly title?: string;
    },
): RegisteredAgentSummary {
    return {
        id: fields.id,
        workspace: "/work/one",
        session_path: `/sessions/${fields.id}.jsonl`,
        kind: fields.kind ?? "background",
        status: fields.status,
        live: fields.status === "working" || fields.status === "waiting",
        ...(fields.parent_id === undefined
            ? {}
            : { parent_id: fields.parent_id }),
        ...(fields.title === undefined ? {} : { title: fields.title }),
    };
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host refuses an oversized frame and keeps serving the connection",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            limits: { maxRequestBytes: 1_024 },
        });
        // The client's own guard sits at the default ceiling, so the server's
        // handling of an oversized frame is only reachable past it.
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({
                type: "host_identity",
                pad: "a".repeat(4_096),
            });
            expect(await connection.receive()).toMatchObject({
                type: "protocol_error",
                reason: "frame_too_large",
            });
            expect(connection.closed).toBe(false);
        } finally {
            connection.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host accepts a frame that takes longer than the idle timeout to arrive",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            limits: { requestIdleMs: 100, requestCeilingMs: 10_000 },
        });
        const socket = createConnection(socketPath);
        try {
            const frame = JSON.stringify({ type: "host_identity" });
            const received = new Promise<string>((resolve, reject) => {
                let text = "";
                socket.on("data", (chunk: Buffer) => {
                    text += chunk.toString("utf8");
                    if (text.includes("\n")) resolve(text);
                });
                socket.once("error", reject);
            });
            await new Promise<void>((resolve) =>
                socket.once("connect", resolve)
            );
            // One byte every 50ms: the whole frame takes far longer than the
            // 100ms idle timer, and none of the gaps between bytes does.
            for (const character of `${frame}\n`.split("")) {
                socket.write(character);
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(await received).toContain("host_identity");
        } finally {
            socket.destroy();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host drops a client that dribbles bytes under the idle timeout",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            limits: { requestIdleMs: 200, requestCeilingMs: 400 },
        });
        const socket = createConnection(socketPath);
        let drip: ReturnType<typeof setInterval> | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", () => {
                    socket.write("{\"type\":");
                    drip = setInterval(() => socket.write(" "), 50);
                });
                socket.once("close", resolve);
                socket.once("error", reject);
            });
        } finally {
            clearInterval(drip);
            socket.destroy();
            await server.close();
        }
    },
    3_000,
);
