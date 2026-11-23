import { loadOptionalVeraConfig, updateVeraConfigDefaults, type VeraCustomProviderConfig } from "../config.ts";
import { writeProviderCatalogSnapshot } from "../model/catalog-cache.ts";
import { deepSeekCatalogModels } from "../model/deepseek-catalog.ts";
import type { ProviderCatalog } from "../model/catalog-shape.ts";
import { normalizeOpenRouterModels } from "../model/openrouter-catalog.ts";
import type { AuthStorage } from "./auth-storage.ts";
import { readModelCatalog } from "./read-model-catalog.ts";
import { findConfiguredProvider, isProviderConnected } from "./registry.ts";

export interface SaveProviderInput {
    readonly id: string;
    readonly declaration: VeraCustomProviderConfig;
    readonly apiKey?: string;
    readonly editing?: string;
    readonly replaces?: string;
    readonly shipped?: boolean;
    readonly restore?: boolean;
}

export interface SaveProviderResult {
    readonly label: string;
    readonly modelCount: number;
}

export function mergedProviderDeclaration(
    previous: VeraCustomProviderConfig | undefined,
    edited: VeraCustomProviderConfig,
): VeraCustomProviderConfig {
    if (previous === undefined) return edited;
    const merged: VeraCustomProviderConfig = { ...previous, ...edited };
    if (previous.protocol === edited.protocol) return merged;
    const { thinking: _thinking, cache: _cache, ...portable } = merged;
    return portable;
}

export interface SaveProviderOptions {
    readonly configPath?: string;
    readonly cacheDir?: string;
}

export async function saveProvider(input: SaveProviderInput, authStorage: AuthStorage, options: SaveProviderOptions = {}): Promise<SaveProviderResult> {
    const config = loadOptionalVeraConfig({ path: options.configPath });
    const provider = findConfiguredProvider(input.id, config);
    if (input.editing === undefined && provider !== undefined
        && isProviderConnected(provider, { authStorage })
        && provider.credential !== "none") throw new Error(`${input.id} is already connected`);
    const stored = authStorage.getCredential(input.id);
    const key = input.apiKey ?? (stored?.type === "api_key" ? stored.key : undefined)
        ?? (provider?.envVar === undefined ? undefined : process.env[provider.envVar]);
    if (input.declaration.credential === "api_key" && !key) throw new Error("Missing API key");
    const catalog = await readModelCatalog({ provider: input.id, baseUrl: input.declaration.base_url,
        ...(provider?.behaviorId === "openrouter" ? { normalize: normalizeOpenRouterModels } : {}),
        protocol: input.declaration.protocol, ...(key === undefined ? {} : { apiKey: key }) });
    updateVeraConfigDefaults(
        input.shipped === true
            ? { provider_endpoint: { id: input.id, url: input.restore === true ? null : input.declaration.base_url } }
            : { custom_provider: { id: input.id, declaration: mergedProviderDeclaration(
                input.editing === undefined ? undefined : config?.providers?.[input.editing], input.declaration,
            ) } },
        { path: options.configPath },
    );
    if (input.apiKey !== undefined) authStorage.setCredential(input.id, { type: "api_key", key: input.apiKey });
    if (input.id === "deepseek") {
        const bundledCatalog: ProviderCatalog = {
            schema_version: 2,
            provider: "deepseek",
            fetched_at: new Date().toISOString(),
            models: deepSeekCatalogModels(),
        };
        writeProviderCatalogSnapshot(bundledCatalog, { cacheDir: options.cacheDir });
    } else {
        writeProviderCatalogSnapshot(catalog, { cacheDir: options.cacheDir });
    }
    if (input.replaces !== undefined) {
        updateVeraConfigDefaults({ custom_provider: { id: input.replaces, declaration: null } }, { path: options.configPath });
        authStorage.deleteCredential(input.replaces);
    }
    return { label: provider?.label ?? input.id, modelCount: catalog.models.length };
}
