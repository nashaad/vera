import type { VeraConfig } from "../config.ts";
import { readProviderCatalogSnapshot, type ProviderCatalogCacheOptions } from "../model/catalog-cache.ts";
import { reduceModels } from "../model/catalog-reduction.ts";
import type { SuggestedModel } from "../model/supported-models.ts";
import { configuredProviders, isProviderConnected, type ProviderConnectionOptions } from "./registry.ts";

export interface ProviderCatalogState {
    readonly id: string;
    readonly label: string;
    readonly refreshedAt?: string;
}

export function connectedProviderCatalogs(config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined,
    options: ProviderConnectionOptions & ProviderCatalogCacheOptions = {}): readonly ProviderCatalogState[] {
    return configuredProviders(config).flatMap((provider) => {
        if (!isProviderConnected(provider, options)) return [];
        const snapshot = readProviderCatalogSnapshot(provider.id, options);
        // A shipped local endpoint is a possibility until it has answered or been configured.
        if ((provider.credential === "none" || provider.credential === "api_key_optional")
            && !provider.custom && !provider.endpointOverridden && snapshot.fetched_at === undefined) return [];
        return [{ id: provider.id, label: provider.label,
            ...(snapshot.fetched_at === undefined ? {} : { refreshedAt: snapshot.fetched_at }) }];
    });
}

export function modelsFromConnectedCatalogs(config: VeraConfig, models: readonly SuggestedModel[],
    options: ProviderConnectionOptions & ProviderCatalogCacheOptions = {}): readonly SuggestedModel[] {
    const descriptors = configuredProviders(config);
    return connectedProviderCatalogs(config, options).flatMap((provider) => {
        const snapshot = readProviderCatalogSnapshot(provider.id, options);
        if (snapshot.fetched_at === undefined) {
            return descriptors.find((row) => row.id === provider.id)?.credential === "oauth"
                ? models.filter((model) => model.provider === provider.id) : [];
        }
        // Catalog refreshes must retain the same reduction policy as initial discovery.
        const hidden = descriptors.find((row) => row.id === provider.id)?.behaviorId === "openrouter"
            ? reduceModels(snapshot.models, {
                now: Math.floor(Date.now() / 1000),
                ...(config.model_picker_max_age_months === undefined ? {} : { maxAgeMonths: config.model_picker_max_age_months }),
                collapseVersions: config.model_picker_collapse_versions === true,
                keep: new Set(snapshot.models.filter((model) => model.recommended).map((model) => model.id)),
            }) : undefined;
        return snapshot.models.map((model) => ({ provider: provider.id, model: model.id,
            label: model.label, description: model.description ?? "", refreshable: true,
            ...(hidden?.has(model.id) ? { hiddenByDefault: hidden.get(model.id) } : {}),
            ...(model.created === undefined ? {} : { created: model.created }),
            ...(model.context_window === undefined ? {} : { contextWindow: model.context_window }) }));
    });
}
