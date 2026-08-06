/**
 * The client-facing projections of the model catalog (nash-50).
 *
 * Two lists reach a client, and they answer different questions.
 * `availableModels` is what discovery describes, in catalog order. The pool is
 * the runtime set the user admitted, newest first, and it keeps an entry that
 * cannot run right now rather than dropping it: the user put it there
 * deliberately, so only the user takes it out.
 *
 * Both carry the model's reasoning levels, resolved through
 * `effectiveCatalog`, narrowed by whatever the pool entry declares or has
 * learned. An empty level list is a fact, not a gap: it means the model has
 * no reasoning control.
 */

import { effectiveCatalog, type EffectiveCatalogOptions } from "./catalog.ts";
import type {
    CatalogModel,
    ReasoningLevel,
    ReasoningLevelId,
} from "./catalog-shape.ts";
import {
    loadPoolFile,
    type LoadPoolFileOptions,
} from "./pool-file-loader.ts";
import {
    isCuratedPoolEntry,
    isVerifiedPoolEntry,
    type PoolFileModel,
    providerOf,
} from "./pool-file.ts";
import { isSelectable, supportedEfforts } from "./pool-policy.ts";
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
    /** True on a model Vera's shipped curation recommends. */
    readonly recommended?: boolean;
    /** The level the curation recommends it at. A note, not a gate. */
    readonly recommendedLevel?: ReasoningLevelId;
}

export interface PooledModel {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    /**
     * False when the model cannot run right now, never a reason to omit it.
     * Availability is about the provider still listing the model, not about
     * evidence: an unverified entry is usable the moment it is admitted.
     */
    readonly available: boolean;
    /**
     * True once a probe or a live rejection has established facts about this
     * model on this key. False is not a warning, only an absence of evidence.
     */
    readonly verified: boolean;
    readonly description?: string;
    readonly contextWindow?: number;
    /** Empty means the model has no reasoning control, or is unavailable. */
    readonly levels: readonly ReasoningLevel[];
    readonly defaultLevel?: ReasoningLevelId;
    /** True on a model Vera's shipped curation recommends. */
    readonly recommended?: boolean;
    /** The level the curation recommends it at. A note, not a gate. */
    readonly recommendedLevel?: ReasoningLevelId;
}

/** The recommendation an entry carries, in the client-facing spelling. */
function recommendation(
    model: CatalogModel | undefined,
): Pick<AvailableModel, "recommended" | "recommendedLevel"> {
    if (model?.recommended !== true) {
        return {};
    }
    return {
        recommended: true,
        ...(model.recommended_level === undefined
            ? {}
            : { recommendedLevel: model.recommended_level }),
    };
}

export interface CatalogViewOptions
    extends LoadPoolFileOptions, EffectiveCatalogOptions {}

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
            ...recommendation(catalogModel),
        };
    });
}

/**
 * Availability comes from the host's runnable list rather than the catalog:
 * the catalog still describes a model whose provider has no credentials, and
 * describing a model is not being able to run it. The facts still come from
 * the catalog, so a runnable model the catalog has never heard of falls back
 * to what the runnable list already knows about it. An entry's level list is
 * the catalog's levels resolved through the pool's own precedence, so a level
 * a probe or a live rejection ruled out drops away.
 */
export function pooledModels(
    available: readonly SuggestedModel[],
    options: CatalogViewOptions = {},
): readonly PooledModel[] {
    const lookup = catalogLookup(options);
    const knownModels = new Map<string, CatalogModel>();
    for (const model of available) {
        knownModels.set(
            `${model.provider}/${model.model}`,
            lookup(model.provider, model.model)
                ?? suggestedAsCatalogModel(model),
        );
    }

    const file = loadPoolFile(options).merged;

    return Object.entries(file.models).flatMap(([id, entry]): PooledModel[] => {
        const provider = providerOf(id);
        if (
            provider === undefined || !isSelectable(id, file)
            || !isCuratedPoolEntry(entry)
        ) {
            return [];
        }
        const name = id.slice(provider.length + 1);
        const verified = isVerifiedPoolEntry(entry);
        const model = knownModels.get(id);
        if (model === undefined) {
            return [{
                provider,
                model: name,
                label: name,
                available: false,
                verified,
                levels: [],
            }];
        }
        const levels = resolvedLevels(model, entry);
        return [{
            provider,
            model: name,
            label: model.label,
            available: true,
            verified,
            ...(model.description === undefined
                ? {}
                : { description: model.description }),
            ...(model.context_window === undefined
                ? {}
                : { contextWindow: model.context_window }),
            levels,
            ...(model.default_level === undefined
                    || !levels.some((level) => level.id === model.default_level)
                ? {}
                : { defaultLevel: model.default_level }),
            ...recommendation(model),
        }];
    });
}

/**
 * The levels an entry may actually be asked for, resolved through the
 * pool's own precedence. The catalog supplies each level's presentation where
 * it knows the level; a level only the pool knows shows its wire string.
 *
 * Two ladder levels can resolve to one wire string, which is one choice for
 * the user however many ladder rungs reach it, so the first wins and the
 * repeat is dropped.
 */
function resolvedLevels(
    model: CatalogModel,
    entry: PoolFileModel,
): readonly ReasoningLevel[] {
    const seen = new Set<string>();
    return supportedEfforts({ entry, catalogModel: model }).flatMap(
        (resolution) => {
            const wire = resolution.wire;
            if (wire === undefined || seen.has(wire)) {
                return [];
            }
            seen.add(wire);
            return [
                model.levels.find((level) => level.id === wire)
                    ?? { id: wire, label: resolution.level },
            ];
        },
    );
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
