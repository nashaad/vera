import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectHost } from "../../src/host/connection.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import { resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import {
    HOST_PROTOCOL_VERSION,
    requestHostIdentity,
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
    "resident host restores stored sessions before publishing itself",
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
            expect(host.registry.list().map((agent) => agent.id)).toEqual([
                "first",
                "second",
            ]);
            expect(await resumeAgentThroughHost(socketPath, firstPath)).toEqual({
                id: "first",
                workspace,
            });

            const first = host.registry.find("first");
            if (first === undefined) {
                throw new Error("Expected restored first agent");
            }
            const attached = first.attach();
            expect(await attached.receive()).toEqual({
                type: "history",
                entries: [{ kind: "user", text: "stored prompt" }],
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
    "resident host isolates corrupt stored sessions during restore",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-corrupt-restore-"));
        const workspace = await realpath(root);
        const sessionDirectory = join(root, "sessions");
        const firstPath = join(sessionDirectory, "first.jsonl");
        const corruptPath = join(sessionDirectory, "middle.jsonl");
        const lastPath = join(sessionDirectory, "third.jsonl");
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
        const canonicalCorruptPath = await realpath(corruptPath);
        const corruptSource = await readFile(corruptPath, "utf8");
        await SessionStore.create(lastPath, {
            sessionId: "third",
            cwd: workspace,
        });

        const failures: Array<{ sessionPath: string; error: unknown }> = [];
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
            onRestoreFailure: (failure) => failures.push(failure),
        });
        try {
            expect(host.registry.list().map((agent) => agent.id)).toEqual([
                "first",
                "third",
            ]);
            expect(failures).toHaveLength(1);
            expect(failures[0]?.sessionPath).toBe(corruptPath);
            expect(String(failures[0]?.error)).toContain(
                `Invalid session file ${canonicalCorruptPath}`,
            );
            expect(String(failures[0]?.error)).toContain("line 2");
            expect(await readFile(corruptPath, "utf8")).toBe(corruptSource);

            await expect(
                resumeAgentThroughHost(socketPath, corruptPath),
            ).rejects.toThrow("Resident agent resume failed");
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "restore diagnostics cannot block later resident sessions",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-restore-report-"));
        const workspace = await realpath(root);
        const sessionDirectory = join(root, "sessions");
        const corruptPath = join(sessionDirectory, "first.jsonl");
        await SessionStore.create(corruptPath, {
            sessionId: "corrupt",
            cwd: workspace,
        });
        await writeFile(corruptPath, "not-json\n", { flag: "a" });
        await SessionStore.create(join(sessionDirectory, "second.jsonl"), {
            sessionId: "second",
            cwd: workspace,
        });

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
            sessionDirectory,
            onRestoreFailure: () => {
                throw new Error("diagnostic sink failed");
            },
        });
        try {
            expect(host.registry.list().map((agent) => agent.id)).toEqual([
                "second",
            ]);
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
                const listing = await connectHost({ socketPath });
                await listing.send({ type: "list_agents" });
                expect(await listing.receive()).toMatchObject({
                    type: "agent_list",
                    agents: [{ id: "failed-agent", status: "failed" }],
                });
                listing.close();

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
