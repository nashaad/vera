import {
    afterEach,
    describe,
    expect,
    test,
} from "bun:test";
import {
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    providerCatalogCachePath,
    listDiscoveredProviders,
    readFreshProviderCatalogSnapshot,
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "../../src/model/catalog-cache.ts";
import type { ProviderCatalog } from "../../src/model/catalog-shape.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("provider catalog cache", () => {
    test("atomically writes and reads a snapshot", () => {
        const cacheDir = temporaryDirectory();
        const catalog: ProviderCatalog = {
            schema_version: 2,
            provider: "openai-codex",
            fetched_at: "2026-07-27T18:24:18.915220Z",
            models: [{
                id: "gpt-5.6-sol",
                label: "GPT-5.6-Sol",
                levels: [{
                    id: "high",
                    label: "High",
                }],
            }],
        };

        writeProviderCatalogSnapshot(catalog, { cacheDir });

        expect(readProviderCatalogSnapshot("openai-codex", { cacheDir }))
            .toEqual(catalog);
        expect(readdirSync(cacheDir).filter((name) => name.endsWith(".tmp")))
            .toEqual([]);
    });

    test("derives the filename from the provider", () => {
        const cacheDir = temporaryDirectory();

        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "openai-codex",
            models: [],
        }, { cacheDir });

        expect(readdirSync(cacheDir)).toEqual(["openai-codex.json"]);
        expect(providerCatalogCachePath("openai-codex", cacheDir))
            .toBe(join(cacheDir, "openai-codex.json"));
    });

    test("refuses provider ids that could leave the cache directory", () => {
        const cacheDir = temporaryDirectory();

        expect(() => providerCatalogCachePath("./../../config", cacheDir))
            .toThrow(/Unsafe provider catalog id/);
        expect(() =>
            writeProviderCatalogSnapshot({
                schema_version: 2,
                provider: "./../../config",
                models: [],
            }, { cacheDir })
        ).toThrow(/Unsafe provider catalog id/);
    });

    test("returns an empty catalog when the file is missing", () => {
        const cacheDir = temporaryDirectory();

        expect(() =>
            readProviderCatalogSnapshot("example", { cacheDir })
        ).not.toThrow();
        expect(readProviderCatalogSnapshot("example", { cacheDir })).toEqual({
            schema_version: 2,
            provider: "example",
            models: [],
        });
    });

    test("returns an empty catalog for malformed JSON", () => {
        const cacheDir = temporaryDirectory();
        writeFileSync(join(cacheDir, "example.json"), "not json");

        expect(() =>
            readProviderCatalogSnapshot("example", { cacheDir })
        ).not.toThrow();
        expect(readProviderCatalogSnapshot("example", { cacheDir })).toEqual({
            schema_version: 2,
            provider: "example",
            models: [],
        });
    });

    test("returns an empty catalog for an invalid catalog shape", () => {
        const cacheDir = temporaryDirectory();
        writeFileSync(
            join(cacheDir, "example.json"),
            JSON.stringify({ foo: "bar" }),
        );

        expect(() =>
            readProviderCatalogSnapshot("example", { cacheDir })
        ).not.toThrow();
        expect(readProviderCatalogSnapshot("example", { cacheDir })).toEqual({
            schema_version: 2,
            provider: "example",
            models: [],
        });
    });

    test("keeps listed pricing through a snapshot write and read", () => {
        const cacheDir = temporaryDirectory();
        const catalog: ProviderCatalog = {
            schema_version: 2,
            provider: "openrouter",
            fetched_at: "2026-08-29T00:00:00Z",
            models: [{
                id: "vendor/model",
                label: "Vendor: Model",
                pricing: { input: 3, output: 15 },
                levels: [],
            }],
        };

        writeProviderCatalogSnapshot(catalog, { cacheDir });
        expect(readProviderCatalogSnapshot("openrouter", { cacheDir }))
            .toEqual(catalog);
    });

    test("does not treat the WebDev Arena cache as a provider catalog", () => {
        const cacheDir = temporaryDirectory();
        writeFileSync(join(cacheDir, "webdev-arena.json"), "{}");
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "openrouter",
            models: [],
        }, { cacheDir });

        expect(listDiscoveredProviders({ cacheDir })).toEqual(["openrouter"]);
    });

    test("a snapshot for a different endpoint is not fresh", () => {
        const cacheDir = temporaryDirectory();
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "outrider",
            fetched_at: new Date().toISOString(),
            endpoint: "http://127.0.0.1:11438/v1/models",
            models: [{ id: "qwen3-1.7b", label: "qwen3-1.7b", levels: [] }],
        }, { cacheDir });

        expect(readFreshProviderCatalogSnapshot(
            "outrider",
            60_000,
            { cacheDir },
            "http://127.0.0.1:11435/v1/models",
        )).toBeUndefined();
        expect(readFreshProviderCatalogSnapshot(
            "outrider",
            60_000,
            { cacheDir },
            "http://127.0.0.1:11438/v1/models",
        )?.models.map((model) => model.id)).toEqual(["qwen3-1.7b"]);
    });
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-catalog-cache-"));
    temporaryDirectories.push(directory);
    return directory;
}
