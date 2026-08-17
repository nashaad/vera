import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
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
            const result = await host.registry.runOnce({
                id: "strata-run",
                workspace,
                sessionPath: join(root, "sessions", "strata-run.jsonl"),
                prompt: "audit this",
            });
            expect(result.outcome).toBe("completed");
            expect(received).toEqual({
                strata: { corpus: { path: workspace } },
            });
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
