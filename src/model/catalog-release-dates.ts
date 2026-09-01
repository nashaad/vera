import type { CatalogModel, ProviderCatalog } from "./catalog-shape.ts";

export function mergeCatalogReleaseDates(
    fetched: ProviderCatalog,
    held: ProviderCatalog | undefined,
): ProviderCatalog {
    if (held === undefined) {
        return fetched;
    }
    const dates = new Map<string, number>();
    for (const model of held.models) {
        if (model.created !== undefined) {
            dates.set(model.id, model.created);
        }
    }
    if (dates.size === 0) {
        return fetched;
    }
    return {
        ...fetched,
        models: fetched.models.map((model) => withHeldDate(model, dates)),
    };
}

function withHeldDate(
    model: CatalogModel,
    dates: ReadonlyMap<string, number>,
): CatalogModel {
    const held = dates.get(model.id);
    if (held === undefined || held === model.created) {
        return model;
    }
    return { ...model, created: held };
}
