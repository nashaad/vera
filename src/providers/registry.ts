import type { VeraConfig, VeraProviderId } from "../config.ts";
import type { AuthStorage } from "./auth-storage.ts";

/**
 * What a provider wants before it can run a turn.
 *
 * `oauth` runs a browser flow and stores what it gets back. `api_key` is a
 * string the user pastes. `none` is a provider that needs no secret at all,
 * which today means a local daemon reached over a host URL.
 */
export type ProviderCredentialKind = "oauth" | "api_key" | "none";

/**
 * Where a provider sits in the connect list. `popular` is the short group at
 * the top; everything else is listed below it alphabetically.
 */
export type ProviderGroup = "popular" | "other";

export interface ProviderDescriptor {
    readonly id: VeraProviderId;
    readonly label: string;
    /** Compact form for tight spaces like the status line, e.g. "codex" for "OpenAI Codex". */
    readonly shortLabel: string;
    readonly group: ProviderGroup;
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
export const PROVIDERS: readonly ProviderDescriptor[] = [
    {
        id: "cerebras",
        label: "Cerebras",
        shortLabel: "cerebras",
        group: "popular",
        credential: "api_key",
        hint: "API key",
        envVar: "CEREBRAS_API_KEY",
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        shortLabel: "deepseek",
        group: "popular",
        credential: "api_key",
        hint: "API key, pay per token",
        envVar: "DEEPSEEK_API_KEY",
    },
    {
        id: "openai-codex",
        label: "OpenAI Codex",
        shortLabel: "codex",
        group: "popular",
        credential: "oauth",
        hint: "ChatGPT Plus/Pro subscription",
    },
    {
        id: "openrouter",
        label: "OpenRouter",
        shortLabel: "openrouter",
        group: "popular",
        credential: "api_key",
        hint: "API key, pay per token",
        envVar: "OPENROUTER_API_KEY",
    },
    {
        id: "ollama",
        label: "Ollama",
        shortLabel: "ollama",
        group: "other",
        credential: "none",
        hint: "local, no account",
        envVar: "OLLAMA_HOST",
    },
];

export function findProvider(id: string): ProviderDescriptor | undefined {
    return PROVIDERS.find((provider) => provider.id === id);
}

export function configuredProviders(
    config: Pick<VeraConfig, "providers"> | undefined,
): readonly ProviderDescriptor[] {
    const custom = Object.entries(config?.providers ?? {}).map(
        ([id, provider]): ProviderDescriptor => ({
            id,
            label: id,
            shortLabel: id,
            group: "other",
            credential: provider.credential,
            hint: provider.credential === "none"
                ? "configured endpoint, no account"
                : provider.api_key_env === undefined
                    ? "API key"
                    : `API key or ${provider.api_key_env}`,
            ...(provider.api_key_env === undefined
                ? {}
                : { envVar: provider.api_key_env }),
        }),
    );
    return [...PROVIDERS, ...custom];
}

export function findConfiguredProvider(
    id: string,
    config: Pick<VeraConfig, "providers"> | undefined,
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
 * A provider needing no credential is always connected, which is the honest
 * answer for a local daemon: whether it is actually running is a different
 * question, and one only a request can answer.
 */
export function isProviderConnected(
    provider: ProviderDescriptor,
    options: ProviderConnectionOptions = {},
): boolean {
    if (provider.credential === "none") {
        return true;
    }
    if (options.authStorage?.getCredential(provider.id) !== undefined) {
        return true;
    }
    const env = options.env ?? process.env;
    return provider.envVar !== undefined && Boolean(env[provider.envVar]);
}
