import type { VeraConfig, VeraProviderId } from "../config.ts";
import type { AuthStorage } from "./auth-storage.ts";
import {
    resolveProviders,
    type ProviderDiscoveryDefinition,
    type ProviderLocalRuntime,
    type ProviderProtocol,
    type ProviderRecommendation,
    type RecommendedModel,
} from "./definitions.ts";

export type ProviderCredentialKind =
    | "oauth"
    | "api_key"
    | "api_key_optional"
    | "none";

export type ProviderAccessKind = "subscription" | "api_key" | "local";

export interface ProviderDescriptor {
    readonly id: VeraProviderId;
    readonly label: string;
    readonly shortLabel: string;
    readonly access: ProviderAccessKind;
    readonly credential: ProviderCredentialKind;
    readonly hint?: string;
    readonly envVar?: string;
    readonly baseUrl?: string;
    readonly endpointOverridden?: boolean;
    readonly fixedEndpoint?: boolean;
    readonly protocol?: ProviderProtocol;
    readonly behaviorId?: string;
    readonly discovery?: ProviderDiscoveryDefinition;
    readonly compatibility?: Readonly<{
        readonly request?: readonly string[];
        readonly response?: readonly string[];
        readonly error?: readonly string[];
        readonly effort?: readonly string[];
        readonly catalog?: readonly string[];
    }>;
    readonly custom?: boolean;
    /** Why this provider is put in front of a cold user. Absent means it waits to be found. */
    readonly recommend?: ProviderRecommendation;
    /** The models this provider itself puts forward, by role. */
    readonly recommendModels?: readonly RecommendedModel[];
    /** The CLI Vera drives to put this provider on the machine and bring it up. */
    readonly localRuntime?: ProviderLocalRuntime;
    /** Kept on the first-run list under the recommended ones. */
    readonly shortlist?: boolean;
    /** What to say when this provider's model list comes back empty. */
    readonly noModels?: readonly string[];
    readonly requestOptions?: Readonly<{
        readonly behavior: "openrouter-provider-preferences";
        readonly label: string;
        readonly explanation: string;
        readonly documentationUrl: string;
    }>;
}

export function findProvider(id: string): ProviderDescriptor | undefined {
    return configuredProviders(undefined).find((provider) => provider.id === id);
}

export function configuredProviders(
    config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined,
): readonly ProviderDescriptor[] {
    return resolveProviders({
        providers: config?.providers,
        provider_endpoints: config?.provider_endpoints,
    }).map((provider) => descriptorFromResolved(provider));
}

function descriptorFromResolved(provider: ReturnType<typeof resolveProviders>[number]): ProviderDescriptor {
    return {
        id: provider.id,
        label: provider.definition.label,
        shortLabel: provider.definition.short_label,
        access: provider.definition.access,
        credential: provider.definition.credential,
        ...(provider.definition.hint === undefined ? {} : { hint: provider.definition.hint }),
        ...(provider.definition.env_var === undefined ? {} : { envVar: provider.definition.env_var }),
        baseUrl: provider.baseUrl,
        ...(provider.baseUrl !== provider.definition.default_base_url
            ? { endpointOverridden: true }
            : {}),
        ...(provider.definition.fixed_endpoint === true ? { fixedEndpoint: true } : {}),
        protocol: provider.definition.protocol,
        ...(provider.definition.behavior_id === undefined ? {} : { behaviorId: provider.definition.behavior_id }),
        discovery: provider.definition.discovery,
        compatibility: provider.definition.compatibility,
        custom: provider.custom,
        ...(provider.definition.recommend === undefined
            ? {}
            : { recommend: provider.definition.recommend }),
        ...(provider.definition.recommend_models === undefined
            ? {}
            : { recommendModels: provider.definition.recommend_models }),
        ...(provider.definition.local_runtime === undefined
            ? {}
            : { localRuntime: provider.definition.local_runtime }),
        ...(provider.definition.shortlist === true ? { shortlist: true } : {}),
        ...(provider.definition.no_models === undefined
            ? {}
            : { noModels: provider.definition.no_models }),
        ...(provider.definition.request_options === undefined
            ? {}
            : {
                requestOptions: {
                    behavior: provider.definition.request_options.behavior,
                    label: provider.definition.request_options.label,
                    explanation: provider.definition.request_options.explanation,
                    documentationUrl: provider.definition.request_options.documentation_url,
                },
            }),
    };
}

export function findConfiguredProvider(
    id: string,
    config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined,
): ProviderDescriptor | undefined {
    return configuredProviders(config).find((provider) => provider.id === id);
}

export interface ProviderConnectionOptions {
    readonly authStorage?: Pick<AuthStorage, "getCredential">;
    readonly env?: Readonly<Record<string, string | undefined>>;
}

export function isProviderConnected(
    provider: ProviderDescriptor,
    options: ProviderConnectionOptions = {},
): boolean {
    if (
        provider.credential === "none"
        || provider.credential === "api_key_optional"
    ) {
        return true;
    }
    if (options.authStorage?.getCredential(provider.id) !== undefined) {
        return true;
    }
    const env = options.env ?? process.env;
    return provider.envVar !== undefined && Boolean(env[provider.envVar]);
}
