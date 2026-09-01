import type { VeraConfig } from "../config.ts";
import type { ModelAdapter } from "../model/types.ts";
import type { ImageSupportLookup } from "../model/image-support.ts";
import { UserFacingError } from "../user-facing-error.ts";
import type { FailedRequestCapture } from "./failed-request-capture.ts";
import type { AuthStorage } from "./auth-storage.ts";
import {
    createCustomAnthropicAdapter,
    type CustomAnthropicAdapterOptions,
} from "./custom-anthropic.ts";
import {
    createCustomOpenAIAdapter,
    type CustomOpenAIAdapterOptions,
} from "./custom-openai.ts";
import type { ProviderDescriptor } from "./registry.ts";

export interface GenericProviderOptions {
    readonly provider: ProviderDescriptor;
    readonly config?: Pick<VeraConfig, "providers">;
    readonly authStorage?: AuthStorage;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly captureFailedRequest?: FailedRequestCapture;
    readonly imageSupport?: ImageSupportLookup;
}

export function createGenericProviderAdapter(
    options: GenericProviderOptions,
): ModelAdapter {
    const protocol = options.provider.protocol;
    if (protocol !== "openai-chat" && protocol !== "anthropic-messages") {
        throw new Error(
            `Provider ${options.provider.id} needs contributed behavior ${options.provider.behaviorId ?? "unknown"}`,
        );
    }
    const declaration = options.config?.providers?.[options.provider.id];
    const apiKey = genericApiKey(options);
    const shared = {
        provider: options.provider.id,
        baseUrl: options.provider.baseUrl ?? declaration?.base_url ?? "",
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.captureFailedRequest === undefined
            ? {}
            : { captureFailedRequest: options.captureFailedRequest }),
        ...(options.imageSupport === undefined
            ? {}
            : { imageSupport: options.imageSupport }),
    };
    if (protocol === "openai-chat") {
        const openai: CustomOpenAIAdapterOptions = {
            ...shared,
            requestLayers: [
                ...(options.provider.compatibility?.request ?? []),
                ...(options.provider.compatibility?.effort ?? []),
            ],
            ...(declaration?.images === undefined ? {} : { supportsImageInput: declaration.images }),
        };
        return createCustomOpenAIAdapter(openai);
    }
    const anthropic: CustomAnthropicAdapterOptions = {
        ...shared,
        ...(declaration?.images === undefined ? {} : { supportsImageInput: declaration.images }),
        ...(declaration?.max_tokens === undefined ? {} : { defaultMaxTokens: declaration.max_tokens }),
        ...(declaration?.thinking === undefined ? {} : { adaptiveThinking: true }),
    };
    return createCustomAnthropicAdapter(anthropic);
}

function genericApiKey(options: GenericProviderOptions): string | undefined {
    const credential = options.provider.credential;
    if (credential === "none") return undefined;
    const stored = options.authStorage?.getCredential(options.provider.id);
    if (stored?.type === "api_key" && stored.key.length > 0) return stored.key;
    const envVar = options.provider.envVar;
    const fromEnv = envVar === undefined
        ? undefined
        : (options.env ?? process.env)[envVar];
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    if (credential === "api_key") {
        throw new UserFacingError(
            `No credentials for provider ${options.provider.id}. Connect it from the model pane (ctrl+e)${envVar === undefined ? "" : ` or set ${envVar}`}.`,
        );
    }
    if (credential === "oauth") {
        throw new Error(`Provider ${options.provider.id} requires contributed OAuth behavior`);
    }
    return undefined;
}
