import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startingVeraConfig } from "../../src/config.ts";
import { connectedProviderCatalogs, modelsFromConnectedCatalogs } from "../../src/providers/catalog-state.ts";
import { writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";

test("disconnected providers cannot leak shipped models into an empty install", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "vera-catalog-state-"));
    try {
        const options = { cacheDir, env: {}, authStorage: { getCredential: () => undefined } };
        expect(connectedProviderCatalogs(undefined, options)).toEqual([]);
        expect(modelsFromConnectedCatalogs(startingVeraConfig(), [{ provider: "openrouter", model: "ghost", label: "Ghost", description: "" }], options)).toEqual([]);
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test("connected never-refreshed and refreshed empty catalogs are separate facts", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "vera-catalog-state-"));
    try {
        const config = { ...startingVeraConfig(), providers: { anthropic: { protocol: "anthropic-messages" as const, credential: "api_key" as const, base_url: "https://api.anthropic.com/v1" } } };
        const options = { cacheDir, env: {}, authStorage: { getCredential: (id: string) => id === "anthropic" ? { type: "api_key" as const, key: "test" } : undefined } };
        expect(connectedProviderCatalogs(config, options)).toEqual([{ id: "anthropic", label: "anthropic" }]);
        writeProviderCatalogSnapshot({ schema_version: 2, provider: "anthropic", models: [], fetched_at: "2026-09-06T00:00:00Z" }, { cacheDir });
        expect(connectedProviderCatalogs(config, options)[0]?.refreshedAt).toBeDefined();
        expect(modelsFromConnectedCatalogs(config, [], options)).toEqual([]);
        writeProviderCatalogSnapshot({ schema_version: 2, provider: "anthropic", models: [{ id: "one", label: "One", levels: [] }], fetched_at: "2026-09-06T00:01:00Z" }, { cacheDir });
        expect(modelsFromConnectedCatalogs(config, [], options).map((row) => row.model)).toEqual(["one"]);
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});
