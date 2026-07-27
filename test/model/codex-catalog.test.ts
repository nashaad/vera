import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { normalizeCodexModelCache } from "../../src/model/codex-catalog.ts";

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
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
        ]);
        expect(sol?.levels).toHaveLength(6);
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
