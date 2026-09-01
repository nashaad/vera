import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadVeraConfig,
    updateVeraConfigDefaults,
} from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import type { AgentRegistry } from "../../src/host/agent-registry.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a real host applies a model request extension before provider dispatch",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-model-request-hook-"));
        const workspace = await realpath(root);
        const extension = join(root, "extension");
        const configPath = join(root, "config.json");
        await mkdir(extension);
        await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
            id: "strata.test",
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities: ["hooks.model_request"],
        }));
        await writeFile(join(extension, "extension.ts"), `
            export function activate(vera) {
                vera.hooks.registerModelRequest("strata", ({ workspace }) => ({
                    corpus: { path: workspace },
                }));
            }
        `);
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "vera-strata",
            model: "strata",
            approval_mode: "ask",
            providers: {
                "vera-strata": {
                    protocol: "openai-chat",
                    base_url: "https://strata.example.com/v1",
                    credential: "none",
                },
            },
            extensions: [{ path: extension, enabled: true, config: {} }],
        }));

        let received: unknown;
        const adapter: ModelAdapter = {
            stream(request) {
                received = request.bodyExtensions;
                const stream = new ModelEventStream();
                stream.push({ type: "start" });
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "done" }],
                        source: {
                            provider: "vera-strata",
                            api: "openai-chat-completions",
                            model: request.model,
                        },
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                });
                return stream;
            },
        };
        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            createAdapter: () => adapter,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            await runHostedPrompt(host.registry, {
                id: "strata-run",
                workspace,
                sessionPath: join(root, "sessions", "strata-run.jsonl"),
                prompt: "audit this",
            });
            expect(received).toEqual({
                strata: { corpus: { path: workspace } },
            });
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a real host combines hooks with the latest persisted exact-model options",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-model-request-options-"));
        const workspace = await realpath(root);
        const extension = join(root, "extension");
        const configPath = join(root, "config.json");
        await mkdir(extension);
        await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
            id: "request-options.test",
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities: ["hooks.model_request"],
        }));
        await writeFile(join(extension, "extension.ts"), `
            export function activate(vera) {
                vera.hooks.registerModelRequest("strata", () => ({
                    corpus: { id: "public" },
                }));
            }
        `);
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "test/model",
            approval_mode: "ask",
            extensions: [{ path: extension, enabled: true, config: {} }],
            model_request_options: {
                "openrouter/test/model": {
                    body: { provider: { only: ["first"] } },
                },
            },
        }));

        const received: unknown[] = [];
        const adapter: ModelAdapter = {
            stream(request) {
                received.push(request.bodyExtensions);
                const stream = new ModelEventStream();
                stream.push({ type: "start" });
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "done" }],
                        source: {
                            provider: "openrouter",
                            api: "test",
                            model: request.model,
                        },
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                });
                return stream;
            },
        };
        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            configPath,
            createAdapter: () => adapter,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            await runHostedPrompt(host.registry, {
                id: "request-options-first",
                workspace,
                sessionPath: join(root, "sessions", "first.jsonl"),
                prompt: "first",
            });

            updateVeraConfigDefaults({
                model_request_options: {
                    model: "openrouter/test/model",
                    body: { provider: { only: ["second-longer"] } },
                },
            }, { path: configPath });
            await runHostedPrompt(host.registry, {
                id: "request-options-second",
                workspace,
                sessionPath: join(root, "sessions", "second.jsonl"),
                prompt: "second",
            });

            expect(received).toEqual([
                {
                    strata: { corpus: { id: "public" } },
                    provider: { only: ["first"] },
                },
                {
                    strata: { corpus: { id: "public" } },
                    provider: { only: ["second-longer"] },
                },
            ]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident model verification uses the configured request options",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-model-verify-options-"));
        const workspace = await realpath(root);
        const configPath = join(root, "config.json");
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = join(root, "vera-home");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "test/model",
            approval_mode: "ask",
            model_request_options: {
                "openrouter/test/model": {
                    body: { provider: { only: ["z-ai"] } },
                },
            },
        }));

        const received: unknown[] = [];
        const adapter: ModelAdapter = {
            stream(request) {
                received.push(request.bodyExtensions);
                const stream = new ModelEventStream();
                stream.push({ type: "start" });
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "not the probe sentinel" }],
                        source: {
                            provider: "openrouter",
                            api: "test",
                            model: request.model,
                        },
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                });
                return stream;
            },
        };
        let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
        try {
            host = await startResidentHost({
                config: loadVeraConfig({ path: configPath }),
                configPath,
                createAdapter: () => adapter,
                socketPath: join(root, "host.sock"),
                lockPath: join(root, "host.json"),
                sessionDirectory: join(root, "sessions"),
                eventLogDirectory: join(root, "logs"),
            });
            const agent = await host.registry.create({
                id: "verify-request-options",
                workspace,
                sessionPath: join(root, "sessions", "verify.jsonl"),
            });
            const outcome = await host.registry.poolAdd(
                agent.id,
                { provider: "openrouter", model: "test/model" },
                () => {},
                { verify: true },
            );

            expect(outcome.verdict).toBe("incompatible");
            expect(received.length).toBeGreaterThan(0);
            expect(received).toEqual(received.map(() => ({
                provider: { only: ["z-ai"] },
            })));
        } finally {
            await host?.close();
            if (previousHome === undefined) {
                delete process.env.VERA_HOME;
            } else {
                process.env.VERA_HOME = previousHome;
            }
            await rm(root, { recursive: true, force: true });
        }
    },
);

async function runHostedPrompt(
    registry: AgentRegistry,
    options: {
        readonly id: string;
        readonly workspace: string;
        readonly sessionPath: string;
        readonly prompt: string;
    },
): Promise<void> {
    const agent = await registry.create({
        id: options.id,
        workspace: options.workspace,
        sessionPath: options.sessionPath,
    });
    const attachment = agent.attach();
    try {
        while (true) {
            const update = await attachment.receive();
            if (update.type === "history") {
                agent.sendPrompt(options.prompt);
                continue;
            }
            if (
                update.type === "turn_finished"
                || update.type === "agent_failed"
            ) {
                return;
            }
        }
    } finally {
        attachment.detach();
    }
}
