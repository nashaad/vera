import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRecommendedModels } from "../../src/model/recommended-models.ts";

function tempCatalog(value: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), "vera-recommended-")), "r.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
}

test("the shipped recommendations parse and every entry is whole", () => {
    const recommended = loadRecommendedModels();

    expect(recommended.length).toBeGreaterThan(0);
    for (const entry of recommended) {
        expect(entry.provider.length).toBeGreaterThan(0);
        expect(entry.model.length).toBeGreaterThan(0);
    }
});

test("the shipped recommendations name each model at most once", () => {
    const keys = loadRecommendedModels().map((entry) =>
        `${entry.provider}/${entry.model}`
    );

    expect(new Set(keys).size).toBe(keys.length);
});

test("a damaged recommendations file is an error, not an empty list", () => {
    const path = tempCatalog({
        schema_version: 1,
        recommended: [{ provider: "openrouter" }],
    });

    expect(() => loadRecommendedModels(path)).toThrow(
        "Invalid recommended-models catalog",
    );
});

// One entry per model is what keeps the picker's Top picks view a filter: a
// model named twice would have to become two rows for the same model.
test("a model recommended twice is an error", () => {
    const path = tempCatalog({
        schema_version: 1,
        recommended: [
            { provider: "openrouter", model: "z-ai/glm-5.2", reasoning_effort: "high" },
            { provider: "openrouter", model: "z-ai/glm-5.2", reasoning_effort: "low" },
        ],
    });

    expect(() => loadRecommendedModels(path)).toThrow(
        "Invalid recommended-models catalog",
    );
});
