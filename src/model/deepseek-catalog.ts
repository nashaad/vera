import {
    writeProviderCatalogSnapshot,
} from "./catalog-cache.ts";
import type {
    CatalogModel,
    ProviderCatalog,
    ReasoningLevel,
} from "./catalog-shape.ts";

const PROVIDER = "deepseek";

const REASONING_LEVELS: readonly ReasoningLevel[] = [
    { id: "max", label: "Max" },
    { id: "high", label: "High" },
    { id: "off", label: "Off" },
];

const MODELS: readonly CatalogModel[] = [
    {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        description: "native DeepSeek reasoning model",
        context_window: 1_000_000,
        tool_support: true,
        default_level: "high",
        levels: REASONING_LEVELS,
    },
    {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        description: "native DeepSeek fast reasoning model",
        context_window: 1_000_000,
        tool_support: true,
        default_level: "high",
        levels: REASONING_LEVELS,
    },
];

export function refreshDeepSeekCatalog(
    options: { readonly cacheDir?: string } = {},
): ProviderCatalog {
    const catalog: ProviderCatalog = {
        schema_version: 2,
        provider: PROVIDER,
        fetched_at: new Date().toISOString(),
        models: MODELS,
    };
    try {
        writeProviderCatalogSnapshot(catalog, options);
    } catch {
        // A cache write failure must not hide models the provider can still run.
    }
    return catalog;
}

export function deepSeekCatalogModels(): readonly CatalogModel[] {
    return MODELS;
}
