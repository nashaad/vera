import type { ProviderStatus } from "../../protocol/bridge.ts";

export function customProviderHost(provider: ProviderStatus): string {
    if (!provider.connected || !provider.custom || !provider.endpoint) return "";
    try { return new URL(provider.endpoint).host; } catch { return ""; }
}

export function connectedProviderLabel(provider: ProviderStatus): string {
    if (provider.custom) return "Custom";
    if (provider.methods.length === 0) return "Local";
    if (provider.connected_by === "environment") return "Environment";
    if (provider.connected_by === "browser") return "Signed in";
    if (provider.connected_by === "key") return "Stored key";
    return "Connected";
}

export function availableProviderLabel(provider: ProviderStatus): string {
    if (provider.methods.length === 0) return "Local";
    return provider.methods.includes("browser") ? "Sign in" : "Key";
}
