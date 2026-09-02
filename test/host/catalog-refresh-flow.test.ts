import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadVeraConfig,
    updateVeraConfigDefaults,
} from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { refreshCatalogThroughHost } from "../../src/host/model-settings-client.ts";
import { readProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";
import type { AuthStorage } from "../../src/providers/auth-storage.ts";

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
                    provider: "openrouter",
                    api: "openai-chat-completions",
                    model: "one/model",
                },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        });
        return stream;
    },
};

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a declared credentialless provider refreshes without spending a stale key",
    async () => {
        const root = await realpath(
            await mkdtemp(join(tmpdir(), "vera-custom-refresh-")),
        );
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = root;

        let listed: string | undefined = "first-model";
        const authorization: Array<string | null> = [];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                authorization.push(request.headers.get("authorization"));
                return Response.json({
                    data: listed === undefined ? [] : [{ id: listed }],
                });
            },
        });
        const authStorage = {
            getCredential: (provider: string) => provider === "local-gateway"
                ? {
                    type: "api_key" as const,
                    key: "stored-key-that-must-not-be-sent",
                }
                : undefined,
            setCredential: () => {},
            deleteCredential: () => {},
        } satisfies AuthStorage;
        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            approval_mode: "ask",
            providers: {
                "local-gateway": {
                    protocol: "openai-chat",
                    base_url: `http://localhost:${server.port}/v1`,
                    credential: "none",
                },
            },
        }));

        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            createAdapter: () => adapter,
            authStorage,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });

        try {
            const agent = await host.registry.create({
                workspace: root,
                sessionPath: join(root, "sessions", "agent.jsonl"),
            });

            listed = "second-model";
            const refreshed = await host.registry.refreshCatalog(
                agent.id,
                "local-gateway",
            );
            expect(refreshed?.availableModels).toContainEqual(expect.objectContaining({
                provider: "local-gateway",
                model: "second-model",
                refreshable: true,
            }));
            expect(refreshed?.refreshableProviders).toContain("local-gateway");

            listed = undefined;
            const emptied = await host.registry.refreshCatalog(
                agent.id,
                "local-gateway",
            );
            expect(emptied?.availableModels?.some(
                (model) => model.provider === "local-gateway",
            )).toBe(false);
            expect(emptied?.refreshableProviders).toContain("local-gateway");
            expect(authorization).toEqual([null, null]);
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

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a real host asks the provider again only when a refresh is requested",
    async () => {
        const root = await realpath(
            await mkdtemp(join(tmpdir(), "vera-catalog-refresh-")),
        );
        const previousHome = process.env.VERA_HOME;
        const previousKey = process.env.OPENROUTER_API_KEY;
        process.env.VERA_HOME = root;
        process.env.OPENROUTER_API_KEY = "test-key";

        let requests = 0;
        let failing = false;
        let listed = "first/model";
        const server = Bun.serve({
            port: 0,
            fetch() {
                requests += 1;
                if (failing) {
                    return new Response("nope", { status: 500 });
                }
                return Response.json({
                    data: [{
                        id: listed,
                        name: listed,
                        supported_parameters: ["tools", "reasoning"],
                        reasoning: {
                            supported_efforts: ["low", "high", "max"],
                        },
                    }],
                });
            },
        });

        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "first/model",
            approval_mode: "ask",
            provider_endpoints: {
                openrouter: `http://localhost:${server.port}/api/v1`,
            },
        }));

        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            createAdapter: () => adapter,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });

        try {
            const agent = await host.registry.create({
                workspace: root,
                sessionPath: join(root, "sessions", "agent.jsonl"),
            });
            const beforeRefresh = requests;

            listed = "second/model";
            const settings = await host.registry.refreshCatalog(
                agent.id,
                "openrouter",
            );
            expect(requests).toBe(beforeRefresh + 1);
            const fetched = settings?.availableModels?.find(
                (model) => model.model === "second/model",
            );
            expect(fetched).toBeDefined();
            // The announced vocabulary survives the round trip rather than
            // being flattened to the three OpenRouter documents.
            expect(fetched?.levels).toMatchObject([
                { id: "max" },
                { id: "high" },
                { id: "low" },
            ]);

            // A provider whose list is not fetched costs no request.
            expect(await host.registry.refreshCatalog(agent.id, "openai-codex"))
                .toBeUndefined();
            expect(requests).toBe(beforeRefresh + 1);

            // A provider that cannot answer is a refusal, not a refresh.
            // Discovery still hands back the snapshot it remembers, so
            // without this the user is told their list is current when
            // nothing was fetched.
            failing = true;
            expect(await host.registry.refreshCatalog(agent.id, "openrouter"))
                .toBeUndefined();
            expect(requests).toBe(beforeRefresh + 2);

            // And the remembered list is still there afterwards.
            failing = false;
            listed = "third/model";
            const after = await host.registry.refreshCatalog(
                agent.id,
                "openrouter",
            );
            expect(after?.availableModels?.map((model) => model.model))
                .toContain("third/model");
        } finally {
            await host.close();
            server.stop(true);
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
            else process.env.OPENROUTER_API_KEY = previousKey;
            await rm(root, { recursive: true, force: true });
        }
    },
    15_000,
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a resident host refresh removes an oMLX model that disappeared",
    async () => {
        const root = await realpath(
            await mkdtemp(join(tmpdir(), "vera-omlx-refresh-")),
        );
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = root;

        let listed = true;
        let requests = 0;
        const server = createServer((request, response) => {
            requests += 1;
            if (request.url !== "/v1/models") {
                response.writeHead(404);
                response.end("not found");
                return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                data: listed ? [{ id: "deleted-model" }] : [],
            }));
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("refresh test server did not expose a port");
        }

        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "omlx",
            model: "configured-model",
            approval_mode: "ask",
            provider_endpoints: {
                omlx: `http://127.0.0.1:${address.port}/v1`,
            },
        }));

        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });

        try {
            const agent = await host.registry.create({
                workspace: root,
                sessionPath: join(root, "sessions", "agent.jsonl"),
            });
            expect(requests).toBe(1);
            listed = false;
            const refreshed = await host.registry.refreshCatalog(agent.id, "omlx");
            expect(requests).toBe(2);
            expect(refreshed?.availableModels?.map((model) => model.model)).not.toContain(
                "deleted-model",
            );
            expect(refreshed?.availableModels?.map((model) => model.model)).toContain(
                "configured-model",
            );
        } finally {
            await host.close();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined ? resolve() : reject(error));
            });
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            await rm(root, { recursive: true, force: true });
        }
    },
    15_000,
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "editing a custom provider endpoint refreshes the new URL, not the old one",
    async () => {
        const root = await realpath(
            await mkdtemp(join(tmpdir(), "vera-moved-refresh-")),
        );
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = root;

        const oldHits: string[] = [];
        const newHits: string[] = [];
        const oldServer = Bun.serve({
            port: 0,
            fetch(request) {
                oldHits.push(new URL(request.url).pathname);
                return Response.json({
                    data: [{ id: "qwen3-1.7b" }],
                });
            },
        });
        const newServer = Bun.serve({
            port: 0,
            fetch(request) {
                newHits.push(new URL(request.url).pathname);
                return Response.json({
                    data: [{ id: "qwen35-9b-provisional" }],
                });
            },
        });
        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            approval_mode: "ask",
            providers: {
                outrider: {
                    protocol: "openai-chat",
                    base_url: `http://127.0.0.1:${oldServer.port}/v1`,
                    credential: "none",
                },
            },
        }));

        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            createAdapter: () => adapter,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });

        try {
            const agent = await host.registry.create({
                workspace: root,
                sessionPath: join(root, "sessions", "agent.jsonl"),
            });
            const first = await host.registry.refreshCatalog(agent.id, "outrider");
            expect(first?.availableModels).toContainEqual(expect.objectContaining({
                provider: "outrider",
                model: "qwen3-1.7b",
            }));
            expect(oldHits).toEqual(["/v1/models"]);
            expect(newHits).toEqual([]);
            const cachedBefore = readProviderCatalogSnapshot("outrider");
            expect(cachedBefore.models.map((model) => model.id))
                .toEqual(["qwen3-1.7b"]);

            updateVeraConfigDefaults({
                custom_provider: {
                    id: "outrider",
                    declaration: {
                        protocol: "openai-chat",
                        base_url: `http://127.0.0.1:${newServer.port}/v1`,
                        credential: "none",
                    },
                },
            }, { path: configPath });

            const moved = await host.registry.refreshCatalog(agent.id, "outrider");
            expect(moved?.availableModels).toContainEqual(expect.objectContaining({
                provider: "outrider",
                model: "qwen35-9b-provisional",
            }));
            expect(
                moved?.availableModels?.some((model) =>
                    model.provider === "outrider" && model.model === "qwen3-1.7b"
                ),
            ).toBe(false);
            expect(oldHits).toEqual(["/v1/models"]);
            expect(newHits).toEqual(["/v1/models"]);
            expect(readProviderCatalogSnapshot("outrider").models.map((model) => model.id))
                .toEqual(["qwen35-9b-provisional"]);
            expect(readProviderCatalogSnapshot("outrider").fetched_at)
                .not.toBe(cachedBefore.fetched_at);
        } finally {
            await host.close();
            oldServer.stop(true);
            newServer.stop(true);
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            await rm(root, { recursive: true, force: true });
        }
    },
    15_000,
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "home refreshes a moved custom provider without a session",
    async () => {
        const root = await realpath(
            await mkdtemp(join(tmpdir(), "vera-home-moved-refresh-")),
        );
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = root;

        const oldHits: string[] = [];
        const newHits: string[] = [];
        const oldServer = Bun.serve({
            port: 0,
            fetch() {
                oldHits.push("hit");
                return Response.json({ data: [{ id: "qwen3-1.7b" }] });
            },
        });
        const newServer = Bun.serve({
            port: 0,
            fetch() {
                newHits.push("hit");
                return Response.json({
                    data: [{ id: "qwen35-9b-provisional" }],
                });
            },
        });
        const configPath = join(root, "config.json");
        const socketPath = join(root, "host.sock");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            approval_mode: "ask",
            providers: {
                outrider: {
                    protocol: "openai-chat",
                    base_url: `http://127.0.0.1:${oldServer.port}/v1`,
                    credential: "none",
                },
            },
        }));

        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            createAdapter: () => adapter,
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });

        try {
            const first = await refreshCatalogThroughHost(socketPath, "outrider", root);
            expect(first?.availableModels).toContainEqual(expect.objectContaining({
                provider: "outrider",
                model: "qwen3-1.7b",
            }));
            expect(oldHits).toHaveLength(1);
            expect(newHits).toHaveLength(0);

            updateVeraConfigDefaults({
                custom_provider: {
                    id: "outrider",
                    declaration: {
                        protocol: "openai-chat",
                        base_url: `http://127.0.0.1:${newServer.port}/v1`,
                        credential: "none",
                    },
                },
            }, { path: configPath });

            const moved = await refreshCatalogThroughHost(socketPath, "outrider", root);
            expect(moved?.availableModels).toContainEqual(expect.objectContaining({
                provider: "outrider",
                model: "qwen35-9b-provisional",
            }));
            expect(oldHits).toHaveLength(1);
            expect(newHits).toHaveLength(1);
        } finally {
            await host.close();
            oldServer.stop(true);
            newServer.stop(true);
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            await rm(root, { recursive: true, force: true });
        }
    },
    15_000,
);
