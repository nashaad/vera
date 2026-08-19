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
    IMAGES_LEARNED_KEY,
    isCuratedPoolEntry,
    isVerifiedPoolEntry,
    type PoolFileModel,
    providerOf,
} from "./pool-file.ts";
import { poolNameOf } from "./pool-names.ts";
import { isSelectable, supportedEfforts } from "./pool-policy.ts";
import type { SuggestedModel } from "./supported-models.ts";
import type { ReductionReason } from "./catalog-reduction.ts";

export interface AvailableModel {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly description: string;
    readonly contextWindow?: number;
    /**
     * Why the picker folds this row away until the user reveals everything.
     * Absent means the row is shown.
     */
    readonly hiddenByDefault?: ReductionReason;
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
    /** The user's own name for this entry, when it has one. */
    readonly poolName?: string;
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
    /**
     * Whether the model takes image input, resolved the same way everything
     * else about it is. Absent means no source has said, which a row shows as
     * nothing rather than as a no.
     */
    readonly imageSupport?: boolean;
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
            ...(model.hiddenByDefault === undefined
                ? {}
                : { hiddenByDefault: model.hiddenByDefault }),
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
        const poolName = poolNameOf(file, id);
        const named = poolName === undefined ? {} : { poolName };
        const verified = isVerifiedPoolEntry(entry);
        const model = knownModels.get(id);
        if (model === undefined) {
            return [{
                provider,
                model: name,
                label: name,
                ...named,
                available: false,
                verified,
                levels: [],
            }];
        }
        const levels = resolvedLevels(model, entry);
        const imageSupport = entry?.images
            ?? entry?.learned?.[IMAGES_LEARNED_KEY]?.ok
            ?? model.image_support;
        return [{
            provider,
            model: name,
            label: model.label,
            ...named,
            available: true,
            verified,
            ...(model.description === undefined
                ? {}
                : { description: model.description }),
            ...(model.context_window === undefined
                ? {}
                : { contextWindow: model.context_window }),
            ...(imageSupport === undefined ? {} : { imageSupport }),
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

/**
 * Which level list applies to one model, given only the two projections a
 * client holds.
 *
 * A ready pool entry wins outright, including when its level list is empty:
 * admission narrowed it to what this key actually verified, and an empty
 * result there means the model has no reasoning control. Only when no ready
 * entry exists does the catalog answer, which is the case for a model the
 * pool never admitted, reached through the `/model <name>` escape hatch.
 *
 * This is the same precedence `publishedReasoningLevels` applies host-side,
 * over the wire projections instead of the files. Both exist because they read
 * different inputs; they must not read them in a different order.
 */
export function levelsForModel(
    provider: string | undefined,
    model: string,
    pooled: readonly PooledModel[] = [],
    available: readonly AvailableModel[] = [],
): {
    readonly levels: readonly ReasoningLevel[];
    readonly defaultLevel?: ReasoningLevelId;
} {
    const matches = (candidate: { provider: string; model: string }) =>
        candidate.model === model
        && (provider === undefined || candidate.provider === provider);
    const entry = pooled.find((candidate) =>
        matches(candidate) && candidate.available
    ) ?? available.find(matches);
    return {
        levels: entry?.levels ?? [],
        ...(entry?.defaultLevel === undefined
            ? {}
            : { defaultLevel: entry.defaultLevel }),
    };
}
