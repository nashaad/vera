import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { refreshCatalogsThroughHost } from "../../src/host/catalog-refresh-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { providerCatalogCacheDir } from "../../src/model/catalog-cache.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";
import { readWebDevArenaSnapshot, refreshWebDevArena } from "../../src/model/webdev-arena.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

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
                    provider: "test-gateway",
                    api: "openai-chat-completions",
                    model: "arena-model",
                },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        });
        return stream;
    },
};

function arenaUrl(input: string | URL | Request): string {
    if (typeof input === "string") return input;
    return input instanceof URL ? input.toString() : input.url;
}

test("a slow arena download does not hold the catalog refresh", async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "vera-arena-refresh-")),
    );
    const server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ data: [{ id: "arena-model" }] }),
    });
    const configPath = join(root, "config.json");
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
        schema_version: 1,
        provider: "test-gateway",
        model: "arena-model",
        approval_mode: "ask",
        providers: {
            "test-gateway": {
                protocol: "openai-chat",
                base_url: `http://127.0.0.1:${server.port}/v1`,
                credential: "none",
            },
        },
    }));

    let releaseArena!: () => void;
    const arenaGate = new Promise<void>((resolve) => {
        releaseArena = resolve;
    });
    let arenaRequests = 0;
    const catalogFetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
    ) => {
        if (!arenaUrl(input).startsWith("https://datasets-server.huggingface.co/")) {
            return await globalThis.fetch(input, init);
        }
        arenaRequests += 1;
        await arenaGate;
        return Response.json({
            num_rows_total: 1,
            rows: [{
                row: {
                    model_name: "arena-model",
                    category: "overall",
                    rating: 1234,
                    rank: 1,
                },
            }],
        });
    }) as typeof globalThis.fetch;

    const host = await startResidentHost({
        config: loadVeraConfig({ path: configPath }),
        home: root,
        createAdapter: () => adapter,
        catalogFetch,
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
        const attachment = agent.attach();
        expect((await attachment.receive(AbortSignal.timeout(5_000))).type)
            .toBe("history");

        const fastRefresh = host.registry.refreshCatalog(
            agent.id,
            "test-gateway",
        );
        const refreshed = await Promise.race([
            fastRefresh,
            new Promise<never>((_resolve, reject) => {
                setTimeout(
                    () => reject(new Error("refresh waited for the arena")),
                    2_000,
                );
            }),
        ]);
        expect(refreshed?.availableModels).toContainEqual(
            expect.objectContaining({
                provider: "test-gateway",
                model: "arena-model",
            }),
        );
        expect(refreshed?.availableModels?.find(
            (model) => model.model === "arena-model",
        )?.waScore).toBeUndefined();
        expect(arenaRequests).toBe(1);
        expect(readWebDevArenaSnapshot(providerCatalogCacheDir(root)))
            .toBeUndefined();

        const secondRefresh = await host.registry.refreshCatalog(
            agent.id,
            "test-gateway",
        );
        expect(secondRefresh).toBeDefined();
        expect(arenaRequests).toBe(1);

        releaseArena();
        let settingsUpdate:
            | Extract<AgentUpdate, { type: "model_settings" }>
            | undefined;
        while (settingsUpdate === undefined) {
            const update = await attachment.receive(
                AbortSignal.timeout(5_000),
            );
            if (update.type === "model_settings") settingsUpdate = update;
        }
        expect(settingsUpdate.settings.availableModels?.find(
            (model) => model.model === "arena-model",
        )?.waScore).toBe(1234);
        expect(readWebDevArenaSnapshot(providerCatalogCacheDir(root))?.rows)
            .toContainEqual(expect.objectContaining({
                model_name: "arena-model",
                rating: 1234,
            }));
    } finally {
        releaseArena();
        await host.close();
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});

test("a bulk catalog refresh does not wait for the arena download", async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "vera-arena-bulk-")),
    );
    const server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ data: [{ id: "arena-model" }] }),
    });
    const configPath = join(root, "config.json");
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
        schema_version: 1,
        provider: "test-gateway",
        model: "arena-model",
        approval_mode: "ask",
        providers: {
            "test-gateway": {
                protocol: "openai-chat",
                base_url: `http://127.0.0.1:${server.port}/v1`,
                credential: "none",
                discovery: { mode: "models", credential: "none" },
            },
        },
    }));

    let releaseArena!: () => void;
    const arenaGate = new Promise<void>((resolve) => {
        releaseArena = resolve;
    });
    let arenaRequests = 0;
    const catalogFetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
    ) => {
        if (!arenaUrl(input).startsWith("https://datasets-server.huggingface.co/")) {
            return await globalThis.fetch(input, init);
        }
        arenaRequests += 1;
        await arenaGate;
        return Response.json({
            num_rows_total: 1,
            rows: [{
                row: {
                    model_name: "arena-model",
                    category: "overall",
                    rating: 1234,
                    rank: 1,
                },
            }],
        });
    }) as typeof globalThis.fetch;

    const host = await startResidentHost({
        config: loadVeraConfig({ path: configPath }),
        home: root,
        createAdapter: () => adapter,
        catalogFetch,
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
    });

    try {
        const outcomes = await Promise.race([
            refreshCatalogsThroughHost(join(root, "host.sock")),
            new Promise<never>((_resolve, reject) => {
                setTimeout(
                    () => reject(new Error("bulk refresh waited for the arena")),
                    2_000,
                );
            }),
        ]);
        expect(outcomes).toContainEqual(expect.objectContaining({
            provider: "test-gateway",
            models: 1,
        }));
        expect(arenaRequests).toBe(1);

        releaseArena();
        let waScore: number | undefined;
        for (let attempt = 0; attempt < 250; attempt += 1) {
            waScore = host.registry.readHostModelSettings(root).availableModels?.find(
                (model) => model.model === "arena-model",
            )?.waScore;
            if (waScore === 1234) break;
            await Bun.sleep(20);
        }
        expect(waScore).toBe(1234);
        expect(readWebDevArenaSnapshot(providerCatalogCacheDir(root))?.rows)
            .toContainEqual(expect.objectContaining({
                model_name: "arena-model",
                rating: 1234,
            }));
    } finally {
        releaseArena();
        await host.close();
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});

test("a fresh arena cache makes startup skip the download", async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "vera-arena-fresh-")),
    );
    const server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ data: [{ id: "arena-model" }] }),
    });
    const configPath = join(root, "config.json");
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
        schema_version: 1,
        provider: "test-gateway",
        model: "arena-model",
        approval_mode: "ask",
        providers: {
            "test-gateway": {
                protocol: "openai-chat",
                base_url: `http://127.0.0.1:${server.port}/v1`,
                credential: "none",
                discovery: { mode: "models", credential: "none" },
            },
        },
    }));

    const seeded = await refreshWebDevArena({
        maxAgeMs: 0,
        cacheDir: providerCatalogCacheDir(root),
        fetch: (async (
            _input: string | URL | Request,
            _init?: RequestInit,
        ) => Response.json({
            num_rows_total: 1,
            rows: [{
                row: {
                    model_name: "arena-model",
                    category: "overall",
                    rating: 4321,
                    rank: 1,
                },
            }],
        })) as typeof globalThis.fetch,
    });
    expect(seeded?.rows[0]?.rating).toBe(4321);

    let arenaRequests = 0;
    const catalogFetch = (async (
        _input: string | URL | Request,
        _init?: RequestInit,
    ) => {
        arenaRequests += 1;
        return Response.json({
            num_rows_total: 1,
            rows: [{
                row: {
                    model_name: "arena-model",
                    category: "overall",
                    rating: 1234,
                    rank: 1,
                },
            }],
        });
    }) as typeof globalThis.fetch;

    const host = await startResidentHost({
        config: loadVeraConfig({ path: configPath }),
        home: root,
        catalogFetch,
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
    });

    try {
        expect(arenaRequests).toBe(0);
        expect(host.registry.readHostModelSettings(root).availableModels?.find(
            (model) => model.model === "arena-model",
        )?.waScore).toBe(4321);
    } finally {
        await host.close();
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});

test("host startup does not wait for the arena download", async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "vera-arena-startup-")),
    );
    const server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ data: [{ id: "arena-model" }] }),
    });
    const configPath = join(root, "config.json");
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
        schema_version: 1,
        provider: "test-gateway",
        model: "arena-model",
        approval_mode: "ask",
        providers: {
            "test-gateway": {
                protocol: "openai-chat",
                base_url: `http://127.0.0.1:${server.port}/v1`,
                credential: "none",
                discovery: { mode: "models", credential: "none" },
            },
        },
    }));

    const originalFetch = globalThis.fetch;
    let releaseArena!: () => void;
    const arenaGate = new Promise<void>((resolve) => {
        releaseArena = resolve;
    });
    let arenaRequests = 0;
    const catalogFetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
    ) => {
        if (!arenaUrl(input).startsWith("https://datasets-server.huggingface.co/")) {
            return await originalFetch(input, init);
        }
        arenaRequests += 1;
        await arenaGate;
        return Response.json({
            num_rows_total: 1,
            rows: [{
                row: {
                    model_name: "arena-model",
                    category: "overall",
                    rating: 1234,
                    rank: 1,
                },
            }],
        });
    }) as typeof globalThis.fetch;
    globalThis.fetch = catalogFetch;

    const started = performance.now();
    const host = await Promise.race([
        startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            home: root,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        }).finally(() => {
            globalThis.fetch = originalFetch;
        }),
        new Promise<never>((_resolve, reject) => {
            setTimeout(
                () => reject(new Error("host startup waited for the arena")),
                3_000,
            );
        }),
    ]);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(arenaRequests).toBe(1);
    expect(host.registry.readHostModelSettings(root).availableModels?.find(
        (model) => model.model === "arena-model",
    )?.waScore).toBeUndefined();

    try {
        const agent = await host.registry.create({
            workspace: root,
            sessionPath: join(root, "sessions", "agent.jsonl"),
        });
        const attachment = agent.attach();
        expect((await attachment.receive(AbortSignal.timeout(5_000))).type)
            .toBe("history");

        releaseArena();
        let settingsUpdate:
            | Extract<AgentUpdate, { type: "model_settings" }>
            | undefined;
        while (settingsUpdate === undefined) {
            const update = await attachment.receive(
                AbortSignal.timeout(5_000),
            );
            if (
                update.type === "model_settings"
                && update.settings.availableModels?.find(
                    (model) => model.model === "arena-model",
                )?.waScore === 1234
            ) {
                settingsUpdate = update;
            }
        }
        expect(settingsUpdate.settings.availableModels?.find(
            (model) => model.model === "arena-model",
        )?.waScore).toBe(1234);
        expect(readWebDevArenaSnapshot(providerCatalogCacheDir(root))?.rows)
            .toContainEqual(expect.objectContaining({
                model_name: "arena-model",
                rating: 1234,
            }));
    } finally {
        releaseArena();
        await host.close();
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});
