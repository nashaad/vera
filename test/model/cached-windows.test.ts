import {
    afterEach,
    describe,
    expect,
    test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import type { CatalogModel, ProviderCatalog } from "../../src/model/catalog-shape.ts";
import {
    cachedContextWindow,
    cachedProviderModels,
    modelNameKey,
    readCachedWindowIndex,
    withCachedWindows,
} from "../../src/model/cached-windows.ts";
import type { SuggestedModel } from "../../src/model/supported-models.ts";

const temporaryDirectories: string[] = [];

function cacheDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-cached-windows-"));
    temporaryDirectories.push(directory);
    return directory;
}

function model(id: string, contextWindow?: number): CatalogModel {
    return {
        id,
        label: id,
        levels: [],
        ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
    };
}

function snapshot(provider: string, models: readonly CatalogModel[]): ProviderCatalog {
    return {
        schema_version: 2,
        provider,
        fetched_at: new Date().toISOString(),
        models,
    };
}

afterEach(() => {
    while (temporaryDirectories.length > 0) {
        rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
    }
});

describe("modelNameKey", () => {
    test("ignores word order", () => {
        expect(modelNameKey("claude-4.5-sonnet")).toBe(modelNameKey("claude-sonnet-4.5"));
    });

    test("ignores the serving namespace", () => {
        expect(modelNameKey("anthropic/claude-opus-5")).toBe(modelNameKey("claude-opus-5"));
    });

    test("keeps different models apart", () => {
        expect(modelNameKey("qwen3-1.7b")).not.toBe(modelNameKey("qwen3-32b"));
        expect(modelNameKey("llama-3-70b")).not.toBe(modelNameKey("llama-3-70b-instruct"));
    });
});

describe("readCachedWindowIndex", () => {
    test("resolves a window the supported-models catalog never carried", () => {
        const cacheDir = cacheDirectory();
        writeProviderCatalogSnapshot(
            snapshot("outrider_t1", [model("gemma4-26b", 32_768)]),
            { cacheDir },
        );
        const index = readCachedWindowIndex({ cacheDir });
        expect(cachedContextWindow("outrider_t1", "gemma4-26b", index)).toBe(32_768);
    });

    test("resolves across providers, because a window belongs to the model", () => {
        const cacheDir = cacheDirectory();
        writeProviderCatalogSnapshot(
            snapshot("openrouter", [model("anthropic/claude-sonnet-4.5", 200_000)]),
            { cacheDir },
        );
        const index = readCachedWindowIndex({ cacheDir });
        expect(cachedContextWindow("someone-else", "claude-4.5-sonnet", index))
            .toBe(200_000);
    });

    test("prefers the exact provider row over a cross-provider match", () => {
        const cacheDir = cacheDirectory();
        writeProviderCatalogSnapshot(
            snapshot("reseller", [model("qwen3-32b", 16_384)]),
            { cacheDir },
        );
        writeProviderCatalogSnapshot(
            snapshot("upstream", [model("qwen3-32b", 131_072)]),
            { cacheDir },
        );
        const index = readCachedWindowIndex({ cacheDir });
        expect(cachedContextWindow("upstream", "qwen3-32b", index)).toBe(131_072);
    });

    test("takes the smallest window when providers disagree and none matches", () => {
        const cacheDir = cacheDirectory();
        writeProviderCatalogSnapshot(
            snapshot("generous", [model("qwen3-32b", 131_072)]),
            { cacheDir },
        );
        writeProviderCatalogSnapshot(
            snapshot("stingy", [model("qwen3-32b", 16_384)]),
            { cacheDir },
        );
        const index = readCachedWindowIndex({ cacheDir });
        expect(cachedContextWindow("unknown", "qwen3-32b", index)).toBe(16_384);
    });

    test("returns nothing for a model no cache has seen", () => {
        const index = readCachedWindowIndex({ cacheDir: cacheDirectory() });
        expect(cachedContextWindow("outrider_t1", "not-a-model", index)).toBeUndefined();
    });

    test("skips models whose window is missing or not positive", () => {
        const cacheDir = cacheDirectory();
        writeProviderCatalogSnapshot(
            snapshot("odd", [model("no-window"), model("zero-window", 0)]),
            { cacheDir },
        );
        const index = readCachedWindowIndex({ cacheDir });
        expect(cachedContextWindow("odd", "no-window", index)).toBeUndefined();
        expect(cachedContextWindow("odd", "zero-window", index)).toBeUndefined();
    });
});

describe("withCachedWindows", () => {
    test("fills a bare configured row", () => {
        const cacheDir = cacheDirectory();
        writeProviderCatalogSnapshot(
            snapshot("outrider_t1", [model("gemma4-26b", 32_768)]),
            { cacheDir },
        );
        const rows: readonly SuggestedModel[] = [{
            provider: "outrider_t1",
            model: "gemma4-26b",
            label: "gemma4-26b",
            description: "configured model",
        }];
        const filled = withCachedWindows(rows, readCachedWindowIndex({ cacheDir }));
        expect(filled[0]?.contextWindow).toBe(32_768);
    });

    test("leaves a declared window alone", () => {
        const cacheDir = cacheDirectory();
        writeProviderCatalogSnapshot(
            snapshot("outrider_t1", [model("gemma4-26b", 32_768)]),
            { cacheDir },
        );
        const rows: readonly SuggestedModel[] = [{
            provider: "outrider_t1",
            model: "gemma4-26b",
            label: "gemma4-26b",
            description: "configured model",
            contextWindow: 8_192,
        }];
        const filled = withCachedWindows(rows, readCachedWindowIndex({ cacheDir }));
        expect(filled[0]?.contextWindow).toBe(8_192);
    });
});

describe("cachedProviderModels", () => {
    test("lists everything a hand-added endpoint served", () => {
        const cacheDir = cacheDirectory();
        writeProviderCatalogSnapshot(
            snapshot("outrider_t1", [
                model("gemma4-26b", 32_768),
                model("qwen3-1.7b", 32_768),
            ]),
            { cacheDir },
        );
        const known: readonly SuggestedModel[] = [{
            provider: "outrider_t1",
            model: "gemma4-26b",
            label: "gemma4-26b",
            description: "configured model",
        }];
        const added = cachedProviderModels(["outrider_t1"], known, { cacheDir });
        expect(added.map((row) => row.model)).toEqual(["qwen3-1.7b"]);
        expect(added[0]?.contextWindow).toBe(32_768);
    });

    test("ignores a cache whose provider is no longer configured", () => {
        const cacheDir = cacheDirectory();
        writeProviderCatalogSnapshot(
            snapshot("removed", [model("orphan", 4_096)]),
            { cacheDir },
        );
        expect(cachedProviderModels(["outrider_t1"], [], { cacheDir })).toEqual([]);
    });
});
