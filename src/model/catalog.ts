import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    providerCatalogCacheDir,
    providerCatalogCachePath,
} from "./catalog-cache.ts";
import type {
    CatalogModel,
    ProviderCatalog,
    ReasoningLevel,
} from "./catalog-shape.ts";

const CATALOG_PATH = fileURLToPath(
    new URL("../../config/models.json", import.meta.url),
);

interface SourceModel {
    readonly id: string;
    readonly label?: string;
    readonly description?: string;
    readonly order?: number;
    readonly context_window?: number;
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
    readonly curatedPath?: string;
    readonly cacheDir?: string;
}

export function loadCuratedCatalog(
    path = CATALOG_PATH,
): ProviderCatalog[] {
    return loadCuratedSource(path).map(toProviderCatalog);
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
    const curated = loadCuratedSource(options.curatedPath)
        .find((catalog) => catalog.provider === provider);
    const discovery = loadDiscoverySource(provider, options.cacheDir);
    const models = new Map<string, SourceModel>();

    for (const model of curated?.models ?? []) {
        models.set(model.id, model);
    }
    for (const model of discovery?.models ?? []) {
        const existing = models.get(model.id);
        models.set(model.id, existing === undefined
            ? model
            : mergeSourceModels(existing, model));
    }

    return {
        schema_version: 2,
        provider,
        models: [...models.values()]
            .map(toCatalogModel)
            .filter((model): model is CatalogModel => model !== undefined)
            .sort(compareModels),
    };
}

function loadCuratedSource(path = CATALOG_PATH): SourceCatalog[] {
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(value)) {
            return [];
        }
        const catalogs = value.map(parseCatalog);
        return catalogs.every(
            (catalog): catalog is SourceCatalog => catalog !== undefined,
        ) ? catalogs : [];
    } catch {
        return [];
    }
}

function loadDiscoverySource(
    provider: string,
    cacheDir = providerCatalogCacheDir(),
): SourceCatalog | undefined {
    try {
        const value: unknown = JSON.parse(
            readFileSync(providerCatalogCachePath(provider, cacheDir), "utf8"),
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

function mergeSourceModels(
    curated: SourceModel,
    discovery: SourceModel,
): SourceModel {
    return {
        id: discovery.id,
        ...(discovery.label !== undefined
            ? { label: discovery.label }
            : curated.label !== undefined
                ? { label: curated.label }
                : {}),
        ...(discovery.description !== undefined
            ? { description: discovery.description }
            : curated.description !== undefined
                ? { description: curated.description }
                : {}),
        ...(discovery.order !== undefined
            ? { order: discovery.order }
            : curated.order !== undefined
                ? { order: curated.order }
                : {}),
        ...(discovery.context_window !== undefined
            ? { context_window: discovery.context_window }
            : curated.context_window !== undefined
                ? { context_window: curated.context_window }
                : {}),
        ...(discovery.tool_support !== undefined
            ? { tool_support: discovery.tool_support }
            : curated.tool_support !== undefined
                ? { tool_support: curated.tool_support }
                : {}),
        ...(discovery.default_level !== undefined
            ? { default_level: discovery.default_level }
            : curated.default_level !== undefined
                ? { default_level: curated.default_level }
                : {}),
        ...(discovery.levels !== undefined && discovery.levels.length > 0
            ? { levels: mergeLevels(curated.levels ?? [], discovery.levels) }
            : curated.levels !== undefined
                ? { levels: curated.levels }
                : {}),
    };
}

/**
 * Discovery decides which levels exist: the set is atomic and never gains an
 * id curated didn't announce. Within that set, curated fills in a label or
 * description discovery left out, matched by level id. A curated level whose
 * id is absent from the discovery set is dropped, not carried forward.
 */
function mergeLevels(
    curated: readonly ReasoningLevel[],
    discovery: readonly ReasoningLevel[],
): readonly ReasoningLevel[] {
    const curatedById = new Map(curated.map((level) => [level.id, level]));
    return discovery.map((level) => {
        const curatedLevel = curatedById.get(level.id);
        if (curatedLevel === undefined) {
            return level;
        }
        return {
            id: level.id,
            label: level.label,
            ...(level.description !== undefined
                ? { description: level.description }
                : curatedLevel.description !== undefined
                    ? { description: curatedLevel.description }
                    : {}),
        };
    });
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
