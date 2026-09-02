import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../../clients/cli/main.ts";
import { loadVeraConfig } from "../../src/config.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { readModelSettingsThroughHost } from "../../src/host/model-settings-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { addPoolModel } from "../../src/model/pool-file-store.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";

const adapter: ModelAdapter = {
    stream() {
        const stream = new ModelEventStream();
        stream.push({ type: "start" });
        stream.push({
            type: "done",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                source: {
                    provider: "openai-codex",
                    api: "openai-responses",
                    model: "gpt-5.6-sol",
                },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        });
        return stream;
    },
};

async function receiveUntil(
    receive: () => Promise<AgentUpdate>,
    predicate: (update: AgentUpdate) => boolean,
): Promise<AgentUpdate> {
    const deadline = Date.now() + 20_000;
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for agent update");
        const update = await Promise.race([
            receive(),
            Bun.sleep(remaining).then(() => {
                throw new Error("Timed out waiting for agent update");
            }),
        ]);
        if (predicate(update)) return update;
    }
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "CLI models refresh updates a running host catalog without restart",
    async () => {
        const root = await realpath(
            await mkdtemp("/tmp/vcr-"),
        );
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = root;
        await mkdir(join(root, "runtime"), { recursive: true });
        await mkdir(join(root, "sessions"), { recursive: true });

        const listed = "qwen35-9b-provisional";
        let fail = false;
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                if (fail) return new Response("down", { status: 500 });
                if (request.method === "GET" && request.url.endsWith("/models")) {
                    return Response.json({
                        data: [{
                            id: listed,
                            context_length: 32_768,
                        }],
                    });
                }
                return new Response("not found", { status: 404 });
            },
        });
        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            approval_mode: "ask",
            providers: {
                outrider_t1: {
                    protocol: "openai-chat",
                    base_url: `http://127.0.0.1:${server.port}/v1`,
                    credential: "none",
                },
            },
        }));
        addPoolModel("outrider_t1/qwen35-9b-provisional");

        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            createAdapter: () => adapter,
            socketPath: join(root, "runtime", "host.sock"),
            lockPath: join(root, "runtime", "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });

        try {
            const before = host.registry.readHostModelSettings(root);
            expect(before.availableModels?.some((model) =>
                model.provider === "outrider_t1"
                    && model.model === "qwen35-9b-provisional"
            )).toBe(false);
            expect(before.pooled?.find((entry) =>
                entry.provider === "outrider_t1"
                    && entry.model === "qwen35-9b-provisional"
            )).toMatchObject({ available: false });

            const agent = await host.registry.create({
                workspace: root,
                sessionPath: join(root, "sessions", "agent.jsonl"),
            });
            const client = await attachAgent({
                socketPath: join(root, "runtime", "host.sock"),
                agentId: agent.id,
            });
            try {
                await receiveUntil(
                    () => client.receive(),
                    (update) => update.type === "history",
                );

                let output = "";
                const exitCode = await runCli(["models", "refresh"], {
                    stdout: { write: (text) => output += text },
                });
                expect(exitCode).toBe(0);
                expect(output).toContain("outrider_t1: 1 models");

                const settings = await readModelSettingsThroughHost(
                    join(root, "runtime", "host.sock"),
                    root,
                );
                expect(settings?.availableModels).toContainEqual(
                    expect.objectContaining({
                        provider: "outrider_t1",
                        model: "qwen35-9b-provisional",
                        refreshable: true,
                    }),
                );
                expect(settings?.pooled).toContainEqual(expect.objectContaining({
                    provider: "outrider_t1",
                    model: "qwen35-9b-provisional",
                    available: true,
                }));

                await client.send({
                    type: "get_model_settings",
                    requestId: "after-cli-refresh",
                });
                const attached = await receiveUntil(
                    () => client.receive(),
                    (update) => update.type === "model_settings"
                        && update.requestId === "after-cli-refresh",
                );
                if (attached.type !== "model_settings") {
                    throw new Error("expected model_settings");
                }
                expect(attached.settings.availableModels).toContainEqual(
                    expect.objectContaining({
                        provider: "outrider_t1",
                        model: "qwen35-9b-provisional",
                    }),
                );
            } finally {
                client.close();
            }

            fail = true;
            await runCli(["models", "refresh"], {
                stdout: { write: () => {} },
            });
            const afterFailure = host.registry.readHostModelSettings(root);
            expect(afterFailure.availableModels).toContainEqual(
                expect.objectContaining({
                    provider: "outrider_t1",
                    model: "qwen35-9b-provisional",
                }),
            );
            expect(afterFailure.availableModels?.some((model) =>
                model.model === "should-not-replace"
            )).toBe(false);
        } finally {
            await host.close();
            server.stop(true);
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            await rm(root, { recursive: true, force: true });
        }
    },
    15_000,
);
