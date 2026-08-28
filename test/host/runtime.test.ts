import { expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectHost } from "../../src/host/connection.ts";
import {
    AgentAttachError,
    attachAgent,
} from "../../src/host/attached-client.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import {
    AgentStartError,
    createAgentThroughHost,
    resumeAgentThroughHost,
} from "../../src/host/agent-start-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { searchSessionsThroughHost } from
    "../../src/host/session-search-client.ts";
import { loadVeraConfig } from "../../src/config.ts";
import {
    HOST_PROTOCOL_VERSION,
    requestHostIdentity,
    requestHostShutdownForReplacement,
    requestHostShutdownIfIdle,
} from "../../src/host/protocol.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import type { HostLogEntry } from "../../src/host/host-log.ts";
import {
    HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
} from "../../src/host/capabilities.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "hard close through the resident host retains a resumable session",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-close-resume-"));
        const socketPath = join(root, "host.sock");
        const sessionDirectory = join(root, "sessions");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
        });

        try {
            const created = await createAgentThroughHost(socketPath, root);
            const listed = (await listAgentsThroughHost(socketPath)).find(
                (agent) => agent.id === created.id,
            );
            expect(listed?.session_path).toBeDefined();
            expect(listed?.name).toMatch(/^[a-z0-9-]+:[0-9a-f]{4}$/);
            const identity = listed!.name!;

            expect(await closeAgentThroughHost(socketPath, created.id))
                .toEqual({ status: "closed", sessionRetained: true });
            expect(host.registry.find(created.id)).toBeUndefined();
            expect(
                (await listAgentsThroughHost(socketPath)).find(
                    (agent) => agent.id === created.id,
                ),
            ).toMatchObject({ id: created.id, live: false });

            const stored = await SessionStore.open(listed!.session_path);
            expect(stored.header.id).toBe(created.id);
            expect(stored.identity()?.name).toBe(identity);
            expect(await resumeAgentThroughHost(socketPath, listed!.session_path))
                .toMatchObject({ id: created.id });
            expect(
                (await listAgentsThroughHost(socketPath)).find(
                    (agent) => agent.id === created.id,
                )?.name,
            ).toBe(identity);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the last interactive release retains and resumes the real session",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-release-resume-"));
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
        });

        try {
            const created = await createAgentThroughHost(socketPath, root);
            const listed = (await listAgentsThroughHost(socketPath)).find(
                (agent) => agent.id === created.id,
            );
            const attach = (clientId: string) => attachAgent({
                socketPath,
                agentId: created.id,
                interactive: true,
                clientId,
                requestedCapabilities: [
                    HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
                ],
            });
            const first = await attach("client-1");
            const second = await attach("client-2");
            await first.receive();
            await second.receive();

            expect(await first.release?.("stop_if_last")).toMatchObject({
                outcome: "detached",
                remainingInteractiveClients: 1,
            });
            expect(host.registry.find(created.id)).toBeDefined();
            expect(await second.release?.("stop_if_last")).toMatchObject({
                outcome: "stopped",
                remainingInteractiveClients: 0,
                sessionRetained: true,
            });
            expect(host.registry.find(created.id)).toBeUndefined();

            const stored = await SessionStore.open(listed!.session_path);
            expect(stored.header.id).toBe(created.id);
            expect(await resumeAgentThroughHost(socketPath, listed!.session_path))
                .toMatchObject({ id: created.id });
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resume finds a live agent through a symlinked session directory",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-resume-alias-"));
        const realSessions = join(root, "real-sessions");
        const sessionDirectory = join(root, "sessions");
        await mkdir(realSessions);
        await symlink(realSessions, sessionDirectory, "dir");
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
        });
        try {
            const created = await createAgentThroughHost(socketPath, root);
            const summary = host.registry.list().find((agent) =>
                agent.id === created.id
            );
            expect(summary?.session_path.startsWith(sessionDirectory)).toBeTrue();
            expect(
                await resumeAgentThroughHost(
                    socketPath,
                    summary?.session_path as string,
                ),
            ).toEqual(created);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host reports startup phase timings through readiness",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-startup-timing-"));
        const entries: HostLogEntry[] = [];
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
            permissionPreferencesPath: join(root, "preferences.json"),
            startupLog: (entry) => entries.push(entry),
        });
        try {
            expect(entries.filter((entry) =>
                entry.type === "host_startup_phase"
            ).map((entry) => entry.phase)).toEqual([
                "model_discovery",
                "permission_preferences",
                "extension_registry",
                "scheduler",
                "server_listen_and_lockfile",
            ]);
            expect(entries.at(-1)).toMatchObject({
                type: "host_startup_complete",
            });
            expect(entries.every((entry) =>
                typeof entry.duration_ms !== "number"
                || entry.duration_ms >= 0
            )).toBeTrue();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a removed workspace reaches the startup client as the reason",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-missing-cwd-"));
        const missing = join(root, "removed-worktree");
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            await expect(createAgentThroughHost(socketPath, missing))
                .rejects.toMatchObject({
                    name: AgentStartError.name,
                    operation: "create",
                    message: `Session workspace is unavailable: ${missing}`,
                });
            expect(await listAgentsThroughHost(socketPath)).toEqual([]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "an accepted idle shutdown closes that exact resident host",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-shutdown-"));
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            expect(await requestHostShutdownIfIdle(
                socketPath,
                host.server.identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toMatchObject({
                type: "shutdown_if_idle_accepted",
                pid: host.server.identity.pid,
                started_at: host.server.identity.started_at,
            });

            const deadline = Date.now() + 1_000;
            while (await requestHostIdentity(socketPath) !== undefined) {
                if (Date.now() >= deadline) {
                    throw new Error("Accepted resident host did not shut down");
                }
                await Bun.sleep(10);
            }
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "an idle attached durable session survives graceful host replacement",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-replacement-"));
        const workspace = await realpath(root);
        const socketPath = join(root, "host.sock");
        const lockPath = join(root, "host.json");
        const sessionDirectory = join(root, "sessions");
        const sessionPath = join(sessionDirectory, "agent.jsonl");
        const config = {
            schema_version: 1 as const,
            provider: "openrouter" as const,
            model: "faux/test",
            approval_mode: "auto" as const,
        };
        let responses = [textResponse("before replacement")];
        const start = () => startResidentHost({
            config,
            createAdapter: () => new FauxAdapter(responses),
            socketPath,
            lockPath,
            sessionDirectory,
        });
        let host = await start();
        try {
            await host.registry.create({
                id: "durable-agent",
                workspace,
                sessionPath,
            });
            const client = await attachReconnectingAgent({
                socketPath: () => socketPath,
                agentId: "durable-agent",
            });
            try {
                await client.receive();
                await client.send({ type: "prompt", content: "first" });
                await receiveUntilType(client, "turn_finished");

                const waiting = receiveUntilType(client, "user_prompt");
                expect(await requestHostShutdownForReplacement(
                    socketPath,
                    host.server.identity,
                    HOST_PROTOCOL_VERSION + 1,
                )).toMatchObject({
                    type: "shutdown_for_replacement_accepted",
                });
                const deadline = Date.now() + 1_000;
                while (await requestHostIdentity(socketPath) !== undefined) {
                    if (Date.now() >= deadline) {
                        throw new Error("Replaced resident host did not stop");
                    }
                    await Bun.sleep(5);
                }
                // A cold replacement may take longer than the old three-attempt,
                // 100 ms reconnect window.
                await Bun.sleep(250);
                responses = [textResponse("after replacement")];
                host = await start();
                await Bun.sleep(60);
                await client.send({ type: "prompt", content: "second" });
                await waiting;
                await receiveUntilType(client, "turn_finished");

                const fresh = await attachAgent({
                    socketPath,
                    agentId: "durable-agent",
                });
                try {
                    expect(await fresh.receive()).toMatchObject({
                        type: "history",
                        entries: [
                            { kind: "user", text: "first" },
                            { kind: "assistant", text: "before replacement" },
                            { kind: "user", text: "second" },
                            { kind: "assistant", text: "after replacement" },
                        ],
                    });
                } finally {
                    fresh.close();
                }
            } finally {
                client.close();
            }
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host wires public extension tool hooks into each agent",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-extension-hook-"));
        const extensionPath = join(root, "extension");
        await mkdir(extensionPath);
        await writeFile(
            join(extensionPath, "vera.extension.json"),
            JSON.stringify({
                id: "test.hook",
                version: "1.0.0",
                sdk: "1",
                entrypoint: "./extension.ts",
                capabilities: ["hooks.pre_tool_use"],
            }),
        );
        await writeFile(join(extensionPath, "extension.ts"), `
            export function activate(vera) {
                vera.hooks.registerPreToolUse((payload) =>
                    payload.toolCall.name === "read"
                        ? { power: "block", reason: "extension policy" }
                        : { power: "observe" }
                );
            }
        `);
        const sessionPath = join(root, "agent.jsonl");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "full_access",
                extensions: [{ path: extensionPath, enabled: true, config: null }],
            },
            createAdapter: () => new FauxAdapter([
                toolResponse("read", { path: "missing.txt" }),
                textResponse("done"),
            ]),
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            const agent = await host.registry.create({
                id: "hook-agent",
                workspace: root,
                sessionPath,
                eventLogPath: join(root, "events.jsonl"),
            });
            const client = agent.attach();
            await client.receive();
            client.send({ type: "prompt", content: "read the file" });
            await receiveUntilType(client, "turn_finished");
            expect((await SessionStore.open(sessionPath)).messages())
                .toContainEqual(expect.objectContaining({
                    role: "tool_result",
                    toolName: "read",
                    isError: true,
                    content: [{
                        type: "text",
                        text: expect.stringContaining("extension policy"),
                    }],
                }));
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host runs the hooks the config points at",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-config-hook-"));
        const profile = join(root, "profile");
        await mkdir(join(profile, "hooks"), { recursive: true });
        const script = join(profile, "hooks", "deny-read.ts");
        await writeFile(script, `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
    power: "block",
    reason: "hooks directory policy",
}));
`);
        await chmod(script, 0o755);
        const configPath = join(profile, "config.json");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            model: "faux/test",
            approval_mode: "full_access",
            hooks: [{
                phase: "pre_tool_use",
                argv: ["deny-read.ts"],
                timeout_ms: 20_000,
            }],
        }));

        // The config is loaded the way the CLI loads it, so the test proves the
        // whole door: the file names a script, the loader binds it to the
        // profile's hooks directory, and the host runs it on a real tool call.
        const sessionPath = join(root, "agent.jsonl");
        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            createAdapter: () => new FauxAdapter([
                toolResponse("read", { path: "missing.txt" }),
                textResponse("done"),
            ]),
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            const agent = await host.registry.create({
                id: "config-hook-agent",
                workspace: root,
                sessionPath,
                eventLogPath: join(root, "events.jsonl"),
            });
            const client = agent.attach();
            await client.receive();
            client.send({ type: "prompt", content: "read the file" });
            await receiveUntilType(client, "turn_finished");
            expect((await SessionStore.open(sessionPath)).messages())
                .toContainEqual(expect.objectContaining({
                    role: "tool_result",
                    toolName: "read",
                    isError: true,
                    content: [{
                        type: "text",
                        text: expect.stringContaining("hooks directory policy"),
                    }],
                }));
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host wires its registry to list and attach requests",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-runtime-"));
        const workspace = await realpath(root);
        const socketPath = join(root, "host.sock");
        const sessionDirectory = join(root, "sessions");
        const sessionPath = join(root, "agent.jsonl");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([textResponse("hello")]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
        });

        try {
            await host.registry.create({
                id: "agent-1",
                workspace: root,
                sessionPath,
                eventLogPath: join(root, "events.jsonl"),
            });
            const resumedSessionPath = join(root, "resumed.jsonl");
            await SessionStore.create(resumedSessionPath, {
                sessionId: "resumed-agent",
                cwd: workspace,
            });
            const resume = await connectHost({ socketPath });
            try {
                await resume.send({
                    type: "resume_agent",
                    session_path: resumedSessionPath,
                });
                expect(await resume.receive()).toEqual({
                    type: "agent_ready",
                    agent_id: "resumed-agent",
                    workspace,
                });
            } finally {
                resume.close();
            }

            const listing = await connectHost({ socketPath });
            try {
                await listing.send({ type: "list_agents" });
                expect(await listing.receive()).toMatchObject({
                    type: "agent_list",
                    agents: [
                        { id: "agent-1", status: "idle" },
                        { id: "resumed-agent", status: "idle" },
                    ],
                });
            } finally {
                listing.close();
            }

            const attached = await connectHost({ socketPath });
            try {
                await attached.send({ type: "attach", agent_id: "agent-1" });
                expect(await attached.receive()).toMatchObject({
                    type: "attached",
                    agent_id: "agent-1",
                });
                expect(messageType(await attached.receive())).toBe("history");
                await attached.send({ type: "prompt", content: "hi" });
                while (messageType(await attached.receive()) !== "turn_finished") {
                    // Drain the attached update stream to the turn boundary.
                }
            } finally {
                attached.close();
            }

            const stored = await SessionStore.open(sessionPath);
            expect(stored.messages().map((message) => message.role)).toEqual([
                "user",
                "assistant",
            ]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host loads and routes a configured extension command",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-extension-"));
        const workspace = await realpath(root);
        const extensionPath = join(root, "extension");
        await mkdir(extensionPath);
        await writeFile(
            join(extensionPath, "vera.extension.json"),
            JSON.stringify({
                id: "test.extension",
                version: "1.0.0",
                sdk: "1",
                entrypoint: "./extension.ts",
                capabilities: ["commands.register"],
            }),
        );
        await writeFile(join(extensionPath, "extension.ts"), `
            export function activate(vera) {
                vera.commands.register({
                    name: "where",
                    description: "Show workspace",
                    usage: "/where",
                    run({ workspace }) {
                        return { kind: "text", text: workspace };
                    },
                });
            }
        `);
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
                extensions: [{
                    path: extensionPath,
                    enabled: true,
                    config: null,
                }],
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        const agent = await host.registry.create({
            id: "agent-1",
            workspace,
            sessionPath: join(root, "agent.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
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
            expect(await connection.receive()).toMatchObject({
                type: "extension_command_list",
                commands: [{ name: "where", source: "test.extension" }],
            });
            await connection.send({
                type: "run_extension_command",
                request_id: "run-1",
                command: "where",
                arguments_text: "",
            });
            expect(await connection.receive()).toEqual({
                type: "extension_command_result",
                request_id: "run-1",
                result: {
                    version: 1,
                    source: "test.extension/where",
                    body: { kind: "text", text: workspace },
                },
            });
        } finally {
            connection.close();
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host exposes a configured extension tool to the model loop",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-extension-tool-"));
        const extensionPath = join(root, "extension");
        await mkdir(extensionPath);
        await writeFile(
            join(extensionPath, "vera.extension.json"),
            JSON.stringify({
                id: "test.search",
                version: "1.0.0",
                sdk: "1",
                entrypoint: "./extension.ts",
                capabilities: ["tools.register"],
            }),
        );
        await writeFile(join(extensionPath, "extension.ts"), `
            export function activate(vera) {
                vera.tools.register({
                    name: "web_search",
                    description: "Search",
                    inputSchema: {
                        type: "object",
                        properties: { query: { type: "string" } },
                        required: ["query"],
                        additionalProperties: false,
                    },
                    permissionOperation: "web.search",
                    run({ input }) {
                        return { output: "result:" + input.query };
                    },
                });
            }
        `);
        const sessionPath = join(root, "agent.jsonl");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "full_access",
                extensions: [{
                    path: extensionPath,
                    enabled: true,
                    config: null,
                }],
            },
            createAdapter: () => new FauxAdapter([
                toolResponse("web_search", { query: "dag" }),
                textResponse("done"),
            ]),
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });

        try {
            const agent = await host.registry.create({
                id: "agent-1",
                workspace: root,
                sessionPath,
                eventLogPath: join(root, "events.jsonl"),
            });
            const client = agent.attach();
            await client.receive();
            client.send({ type: "prompt", content: "search for dag" });
            await receiveUntilType(client, "turn_finished");

            const stored = await SessionStore.open(sessionPath);
            expect(stored.messages()).toContainEqual(expect.objectContaining({
                role: "tool_result",
                toolName: "web_search",
                isError: false,
                content: [{ type: "text", text: "result:dag" }],
            }));
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident rewind stays attached across the Unix socket",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-rewind-"));
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([
                textResponse("first answer"),
                textResponse("second answer"),
            ]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        const agent = await host.registry.create({
            id: "rewind-agent",
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
        });
        const client = await attachAgent({
            socketPath,
            agentId: agent.id,
        });

        try {
            expect((await client.receive()).type).toBe("history");
            for (const prompt of ["first request", "second request"]) {
                await client.send({ type: "prompt", content: prompt });
                await receiveUntilType(client, "turn_finished");
                await receiveUntilType(client, "history");
            }

            await client.send({
                type: "list_timeline",
                requestId: "list-1",
            });
            const timeline = await client.receive();
            if (timeline.type !== "timeline") {
                throw new Error("Expected timeline reply");
            }
            const boundary = timeline.boundaries.find(
                (candidate) => candidate.prompt === "second request",
            );
            if (boundary === undefined) {
                throw new Error("Expected second timeline boundary");
            }

            await client.send({
                type: "preview_timeline_action",
                requestId: "preview-1",
                boundaryId: boundary.userMessageId,
                action: "rewind_conversation",
            });
            const preview = await client.receive();
            if (preview.type !== "timeline_action_preview") {
                throw new Error("Expected timeline preview");
            }
            await client.send({
                type: "apply_timeline_action",
                requestId: "apply-1",
                planId: preview.plan.planId,
            });
            const history = await client.receive();
            expect(history).toMatchObject({
                type: "history",
                entries: [
                    { kind: "user", text: "first request" },
                    { kind: "assistant", text: "first answer" },
                ],
            });
            expect(await client.receive()).toMatchObject({
                type: "timeline_action_applied",
                requestId: "apply-1",
                planId: preview.plan.planId,
            });

            await client.send({
                type: "get_permissions",
                requestId: "permissions-after-rewind",
            });
            expect(await client.receive()).toMatchObject({
                type: "permissions",
                requestId: "permissions-after-rewind",
            });
        } finally {
            await client.detach().catch(() => undefined);
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "session search resolves an imported transcript through its header id",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-search-path-"));
        const workspace = await realpath(root);
        const sessionDirectory = join(root, "sessions");
        const sessionPath = join(sessionDirectory, "imported-name.jsonl");
        const store = await SessionStore.create(sessionPath, {
            sessionId: "actual-id",
            cwd: workspace,
        });
        await store.appendMessage({
            role: "user",
            content: [{ type: "text", text: "provider fallback" }],
        });

        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
        });
        try {
            const found = await searchSessionsThroughHost(socketPath, {
                query: "fallback",
                session_id: "actual-id",
            });
            expect(found.results.map((result) => result.session_id))
                .toEqual(["actual-id"]);
            expect(found.results[0]?.session_path).toBe(sessionPath);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host loads only the session explicitly resumed",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-restore-"));
        const workspace = await realpath(root);
        const sessionDirectory = join(root, "sessions");
        const firstPath = join(sessionDirectory, "first.jsonl");
        const secondPath = join(sessionDirectory, "second.jsonl");
        const firstStore = await SessionStore.create(firstPath, {
            sessionId: "first",
            cwd: workspace,
        });
        await firstStore.appendMessage({
            role: "user",
            content: [{ type: "text", text: "stored prompt" }],
        });
        await SessionStore.create(secondPath, {
            sessionId: "second",
            cwd: workspace,
        });

        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
        });
        try {
            const stored = await listAgentsThroughHost(socketPath);
            expect(stored.map((agent) => ({
                id: agent.id,
                live: agent.live,
                path: agent.session_path,
            }))).toEqual([
                { id: "first", live: false, path: firstPath },
                { id: "second", live: false, path: secondPath },
            ]);
            expect(host.registry.list()).toEqual([]);

            expect(await resumeAgentThroughHost(socketPath, firstPath)).toEqual({
                id: "first",
                workspace,
            });
            expect(host.registry.list().map((agent) => agent.id)).toEqual([
                "first",
            ]);

            const first = host.registry.find("first");
            if (first === undefined) {
                throw new Error("Expected restored first agent");
            }
            const attached = first.attach();
            expect(await attached.receive()).toEqual({
                type: "history",
                entries: [{
                    id: expect.any(String),
                    kind: "user",
                    text: "stored prompt",
                }],
                usage: { rows: [] },
                seq: 0,
            });
            attached.detach();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resume reports a stored provider this Vera build cannot use",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-stale-provider-"));
        const workspace = await realpath(root);
        const sessionDirectory = join(root, "sessions");
        const sessionPath = join(sessionDirectory, "stale.jsonl");
        const store = await SessionStore.create(sessionPath, {
            sessionId: "stale-provider",
            cwd: workspace,
        });
        await store.appendModelSettings({
            provider: "retired-provider",
            model: "old-model",
        });
        const failedPath = join(sessionDirectory, "failed.jsonl");
        const failedStore = await SessionStore.create(failedPath, {
            sessionId: "failed-stale-provider",
            cwd: workspace,
        });
        await failedStore.appendModelSettings({
            provider: "retired-provider",
            model: "old-model",
        });
        await failedStore.appendAgentFailure(
            "failure-1",
            "Resident agent stopped unexpectedly",
        );
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
        });
        try {
            let failure: unknown;
            try {
                await resumeAgentThroughHost(socketPath, sessionPath);
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(AgentStartError);
            expect(failure).toMatchObject({
                operation: "resume",
                reasonCode: "provider_unavailable",
                provider: "retired-provider",
                message:
                    "Session provider \"retired-provider\" is unavailable in this Vera build",
            });
            expect(host.registry.find("stale-provider")).toBeUndefined();

            expect(await resumeAgentThroughHost(socketPath, failedPath)).toEqual({
                id: "failed-stale-provider",
                workspace,
            });
            const failed = await attachAgent({
                socketPath,
                agentId: "failed-stale-provider",
            });
            try {
                expect(await failed.receive()).toMatchObject({ type: "history" });
                expect(await failed.receive()).toMatchObject({
                    type: "agent_failed",
                    failureId: "failure-1",
                });
            } finally {
                failed.close();
            }

            let attachFailure: unknown;
            try {
                await attachAgent({
                    socketPath,
                    agentId: "stale-provider",
                });
            } catch (error) {
                attachFailure = error;
            }
            expect(attachFailure).toBeInstanceOf(AgentAttachError);
            expect(attachFailure).toMatchObject({
                reason: "unavailable",
                reasonCode: "provider_unavailable",
                provider: "retired-provider",
            });
            expect(host.registry.find("stale-provider")).toBeUndefined();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a corrupt lazy session does not affect another resumed session",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-corrupt-restore-"));
        const workspace = await realpath(root);
        const sessionDirectory = join(root, "sessions");
        const firstPath = join(sessionDirectory, "first.jsonl");
        const corruptPath = join(sessionDirectory, "middle.jsonl");
        await SessionStore.create(firstPath, {
            sessionId: "first",
            cwd: workspace,
        });
        await SessionStore.create(corruptPath, {
            sessionId: "corrupt",
            cwd: workspace,
        });
        await writeFile(corruptPath, "{complete but invalid json}\n", {
            flag: "a",
        });
        const corruptSource = await readFile(corruptPath, "utf8");

        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
        });
        try {
            await expect(
                resumeAgentThroughHost(socketPath, corruptPath),
            ).rejects.toThrow("Resident agent resume failed");
            expect(await resumeAgentThroughHost(socketPath, firstPath)).toEqual({
                id: "first",
                workspace,
            });
            expect(host.registry.list().map((agent) => agent.id)).toEqual([
                "first",
            ]);
            expect(await readFile(corruptPath, "utf8")).toBe(corruptSource);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host replays the same failed agent after restart",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-failure-restart-"));
        const workspace = await realpath(root);
        const sessionDirectory = join(root, "sessions");
        const sessionPath = join(sessionDirectory, "failed.jsonl");
        const store = await SessionStore.create(sessionPath, {
            sessionId: "failed-agent",
            cwd: workspace,
        });
        await store.appendMessage({
            role: "user",
            content: [{ type: "text", text: "durable prompt" }],
        });
        await store.appendAgentFailure(
            "failure-1",
            "Resident agent stopped unexpectedly",
        );
        const socketPath = join(root, "host.sock");
        const lockPath = join(root, "host.json");
        let adapterCreations = 0;
        const start = () => startResidentHost({
            config: {
                schema_version: 1 as const,
                provider: "openrouter" as const,
                model: "faux/test",
                approval_mode: "auto" as const,
            },
            createAdapter: () => {
                adapterCreations += 1;
                return new FauxAdapter([textResponse("must not run")]);
            },
            socketPath,
            lockPath,
            sessionDirectory,
        });

        let host = await start();
        try {
            for (let incarnation = 0; incarnation < 2; incarnation += 1) {
                const attached = await attachAgent({
                    socketPath,
                    agentId: "failed-agent",
                });
                expect(await attached.receive()).toMatchObject({
                    type: "history",
                    entries: [{ kind: "user", text: "durable prompt" }],
                });
                expect(await attached.receive()).toEqual({
                    type: "agent_failed",
                    failureId: "failure-1",
                    detail: "Resident agent stopped unexpectedly",
                    seq: 1,
                });
                attached.close();
                const listing = await connectHost({ socketPath });
                await listing.send({ type: "list_agents" });
                expect(await listing.receive()).toMatchObject({
                    type: "agent_list",
                    agents: [{ id: "failed-agent", status: "failed" }],
                });
                listing.close();
                const restored = host.registry.find("failed-agent");
                if (restored === undefined) {
                    throw new Error("Expected restored failed resident");
                }
                const direct = restored.attach();
                expect(() => direct.send({
                    type: "prompt",
                    content: "must stay terminal",
                })).toThrow();
                direct.detach();

                if (incarnation === 0) {
                    await host.close();
                    host = await start();
                }
            }
            expect(adapterCreations).toBe(0);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "closing the resident host aborts an active model request",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-close-"));
        let markStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => markStarted = resolve);
        let requestSignal: AbortSignal | undefined;
        const adapter: ModelAdapter = {
            stream(request): ModelEventStream {
                requestSignal = request.signal;
                const stream = new ModelEventStream();
                stream.push({ type: "start" });
                markStarted?.();
                request.signal?.addEventListener("abort", () => {
                    const error = new Error("model request aborted");
                    stream.push({
                        type: "error",
                        error,
                        message: {
                            role: "assistant",
                            content: [],
                            source: {
                                provider: "faux",
                                api: "scripted",
                                model: "test",
                            },
                            usage: emptyUsage(),
                            stopReason: "aborted",
                            errorMessage: error.message,
                        },
                    });
                }, { once: true });
                return stream;
            },
        };
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => adapter,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });

        try {
            const agent = await host.registry.create({
                id: "working-agent",
                workspace: root,
                sessionPath: join(root, "agent.jsonl"),
                eventLogPath: join(root, "events.jsonl"),
            });
            const client = agent.attach();
            await client.receive();
            client.send({ type: "prompt", content: "keep working" });
            await started;

            await host.close();

            expect(requestSignal?.aborted).toBe(true);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function toolResponse(
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: `${name}-1`,
            name,
            input,
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function messageType(value: unknown): unknown {
    return typeof value === "object" && value !== null && "type" in value
        ? value.type
        : undefined;
}

async function receiveUntilType(
    client: { receive(): Promise<{ readonly type: string }> },
    type: string,
): Promise<void> {
    while ((await client.receive()).type !== type) {
        // Drain ordered updates until the requested boundary.
    }
}
