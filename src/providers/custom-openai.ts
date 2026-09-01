import type { ModelAdapter } from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import type { ImageSupportLookup } from "../model/image-support.ts";
import {
    OpenAICompatibleAdapter,
    type ChatProviderProfile,
} from "./openai-compatible.ts";
import type { OpenRouterChatRequest } from "./openrouter-wire.ts";
import type { FailedRequestCapture } from "./failed-request-capture.ts";
import { decodeOpenAiSse, encodeOpenAiMessage } from "./ollama-openai.ts";
import { providerEndpointUrl } from "./endpoint-url.ts";

export interface CustomOpenAIAdapterOptions {
    readonly provider: string;
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly supportsImageInput?: boolean;
    readonly imageSupport?: ImageSupportLookup;
    /** Named, data-selected request compatibility operations. */
    readonly requestLayers?: readonly string[];
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly captureFailedRequest?: FailedRequestCapture;
}

/** A named endpoint speaking the OpenAI chat-completions protocol. */
export function createCustomOpenAIAdapter(
    options: CustomOpenAIAdapterOptions,
): ModelAdapter {
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const endpoint = providerEndpointUrl(options.baseUrl, "/chat/completions");
    const profile: ChatProviderProfile = {
        provider: options.provider,
        api: "openai-chat-completions",
        ...(options.supportsImageInput === undefined
            ? {}
            : { supportsImageInput: options.supportsImageInput }),
        supportsBodyExtensions: true,
        reasoningEffort: (effort) => effort,
        classifyError: classifyCustomProviderError,
    };

    return new OpenAICompatibleAdapter(
        async (request, signal) => {
            const response = await fetchImplementation(endpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(options.apiKey === undefined
                        ? {}
                        : { authorization: `Bearer ${options.apiKey}` }),
                },
                body: JSON.stringify(encodeRequest(request, options.requestLayers ?? [])),
                signal,
            });
            if (!response.ok) {
                const detail = (await response.text()).slice(0, 4_096).trim();
                const error = new Error(
                    `${options.provider} returned HTTP ${response.status}${
                        detail ? `: ${detail}` : ""
                    }`,
                ) as Error & { status?: number };
                error.status = response.status;
                throw error;
            }
            if (response.body === null) {
                throw new Error(`${options.provider} returned an empty response body`);
            }
            return decodeOpenAiSse(response.body, options.provider);
        },
        undefined,
        profile,
        undefined,
        options.captureFailedRequest,
        options.imageSupport,
    );
}

function encodeRequest(
    request: OpenRouterChatRequest,
    layers: readonly string[],
): Record<string, unknown> {
    const reasoning = request.reasoning?.effort;
    const messages = request.messages.map((message) => {
        const encoded = encodeOpenAiMessage(message);
        if (!layers.includes("reasoning-content") || encoded.reasoning === undefined) {
            return encoded;
        }
        const { reasoning: reasoningContent, ...rest } = encoded;
        return { ...rest, reasoning_content: reasoningContent };
    });
    const providerEffort = mappedProviderEffort(reasoning, layers);
    const reasoningFields = layers.includes("thinking-object")
        ? reasoning === undefined
            ? {}
            : reasoning === "off"
                ? { thinking: { type: "disabled" } }
                : {
                    thinking: { type: "enabled" },
                    ...(providerEffort === undefined
                        ? {}
                        : { reasoning_effort: providerEffort }),
                }
        : layers.includes("cerebras-effort")
            ? cerebrasEffortFields(reasoning, request.model)
            : providerEffort === undefined
                ? {}
                : { reasoning_effort: providerEffort };
    return {
        ...(request.bodyExtensions ?? {}),
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages,
        ...(request.maxTokens === undefined
            ? {}
            : layers.includes("completion-token-field")
                ? { max_completion_tokens: request.maxTokens }
                : { max_tokens: request.maxTokens }),
        ...reasoningFields,
        ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : { tools: request.tools }),
    };
}

function cerebrasEffortFields(
    effort: string | undefined,
    model: string,
): Record<string, string> {
    if (effort === undefined) return {};
    if (model === "gpt-oss-120b") {
        return { reasoning_effort: effort === "off" ? "none" : effort };
    }
    if (model.startsWith("zai-glm-") && effort === "off") {
        return { reasoning_effort: "none" };
    }
    return {};
}

function mappedProviderEffort(
    effort: string | undefined,
    layers: readonly string[],
): string | undefined {
    if (effort === undefined || !layers.includes("deepseek-effort")) {
        return effort;
    }
    if (effort === "xhigh" || effort === "max") return "max";
    if (effort === "minimal" || effort === "low" || effort === "medium") {
        return "high";
    }
    return effort;
}

function classifyCustomProviderError(value: unknown): ProviderFailure {
    const message = value instanceof Error ? value.message : String(value);
    const statusCode = typeof value === "object" && value !== null
            && typeof (value as { status?: unknown }).status === "number"
        ? (value as { status: number }).status
        : undefined;
    if (statusCode === undefined) {
        return { kind: "connection", resolution: "retry", message };
    }
    if (statusCode >= 500) {
        return { kind: "server", resolution: "retry", message, statusCode };
    }
    const kind = statusCode === 401 || statusCode === 403 ? "authentication"
        : statusCode === 404 ? "not_found"
        : statusCode === 408 ? "timeout"
        : statusCode === 429 ? "rate_limit"
        : "invalid_request";
    return {
        kind,
        resolution: statusCode === 408 || statusCode === 429
            ? "retry"
            : "user_action",
        message,
        statusCode,
    };
}
