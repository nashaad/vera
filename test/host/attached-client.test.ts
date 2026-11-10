import { afterEach, expect } from "bun:test";
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
    HistoryPageRequestError,
    PromptRejectedError,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import { NO_BACKGROUND_AGENTS } from "../../src/host/background-agents.ts";
import {
    HOST_CAPABILITY_AGENT_ATTACH_RESUME,
    HOST_CAPABILITY_AGENT_HISTORY_PAGING,
} from "../../src/host/capabilities.ts";
import { HOST_CAPABILITY_SKILL_COMMANDS } from "../../src/host/capabilities.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import { MAX_FRAME_BYTES } from "../../src/host/connection.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { socketTest } from "../support/socket-probe.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
    "a rejected prompt admission reaches its sender and the attachment stays usable",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({ socketPath, lockPath: join(directory, "host.json"), findAgent: () => agent });
        const client = await attachAgent({ socketPath, agentId: agent.id });
        try {
            await client.receive();
            const sending = client.send({ type: "prompt", content: "check the sails" });
            const command = await agent.engine.receive();
            if (command.type !== "prompt" || command.requestId === undefined) throw new Error("missing prompt request ID");
            agent.engine.send({
                type: "prompt_admission", requestId: command.requestId, content: command.content,
                status: "rejected", reason: "Could not save the queued prompt.", seq: 1,
            });
            const rejection = await sending.catch((error: unknown) => error);
            expect(rejection).toBeInstanceOf(PromptRejectedError);
            expect((rejection as PromptRejectedError).reason).toBe("Could not save the queued prompt.");
            agent.engine.send({ type: "assistant_delta", text: "still connected", seq: 2 });
            expect(await client.receive()).toMatchObject({ type: "assistant_delta", text: "still connected" });
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "a host prompt refusal rejects its sender once with a typed reason",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one", {
            turnStartRefusal: () => "This session is blocked.",
        });
        const server = await startHostServer({ socketPath, lockPath: join(directory, "host.json"), findAgent: () => agent });
        const client = await attachAgent({ socketPath, agentId: agent.id });
        try {
            await client.receive();
            const rejection = await client.send({ type: "prompt", content: "check the sails" }).catch((error: unknown) => error);
            expect(rejection).toBeInstanceOf(PromptRejectedError);
            expect((rejection as PromptRejectedError).reason).toBe("This session is blocked.");
            agent.engine.send({ type: "assistant_delta", text: "still connected", seq: 1 });
            expect(await client.receive()).toMatchObject({ type: "assistant_delta", text: "still connected" });
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
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

            const sending = client.send({ type: "prompt", content: "hello" });
            let acknowledged = false;
            void sending.then(() => { acknowledged = true; });
            const command = await agent.engine.receive();
            await Bun.sleep(10);
            expect(acknowledged).toBe(false);
            if (command.type !== "prompt" || command.requestId === undefined) throw new Error("missing prompt request ID");
            expect(command.content).toBe("hello");
            agent.engine.send({ type: "prompt_admission", requestId: command.requestId, content: command.content, status: "accepted", seq: 1 });
            await sending;
            agent.engine.send({
                type: "assistant_delta",
                text: "hi",
                seq: 2,
            });
            expect(await client.receive()).toEqual({
                type: "assistant_delta",
                text: "hi",
                seq: 2,
            });
            agent.engine.send({
                type: "task_notification",
                deliveryId: "completion:child-1",
                sourceAgentId: "child-1",
                content: "The tests pass.",
                seq: 3,
            });
            expect(await client.receive()).toEqual({
                type: "task_notification",
                deliveryId: "completion:child-1",
                sourceAgentId: "child-1",
                content: "The tests pass.",
                seq: 3,
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

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
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
            const sending = first.send({ type: "prompt", content: "hello" });
            const command = await agent.engine.receive();
            if (command.type !== "prompt" || command.requestId === undefined) throw new Error("missing prompt request ID");
            expect(command.content).toBe("hello");
            agent.engine.send({ type: "prompt_admission", requestId: command.requestId, content: command.content, status: "accepted", seq: 1 });
            await sending;
            const updates = [
                { type: "user_prompt" as const, content: "hello", seq: 2 },
                { type: "assistant_delta" as const, text: "hi", seq: 3 },
                { type: "turn_finished" as const, seq: 4 },
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

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
    "attached history skips unknown entries and rejects malformed known entries",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const reasoning = { kind: "reasoning", text: "follow the stars" } as const;
        const server = await scriptedHost(socketPath, [
            { type: "history", entries: [{ kind: "future", text: "ignored" }, reasoning], seq: 0 },
            { type: "history", entries: [{ kind: "reasoning", text: 12 }], seq: 0 },
        ]);
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            expect(await client.receive()).toEqual({ type: "history", entries: [reasoning], seq: 0 });
            await expect(client.receive()).rejects.toThrow("Host sent an invalid agent update");
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
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

socketTest(
    "attached client skips an unknown update type and keeps its sequence",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, [
            { type: "history", entries: [], seq: 4 },
            { type: "assistant_delta", text: "before", seq: 5 },
            { type: "future_update", payload: { value: 1 }, seq: 6 },
            { type: "assistant_delta", text: "after", seq: 7 },
        ]);
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            expect(await client.receive()).toMatchObject({ type: "history", seq: 4 });
            expect(await client.receive()).toMatchObject({ type: "assistant_delta", seq: 5 });
            expect(await client.receive()).toMatchObject({ type: "assistant_delta", seq: 7 });
            expect(client.closed).toBe(false);
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

socketTest(
    "attached client skips an unknown update type without a sequence",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, [
            { type: "history", entries: [], seq: 4 },
            { type: "future_update", seq: "not a sequence" },
            { type: "assistant_delta", text: "next", seq: 5 },
        ]);
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            expect(await client.receive()).toMatchObject({ type: "history", seq: 4 });
            expect(await client.receive()).toMatchObject({ type: "assistant_delta", seq: 5 });
            expect(client.closed).toBe(false);
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

socketTest(
    "attached client rejects a gap after a skipped unknown update",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, [
            { type: "history", entries: [], seq: 4 },
            { type: "future_update", seq: 5 },
            { type: "assistant_delta", text: "gap", seq: 7 },
        ]);
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            expect(await client.receive()).toMatchObject({ type: "history", seq: 4 });
            await expect(client.receive()).rejects.toThrow(
                "Host sent a non-contiguous agent update sequence",
            );
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

socketTest(
    "attached client requires history before a sequenced unknown update",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, [
            { type: "future_update", seq: 1 },
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

socketTest(
    "attached client still rejects a known update with an invalid shape",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, [
            { type: "history", entries: [], seq: 4 },
            { type: "future_update", seq: 5 },
            { type: "assistant_delta", seq: 6 },
        ]);
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            expect(await client.receive()).toMatchObject({ type: "history", seq: 4 });
            await expect(client.receive()).rejects.toThrow(
                "Host sent an invalid agent update",
            );
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

socketTest(
    "a skipped unknown update does not move lastSequence past buffered known updates",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await scriptedHost(socketPath, [
            { type: "history", entries: [], seq: 4 },
            { type: "assistant_delta", text: "buffered", seq: 5 },
            { type: "future_update", seq: 6 },
        ]);
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            await Bun.sleep(10);
            expect(client.lastSequence).toBeUndefined();
            expect(await client.receive()).toMatchObject({ type: "history", seq: 4 });
            expect(client.lastSequence).toBe(4);
            expect(await client.receive()).toMatchObject({ type: "assistant_delta", seq: 5 });
            expect(client.lastSequence).toBe(5);
            expect(client.closed).toBe(false);
        } finally {
            client.close();
            await closeServer(server);
        }
    },
);

socketTest(
    "a skipped unknown update advances lastSequence when nothing is buffered",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const server = createServer((socket) => {
            socket.on("error", () => undefined);
            let late: ReturnType<typeof setTimeout> | undefined;
            socket.once("data", () => {
                socket.write(`${JSON.stringify({
                    type: "attached",
                    agent_id: "agent-1",
                    workspace: "/work/one",
                    background_agents: NO_BACKGROUND_AGENTS,
                })}\n`);
                socket.write(`${JSON.stringify({ type: "history", entries: [], seq: 4 })}\n`);
                socket.write(`${JSON.stringify({ type: "assistant_delta", text: "drained", seq: 5 })}\n`);
                late = setTimeout(() => {
                    socket.write(`${JSON.stringify({ type: "future_update", seq: 6 })}\n`);
                }, 50);
            });
            socket.on("close", () => clearTimeout(late));
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            expect(await client.receive()).toMatchObject({ type: "history", seq: 4 });
            expect(await client.receive()).toMatchObject({ type: "assistant_delta", seq: 5 });
            await Bun.sleep(100);
            expect(client.lastSequence).toBe(6);
            expect(client.closed).toBe(false);
        } finally {
            client.close();
            await closeServer(server);
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
    updates: readonly unknown[],
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

socketTest(
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

socketTest(
    "attached client exposes the session scratch directory when the host sends one",
    async () => {
        for (const scratch of ["/tmp/vera/agent-1", undefined]) {
            const directory = temporaryDirectory();
            const socketPath = join(directory, "host.sock");
            const server = createServer((socket) => {
                socket.once("data", () => {
                    socket.write(`${JSON.stringify({
                        type: "attached",
                        agent_id: "agent-1",
                        workspace: "/work/one",
                        ...(scratch === undefined ? {} : { scratch_directory: scratch }),
                        background_agents: NO_BACKGROUND_AGENTS,
                    })}\n{"type":"history","entries":[],"seq":0}\n`);
                });
            });
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(socketPath, resolve);
            });
            const client = await attachAgent({ socketPath, agentId: "agent-1" });
            try {
                expect(client.scratchDirectory).toBe(scratch);
            } finally {
                client.close();
                await closeServer(server);
            }
        }
    },
);

socketTest(
    "an attach without an explicit limit keeps the 64 MiB frame ceiling",
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
                socket.write(`${JSON.stringify({
                    type: "history",
                    entries: [],
                    pad: "a".repeat(MAX_FRAME_BYTES),
                    seq: 0,
                })}\n`);
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        const client = await attachAgent({ socketPath, agentId: "agent-1" });
        try {
            await expect(client.receive()).rejects.toThrow(
                `limit ${MAX_FRAME_BYTES})`,
            );
        } finally {
            client.close();
            await closeServer(server);
        }
    },
    60_000,
);

function transcriptEntries(count: number): readonly {
    readonly kind: "assistant";
    readonly id: string;
    readonly text: string;
}[] {
    return Array.from({ length: count }, (_, index) => ({
        kind: "assistant" as const,
        id: `message-${index}#0`,
        text: `message ${index}`,
    }));
}

socketTest(
    "a paging client reads older pages without advancing its sequence",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        agent.engine.send({
            type: "history",
            entries: transcriptEntries(500),
            seq: 0,
        });
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
            findAgent: () => agent,
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
            requestedCapabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
        });
        try {
            expect(client.supportsHostCapability(
                HOST_CAPABILITY_AGENT_HISTORY_PAGING,
            )).toBe(true);
            const tail = await client.receive();
            if (tail.type !== "history") throw new Error("expected history");
            expect(tail.entries).toHaveLength(240);
            expect(client.lastSequence).toBe(0);

            const page = await client.requestHistoryPage(
                tail.page!.olderBefore!,
            );
            expect(page.type).toBe("history_page");
            expect(page.before).toBe("message-260#0");
            expect(page.entries).toHaveLength(240);
            expect(page.entries[0]!.id).toBe("message-20#0");
            expect(client.lastSequence).toBe(0);

            agent.engine.send({
                type: "assistant_delta",
                text: "next",
                seq: 1,
            });
            expect(await client.receive()).toMatchObject({
                type: "assistant_delta",
                seq: 1,
            });
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "a page request without the negotiated capability is refused",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
            findAgent: () => agent,
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
        });
        try {
            await client.receive();
            await expect(client.requestHistoryPage("message-0#0")).rejects
                .toThrow("does not support history paging");
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "only one page request may be in flight",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fallback = {
            kind: "page" as const,
            entries: [{
                kind: "reasoning" as const,
                id: "older#r0",
                text: "follow the stars",
            }, {
                kind: "assistant" as const,
                id: "older#0",
                text: "older",
            }],
            page: {
                pageVersion: 1,
                hasMore: false,
                headId: "message-0",
                tailId: "older#0",
            },
        };
        const agent = new ResidentAgent("agent-1", "/work/one", {
            historyPageSource: async () => {
                calls += 1;
                await gate;
                return fallback;
            },
        });
        agent.engine.send({
            type: "history",
            entries: transcriptEntries(1),
            seq: 0,
        });
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
            findAgent: () => agent,
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
            requestedCapabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
        });
        try {
            await client.receive();
            const first = client.requestHistoryPage("outside#0");
            await expect(client.requestHistoryPage("outside#0")).rejects
                .toThrow("already pending");
            const deadline = Date.now() + 2_000;
            while (calls < 1 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            expect(calls).toBe(1);
            release();
            await expect(first).resolves.toMatchObject({
                type: "history_page",
                before: "outside#0",
                entries: [{ kind: "reasoning", id: "older#r0", text: "follow the stars" }, { id: "older#0" }],
            });
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "an aborted page request ignores its late reply and can be retried",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fallback = {
            kind: "page" as const,
            entries: [{
                kind: "assistant" as const,
                id: "older#0",
                text: "older",
            }],
            page: {
                pageVersion: 1,
                hasMore: false,
                headId: "message-0",
                tailId: "older#0",
            },
        };
        const agent = new ResidentAgent("agent-1", "/work/one", {
            historyPageSource: async () => {
                calls += 1;
                await gate;
                return fallback;
            },
        });
        agent.engine.send({
            type: "history",
            entries: transcriptEntries(1),
            seq: 0,
        });
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
            findAgent: () => agent,
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
            requestedCapabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
        });
        try {
            await client.receive();
            const controller = new AbortController();
            const aborted = client.requestHistoryPage(
                "outside#0",
                controller.signal,
            );
            controller.abort();
            await expect(aborted).rejects.toThrow("aborted");
            const deadline = Date.now() + 2_000;
            while (calls < 1 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            release();
            agent.engine.send({
                type: "assistant_delta",
                text: "next",
                seq: 1,
            });
            expect(await client.receive()).toMatchObject({ seq: 1 });
            expect(client.closed).toBe(false);

            const retried = await client.requestHistoryPage("outside#0");
            expect(retried.entries[0]!.id).toBe("older#0");
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "a pending page request rejects on close and a new attachment retries",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fallback = {
            kind: "page" as const,
            entries: [{
                kind: "assistant" as const,
                id: "older#0",
                text: "older",
            }],
            page: {
                pageVersion: 1,
                hasMore: false,
                headId: "message-0",
                tailId: "older#0",
            },
        };
        const agent = new ResidentAgent("agent-1", "/work/one", {
            historyPageSource: async () => {
                await gate;
                return fallback;
            },
        });
        agent.engine.send({
            type: "history",
            entries: transcriptEntries(1),
            seq: 0,
        });
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
            findAgent: () => agent,
        });
        const first = await attachAgent({
            socketPath,
            agentId: agent.id,
            requestedCapabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
        });
        try {
            await first.receive();
            const pending = first.requestHistoryPage("outside#0");
            first.close();
            await expect(pending).rejects.toThrow("closed");
            release();

            const second = await attachAgent({
                socketPath,
                agentId: agent.id,
                requestedCapabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
            });
            try {
                await second.receive();
                const page = await second.requestHistoryPage("outside#0");
                expect(page.entries[0]!.id).toBe("older#0");
            } finally {
                second.close();
            }
        } finally {
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "a refused page rejects with the host's reason",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one", {
            historyPageSource: (before) => before === "huge#0"
                ? { kind: "page_too_large" }
                : { kind: "cursor_not_found" },
        });
        agent.engine.send({
            type: "history",
            entries: transcriptEntries(1),
            seq: 0,
        });
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
            findAgent: () => agent,
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
            requestedCapabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
        });
        try {
            await client.receive();
            const tooLarge = await client.requestHistoryPage("huge#0").then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(tooLarge).toBeInstanceOf(HistoryPageRequestError);
            expect(tooLarge).toMatchObject({ reason: "page_too_large" });

            const missing = await client.requestHistoryPage("missing#0").then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(missing).toMatchObject({ reason: "cursor_not_found" });
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);

socketTest(
    "a page response does not count toward the pending update limit",
    async () => {
        const directory = temporaryDirectory();
        const socketPath = join(directory, "host.sock");
        const agent = new ResidentAgent("agent-1", "/work/one", {
            historyPageSource: async () => ({
                kind: "page",
                entries: [{
                    kind: "assistant",
                    id: "older#0",
                    text: "older",
                }],
                page: {
                    pageVersion: 1,
                    hasMore: false,
                    headId: "message-0",
                    tailId: "older#0",
                },
            }),
        });
        agent.engine.send({
            type: "history",
            entries: transcriptEntries(1),
            seq: 0,
        });
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
            findAgent: () => agent,
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
            maxPendingUpdates: 2,
            requestedCapabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
        });
        try {
            await client.receive();
            agent.engine.send({
                type: "assistant_delta",
                text: "one",
                seq: 1,
            });
            await new Promise((resolve) => setTimeout(resolve, 25));
            await expect(client.requestHistoryPage("outside#0"))
                .resolves.toMatchObject({ before: "outside#0" });

            agent.engine.send({
                type: "assistant_delta",
                text: "two",
                seq: 2,
            });
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(await client.receive()).toMatchObject({ seq: 1 });
            expect(await client.receive()).toMatchObject({ seq: 2 });
            expect(client.closed).toBe(false);
        } finally {
            client.close();
            agent.close();
            await server.close();
        }
    },
);
