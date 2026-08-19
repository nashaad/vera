import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    DEFAULT_CATALOG_MAX_AGE_MS,
    readFreshProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "../../src/model/catalog-cache.ts";
import type { ProviderCatalog } from "../../src/model/catalog-shape.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function cacheDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-freshness-"));
    directories.push(directory);
    return directory;
}

function snapshot(fetchedAt?: string): ProviderCatalog {
    return {
        schema_version: 2,
        provider: "openrouter",
        ...(fetchedAt === undefined ? {} : { fetched_at: fetchedAt }),
        models: [{ id: "vendor/model", label: "Model", levels: [] }],
    };
}

function ago(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
}

describe("readFreshProviderCatalogSnapshot", () => {
    test("a young snapshot answers without asking the provider", () => {
        const cacheDir_ = cacheDir();
        writeProviderCatalogSnapshot(snapshot(ago(60_000)), {
            cacheDir: cacheDir_,
        });

        expect(
            readFreshProviderCatalogSnapshot("openrouter", 3_600_000, {
                cacheDir: cacheDir_,
            })?.models,
        ).toHaveLength(1);
    });

    test("an old snapshot does not", () => {
        const cacheDir_ = cacheDir();
        writeProviderCatalogSnapshot(
            snapshot(ago(DEFAULT_CATALOG_MAX_AGE_MS + 60_000)),
            { cacheDir: cacheDir_ },
        );

        expect(readFreshProviderCatalogSnapshot(
            "openrouter",
            DEFAULT_CATALOG_MAX_AGE_MS,
            { cacheDir: cacheDir_ },
        )).toBeUndefined();
    });

    test("a snapshot that cannot say when it was taken is never fresh", () => {
        const cacheDir_ = cacheDir();
        writeProviderCatalogSnapshot(snapshot(), { cacheDir: cacheDir_ });

        expect(readFreshProviderCatalogSnapshot("openrouter", 3_600_000, {
            cacheDir: cacheDir_,
        })).toBeUndefined();
    });

    test("a date in the future is stale, not fresh forever", () => {
        const cacheDir_ = cacheDir();
        writeProviderCatalogSnapshot(snapshot(ago(-86_400_000)), {
            cacheDir: cacheDir_,
        });

        // A clock that jumped forward once must not pin a list in place.
        expect(readFreshProviderCatalogSnapshot("openrouter", 3_600_000, {
            cacheDir: cacheDir_,
        })).toBeUndefined();
    });

    test("an empty snapshot is never fresh, so the picker is never empty", () => {
        const cacheDir_ = cacheDir();
        writeProviderCatalogSnapshot({
            ...snapshot(ago(60_000)),
            models: [],
        }, { cacheDir: cacheDir_ });

        expect(readFreshProviderCatalogSnapshot("openrouter", 3_600_000, {
            cacheDir: cacheDir_,
        })).toBeUndefined();
    });

    test("a zero age always asks, which is the manual refresh", () => {
        const cacheDir_ = cacheDir();
        writeProviderCatalogSnapshot(snapshot(ago(1_000)), {
            cacheDir: cacheDir_,
        });

        expect(readFreshProviderCatalogSnapshot("openrouter", 0, {
            cacheDir: cacheDir_,
        })).toBeUndefined();
    });

    test("a missing snapshot asks", () => {
        expect(readFreshProviderCatalogSnapshot("openrouter", 3_600_000, {
            cacheDir: cacheDir(),
        })).toBeUndefined();
    });
});
