import type { VeraConfig } from "../config.ts";
import { createOpenAICodexAdapter } from "./openai-codex.ts";
import { createOpenRouterAdapter } from "./openrouter.ts";
import { createOllamaAdapter } from "./ollama-openai.ts";
import { createCerebrasAdapter } from "./cerebras-openai.ts";
import {
    poolEffortLevels,
    type EffortLevelsLookup,
} from "../model/effort-levels.ts";
import { createPoolEffortPool } from "../model/effort-pool.ts";
import type { ModelAdapter } from "../model/types.ts";
import { apiKey, type AuthStorage } from "./auth-storage.ts";
import { findProvider } from "./registry.ts";
import { UserFacingError } from "../user-facing-error.ts";

export interface ConfiguredProviderOptions {
    readonly authStorage?: AuthStorage;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: typeof globalThis.fetch;
    readonly log?: (
        entry: { readonly type: string } & Record<string, unknown>,
    ) => void;
    /**
     * The model's levels for a provider that sends one on the wire. Defaults
     * to the user-scope pool over the cached catalog, which is the same order
     * the picker and request-time coarsening read.
     */
    readonly effortLevels?: EffortLevelsLookup;
}

/**
 * The adapter for each provider the registry lists.
 *
 * Keyed rather than branched so that adding a provider is adding a row here and
 * a row in the registry, and the two cannot drift into a state where one lists a
 * provider the other cannot build.
 */
const ADAPTERS: Readonly<Record<
    string,
    (options: ConfiguredProviderOptions) => ModelAdapter
>> = {
    cerebras: (options) => createCerebrasAdapter({
        apiKey: requiredApiKey("cerebras", options),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    "openai-codex": (options) => createOpenAICodexAdapter({
        ...(options.authStorage === undefined
            ? {}
            : { authStorage: options.authStorage }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    ollama: (options) => createOllamaAdapter({
        host: (options.env ?? process.env).OLLAMA_HOST,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.log === undefined ? {} : { log: options.log }),
    }),
    openrouter: (options) => createOpenRouterAdapter({
        apiKey: requiredApiKey("openrouter", options),
        effortLevels: options.effortLevels ?? poolEffortLevels({
            provider: "openrouter",
            pool: createPoolEffortPool(),
        }),
    }),
};

export function createConfiguredModelAdapter(
    config: VeraConfig,
    options: ConfiguredProviderOptions = {},
): ModelAdapter {
    const build = ADAPTERS[config.provider];
    if (build === undefined) {
        throw new Error(`Unknown provider ${config.provider}`);
    }
    return build(options);
}

/**
 * A stored key first, then the environment.
 *
 * Storing is what the connect pane writes, and it is the path a user who has
 * never seen an env var takes. The environment stays as a fallback rather than a
 * migration: a setup that exported the key years ago keeps working untouched,
 * and the two can coexist because a key the user typed into Vera is the more
 * deliberate of the two.
 */
function requiredApiKey(
    providerId: string,
    options: ConfiguredProviderOptions,
): string {
    const stored = options.authStorage === undefined
        ? undefined
        : apiKey(options.authStorage, providerId);
    if (stored !== undefined && stored.length > 0) {
        return stored;
    }
    const envVar = findProvider(providerId)?.envVar;
    const fromEnv = envVar === undefined
        ? undefined
        : (options.env ?? process.env)[envVar];
    if (fromEnv !== undefined && fromEnv.length > 0) {
        return fromEnv;
    }
    throw new UserFacingError(
        `No credentials for provider ${providerId}. Connect it from the model pane (ctrl+e)${
            envVar === undefined ? "" : ` or set ${envVar}`
        }.`,
    );
}
