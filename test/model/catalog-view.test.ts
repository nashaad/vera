import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    availableModelsWithLevels,
    pinnedModels,
} from "../../src/model/catalog-view.ts";
import { addPin } from "../../src/model/pin-store.ts";
import type { SuggestedModel } from "../../src/model/supported-models.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("available models carry the catalog levels and default level", () => {
    const options = fixture();

    expect(availableModelsWithLevels([
        suggested("test", "with-levels"),
        suggested("test", "no-levels"),
        suggested("test", "unknown-to-catalog"),
    ], options)).toEqual([
        {
            provider: "test",
            model: "with-levels",
            label: "With levels",
            description: "a model",
            levels: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", description: "slow" },
            ],
            defaultLevel: "high",
        },
        {
            provider: "test",
            model: "no-levels",
            label: "No levels",
            description: "a model",
            levels: [],
        },
        {
            provider: "test",
            model: "unknown-to-catalog",
            label: "Unknown to catalog",
            description: "a model",
            levels: [],
        },
    ]);
});

test("pinned keeps its own order and resolves facts through the catalog", () => {
    const options = fixture();
    addPin({ provider: "test", model: "no-levels" }, options);
    addPin({ provider: "test", model: "with-levels" }, options);

    expect(pinnedModels([
        suggested("test", "no-levels"),
        suggested("test", "with-levels"),
    ], options)).toEqual([
        {
            provider: "test",
            model: "with-levels",
            label: "With levels",
            available: true,
            description: "catalog description",
            contextWindow: 200_000,
            levels: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", description: "slow" },
            ],
            defaultLevel: "high",
        },
        {
            provider: "test",
            model: "no-levels",
            label: "No levels",
            available: true,
            levels: [],
        },
    ]);
});

test("a pinned model that cannot run right now stays in the list, flagged", () => {
    const options = fixture();
    addPin({ provider: "test", model: "with-levels" }, options);
    addPin({ provider: "gone", model: "forgotten" }, options);

    // The catalog still describes `with-levels`, but the host cannot run it,
    // so it is unavailable rather than absent.
    expect(pinnedModels([], options)).toEqual([
        {
            provider: "gone",
            model: "forgotten",
            label: "forgotten",
            available: false,
            levels: [],
        },
        {
            provider: "test",
            model: "with-levels",
            label: "with-levels",
            available: false,
            levels: [],
        },
    ]);
});

test("a runnable model the catalog never heard of keeps the host's facts", () => {
    const options = fixture();
    addPin({ provider: "test", model: "unknown-to-catalog" }, options);

    expect(pinnedModels([
        { ...suggested("test", "unknown-to-catalog"), contextWindow: 8_192 },
    ], options)).toEqual([{
        provider: "test",
        model: "unknown-to-catalog",
        label: "Unknown to catalog",
        available: true,
        description: "a model",
        contextWindow: 8_192,
        levels: [],
    }]);
});

function fixture(): {
    readonly path: string;
    readonly curatedPath: string;
    readonly cacheDir: string;
} {
    const directory = mkdtempSync(join(tmpdir(), "vera-catalog-view-"));
    directories.push(directory);
    const curatedPath = join(directory, "models.json");
    const cacheDir = join(directory, "cache");
    mkdirSync(cacheDir);
    writeFileSync(curatedPath, JSON.stringify([{
        schema_version: 2,
        provider: "test",
        models: [
            {
                id: "with-levels",
                label: "With levels",
                description: "catalog description",
                order: 1,
                context_window: 200_000,
                default_level: "high",
                levels: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High", description: "slow" },
                ],
            },
            { id: "no-levels", label: "No levels", order: 2 },
        ],
    }]));
    return { path: join(directory, "config.json"), curatedPath, cacheDir };
}

function suggested(provider: string, model: string): SuggestedModel {
    return {
        provider,
        model,
        label: model === "with-levels"
            ? "With levels"
            : model === "no-levels"
                ? "No levels"
                : "Unknown to catalog",
        description: "a model",
    };
}
