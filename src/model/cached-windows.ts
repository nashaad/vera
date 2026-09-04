import {
    listDiscoveredProviders,
    type ProviderCatalogCacheOptions,
    readProviderCatalogSnapshot,
} from "./catalog-cache.ts";
import type { SuggestedModel } from "./supported-models.ts";

/**
 * A model name reduced to its sorted parts, so `claude-4.5-sonnet` and
 * `claude-sonnet-4.5` land on the same key. Any leading namespace is dropped,
 * because a window belongs to the model rather than to who serves it.
 */
export function modelNameKey(model: string): string {
    const slash = model.lastIndexOf("/");
    return (slash === -1 ? model : model.slice(slash + 1))
        .toLowerCase()
        .split(/[^a-z0-9.]+/)
        .filter((part) => part.length > 0)
        .sort()
        .join("-");
}

export interface CachedWindowIndex {
    readonly exact: ReadonlyMap<string, number>;
    readonly byName: ReadonlyMap<string, number>;
}

export const EMPTY_CACHED_WINDOW_INDEX: CachedWindowIndex = {
    exact: new Map(),
    byName: new Map(),
};

function keepSmaller(
    into: Map<string, number>,
    key: string,
    window: number,
): void {
    const existing = into.get(key);
    if (existing === undefined || window < existing) {
        into.set(key, window);
    }
}

/**
 * Every context window the discovery caches know about. Providers that
 * disagree about a model resolve to the smallest window on offer: compacting
 * earlier than needed costs a summary, claiming a window the endpoint will not
 * serve costs the turn.
 */
export function readCachedWindowIndex(
    options: ProviderCatalogCacheOptions = {},
): CachedWindowIndex {
    const exact = new Map<string, number>();
    const byName = new Map<string, number>();
    for (const provider of listDiscoveredProviders(options)) {
        for (const model of readProviderCatalogSnapshot(provider, options).models) {
            const window = model.context_window;
            if (window === undefined || !(window > 0)) continue;
            keepSmaller(exact, `${provider}/${model.id}`, window);
            keepSmaller(byName, modelNameKey(model.id), window);
        }
    }
    return { exact, byName };
}

export function cachedContextWindow(
    provider: string | undefined,
    model: string,
    index: CachedWindowIndex,
): number | undefined {
    if (provider !== undefined) {
        const window = index.exact.get(`${provider}/${model}`);
        if (window !== undefined) return window;
    }
    return index.byName.get(modelNameKey(model));
}

export function withCachedWindows(
    models: readonly SuggestedModel[],
    index: CachedWindowIndex,
): readonly SuggestedModel[] {
    return models.map((model) => {
        if (model.contextWindow !== undefined) return model;
        const window = cachedContextWindow(model.provider, model.model, index);
        return window === undefined ? model : { ...model, contextWindow: window };
    });
}

/**
 * Cached models for providers whose descriptor does not declare discovery, so
 * a hand-added endpoint lists everything it served rather than only the one
 * model that happens to be configured.
 */
export function cachedProviderModels(
    providers: readonly string[],
    known: readonly SuggestedModel[],
    options: ProviderCatalogCacheOptions = {},
): readonly SuggestedModel[] {
    const seen = new Set(known.map((model) => `${model.provider}/${model.model}`));
    const discovered = new Set(listDiscoveredProviders(options));
    const added: SuggestedModel[] = [];
    for (const provider of providers) {
        if (!discovered.has(provider)) continue;
        for (const model of readProviderCatalogSnapshot(provider, options).models) {
            const id = `${provider}/${model.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            added.push({
                provider,
                model: model.id,
                label: model.label,
                description: model.description ?? "discovered model",
                ...(model.context_window === undefined
                    ? {}
                    : { contextWindow: model.context_window }),
                ...(model.image_support === undefined
                    ? {}
                    : { imageSupport: model.image_support }),
            });
        }
    }
    return added;
}
