import { configuredModelAssignments, type VeraConfig } from "../config.ts";
import { findConfiguredProvider, isProviderConnected, type ProviderConnectionOptions } from "./registry.ts";

/** A plain reason the provider cannot be turned off, or undefined when it can. */
export function providerDisableRefusal(
    config: VeraConfig,
    provider: string,
    options: ProviderConnectionOptions = {},
): string | undefined {
    const descriptor = findConfiguredProvider(provider, config);
    if (descriptor === undefined) return `${provider} is not configured.`;
    const label = descriptor.label;
    if (!isProviderConnected(descriptor, options)) {
        return `${label} is not connected.`;
    }
    if (config.provider === provider) {
        return `${label} provides the default model. Choose another default model before turning it off.`;
    }
    for (const slot of configuredModelAssignments(config)) {
        if (slot.declared.some((model) => model.provider === provider)) {
            return `${label} is assigned to ${slot.label}. Reassign that work before turning it off.`;
        }
    }
    return undefined;
}
