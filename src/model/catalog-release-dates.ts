import type { CatalogModel, ProviderCatalog } from "./catalog-shape.ts";

/**
 * Carries release dates forward from the snapshot Vera already holds onto a
 * freshly fetched catalog.
 *
 * A model cannot become newer than it already is, so a date is resolved once
 * for an id and then kept. The first date seen wins: a model that is delisted
 * and relisted receives a new listing date from the provider, and the original
 * is the truer answer to how long the model has been around.
 *
 * The consequence is deliberate. Vera's stored date can disagree with what the
 * provider currently reports, and that disagreement is the point rather than
 * drift to be corrected.
 */
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
