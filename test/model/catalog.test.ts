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

function withFixtures(
    curated: unknown,
    discovery: unknown,
    run: (curatedPath: string, cacheDir: string) => void,
): void {
    const directory = mkdtempSync(join(tmpdir(), "vera-catalog-"));
    const curatedPath = join(directory, "models.json");
    const cacheDir = join(directory, "cache");
    mkdirSync(cacheDir);
    writeFileSync(curatedPath, JSON.stringify(curated));
    if (typeof discovery === "string") {
        writeFileSync(join(cacheDir, "test.json"), discovery);
    } else if (discovery !== undefined) {
        writeFileSync(join(cacheDir, "test.json"), JSON.stringify(discovery));
    }

    try {
        run(curatedPath, cacheDir);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function catalog(models: unknown[]): unknown {
    return [{ schema_version: 2, provider: "test", models }];
}

function snapshot(models: unknown[]): unknown {
    return {
        schema_version: 2,
        provider: "test",
        fetched_at: "2026-07-27T00:00:00Z",
        models,
    };
}

test("merges overlapping models field by field with discovery winning", () => {
    withFixtures(
        catalog([{
            id: "shared",
            label: "Curated",
            description: "kept from curated",
            levels: [],
        }]),
        snapshot([{
            id: "shared",
            label: "Discovered",
            context_window: 128000,
            levels: [],
        }]),
        (curatedPath, cacheDir) => {
            expect(effectiveCatalog("test", {
                curatedPath,
                cacheDir,
            }).models).toEqual([{
                id: "shared",
                label: "Discovered",
                description: "kept from curated",
                context_window: 128000,
                levels: [],
            }]);
        },
    );
});

test("malformed discovery falls back exactly to curated models", () => {
    withFixtures(
        catalog([{ id: "curated", label: "Curated", levels: [] }]),
        "{not json",
        (curatedPath, cacheDir) => {
            const result = effectiveCatalog("test", {
                curatedPath,
                cacheDir,
            });
            expect(result.models).toEqual([
                { id: "curated", label: "Curated", levels: [] },
            ]);
            expect(loadDiscoveryCatalog("test", cacheDir)).toBeUndefined();
        },
    );
});

test("missing curated file still returns valid discovery models", () => {
    withFixtures(
        catalog([]),
        snapshot([{
            id: "discovered",
            label: "Discovered",
            levels: [],
        }]),
        (curatedPath, cacheDir) => {
            expect(effectiveCatalog("test", {
                curatedPath: `${curatedPath}.missing`,
                cacheDir,
            }).models).toEqual([{
                id: "discovered",
                label: "Discovered",
                levels: [],
            }]);
        },
    );
});

test("orders defined values first and breaks ties by label", () => {
    withFixtures(
        catalog([
            { id: "three", label: "Three", order: 3, levels: [] },
            { id: "one", label: "One", order: 1, levels: [] },
            { id: "zulu", label: "Zulu", levels: [] },
            { id: "alpha", label: "Alpha", levels: [] },
        ]),
        undefined,
        (curatedPath, cacheDir) => {
            expect(effectiveCatalog("test", {
                curatedPath,
                cacheDir,
            }).models.map((model) => model.id)).toEqual([
                "one",
                "three",
                "alpha",
                "zulu",
            ]);
        },
    );
});

test("replaces levels as one field and falls back for empty levels", () => {
    const curatedLevels = [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
    ];
    withFixtures(
        catalog([
            { id: "replace", label: "Replace", levels: curatedLevels },
            { id: "fallback", label: "Fallback", levels: curatedLevels },
        ]),
        snapshot([
            {
                id: "replace",
                label: "Replace",
                levels: [{ id: "c", label: "C" }],
            },
            { id: "fallback", label: "Fallback", levels: [] },
        ]),
        (curatedPath, cacheDir) => {
            const models = effectiveCatalog("test", {
                curatedPath,
                cacheDir,
            }).models;
            expect(models.find((model) => model.id === "replace")?.levels)
                .toEqual([{ id: "c", label: "C" }]);
            expect(models.find((model) => model.id === "fallback")?.levels)
                .toEqual(curatedLevels);
        },
    );
});

test("overlays curated descriptions onto discovery's level set by id", () => {
    withFixtures(
        catalog([{
            id: "described",
            label: "Described",
            levels: [
                { id: "low", label: "Low", description: "curated low" },
                { id: "high", label: "High", description: "curated high" },
            ],
        }]),
        snapshot([{
            id: "described",
            label: "Described",
            levels: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
            ],
        }]),
        (curatedPath, cacheDir) => {
            const models = effectiveCatalog("test", {
                curatedPath,
                cacheDir,
            }).models;
            expect(models.find((model) => model.id === "described")?.levels)
                .toEqual([
                    { id: "low", label: "Low", description: "curated low" },
                    { id: "high", label: "High", description: "curated high" },
                ]);
        },
    );
});

test("drops a curated level id that discovery does not announce", () => {
    withFixtures(
        catalog([{
            id: "narrowed",
            label: "Narrowed",
            levels: [
                { id: "low", label: "Low", description: "curated low" },
                { id: "extinct", label: "Extinct", description: "gone" },
            ],
        }]),
        snapshot([{
            id: "narrowed",
            label: "Narrowed",
            levels: [{ id: "low", label: "Low" }],
        }]),
        (curatedPath, cacheDir) => {
            const models = effectiveCatalog("test", {
                curatedPath,
                cacheDir,
            }).models;
            expect(models.find((model) => model.id === "narrowed")?.levels)
                .toEqual([
                    { id: "low", label: "Low", description: "curated low" },
                ]);
        },
    );
});

test("drops model entries without a usable id", () => {
    withFixtures(
        catalog([
            { label: "Missing", levels: [] },
            { id: "", label: "Empty", levels: [] },
            { id: "valid", label: "Valid", levels: [] },
        ]),
        snapshot([]),
        (curatedPath, cacheDir) => {
            expect(effectiveCatalog("test", {
                curatedPath,
                cacheDir,
            }).models.map((model) => model.id)).toEqual(["valid"]);
        },
    );
});
