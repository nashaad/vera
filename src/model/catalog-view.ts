
import { effectiveCatalog, type EffectiveCatalogOptions } from "./catalog.ts";
import type {
    CatalogModel,
    ModelPricing,
    ReasoningLevel,
    ReasoningLevelId,
} from "./catalog-shape.ts";
import {
    loadPoolFile,
    type LoadPoolFileOptions,
} from "./pool-file-loader.ts";
import {
    IMAGES_LEARNED_KEY,
    effortLearnedKey,
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
    readonly pricing?: ModelPricing;
    readonly waScore?: number;
    readonly onPareto?: boolean;
    readonly imageSupport?: boolean;
    readonly refreshable?: boolean;
    readonly verified?: boolean;
    readonly verificationError?: string;
    readonly hiddenByDefault?: ReductionReason;
    readonly levels: readonly ReasoningLevel[];
    readonly defaultLevel?: ReasoningLevelId;
    readonly recommended?: boolean;
    readonly recommendedLevel?: ReasoningLevelId;
}

export interface PooledModel {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly poolName?: string;
    readonly displayName?: string;
    readonly available: boolean;
    readonly verified: boolean;
    readonly description?: string;
    readonly contextWindow?: number;
    readonly pricing?: ModelPricing;
    readonly waScore?: number;
    readonly onPareto?: boolean;
    readonly imageSupport?: boolean;
    readonly levels: readonly ReasoningLevel[];
    readonly defaultLevel?: ReasoningLevelId;
    readonly recommended?: boolean;
    readonly recommendedLevel?: ReasoningLevelId;
}

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
    extends LoadPoolFileOptions, EffectiveCatalogOptions {
    readonly includeUncurated?: boolean;
}

/** Adds each model's levels to the host's runnable list. Label and description stay as the host supplied them: discovery knows names for models the shipped catalog has never. */
export function availableModelsWithLevels(
    models: readonly SuggestedModel[],
    options: CatalogViewOptions = {},
): readonly AvailableModel[] {
    const lookup = catalogLookup(options);
    const file = loadPoolFile(options).merged;
    return models.map((model) => {
        const catalogModel = lookup(model.provider, model.model);
        const entry = file.models[`${model.provider}/${model.model}`];
        const levels = admittedLevels(catalogModel?.levels ?? [], entry);
        return {
            provider: model.provider,
            model: model.model,
            label: entry?.displayName ?? model.label,
            ...(entry?.learned?.probe === undefined ? {} : { verified: isVerifiedPoolEntry(entry) }),
            ...(entry?.learned?.probe?.error === undefined ? {} : { verificationError: entry.learned.probe.error }),
            description: model.description,
            ...(model.contextWindow === undefined
                ? {}
                : { contextWindow: model.contextWindow }),
            ...(catalogModel?.pricing === undefined
                ? {}
                : { pricing: catalogModel.pricing }),
            ...(catalogModel?.image_support === undefined
                ? {}
                : { imageSupport: catalogModel.image_support }),
            ...(model.refreshable === true ? { refreshable: true } : {}),
            ...(model.hiddenByDefault === undefined
                ? {}
                : { hiddenByDefault: model.hiddenByDefault }),
            levels,
            ...(catalogModel?.default_level === undefined
                    || !levels.some(
                        (level) => level.id === catalogModel.default_level,
                    )
                ? {}
                : { defaultLevel: catalogModel.default_level }),
            ...recommendation(catalogModel),
        };
    });
}

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
            || (!options.includeUncurated && !isCuratedPoolEntry(entry))
        ) {
            return [];
        }
        const name = id.slice(provider.length + 1);
        const poolName = poolNameOf(file, id);
        const named = { ...(poolName === undefined ? {} : { poolName }),
            ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }) };
        const verified = isVerifiedPoolEntry(entry);
        const model = knownModels.get(id);
        if (model === undefined) {
            return [{
                provider,
                model: name,
                label: entry.displayName ?? name,
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
            label: entry.displayName ?? model.label,
            ...named,
            available: true,
            verified,
            ...(model.description === undefined
                ? {}
                : { description: model.description }),
            ...(model.context_window === undefined
                ? {}
                : { contextWindow: model.context_window }),
            ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
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

/** Ordered strongest first. Callers reverse; none may re-derive order from names. */
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
            const fromCatalog = model.levels.find(
                (level) => level.id === resolution.level,
            ) ?? model.levels.find(
                (level) => (level.wire ?? level.id) === wire,
            );
            return [
                fromCatalog ?? {
                    id: resolution.level,
                    label: resolution.level,
                    ...(wire === resolution.level ? {} : { wire }),
                },
            ];
        },
    ).reverse();
}

function isAdmitted(level: string, entry: PoolFileModel | undefined): boolean {
    if (entry === undefined) {
        return true;
    }
    if (entry.efforts !== undefined && level in entry.efforts) {
        return entry.efforts[level] !== null;
    }
    return entry.learned?.[effortLearnedKey(level)]?.ok !== false;
}

function admittedLevels(
    levels: readonly ReasoningLevel[],
    entry: PoolFileModel | undefined,
): readonly ReasoningLevel[] {
    return levels.filter((level) => isAdmitted(level.id, entry));
}

export function admittedEffortIds<T extends string>(
    provider: string,
    model: string,
    levels: readonly T[],
    options: CatalogViewOptions = {},
): readonly T[] {
    const entry = loadPoolFile(options).merged.models[`${provider}/${model}`];
    if (entry === undefined) {
        return levels;
    }
    return levels.filter((level) => isAdmitted(level, entry));
}

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

/** Which level list applies to one model, given only the two projections a client holds. */
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
