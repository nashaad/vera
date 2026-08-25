import type { VeraConfig, VeraProviderId } from "../config.ts";
import type { AuthStorage } from "./auth-storage.ts";
import {
    resolveProviders,
    type ProviderDiscoveryDefinition,
    type ProviderProtocol,
} from "./definitions.ts";

/**
 * What a provider wants before it can run a turn.
 *
 * `oauth` runs a browser flow and stores what it gets back. `api_key` is a
 * string the user pastes. `api_key_optional` is a local provider that can
 * accept a key when its server requires one. `none` needs no secret at all.
 */
export type ProviderCredentialKind =
    | "oauth"
    | "api_key"
    | "api_key_optional"
    | "none";

/** How the user gets access to a provider. */
export type ProviderAccessKind = "subscription" | "api_key" | "local";

export interface ProviderDescriptor {
    readonly id: VeraProviderId;
    readonly label: string;
    /** Compact form for tight spaces like the status line, e.g. "codex" for "OpenAI Codex". */
    readonly shortLabel: string;
    readonly access: ProviderAccessKind;
    readonly credential: ProviderCredentialKind;
    /**
     * What the row says in parentheses after the label: the credential in the
     * user's words, not the mechanism's. Absent when the label says it all.
     */
    readonly hint?: string;
    /**
     * The environment variable this provider will still read when nothing is
     * stored. Kept so a setup that predates stored credentials keeps working.
     */
    readonly envVar?: string;
    /**
     * Where requests go. Shipped with a default that the user can point
     * elsewhere, because a region, a proxy, or a gateway is the same provider
     * on a different host.
     */
    readonly baseUrl?: string;
    readonly endpointOverridden?: boolean;
    /**
     * Set when the endpoint is not the user's to move: a subscription flow is
     * bound to the account it signs in to. The pane shows the URL and offers
     * no field.
     */
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
}

/**
 * The providers Vera offers, hand-picked rather than exhaustive.
 *
 * A row here is a promise that choosing it runs a model, so a provider appears
 * only once its adapter exists. A list that check-marks a provider it cannot
 * serve is worse than a list that never mentioned it: the user connects an
 * account, believes they are done, and finds out at the first turn.
 *
 * So this list grows one row at a time, with the adapter, and never ahead of it.
 */
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

/**
 * Whether this provider is ready to run without asking the user for anything.
 *
 * A stored secret and one in the environment both count: the connect list
 * reports what Vera can do, not where the secret came from, and a user who
 * exported a key years ago is connected whether or not Vera wrote the file.
 *
 * A provider needing no credential, or one whose local key is optional, is
 * always connected: whether its daemon is actually running is a different
 * question, and one only a request can answer.
 */
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
