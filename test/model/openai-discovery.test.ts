import { expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "../../src/model/catalog-cache.ts";
import { refreshOpenAIProviderCatalog } from "../../src/model/openai-discovery.ts";

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
        expect(catalog?.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
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
        expect(fresh?.models.map((model) => model.id)).toEqual(["cached"]);

        const stale = await refreshOpenAIProviderCatalog({
            provider: "fixture-provider",
            baseUrl: "https://fixture.example/v1",
            maxAgeMs: 1,
            cacheDir,
            fetch: async () => new Response("", { status: 503 }),
        });
        expect(stale?.models.map((model) => model.id)).toEqual(["cached"]);
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
        expect(result).toBeUndefined();
    } finally {
        rmSync(cacheDir, { recursive: true, force: true });
    }
});
