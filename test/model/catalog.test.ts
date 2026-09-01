import { expect, test } from "bun:test";
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    effectiveCatalog,
    loadDiscoveryCatalog,
} from "../../src/model/catalog.ts";

function withDiscovery(
    discovery: unknown,
    run: (cacheDir: string) => void,
): void {
    const directory = mkdtempSync(join(tmpdir(), "vera-catalog-"));
    const cacheDir = join(directory, "cache");
    mkdirSync(cacheDir);
    if (typeof discovery === "string") {
        writeFileSync(join(cacheDir, "test.json"), discovery);
    } else if (discovery !== undefined) {
        writeFileSync(join(cacheDir, "test.json"), JSON.stringify(discovery));
    }

    try {
        run(cacheDir);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function snapshot(models: unknown[]): unknown {
    return {
        schema_version: 2,
        provider: "test",
        fetched_at: "2026-07-27T00:00:00Z",
        models,
    };
}

test("reads what discovery published for the provider", () => {
    withDiscovery(
        snapshot([{
            id: "discovered",
            label: "Discovered",
            context_window: 128000,
            levels: [{ id: "high", label: "High" }],
        }]),
        (cacheDir) => {
            expect(effectiveCatalog("test", { cacheDir }).models).toEqual([{
                id: "discovered",
                label: "Discovered",
                context_window: 128000,
                levels: [{ id: "high", label: "High" }],
            }]);
        },
    );
});

test("a provider nobody has discovered yet has no models, not an error", () => {
    withDiscovery(undefined, (cacheDir) => {
        expect(effectiveCatalog("test", { cacheDir }).models).toEqual([]);
        expect(loadDiscoveryCatalog("test", cacheDir)).toBeUndefined();
    });
});

test("a damaged snapshot reads as no models rather than throwing", () => {
    withDiscovery("{not json", (cacheDir) => {
        expect(effectiveCatalog("test", { cacheDir }).models).toEqual([]);
        expect(loadDiscoveryCatalog("test", cacheDir)).toBeUndefined();
    });
});

test("orders defined values first and breaks ties by label", () => {
    withDiscovery(
        snapshot([
            { id: "three", label: "Three", order: 3, levels: [] },
            { id: "one", label: "One", order: 1, levels: [] },
            { id: "zulu", label: "Zulu", levels: [] },
            { id: "alpha", label: "Alpha", levels: [] },
        ]),
        (cacheDir) => {
            expect(
                effectiveCatalog("test", { cacheDir })
                    .models.map((model) => model.id),
            ).toEqual(["one", "three", "alpha", "zulu"]);
        },
    );
});

test("drops model entries without a usable id", () => {
    withDiscovery(
        snapshot([
            { label: "Missing", levels: [] },
            { id: "", label: "Empty", levels: [] },
            { id: "valid", label: "Valid", levels: [] },
        ]),
        (cacheDir) => {
            expect(
                effectiveCatalog("test", { cacheDir })
                    .models.map((model) => model.id),
            ).toEqual(["valid"]);
        },
    );
});

test("Ollama thinking models get overlay vocabulary, not High/Medium/Low", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-catalog-"));
    const cacheDir = join(directory, "cache");
    mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, "ollama.json"), JSON.stringify({
        schema_version: 2,
        provider: "ollama",
        models: [{
            id: "qwen3:latest",
            label: "qwen3:latest",
            thinking_support: true,
            levels: [],
        }, {
            id: "gpt-oss:20b",
            label: "gpt-oss:20b",
            thinking_support: true,
            levels: [
                { id: "high", label: "High" },
                { id: "medium", label: "Medium" },
                { id: "low", label: "Low" },
            ],
        }],
    }));
    try {
        const qwen = effectiveCatalog("ollama", { cacheDir }).models
            .find((model) => model.id === "qwen3:latest");
        expect(qwen?.levels.map((level) => level.id)).toEqual([
            "max",
            "high",
            "medium",
            "low",
            "off",
        ]);
        expect(qwen?.levels.find((level) => level.id === "off")?.wire).toBe("none");

        const gptOss = effectiveCatalog("ollama", { cacheDir }).models
            .find((model) => model.id === "gpt-oss:20b");
        expect(gptOss?.levels.map((level) => level.id)).toEqual([
            "high",
            "medium",
            "low",
        ]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
