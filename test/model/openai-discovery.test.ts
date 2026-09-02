import { expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "../../src/model/catalog-cache.ts";
import {
    normalizeOpenAIModels,
    refreshOpenAIProviderCatalog,
    type ProviderCatalogRefreshResult,
} from "../../src/model/openai-discovery.ts";

function resultCatalog(result: ProviderCatalogRefreshResult) {
    if (!("catalog" in result)) {
        throw new Error(`expected a catalog, got ${result.status}`);
    }
    return result.catalog;
}

function temporaryCache(): string {
    return mkdtempSync(join(tmpdir(), "vera-openai-discovery-"));
}

test("generic OpenAI discovery authenticates, normalizes, and writes one provider snapshot", async () => {
    const cacheDir = temporaryCache();
    let requested = "";
    try {
        const catalog = await refreshOpenAIProviderCatalog({
            provider: "fixture-provider",
            baseUrl: "https://fixture.example/v1",
            apiKey: "stored-fixture-key",
            cacheDir,
            fetch: async (input, init) => {
                requested = String(input);
                expect(new Headers(init?.headers).get("authorization"))
                    .toBe("Bearer stored-fixture-key");
                return new Response(JSON.stringify({ data: [
                    { id: "model-a", name: "Model A" },
                    { id: "model-b" },
                ] }), { status: 200 });
            },
        });
        expect(requested).toBe("https://fixture.example/v1/models");
        expect(catalog.status).toBe("refreshed");
        expect(resultCatalog(catalog).models.map((model) => model.id))
            .toEqual(["model-a", "model-b"]);
        expect(readProviderCatalogSnapshot("fixture-provider", { cacheDir }).models)
            .toHaveLength(2);
    } finally {
        rmSync(cacheDir, { recursive: true, force: true });
    }
});

test("fresh snapshots avoid a provider request and failed refreshes use stale rows", async () => {
    const cacheDir = temporaryCache();
    try {
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "fixture-provider",
            fetched_at: new Date().toISOString(),
            endpoint: "https://fixture.example/v1/models",
            models: [{ id: "cached", label: "Cached", levels: [] }],
        }, { cacheDir });
        const fresh = await refreshOpenAIProviderCatalog({
            provider: "fixture-provider",
            baseUrl: "https://fixture.example/v1",
            maxAgeMs: 60_000,
            cacheDir,
            fetch: async () => {
                throw new Error("fresh cache should prevent this request");
            },
        });
        expect(fresh).toMatchObject({ status: "fresh" });
        expect(resultCatalog(fresh).models.map((model) => model.id)).toEqual(["cached"]);

        await Bun.sleep(5);

        const stale = await refreshOpenAIProviderCatalog({
            provider: "fixture-provider",
            baseUrl: "https://fixture.example/v1",
            maxAgeMs: 1,
            cacheDir,
            fetch: async () => new Response("", { status: 503 }),
        });
        expect(stale).toMatchObject({
            status: "stale",
            failure: "unavailable",
        });
        expect(resultCatalog(stale).models.map((model) => model.id)).toEqual(["cached"]);
    } finally {
        rmSync(cacheDir, { recursive: true, force: true });
    }
});

test("a listing from a previous endpoint is not fresh and is not kept stale", async () => {
    const cacheDir = temporaryCache();
    try {
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "outrider",
            fetched_at: new Date().toISOString(),
            endpoint: "http://127.0.0.1:11438/v1/models",
            models: [{ id: "qwen3-1.7b", label: "qwen3-1.7b", levels: [] }],
        }, { cacheDir });
        let requested = "";
        const moved = await refreshOpenAIProviderCatalog({
            provider: "outrider",
            baseUrl: "http://127.0.0.1:11435/v1",
            maxAgeMs: 60_000,
            cacheDir,
            fetch: async (input) => {
                requested = String(input);
                return new Response(JSON.stringify({
                    data: [{ id: "qwen35-9b-provisional" }],
                }), { status: 200 });
            },
        });
        expect(requested).toBe("http://127.0.0.1:11435/v1/models");
        expect(moved.status).toBe("refreshed");
        expect(resultCatalog(moved).models.map((model) => model.id))
            .toEqual(["qwen35-9b-provisional"]);
        expect(resultCatalog(moved).endpoint)
            .toBe("http://127.0.0.1:11435/v1/models");

        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "outrider",
            fetched_at: new Date().toISOString(),
            endpoint: "http://127.0.0.1:11438/v1/models",
            models: [{ id: "qwen3-1.7b", label: "qwen3-1.7b", levels: [] }],
        }, { cacheDir });
        const failed = await refreshOpenAIProviderCatalog({
            provider: "outrider",
            baseUrl: "http://127.0.0.1:11435/v1",
            maxAgeMs: 0,
            cacheDir,
            fetch: async () => new Response("", { status: 503 }),
        });
        expect(failed).toEqual({ status: "failed", failure: "unavailable" });
        expect(readProviderCatalogSnapshot("outrider", { cacheDir }).models)
            .toMatchObject([{ id: "qwen3-1.7b" }]);
    } finally {
        rmSync(cacheDir, { recursive: true, force: true });
    }
});

test("an empty or unlisted endpoint is a normal type-a-model state", async () => {
    const cacheDir = temporaryCache();
    try {
        const result = await refreshOpenAIProviderCatalog({
            provider: "fixture-provider",
            baseUrl: "https://fixture.example/v1",
            cacheDir,
            fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
        });
        expect(result).toEqual({
            status: "failed",
            failure: "empty_response",
        });
    } finally {
        rmSync(cacheDir, { recursive: true, force: true });
    }
});

test("malformed optional discovery preserves a good snapshot", async () => {
    const cacheDir = temporaryCache();
    try {
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "omlx",
            fetched_at: "2026-08-24T00:00:00.000Z",
            endpoint: "http://127.0.0.1:8000/v1/models",
            models: [{ id: "kept", label: "Kept", levels: [] }],
        }, { cacheDir });

        const result = await refreshOpenAIProviderCatalog({
            provider: "omlx",
            baseUrl: "http://127.0.0.1:8000/v1",
            cacheDir,
            maxAgeMs: 0,
            preserveEmpty: true,
            fetch: async () => new Response("{}", { status: 200 }),
        });

        expect(result).toMatchObject({
            status: "stale",
            failure: "malformed_response",
        });
        expect(readProviderCatalogSnapshot("omlx", { cacheDir }).models)
            .toMatchObject([{ id: "kept" }]);
    } finally {
        rmSync(cacheDir, { recursive: true, force: true });
    }
});

test("a successful response reports when its snapshot cannot be saved", async () => {
    const directory = temporaryCache();
    const cacheDir = join(directory, "not-a-directory");
    writeFileSync(cacheDir, "occupied");
    try {
        const result = await refreshOpenAIProviderCatalog({
            provider: "fixture-provider",
            baseUrl: "https://fixture.example/v1",
            cacheDir,
            fetch: async () => new Response(JSON.stringify({
                data: [{ id: "model-a" }],
            }), { status: 200 }),
        });

        expect(result.status).toBe("persistence_failed");
        expect(resultCatalog(result).models.map((model) => model.id)).toEqual(["model-a"]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a Cerebras catalog layer reads the nested context limit", () => {
    const catalog = normalizeOpenAIModels("cerebras", {
        data: [{
            id: "gpt-oss-120b",
            name: "GPT OSS 120B",
            limits: { max_context_length: 131_072 },
        }],
    }, ["cerebras-models"]);

    expect(catalog.models[0]).toMatchObject({
        id: "gpt-oss-120b",
        context_window: 131_072,
    });
});

test("llama.cpp discovery reads the active context window", () => {
    const catalog = normalizeOpenAIModels("outrider", {
        data: [{
            id: "qwen3-1.7b",
            owned_by: "llamacpp",
            meta: { n_ctx: 32_768, n_ctx_train: 40_960 },
        }],
    });

    expect(catalog.models[0]).toMatchObject({
        id: "qwen3-1.7b",
        context_window: 32_768,
    });
});
