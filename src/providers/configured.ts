import type { VeraConfig } from "../config.ts";
import { createOpenAICodexAdapter } from "./openai-codex.ts";
import { createOpenRouterAdapter } from "./openrouter.ts";
import { createOllamaAdapter } from "./ollama-openai.ts";
import { createCerebrasAdapter } from "./cerebras-openai.ts";
import { createDeepSeekAdapter } from "./deepseek-openai.ts";
import {
    poolEffortLevels,
    type EffortLevelsLookup,
} from "../model/effort-levels.ts";
import {
    poolImageSupport,
    type ImageSupportLookup,
} from "../model/image-support.ts";
import { createPoolEffortPool } from "../model/effort-pool.ts";
import type { ModelAdapter } from "../model/types.ts";
import { apiKey, type AuthStorage } from "./auth-storage.ts";
import { findProvider } from "./registry.ts";
import { UserFacingError } from "../user-facing-error.ts";
import type { FailedRequestCapture } from "./failed-request-capture.ts";
import { createCustomOpenAIAdapter } from "./custom-openai.ts";
import { createCustomAnthropicAdapter } from "./custom-anthropic.ts";
import {
    type OpenRouterAllowanceGuard,
    openRouterAllowanceScope,
} from "./openrouter-allowance-guard.ts";

export interface ConfiguredProviderOptions {
    readonly authStorage?: AuthStorage;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly log?: (
        entry: { readonly type: string } & Record<string, unknown>,
    ) => void;
    /**
     * The model's levels for a provider that sends one on the wire. Defaults
     * to the pool over the cached catalog, which is the same order the picker
     * and request-time coarsening read.
     */
    readonly effortLevels?: EffortLevelsLookup;
    /** The model's image support. Defaults to the same pool-over-catalog read. */
    readonly imageSupport?: ImageSupportLookup;
    /** The workspace whose pool overlays the user's, when there is one. */
    readonly projectRoot?: string;
    /**
     * Where a failed provider request is kept. Scoped by whoever builds the
     * adapter, because the caps it enforces are per session.
     */
    readonly captureFailedRequest?: FailedRequestCapture;
    /** Host-wide, short-lived OpenRouter allowance evidence. */
    readonly openRouterAllowanceGuard?: OpenRouterAllowanceGuard;
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
    (options: ConfiguredProviderOptions, baseUrl?: string) => ModelAdapter
>> = {
    cerebras: (options, baseUrl) => createCerebrasAdapter({
        apiKey: requiredApiKey("cerebras", options),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...capture(options),
    }),
    deepseek: (options, baseUrl) => createDeepSeekAdapter({
        apiKey: requiredApiKey("deepseek", options),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...capture(options),
    }),
    "openai-codex": (options) => createOpenAICodexAdapter({
        ...(options.authStorage === undefined
            ? {}
            : { authStorage: options.authStorage }),
        ...(options.fetch === undefined
            ? {}
            : { fetch: options.fetch as typeof globalThis.fetch }),
    }),
    ollama: (options, baseUrl) => createOllamaAdapter({
        // Ollama is reached by host, and the adapter adds the OpenAI path
        // itself. A pasted URL that already carries it would otherwise be
        // asked for /v1/v1.
        host: baseUrl === undefined
            ? (options.env ?? process.env).OLLAMA_HOST
            : ollamaHost(baseUrl),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.log === undefined ? {} : { log: options.log }),
        ...capture(options),
    }),
    openrouter: (options, baseUrl) => {
        const pool = createPoolEffortPool(
            options.projectRoot === undefined
                ? {}
                : { projectRoot: options.projectRoot },
        );
        const apiKey = requiredApiKey("openrouter", options);
        return createOpenRouterAdapter({
            apiKey,
            ...(baseUrl === undefined ? {} : { baseUrl }),
            effortLevels: options.effortLevels
                ?? poolEffortLevels({ provider: "openrouter", pool }),
            imageSupport: options.imageSupport
                ?? poolImageSupport({ provider: "openrouter", pool }),
            ...(options.openRouterAllowanceGuard === undefined
                ? {}
                : {
                    allowanceGuard: options.openRouterAllowanceGuard,
                    allowanceScope: openRouterAllowanceScope(apiKey),
                }),
            ...capture(options),
        });
    },
};

/** A host, from whatever shape of Ollama URL the config carries. */
function ollamaHost(value: string): string {
    return value.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function capture(
    options: ConfiguredProviderOptions,
): { captureFailedRequest?: FailedRequestCapture } {
    return options.captureFailedRequest === undefined
        ? {}
        : { captureFailedRequest: options.captureFailedRequest };
}

export function createConfiguredModelAdapter(
    config: VeraConfig,
    options: ConfiguredProviderOptions = {},
): ModelAdapter {
    const build = ADAPTERS[config.provider];
    if (build !== undefined) {
        // A shipped provider keeps its own adapter when the endpoint moves:
        // the wire quirks, error classification, and effort mapping belong to
        // the provider, not to the host it happens to answer on.
        return build(options, config.provider_endpoints?.[config.provider]);
    }
    const custom = config.providers?.[config.provider];
    if (custom === undefined) {
        throw new Error(`Unknown provider ${config.provider}`);
    }
    const apiKey = custom.credential === "none"
        ? undefined
        : customProviderApiKey(config.provider, custom.api_key_env, options);
    if (custom.protocol === "openai-chat") {
        return createCustomOpenAIAdapter({
            provider: config.provider,
            baseUrl: custom.base_url,
            supportsImageInput: custom.images,
            ...(apiKey === undefined ? {} : { apiKey }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...capture(options),
        });
    }
    return createCustomAnthropicAdapter({
        provider: config.provider,
        baseUrl: custom.base_url,
        supportsImageInput: custom.images,
        defaultMaxTokens: custom.max_tokens,
        adaptiveThinking: custom.thinking === "adaptive",
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...capture(options),
    });
}

function customProviderApiKey(
    providerId: string,
    envVar: string | undefined,
    options: ConfiguredProviderOptions,
): string {
    const stored = options.authStorage === undefined
        ? undefined
        : apiKey(options.authStorage, providerId);
    if (stored !== undefined && stored.length > 0) {
        return stored;
    }
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
