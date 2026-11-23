import { connectedProviderCatalogs } from "./catalog-state.ts";
import { loadOptionalVeraConfig, type VeraConfig } from "../config.ts";
import { createAuthStorage, type AuthStorage } from "./auth-storage.ts";
import { loginOpenAICodex } from "./openai-codex-oauth.ts";
import { isSafeProviderId } from "./provider-id.ts";
import { providerEndpointError } from "./read-model-catalog.ts";
import { providerEnabled } from "./provider-enabled.ts";
import { configuredProviders, findConfiguredProvider } from "./registry.ts";
import { saveProvider, type SaveProviderInput } from "./save-provider.ts";

export interface ProviderSignInStatus {
    readonly id: string;
    readonly name: string;
    readonly methods: readonly ("key" | "browser")[];
    readonly connected: boolean;
    readonly catalog_connected: boolean;
    readonly enabled: boolean;
    readonly connected_by?: "key" | "browser" | "environment" | "none";
    readonly endpoint?: string;
    readonly protocol?: "openai-chat" | "anthropic-messages";
    readonly custom: boolean;
    readonly models_discovered?: number;
}

export interface ProviderSignInOptions {
    readonly configPath?: string;
    readonly cacheDir?: string;
    readonly authStorage?: AuthStorage;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly login?: typeof loginOpenAICodex;
}

export interface ProviderSignInService {
    list(): readonly ProviderSignInStatus[];
    needsSetup(): boolean;
    save(input: SaveProviderInput & { readonly custom: boolean; readonly reuseExisting?: boolean }): Promise<ProviderSignInStatus>;
    login(provider: string, signal: AbortSignal, onUrl: (url: string) => void): Promise<ProviderSignInStatus>;
}

export function createProviderSignInService(options: ProviderSignInOptions = {}): ProviderSignInService {
    const auth = options.authStorage ?? createAuthStorage();
    const list = (): readonly ProviderSignInStatus[] => {
        const config = loadOptionalVeraConfig({ path: options.configPath });
        const connected = new Set(connectedProviderCatalogs(config, { authStorage: auth, cacheDir: options.cacheDir, env: options.env }).map((entry) => entry.id));
        return configuredProviders(config).map((provider) => {
            const credential = auth.getCredential(provider.id);
            const connectedBy = credential?.type === "api_key" ? "key" as const
                : credential?.type === "oauth" ? "browser" as const
                    : provider.envVar !== undefined && Boolean((options.env ?? process.env)[provider.envVar]) ? "environment" as const
                        : provider.credential === "none" || provider.credential === "api_key_optional" ? "none" as const : undefined;
            const methods: ("key" | "browser")[] = provider.credential === "oauth" ? ["browser"]
                : provider.credential === "api_key" || provider.credential === "api_key_optional" ? ["key"] : [];
            return {
                id: provider.id, name: provider.label, methods,
                connected: connectedBy !== undefined && (connectedBy !== "none" || connected.has(provider.id)),
                catalog_connected: connected.has(provider.id),
                enabled: providerEnabled(config, provider.id),
                ...(connectedBy === undefined || (connectedBy === "none" && !connected.has(provider.id)) ? {} : { connected_by: connectedBy }),
                ...(safeEndpoint(provider.baseUrl) === undefined ? {} : { endpoint: safeEndpoint(provider.baseUrl) }),
                ...(provider.credential === "oauth" ? {} : { protocol: provider.protocol === "anthropic-messages" ? "anthropic-messages" as const : "openai-chat" as const }),
                custom: provider.custom === true,
            };
        });
    };
    const status = (id: string): ProviderSignInStatus => {
        const found = list().find((provider) => provider.id === id);
        if (found === undefined) throw new Error("Unknown provider");
        return found;
    };
    return {
        list,
        needsSetup: () => providerSetupRequired(loadOptionalVeraConfig({ path: options.configPath }), { authStorage: auth, cacheDir: options.cacheDir, env: options.env }),
        async save(input) {
            if (!isSafeProviderId(input.id) || input.id.length > 128) throw new Error("Invalid provider name");
            const provider = findConfiguredProvider(input.id, loadOptionalVeraConfig({ path: options.configPath }));
            if (provider === undefined && !input.custom) throw new Error("Unknown provider");
            if (provider !== undefined && input.custom && !provider.custom) throw new Error("Provider name is already in use");
            const stored = input.editing === input.id && input.reuseExisting === true ? auth.getCredential(input.id) : undefined;
            const environmentKey = input.editing === input.id && input.reuseExisting === true && provider?.envVar !== undefined
                ? (options.env ?? process.env)[provider.envVar] : undefined;
            const existingKey = stored?.type === "api_key" ? stored.key : environmentKey;
            const hasExistingKey = Boolean(existingKey);
            if (input.declaration.credential === "api_key" && (input.apiKey === undefined || input.apiKey.trim().length === 0 || input.apiKey.length > 16_384) && !hasExistingKey) throw new Error("Missing API key");
            if (provider !== undefined && provider.credential !== "none" && provider.credential !== "api_key_optional" && input.declaration.credential === "none") throw new Error("This provider requires a key");
            if (provider !== undefined && !provider.custom && (provider.credential === "oauth"
                || (provider.protocol === "anthropic-messages" ? "anthropic-messages" : "openai-chat") !== input.declaration.protocol)) throw new Error("Invalid provider protocol");
            if (input.replaces !== undefined && (input.editing !== input.replaces || !findConfiguredProvider(input.replaces, loadOptionalVeraConfig({ path: options.configPath }))?.custom)) throw new Error("Invalid provider replacement");
            const endpointError = providerEndpointError(input.declaration.base_url);
            if (endpointError !== undefined) throw new Error(endpointError);
            const url = new URL(input.declaration.base_url);
            if (url.username || url.password) throw new Error("Endpoint cannot contain credentials");
            if (provider?.fixedEndpoint && provider.baseUrl !== input.declaration.base_url) throw new Error("This provider has a fixed endpoint");
            try {
                const result = await saveProvider({ ...input, shipped: provider !== undefined && !provider.custom }, auth, { configPath: options.configPath, cacheDir: options.cacheDir });
                return { ...status(input.id), models_discovered: result.modelCount };
            } catch (error) {
                const message = error instanceof Error ? error.message : "Could not save provider";
                const secret = input.apiKey || existingKey;
                throw new Error(secret ? message.split(secret).join("[redacted]") : message);
            }
        },
        async login(provider, signal, onUrl) {
            if (provider !== "openai-codex") throw new Error("Unknown browser sign-in provider");
            await (options.login ?? loginOpenAICodex)({ authStorage: auth, signal, onAuthorizationUrl: onUrl, openAuthorizationUrl: async () => true });
            return status(provider);
        },
    };
}

function safeEndpoint(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    try {
        const url = new URL(value);
        return url.username || url.password || url.search || url.hash ? undefined : value;
    } catch {
        return undefined;
    }
}

export function providerSetupRequired(
    config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined,
    options: Parameters<typeof connectedProviderCatalogs>[1] = {},
): boolean {
    return connectedProviderCatalogs(config, options).length === 0;
}
