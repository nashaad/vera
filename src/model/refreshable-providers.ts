import {
    resolveProviders,
    type ProviderResolutionInput,
} from "../providers/definitions.ts";

export function isRefreshableProvider(
    provider: string,
    input: ProviderResolutionInput = {},
): boolean {
    return resolveProviders(input).some((entry) =>
        entry.id === provider && entry.definition.discovery.mode === "models"
    );
}
