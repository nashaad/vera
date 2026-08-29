import {
    providerCatalogCacheDir,
    providerCatalogCachePath,
} from "./catalog-cache.ts";
import type {
    CatalogModel,
    ProviderCatalog,
    ReasoningLevel,
} from "./catalog-shape.ts";
import {
    loadRecommendedModels,
    type RecommendedModel,
} from "./recommended-models.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

interface SourceModel {
    readonly id: string;
    readonly label?: string;
    readonly description?: string;
    readonly order?: number;
    readonly context_window?: number;
    readonly created?: number;
    readonly tool_support?: boolean;
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
    /**
     * The curation that stamps `recommended` onto matching entries. Defaults to
     * the file Vera ships; passing a list keeps a caller (and a test) off disk.
     */
    readonly recommended?: readonly RecommendedModel[];
}

export function loadDiscoveryCatalog(
    provider: string,
    cacheDir = providerCatalogCacheDir(),
): ProviderCatalog | undefined {
    const catalog = loadDiscoverySource(provider, cacheDir);
    return catalog === undefined ? undefined : toProviderCatalog(catalog);
}

/**
 * What Vera knows about a provider's models. Discovery is the only source: a
 * provider is the authority on its own model list, and a list shipped in the
 * repo is out of date the day after it is written. A provider Vera has never
 * discovered yields an empty catalog rather than an error, which is the honest
 * answer to "what does this provider offer" before anyone has asked it.
 */
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
            .map((model) => withRecommendation(model, recommended))
            .sort(compareModels),
    };
}

/**
 * The shipped curation, read once. A missing or damaged file leaves every entry
 * unflagged: a recommendation is a note, so losing it must not cost the user
 * the model list itself.
 */
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
        || !optionalType(model.default_level, "string")
        || (model.levels !== undefined
            && (!Array.isArray(model.levels)
                || !model.levels.every(isReasoningLevel)))) {
        return undefined;
    }

    return model as unknown as SourceModel;
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
    const level = asRecord(value);
    return level !== undefined
        && typeof level.id === "string"
        && typeof level.label === "string"
        && optionalType(level.description, "string");
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
