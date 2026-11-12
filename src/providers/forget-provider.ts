import { rmSync } from "node:fs";
import { configuredModelAssignments, startingVeraConfig, loadOptionalVeraConfig, updateVeraConfigDefaults } from "../config.ts";
import { providerCatalogCachePath } from "../model/catalog-cache.ts";
import { removeProviderPoolModels } from "../model/pool-file-store.ts";
import type { AuthStorage } from "./auth-storage.ts";
import { findConfiguredProvider } from "./registry.ts";

export function forgetProviderConnection(providerId: string, authStorage: AuthStorage, options: {
    readonly configPath?: string;
    readonly poolPath?: string;
    readonly cacheDir?: string;
} = {}): void {
    const configOptions = options.configPath === undefined ? {} : { path: options.configPath };
    const poolOptions = options.poolPath === undefined ? {} : { path: options.poolPath };
    const config = loadOptionalVeraConfig(configOptions);
    const provider = findConfiguredProvider(providerId, config);
    if (provider === undefined) throw new Error("Provider is no longer configured");
    if (provider.envVar && process.env[provider.envVar]) throw new Error(`Remove ${provider.envVar} from the host env file (machine/env in the Vera home) and restart the host to disconnect this provider`);
    for (const slot of config === undefined ? [] : configuredModelAssignments(config)) {
        if (slot.declared.some((model) => model.provider === providerId)) {
            updateVeraConfigDefaults({ model_assignment: { assignment: slot.assignment, binding: null } }, configOptions);
        }
    }
    removeProviderPoolModels(providerId, poolOptions);
    authStorage.deleteCredential(providerId);
    if (provider.custom && config?.provider === providerId) {
        const starting = startingVeraConfig();
        updateVeraConfigDefaults({ provider: starting.provider, model: starting.model, reasoning_effort: null }, configOptions);
    }
    if (provider.custom) updateVeraConfigDefaults({ custom_provider: { id: providerId, declaration: null } }, configOptions);
    else if (provider.endpointOverridden) updateVeraConfigDefaults({ provider_endpoint: { id: providerId, url: null } }, configOptions);
    rmSync(providerCatalogCachePath(providerId, options.cacheDir), { force: true });
}
