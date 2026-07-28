/**
 * The client-facing projections of the model catalog (nash-50).
 *
 * Two lists reach a client, and they answer different questions.
 * `availableModels` is what can run right now, in catalog order. The pin list is
 * what the user chose to keep, newest pin first, and it keeps an entry that
 * cannot run right now rather than dropping it: the user put it there
 * deliberately, so only the user takes it out.
 *
 * Both carry the model's reasoning levels, resolved through
 * `effectiveCatalog`, so a client can show the levels of a model the user is
 * only looking at rather than only the one that is running. An empty level
 * list is a fact, not a gap: it means the model has no reasoning control.
 */

import { effectiveCatalog, type EffectiveCatalogOptions } from "./catalog.ts";
import type {
    CatalogModel,
    ReasoningLevel,
    ReasoningLevelId,
} from "./catalog-shape.ts";
import {
    readPins,
    resolvePins,
    type PinStoreOptions,
} from "./pin-store.ts";
import type { SuggestedModel } from "./supported-models.ts";

export interface AvailableModel {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly description: string;
    readonly contextWindow?: number;
    /** Empty means the model has no reasoning control at all. */
    readonly levels: readonly ReasoningLevel[];
    readonly defaultLevel?: ReasoningLevelId;
}

export interface PinnedModel {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    /** False when the model cannot run right now, never a reason to omit it. */
    readonly available: boolean;
    readonly description?: string;
    readonly contextWindow?: number;
    /** Empty means the model has no reasoning control, or is unavailable. */
    readonly levels: readonly ReasoningLevel[];
    readonly defaultLevel?: ReasoningLevelId;
}

export interface CatalogViewOptions
    extends PinStoreOptions, EffectiveCatalogOptions {}

/**
 * Adds each model's levels to the host's runnable list. Label and description
 * stay as the host supplied them: discovery knows names for models the shipped
 * catalog has never heard of, and the catalog must not overwrite them.
 */
export function availableModelsWithLevels(
    models: readonly SuggestedModel[],
    options: EffectiveCatalogOptions = {},
): readonly AvailableModel[] {
    const lookup = catalogLookup(options);
    return models.map((model) => {
        const catalogModel = lookup(model.provider, model.model);
        return {
            provider: model.provider,
            model: model.model,
            label: model.label,
            description: model.description,
            ...(model.contextWindow === undefined
                ? {}
                : { contextWindow: model.contextWindow }),
            levels: catalogModel?.levels ?? [],
            ...(catalogModel?.default_level === undefined
                ? {}
                : { defaultLevel: catalogModel.default_level }),
        };
    });
}

/**
 * Availability comes from the host's runnable list rather than the catalog:
 * the catalog still describes a model whose provider has no credentials, and
 * describing a model is not being able to run it. The facts still come from
 * the catalog, so a runnable model the catalog has never heard of falls back
 * to what the runnable list already knows about it.
 */
export function pinnedModels(
    available: readonly SuggestedModel[],
    options: CatalogViewOptions = {},
): readonly PinnedModel[] {
    const lookup = catalogLookup(options);
    const knownModels = new Map<string, CatalogModel>();
    for (const model of available) {
        knownModels.set(
            `${model.provider}/${model.model}`,
            lookup(model.provider, model.model)
                ?? suggestedAsCatalogModel(model),
        );
    }

    return resolvePins(readPins(options), knownModels).map((entry) => {
        if (entry.status === "unavailable") {
            return {
                provider: entry.provider,
                model: entry.model,
                label: entry.model,
                available: false,
                levels: [],
            };
        }
        const model = entry.catalogModel;
        return {
            provider: entry.provider,
            model: entry.model,
            label: model.label,
            available: true,
            ...(model.description === undefined
                ? {}
                : { description: model.description }),
            ...(model.context_window === undefined
                ? {}
                : { contextWindow: model.context_window }),
            levels: model.levels,
            ...(model.default_level === undefined
                ? {}
                : { defaultLevel: model.default_level }),
        };
    });
}

/** One catalog read per provider, however many models are looked up. */
function catalogLookup(
    options: EffectiveCatalogOptions,
): (provider: string, model: string) => CatalogModel | undefined {
    const catalogs = new Map<string, readonly CatalogModel[]>();
    return (provider, model) => {
        let models = catalogs.get(provider);
        if (models === undefined) {
            models = effectiveCatalog(provider, options).models;
            catalogs.set(provider, models);
        }
        return models.find((candidate) => candidate.id === model);
    };
}

function suggestedAsCatalogModel(model: SuggestedModel): CatalogModel {
    return {
        id: model.model,
        label: model.label,
        description: model.description,
        ...(model.contextWindow === undefined
            ? {}
            : { context_window: model.contextWindow }),
        levels: [],
    };
}
