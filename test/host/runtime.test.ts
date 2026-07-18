import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectHost } from "../../src/host/connection.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host wires its registry to list and attach requests",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-runtime-"));
        const socketPath = join(root, "host.sock");
        const sessionPath = join(root, "agent.jsonl");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "approve_for_me",
            },
            createAdapter: () => new FauxAdapter([textResponse("hello")]),
            socketPath,
            lockPath: join(root, "host.json"),
        });

        try {
            await host.registry.create({
                id: "agent-1",
                workspace: root,
                sessionPath,
                eventLogPath: join(root, "events.jsonl"),
            });

            const listing = await connectHost({ socketPath });
            try {
                await listing.send({ type: "list_agents" });
                expect(await listing.receive()).toMatchObject({
                    type: "agent_list",
                    agents: [{ id: "agent-1", status: "idle" }],
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
                approval_mode: "approve_for_me",
            },
            createAdapter: () => adapter,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
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
