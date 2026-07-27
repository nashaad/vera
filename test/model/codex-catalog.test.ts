import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    normalizeCodexModelCache,
    refreshCodexCatalog,
} from "../../src/model/codex-catalog.ts";
import { readProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import { effectiveCatalog } from "../../src/model/catalog.ts";

const fixturePath = new URL(
    "../fixtures/codex-models-cache.json",
    import.meta.url,
);
const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("normalizeCodexModelCache", () => {
    test("normalizes the Codex cache into the pinned catalog shape", () => {
        const catalog = normalizeCodexModelCache(fixture);
        const sol = catalog.models.find((model) => model.id === "gpt-5.6-sol");

        expect(catalog.schema_version).toBe(2);
        expect(catalog.provider).toBe("openai-codex");
        expect(catalog.fetched_at).toBe(
            (fixture as { fetched_at: string }).fetched_at,
        );
        expect(sol?.levels.map((level) => level.id)).toEqual([
            "ultra",
            "max",
            "xhigh",
            "high",
            "medium",
            "low",
        ]);
        expect(sol?.levels).toHaveLength(6);
    });

    test("stores levels strongest first, reversing Codex's own order", () => {
        const source = (fixture as {
            models: { slug: string; supported_reasoning_levels: unknown[] }[];
        }).models.find((model) => model.slug === "gpt-5.6-sol");
        const sol = normalizeCodexModelCache(fixture).models.find(
            (model) => model.id === "gpt-5.6-sol",
        );

        // Not a restatement of the case above: it pins the direction to the
        // source rather than to a hardcoded list, so a fixture refresh that
        // changes which levels exist still checks the thing that matters.
        expect(sol?.levels.map((level) => level.id)).toEqual(
            (source?.supported_reasoning_levels as { effort: string }[])
                .map((level) => level.effort)
                .reverse(),
        );
    });

    test("does not copy large unmapped fields", () => {
        const serialized = JSON.stringify(normalizeCodexModelCache(fixture));

        expect(serialized).not.toContain(
            "TRUNCATED_FOR_FIXTURE_large_system_prompt_must_never_be_copied",
        );
        expect(serialized).not.toContain("TRUNCATED_FOR_FIXTURE");
    });

    test("filters only models whose visibility is hide", () => {
        const catalog = normalizeCodexModelCache(fixture);
        const ids = catalog.models.map((model) => model.id);

        expect(ids).not.toContain("codex-auto-review");
        expect(ids).toContain("gpt-5.3-codex-spark");
    });

    test("returns an empty catalog for malformed input", () => {
        const malformed = [
            null,
            {},
            { models: "not an array" },
            { models: [123, null, { slug: 5 }] },
        ];

        for (const raw of malformed) {
            expect(() => normalizeCodexModelCache(raw)).not.toThrow();
            expect(normalizeCodexModelCache(raw).models).toEqual([]);
        }
    });
});

describe("refreshCodexCatalog", () => {
    const directories: string[] = [];

    function scratch(): string {
        const directory = mkdtempSync(join(tmpdir(), "vera-codex-"));
        directories.push(directory);
        return directory;
    }

    afterEach(() => {
        while (directories.length > 0) {
            rmSync(directories.pop()!, { recursive: true, force: true });
        }
    });

    test("republishes the Codex cache as a discovery snapshot", () => {
        const directory = scratch();
        const cachePath = join(directory, "models_cache.json");
        writeFileSync(cachePath, JSON.stringify(fixture));

        const catalog = refreshCodexCatalog({ cachePath, cacheDir: directory });
        const snapshot = readProviderCatalogSnapshot("openai-codex", {
            cacheDir: directory,
        });

        expect(catalog?.models.length).toBeGreaterThan(0);
        expect(snapshot.models.map((model) => model.id))
            .toEqual(catalog!.models.map((model) => model.id));
    });

    test("a snapshot it wrote is what the catalog then reads", () => {
        const directory = scratch();
        const cachePath = join(directory, "models_cache.json");
        writeFileSync(cachePath, JSON.stringify(fixture));

        refreshCodexCatalog({ cachePath, cacheDir: directory });
        const sol = effectiveCatalog("openai-codex", { cacheDir: directory })
            .models.find((model) => model.id === "gpt-5.6-sol");

        // The point of the whole slice: a model named in no Vera file arrives
        // with its levels, in the order every consumer expects.
        expect(sol?.label).toBe("GPT-5.6-Sol");
        expect(sol?.levels[0]?.id).toBe("ultra");
    });

    test("a missing or unreadable cache is not an error", () => {
        const directory = scratch();

        expect(refreshCodexCatalog({
            cachePath: join(directory, "absent.json"),
            cacheDir: directory,
        })).toBeUndefined();

        const malformed = join(directory, "malformed.json");
        writeFileSync(malformed, "{ not json");
        expect(refreshCodexCatalog({ cachePath: malformed, cacheDir: directory }))
            .toBeUndefined();
    });

    test("a cache with no usable models publishes nothing", () => {
        const directory = scratch();
        const cachePath = join(directory, "models_cache.json");
        writeFileSync(cachePath, JSON.stringify({ models: [] }));

        expect(refreshCodexCatalog({ cachePath, cacheDir: directory }))
            .toBeUndefined();
        expect(
            readProviderCatalogSnapshot("openai-codex", { cacheDir: directory })
                .models,
        ).toEqual([]);
    });
});
