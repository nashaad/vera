import type { VeraConfig } from "../config.ts";
import type {
    EffortLevelsLookup,
} from "../model/effort-levels.ts";
import {
    poolImageSupport,
    type ImageSupportLookup,
} from "../model/image-support.ts";
import { createPoolEffortPool } from "../model/effort-pool.ts";
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
    readonly effortLevels?: EffortLevelsLookup;
    readonly imageSupport?: ImageSupportLookup;
    readonly projectRoot?: string;
    readonly captureFailedRequest?: FailedRequestCapture;
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
            ...imageLookup(
                config.provider,
                options,
                config.providers?.[config.provider]?.images,
            ),
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
            ...imageLookup(
                config.provider,
                options,
                config.providers?.[config.provider]?.images,
            ),
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
            ...imageLookup(
                config.provider,
                options,
                config.providers?.[config.provider]?.images,
            ),
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
        ...imageLookup(config.provider, options, custom.images),
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

function capture(
    options: ConfiguredProviderOptions,
): { captureFailedRequest?: FailedRequestCapture } {
    return options.captureFailedRequest === undefined
        ? {}
        : { captureFailedRequest: options.captureFailedRequest };
}

function imageLookup(
    provider: string,
    options: ConfiguredProviderOptions,
    declared?: boolean,
): { imageSupport?: ImageSupportLookup } {
    if (options.imageSupport !== undefined) {
        return { imageSupport: options.imageSupport };
    }
    if (declared !== undefined) {
        return {};
    }
    const pool = createPoolEffortPool(
        options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot },
    );
    return {
        imageSupport: poolImageSupport({ provider, pool }),
    };
}
