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
