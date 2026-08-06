import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    availableModelsWithLevels,
    pooledModels,
} from "../../src/model/catalog-view.ts";
import {
    addPoolEntry,
    type PoolVerification,
} from "../../src/model/pool-store.ts";
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

test("ready entries keep pool order and narrow levels to the verified ones", () => {
    const options = fixture();
    addPoolEntry({
        provider: "test",
        model: "no-levels",
        verification: verification([]),
    }, options);
    addPoolEntry({
        provider: "test",
        model: "with-levels",
        verification: verification([
            { vera_effort: "high", provider_effort: "high" },
        ]),
    }, options);

    // Admission verified only "high", so the catalog's "low" is not served.
    expect(pooledModels([
        suggested("test", "no-levels"),
        suggested("test", "with-levels"),
    ], options)).toEqual([
        {
            provider: "test",
            model: "with-levels",
            label: "With levels",
            available: true,
            status: "ready",
            description: "catalog description",
            contextWindow: 200_000,
            levels: [{ id: "high", label: "High", description: "slow" }],
            defaultLevel: "high",
        },
        {
            provider: "test",
            model: "no-levels",
            label: "No levels",
            available: true,
            status: "ready",
            levels: [],
        },
    ]);
});

test("an unverified entry is never available, even when the provider lists it", () => {
    const options = fixture();
    addPoolEntry({ provider: "test", model: "with-levels" }, options);

    expect(pooledModels([
        suggested("test", "with-levels"),
    ], options)).toEqual([{
        provider: "test",
        model: "with-levels",
        label: "With levels",
        available: false,
        status: "needs_verify",
        description: "catalog description",
        contextWindow: 200_000,
        levels: [
            { id: "low", label: "Low" },
            { id: "high", label: "High", description: "slow" },
        ],
        defaultLevel: "high",
    }]);
});

test("a needs-reverify record demotes a verified entry to needs_verify", () => {
    const options = fixture();
    addPoolEntry({
        provider: "test",
        model: "no-levels",
        verification: { ...verification([]), needs_reverify: true },
    }, options);

    expect(pooledModels([
        suggested("test", "no-levels"),
    ], options)).toEqual([{
        provider: "test",
        model: "no-levels",
        label: "No levels",
        available: false,
        status: "needs_verify",
        levels: [],
    }]);
});

test("a pooled model that cannot run right now stays in the list, flagged", () => {
    const options = fixture();
    addPoolEntry({
        provider: "test",
        model: "with-levels",
        verification: verification([
            { vera_effort: "high", provider_effort: "high" },
        ]),
    }, options);
    addPoolEntry({ provider: "gone", model: "forgotten" }, options);

    // The catalog still describes `with-levels`, but the host cannot run it,
    // so it is unavailable rather than absent, whatever its admission record.
    expect(pooledModels([], options)).toEqual([
        {
            provider: "gone",
            model: "forgotten",
            label: "forgotten",
            available: false,
            status: "needs_verify",
            levels: [],
        },
        {
            provider: "test",
            model: "with-levels",
            label: "with-levels",
            available: false,
            status: "ready",
            levels: [],
        },
    ]);
});

test("a runnable model the catalog never heard of keeps the host's facts", () => {
    const options = fixture();
    addPoolEntry({
        provider: "test",
        model: "unknown-to-catalog",
        verification: verification([]),
    }, options);

    expect(pooledModels([
        { ...suggested("test", "unknown-to-catalog"), contextWindow: 8_192 },
    ], options)).toEqual([{
        provider: "test",
        model: "unknown-to-catalog",
        label: "Unknown to catalog",
        available: true,
        status: "ready",
        description: "a model",
        contextWindow: 8_192,
        levels: [],
    }]);
});

function fixture(): {
    readonly path: string;
    readonly cacheDir: string;
} {
    const directory = mkdtempSync(join(tmpdir(), "vera-catalog-view-"));
    directories.push(directory);
    const cacheDir = join(directory, "cache");
    mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, "test.json"), JSON.stringify({
        schema_version: 2,
        provider: "test",
        fetched_at: "2026-07-27T00:00:00Z",
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
    }));
    return { path: join(directory, "config.json"), cacheDir };
}

function verification(
    levels: PoolVerification["levels"],
): PoolVerification {
    return {
        verified_at: "2026-08-01T00:00:00.000Z",
        response_model: "response-model",
        levels,
        checked: "user_key",
    };
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
