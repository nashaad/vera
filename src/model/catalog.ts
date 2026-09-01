import {
    providerCatalogCacheDir,
    providerCatalogCachePath,
} from "./catalog-cache.ts";
import type {
    CatalogModel,
    ModelPricing,
    ProviderCatalog,
    ReasoningLevel,
} from "./catalog-shape.ts";
import {
    loadRecommendedModels,
    type RecommendedModel,
} from "./recommended-models.ts";
import {
    joinSettingsOverlay,
    overlayCatalogLevels,
    type SettingsOverlay,
} from "./settings-overlay.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

interface SourceModel {
    readonly id: string;
    readonly label?: string;
    readonly description?: string;
    readonly order?: number;
    readonly context_window?: number;
    readonly created?: number;
    readonly tool_support?: boolean;
    readonly image_support?: boolean;
    readonly thinking_support?: boolean;
    readonly pricing?: ModelPricing;
    readonly default_level?: string;
    readonly levels?: readonly ReasoningLevel[];
}

interface SourceCatalog {
    readonly schema_version: 2;
    readonly provider: string;
    readonly fetched_at?: string;
    readonly models: readonly SourceModel[];
}

export interface EffectiveCatalogOptions {
    readonly cacheDir?: string;
    readonly recommended?: readonly RecommendedModel[];
    /** Test seam. Absent reads the shipped overlay file. */
    readonly overlay?: SettingsOverlay;
}

export function loadDiscoveryCatalog(
    provider: string,
    cacheDir = providerCatalogCacheDir(),
): ProviderCatalog | undefined {
    const catalog = loadDiscoverySource(provider, cacheDir);
    return catalog === undefined ? undefined : toProviderCatalog(catalog);
}

export function effectiveCatalog(
    provider: string,
    options: EffectiveCatalogOptions = {},
): ProviderCatalog {
    const discovery = loadDiscoverySource(provider, options.cacheDir);
    const recommended = recommendationsFor(
        provider,
        options.recommended ?? shippedRecommendations(),
    );
    return {
        schema_version: 2,
        provider,
        models: (discovery?.models ?? [])
            .map(toCatalogModel)
            .filter((model): model is CatalogModel => model !== undefined)
            .map((model) => withSettingsOverlay(provider, model, options.overlay))
            .map((model) => withRecommendation(model, recommended))
            .sort(compareModels),
    };
}

function withSettingsOverlay(
    provider: string,
    model: CatalogModel,
    overlay?: SettingsOverlay,
): CatalogModel {
    const liveThinking = model.thinking_support === true || model.levels.length > 0;
    const row = joinSettingsOverlay({
        provider,
        listingId: model.id,
        liveThinking,
        ...(overlay === undefined ? {} : { overlay }),
    });
    if (row === undefined) return model;
    return {
        ...model,
        levels: overlayCatalogLevels(row),
    };
}

/** A missing recommendation file must not cost the user the model list. */
let shipped: readonly RecommendedModel[] | undefined;

function shippedRecommendations(): readonly RecommendedModel[] {
    if (shipped === undefined) {
        try {
            shipped = loadRecommendedModels();
        } catch {
            shipped = [];
        }
    }
    return shipped;
}

function recommendationsFor(
    provider: string,
    recommended: readonly RecommendedModel[],
): Map<string, RecommendedModel> {
    return new Map(
        recommended
            .filter((entry) => entry.provider === provider)
            .map((entry) => [entry.model, entry] as const),
    );
}

function withRecommendation(
    model: CatalogModel,
    recommended: Map<string, RecommendedModel>,
): CatalogModel {
    const entry = recommended.get(model.id);
    if (entry === undefined) {
        return model;
    }
    return {
        ...model,
        recommended: true,
        ...(entry.reasoning_effort === undefined
            ? {}
            : { recommended_level: entry.reasoning_effort }),
    };
}

function loadDiscoverySource(
    provider: string,
    cacheDir = providerCatalogCacheDir(),
): SourceCatalog | undefined {
    try {
        const value: unknown = JSON.parse(
            readRegularFileTextSync(
                providerCatalogCachePath(provider, cacheDir),
            ),
        );
        const catalog = parseCatalog(value);
        return catalog?.provider === provider ? catalog : undefined;
    } catch {
        return undefined;
    }
}

function parseCatalog(value: unknown): SourceCatalog | undefined {
    const catalog = asRecord(value);
    if (catalog === undefined
        || catalog.schema_version !== 2
        || typeof catalog.provider !== "string"
        || !Array.isArray(catalog.models)
        || (catalog.fetched_at !== undefined
            && typeof catalog.fetched_at !== "string")) {
        return undefined;
    }

    return {
        schema_version: 2,
        provider: catalog.provider,
        ...(catalog.fetched_at === undefined
            ? {}
            : { fetched_at: catalog.fetched_at as string }),
        models: catalog.models
            .map(parseModel)
            .filter((model): model is SourceModel => model !== undefined),
    };
}

function parseModel(value: unknown): SourceModel | undefined {
    const model = asRecord(value);
    if (model === undefined
        || typeof model.id !== "string"
        || model.id.length === 0
        || !optionalType(model.label, "string")
        || !optionalType(model.description, "string")
        || !optionalType(model.order, "number")
        || !optionalType(model.context_window, "number")
        || !optionalType(model.created, "number")
        || !optionalType(model.tool_support, "boolean")
        || !optionalType(model.image_support, "boolean")
        || !optionalType(model.thinking_support, "boolean")
        || !optionalType(model.default_level, "string")
        || (model.levels !== undefined
            && (!Array.isArray(model.levels)
                || !model.levels.every(isReasoningLevel)))) {
        return undefined;
    }

    const { pricing: rawPricing, ...rest } = model;
    const pricing = optionalPricing(rawPricing);
    return {
        ...rest,
        ...(pricing === undefined ? {} : { pricing }),
    } as unknown as SourceModel;
}

/** A malformed pricing object is omitted for that row. It must not drop the model, and it must not empty the catalog. */
function optionalPricing(value: unknown): ModelPricing | undefined {
    if (value === undefined) {
        return undefined;
    }
    const pricing = asRecord(value);
    if (
        pricing === undefined
        || !nonNegativeFinite(pricing.input)
        || !nonNegativeFinite(pricing.output)
    ) {
        return undefined;
    }
    return {
        input: pricing.input,
        output: pricing.output,
        ...(nonNegativeFinite(pricing.cache) ? { cache: pricing.cache } : {}),
    };
}

function nonNegativeFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
    const level = asRecord(value);
    return level !== undefined
        && typeof level.id === "string"
        && typeof level.label === "string"
        && optionalType(level.description, "string")
        && optionalType(level.wire, "string");
}

function toProviderCatalog(catalog: SourceCatalog): ProviderCatalog {
    const models: CatalogModel[] = [];
    for (const model of catalog.models) {
        if (model.label === undefined) {
            continue;
        }
        models.push({
            ...model,
            label: model.label,
            levels: model.levels ?? [],
        });
    }
    return {
        schema_version: 2,
        provider: catalog.provider,
        ...(catalog.fetched_at === undefined
            ? {}
            : { fetched_at: catalog.fetched_at }),
        models,
    };
}

function toCatalogModel(model: SourceModel): CatalogModel | undefined {
    if (model.label === undefined) {
        return undefined;
    }
    return {
        ...model,
        label: model.label,
        levels: model.levels ?? [],
    };
}

function compareModels(left: CatalogModel, right: CatalogModel): number {
    if (left.order !== right.order) {
        if (left.order === undefined) {
            return 1;
        }
        if (right.order === undefined) {
            return -1;
        }
        return left.order - right.order;
    }
    return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
}

function optionalType(
    value: unknown,
    type: "boolean" | "number" | "string",
): boolean {
    return value === undefined || typeof value === type;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
