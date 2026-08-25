import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";
import {
    AgentAttachError,
    attachAgent,
    ExtensionCommandError,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import { NO_BACKGROUND_AGENTS } from "../../src/host/background-agents.ts";
import { HOST_CAPABILITY_AGENT_ATTACH_RESUME } from "../../src/host/capabilities.ts";
import { HOST_CAPABILITY_SKILL_COMMANDS } from "../../src/host/capabilities.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached clients negotiate capabilities on each connection",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: ["agent.branch-options.v1"],
            findAgent: () => agent,
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
            requestedCapabilities: [
                "agent.future.v1",
                "agent.branch-options.v1",
            ],
        });
        try {
            expect(client.capabilities).toEqual(["agent.branch-options.v1"]);
            expect(client.supportsHostCapability("agent.branch-options.v1"))
                .toBe(true);
            expect(client.supportsHostCapability("agent.future.v1"))
                .toBe(false);
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "an old client can attach to a capability-advertising host",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACH_RESUME],
            findAgent: () => agent,
        });
        const oldClient = await attachAgent({
            socketPath,
            agentId: agent.id,
        });
        try {
            expect(oldClient.capabilities).toEqual([]);
            expect((await oldClient.receive()).type).toBe("history");
        } finally {
            oldClient.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "skill authority crosses only the typed attached-client command",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const events = new EngineEventBus();
        events.subscribe(createProtocolEncoder(agent.engine));
        const router = new InboundCommandRouter(agent.engine, events, {
            listSkills: async () => ({
                skills: [{
                    name: "deploy",
                    description: "Deploy the service.",
                    disableModelInvocation: true,
                }],
                warnings: [],
            }),
            invokeSkill: async () => ({ allowed: true }),
        });
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_SKILL_COMMANDS],
            findAgent: () => agent,
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
            requestedCapabilities: [HOST_CAPABILITY_SKILL_COMMANDS],
        });
        try {
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "list_skills", requestId: "skills-1" });
            expect(await client.receive()).toMatchObject({
                type: "skill_catalog",
                requestId: "skills-1",
                skills: [{ name: "deploy" }],
            });

            await client.send({
                type: "invoke_skill",
                requestId: "invoke-1",
                name: "deploy",
                argumentsText: "staging",
            });
            const invokedTurn = router.startTurn();
            expect(await client.receive()).toMatchObject({
                type: "skill_invocation_accepted",
                requestId: "invoke-1",
            });
            const invoked = await invokedTurn;
            expect(invoked.userInvokedSkill).toBe("deploy");
            router.finishTurn();

            await client.send({
                type: "prompt",
                content: "/deploy production",
                userInvokedSkill: "deploy",
            } as unknown as ClientCommand);
            const forged = await router.startTurn();
            expect(forged.userInvokedSkill).toBeUndefined();
            router.finishTurn();
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached clients resume after their last accepted sequence",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_ATTACH_RESUME],
            findAgent: () => agent,
        });
        const first = await attachAgent({
            socketPath,
            agentId: agent.id,
            requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACH_RESUME],
        });
        try {
            expect((await first.receive()).type).toBe("history");
            agent.engine.send({
                type: "assistant_delta",
                text: "first",
                seq: 1,
            });
            agent.engine.send({
                type: "assistant_delta",
                text: "second",
                seq: 2,
            });
            expect(await first.receive()).toMatchObject({ seq: 1 });
            expect(first.lastSequence).toBe(1);
            first.close();

            const resumed = await attachAgent({
                socketPath,
                agentId: agent.id,
                requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACH_RESUME],
                afterSequence: 1,
            });
            try {
                expect(await resumed.receive()).toEqual({
                    type: "assistant_delta",
                    text: "second",
                    seq: 2,
                });
                expect(resumed.lastSequence).toBe(2);
            } finally {
                resumed.close();
            }

            agent.engine.send({
                type: "history",
                entries: [{ kind: "assistant", text: "firstsecond" }],
                seq: 2,
            });
            const rebuilt = await attachAgent({
                socketPath,
                agentId: agent.id,
                requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACH_RESUME],
                afterSequence: 1,
            });
            try {
                expect(await rebuilt.receive()).toMatchObject({
                    type: "history",
                    seq: 2,
                });
            } finally {
                rebuilt.close();
            }

            await expect(attachAgent({
                socketPath,
                agentId: agent.id,
                requestedCapabilities: [],
                afterSequence: 2,
            })).rejects.toMatchObject({ reason: "unavailable" });
            await expect(attachAgent({
                socketPath,
                agentId: agent.id,
                requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACH_RESUME],
                afterSequence: 3,
            })).rejects.toMatchObject({ reason: "unavailable" });
        } finally {
            first.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached clients require negotiated support for a replay cursor",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, []);
        try {
            await expect(attachAgent({
                socketPath,
                agentId: "agent-1",
                requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACH_RESUME],
                afterSequence: 4,
            })).rejects.toThrow("invalid attach response");
        } finally {
            await closeServer(server);
        }
    },
);

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
    "attached client correlates extension replies beside agent updates",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const completions = new Map<
            string,
            (value: {
                version: 1;
                source: string;
                body: { kind: "text"; text: string };
            }) => void
        >();
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            listExtensionCommands: () => [{
                name: "hello",
                description: "Say hello",
                usage: "/hello [name]",
                source: "test.extension",
            }],
            runExtensionCommand: (_name, argumentsText) =>
                new Promise((resolve) => {
                    completions.set(argumentsText, resolve);
                }),
        });
        const client = await attachAgent({ socketPath, agentId: agent.id });
        try {
            expect(await client.receive()).toMatchObject({ type: "history" });
            expect(await client.listExtensionCommands()).toEqual([{
                name: "hello",
                description: "Say hello",
                usage: "/hello [name]",
                source: "test.extension",
            }]);

            const first = client.runExtensionCommand("hello", "first");
            const second = client.runExtensionCommand("hello", "second");
            while (completions.size < 2) {
                await Bun.sleep(1);
            }
            agent.engine.send({
                type: "assistant_delta",
                text: "still streaming",
                seq: 1,
            });
            completions.get("second")?.({
                version: 1,
                source: "test.extension/hello",
                body: { kind: "text", text: "second result" },
            });
            completions.get("first")?.({
                version: 1,
                source: "test.extension/hello",
                body: { kind: "text", text: "first result" },
            });

            expect(await first).toMatchObject({
                body: { text: "first result" },
            });
            expect(await second).toMatchObject({
                body: { text: "second result" },
            });
            expect(await client.receive()).toEqual({
                type: "assistant_delta",
                text: "still streaming",
                seq: 1,
            });
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client returns typed extension failures and remains usable",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            listExtensionCommands: () => [{
                name: "fail",
                description: "Fail once",
                usage: "/fail",
                source: "test.extension",
            }],
            runExtensionCommand: async (_name, argumentsText) => {
                if (argumentsText === "bad") {
                    throw new Error("broken handler");
                }
                if (argumentsText === "blank") {
                    throw new Error(" ");
                }
                return {
                    version: 1,
                    source: "test.extension/fail",
                    body: { kind: "text", text: "recovered" },
                };
            },
        });
        const client = await attachAgent({ socketPath, agentId: agent.id });
        try {
            await client.receive();
            await expect(
                client.runExtensionCommand("fail", "bad"),
            ).rejects.toMatchObject({
                name: ExtensionCommandError.name,
                source: "test.extension/fail",
                reason: "handler_failed",
            });
            await expect(
                client.runExtensionCommand("fail", "blank"),
            ).rejects.toThrow("Extension command failed: handler_failed");
            expect(
                await client.runExtensionCommand("fail", "retry"),
            ).toMatchObject({
                body: { text: "recovered" },
            });
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "extension replies pass a full agent update queue",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            listExtensionCommands: () => [{
                name: "hello",
                description: "Say hello",
                usage: "/hello",
                source: "test.extension",
            }],
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
            maxPendingUpdates: 1,
        });
        try {
            expect(await client.listExtensionCommands()).toHaveLength(1);
            expect(await client.receive()).toMatchObject({ type: "history" });
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "agent updates cannot grow the buffer while a control reply is pending",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            listExtensionCommands: () => [],
            runExtensionCommand: (_name, _arguments, _workspace, signal) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("aborted")),
                        { once: true },
                    );
                }),
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
            maxPendingUpdates: 1,
        });
        try {
            const pending = client.runExtensionCommand("wait", "");
            await Bun.sleep(0);
            agent.engine.send({
                type: "assistant_delta",
                text: "overflow",
                seq: 1,
            });
            await expect(pending).rejects.toThrow(
                "Agent updates exceeded the client buffer",
            );
            expect(client.closed).toBeTrue();
            expect(await client.receive()).toMatchObject({ type: "history" });
            await expect(client.receive()).rejects.toThrow(
                "Agent updates exceeded the client buffer",
            );
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "malformed correlated extension replies reject instead of hanging",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = createServer((socket) => {
            let buffered = "";
            socket.on("data", (chunk: Buffer) => {
                buffered += chunk.toString("utf8");
                while (buffered.includes("\n")) {
                    const newlineAt = buffered.indexOf("\n");
                    const value = JSON.parse(buffered.slice(0, newlineAt)) as {
                        type: string;
                        request_id?: string;
                    };
                    buffered = buffered.slice(newlineAt + 1);
                    if (value.type === "attach") {
                        socket.write(`${JSON.stringify({
                            type: "attached",
                            agent_id: "agent-1",
                            workspace: "/work/one",
                            background_agents: NO_BACKGROUND_AGENTS,
                        })}\n`);
                        socket.write(
                            '{"type":"history","entries":[],"seq":0}\n',
                        );
                    } else if (value.type === "list_extension_commands") {
                        socket.write(`${JSON.stringify({
                            type: "extension_command_list",
                            request_id: value.request_id,
                            commands: [{ name: "INVALID" }],
                        })}\n`);
                    }
                }
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            await client.receive();
            await expect(client.listExtensionCommands()).rejects.toThrow(
                "Host sent an invalid extension response",
            );
            expect(client.closed).toBeTrue();
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client notices disconnect while update delivery is paused",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = createServer((socket) => {
            socket.once("data", () => {
                socket.end(`${JSON.stringify({
                    type: "attached",
                    agent_id: "agent-1",
                    workspace: "/work/one",
                    background_agents: NO_BACKGROUND_AGENTS,
                })}\n{"type":"history","entries":[],"seq":0}\n${
                    JSON.stringify({
                        type: "assistant_delta",
                        text: "final buffered update",
                        seq: 1,
                    })
                }\n`);
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
            while (!client.closed) {
                await Bun.sleep(1);
            }
            expect(await client.receive()).toMatchObject({ type: "history" });
            expect(await client.receive()).toEqual({
                type: "assistant_delta",
                text: "final buffered update",
                seq: 1,
            });
            await expect(client.receive()).rejects.toThrow(
                "host connection closed",
            );
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "detaching rejects a pending extension request",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            listExtensionCommands: () => [],
            runExtensionCommand: (_name, _arguments, _workspace, signal) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("aborted")),
                        { once: true },
                    );
                }),
        });
        const client = await attachAgent({ socketPath, agentId: agent.id });
        try {
            await client.receive();
            const pending = client.runExtensionCommand("wait", "");
            await Bun.sleep(0);
            await client.detach();
            await expect(pending).rejects.toThrow(
                "Agent attachment is detached",
            );
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
                    background_agents: NO_BACKGROUND_AGENTS,
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
    "attached client rejects a checkpoint jump after replay begins",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, [
            { type: "history", entries: [], seq: 4 },
            { type: "assistant_delta", text: "continued", seq: 5 },
            { type: "history", entries: [], seq: 100 },
        ]);
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            expect(await client.receive()).toMatchObject({ seq: 4 });
            expect(await client.receive()).toMatchObject({ seq: 5 });
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
                background_agents: NO_BACKGROUND_AGENTS,
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

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "attached client reads background work from the attach and the pushes after it",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("main", "/work/one");
        const listeners = new Set<() => void>();
        let running = 1;
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            findAgent: () => agent,
            listAgents: () => [
                {
                    id: "main",
                    workspace: "/work/one",
                    session_path: "/sessions/main.jsonl",
                    kind: "interactive",
                    status: "idle",
                    live: true,
                },
                ...(running === 0 ? [] : [{
                    id: "child",
                    workspace: "/work/one",
                    session_path: "/sessions/child.jsonl",
                    kind: "background" as const,
                    status: "working" as const,
                    live: true,
                    parent_id: "main",
                    title: "research",
                }]),
            ],
            onRosterChanged: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        });
        const client = await attachAgent({ socketPath, agentId: agent.id });
        try {
            // Correct before anything changes, not after the first change.
            expect(client.backgroundAgents).toEqual({
                running: 1,
                children: ["research"],
                has_parent: false,
            });

            const seen: unknown[] = [];
            let pushed: () => void = () => undefined;
            const nextPush = new Promise<void>((resolve) => pushed = resolve);
            const stop = client.onBackgroundAgents((agents) => {
                seen.push(agents);
                pushed();
            });
            running = 0;
            for (const listener of listeners) {
                listener();
            }
            await nextPush;
            expect(seen).toEqual([{
                running: 0,
                children: [],
                has_parent: false,
            }]);
            // The update stream still starts at the history checkpoint, so the
            // push travelled beside the agent updates rather than among them.
            expect(await client.receive()).toEqual({
                type: "history",
                entries: [],
                seq: 0,
            });
            expect(client.backgroundAgents).toEqual({
                running: 0,
                children: [],
                has_parent: false,
            });

            stop();
            running = 1;
            for (const listener of listeners) {
                listener();
            }
            agent.engine.send({ type: "status", state: "idle", seq: 1 });
            expect(await client.receive()).toMatchObject({ type: "status" });
            expect(seen).toHaveLength(1);
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);
