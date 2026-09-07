import { rmSync } from "node:fs";
import { configuredModelAssignments, startingVeraConfig, loadOptionalVeraConfig, updateVeraConfigDefaults } from "../config.ts";
import { providerCatalogCachePath } from "../model/catalog-cache.ts";
import { removeProviderPoolModels } from "../model/pool-file-store.ts";
import type { AuthStorage } from "./auth-storage.ts";
import { findConfiguredProvider } from "./registry.ts";

export function forgetProviderConnection(providerId: string, authStorage: AuthStorage): void {
    const config = loadOptionalVeraConfig();
    const provider = findConfiguredProvider(providerId, config);
    if (provider === undefined) throw new Error("Provider is no longer configured");
    if (provider.envVar && process.env[provider.envVar]) throw new Error(`Unset ${provider.envVar} in the host environment to disconnect this provider`);
    for (const slot of config === undefined ? [] : configuredModelAssignments(config)) {
        if (slot.declared.some((model) => model.provider === providerId)) {
            updateVeraConfigDefaults({ model_assignment: { assignment: slot.assignment, binding: null } });
        }
    }
    removeProviderPoolModels(providerId);
    authStorage.deleteCredential(providerId);
    if (provider.custom && config?.provider === providerId) {
        const starting = startingVeraConfig();
        updateVeraConfigDefaults({ provider: starting.provider, model: starting.model, reasoning_effort: null });
    }
    if (provider.custom) updateVeraConfigDefaults({ custom_provider: { id: providerId, declaration: null } });
    else if (provider.endpointOverridden) updateVeraConfigDefaults({ provider_endpoint: { id: providerId, url: null } });
    rmSync(providerCatalogCachePath(providerId), { force: true });
}
