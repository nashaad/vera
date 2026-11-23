import type { VeraConfig } from "../config.ts";

// Whether a provider is On, given config.json's `disabled_providers`.
// Kept free of file access so the desktop window can share it with the host.

export function providerEnabled(
    config: Pick<VeraConfig, "disabled_providers"> | undefined,
    provider: string,
): boolean {
    return config?.disabled_providers?.includes(provider) !== true;
}
