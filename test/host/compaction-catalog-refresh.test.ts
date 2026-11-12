import { expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { providerCatalogCacheDir, writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";
import type { AuthStorage } from "../../src/providers/auth-storage.ts";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";

socketAndLoopbackTest(
    "a single-provider refresh changes the catalog window used by compaction",
    async () => {
        const home = await mkdtemp(join(tmpdir(), "vera-compact-catalog-"));
        const server = Bun.serve({
            port: 0,
            fetch: () => Response.json({
                data: [{ id: "pirate/crow", context_length: 50_000 }],
            }),
        });
        const authStorage = {
            getCredential: (provider: string) => provider === "openrouter"
                ? { type: "api_key" as const, key: "test-key" }
                : undefined,
            setCredential: () => {},
            deleteCredential: () => {},
        } satisfies AuthStorage;
        let requests = 0;
        const adapter: ModelAdapter = {
            stream() {
                requests += 1;
                const stream = new ModelEventStream();
                stream.push({ type: "start" });
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "Course set." }],
                        source: { provider: "openrouter", api: "test", model: "pirate/crow" },
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                });
                return stream;
            },
        };
        try {
            const configPath = join(home, "config.json");
            await writeFile(configPath, JSON.stringify({
                schema_version: 1,
                provider: "openrouter",
                model: "pirate/crow",
                approval_mode: "auto",
                provider_endpoints: { openrouter: `http://127.0.0.1:${server.port}/api/v1` },
                model_assignments: {
                    compaction: {
                        models: [{ name: "crow", provider: "openrouter", model: "pirate/crow" }],
                    },
                },
            }));
            writeProviderCatalogSnapshot({
                schema_version: 2,
                provider: "openrouter",
                fetched_at: new Date().toISOString(),
                models: [{ id: "pirate/crow", label: "crow", context_window: 1_000, levels: [] }],
            }, { cacheDir: providerCatalogCacheDir(home) });
            const host = await startResidentHost({
                home,
                config: loadVeraConfig({ path: configPath }),
                createAdapter: () => adapter,
                authStorage,
                socketPath: join(home, "host.sock"),
                lockPath: join(home, "host.json"),
                sessionDirectory: join(home, "sessions"),
            });
            try {
                await host.registry.create({ id: "crow", workspace: home });
                const summarize = () => host.registry.agents.get("crow")
                    ?.loopServices?.compaction?.rungs[0].models.summarizer;
                const request = {
                    systemPrompt: "",
                    messages: [{
                        role: "user" as const,
                        content: [{ type: "text" as const, text: "x".repeat(12_000) }],
                    }],
                    maxTokens: 32,
                };
                const signal = new AbortController().signal;
                const before = summarize();
                if (before === undefined) throw new Error("summarizer is not bound");
                await expect(before(request, signal)).rejects.toThrow("window is 1000");
                expect(requests).toBe(0);

                expect(await host.registry.refreshHostCatalog("openrouter")).toBeDefined();
                const after = summarize();
                if (after === undefined) throw new Error("summarizer is not bound");
                expect((await after(request, signal)).text).toBe("Course set.");
                expect(requests).toBe(1);
            } finally {
                await host.close();
            }
        } finally {
            server.stop(true);
            await rm(home, { recursive: true, force: true });
        }
    },
    15_000,
);
