import type { VeraConfig } from "../config.ts";
import type {
    EffortLevelsLookup,
} from "../model/effort-levels.ts";
import type {
    ImageSupportLookup,
} from "../model/image-support.ts";
import type { ModelAdapter } from "../model/types.ts";
import { apiKey, type AuthStorage } from "./auth-storage.ts";
import { findConfiguredProvider } from "./registry.ts";
import { createGenericProviderAdapter } from "./generic.ts";
import { createExecutableProviderAdapter } from "./executable-contributions.ts";
import { UserFacingError } from "../user-facing-error.ts";
import type { FailedRequestCapture } from "./failed-request-capture.ts";
import { createCustomOpenAIAdapter } from "./custom-openai.ts";
import { createCustomAnthropicAdapter } from "./custom-anthropic.ts";
import {
    type OpenRouterAllowanceGuard,
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

export function createConfiguredModelAdapter(
    config: VeraConfig,
    options: ConfiguredProviderOptions = {},
): ModelAdapter {
    const descriptor = findConfiguredProvider(config.provider, config);
    if (descriptor?.custom === true) {
        return createGenericProviderAdapter({
            provider: descriptor,
            config,
            ...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...capture(options),
        });
    }
    if (descriptor?.behaviorId !== undefined) {
        return createExecutableProviderAdapter(descriptor.behaviorId, descriptor, options);
    }
    if (descriptor !== undefined && descriptor.behaviorId === undefined) {
        return createGenericProviderAdapter({
            provider: descriptor!,
            config,
            ...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...capture(options),
        });
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
function capture(
    options: ConfiguredProviderOptions,
): { captureFailedRequest?: FailedRequestCapture } {
    return options.captureFailedRequest === undefined
        ? {}
        : { captureFailedRequest: options.captureFailedRequest };
}
