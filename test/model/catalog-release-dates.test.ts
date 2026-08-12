import { expect, test } from "bun:test";

import type { ProviderCatalog } from "../../src/model/catalog-shape.ts";
import { mergeCatalogReleaseDates } from "../../src/model/catalog-release-dates.ts";

function catalog(
    models: readonly { id: string; created?: number }[],
): ProviderCatalog {
    return {
        schema_version: 2,
        provider: "openrouter",
        models: models.map((model) => ({
            ...model,
            label: model.id,
            levels: [],
        })),
    };
}

test("a date already held is kept over a later listing that disagrees", () => {
    const merged = mergeCatalogReleaseDates(
        catalog([{ id: "vendor/model", created: 2_000 }]),
        catalog([{ id: "vendor/model", created: 1_000 }]),
    );
    expect(merged.models[0]?.created).toBe(1_000);
});

test("a model Vera has never dated takes the date it was just given", () => {
    const merged = mergeCatalogReleaseDates(
        catalog([{ id: "vendor/new", created: 2_000 }]),
        catalog([{ id: "vendor/old", created: 1_000 }]),
    );
    expect(merged.models[0]?.created).toBe(2_000);
});

test("a first fetch with nothing held through is the fetch itself", () => {
    const fetched = catalog([{ id: "vendor/model", created: 2_000 }]);
    expect(mergeCatalogReleaseDates(fetched, undefined)).toBe(fetched);
});

test("a held model the provider stopped dating keeps its date", () => {
    const merged = mergeCatalogReleaseDates(
        catalog([{ id: "vendor/model" }]),
        catalog([{ id: "vendor/model", created: 1_000 }]),
    );
    expect(merged.models[0]?.created).toBe(1_000);
});
