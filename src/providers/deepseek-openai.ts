import type { ChatMessages } from "@openrouter/sdk/models";

import type { ModelAdapter, ModelReasoningEffort } from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import {
    OpenAICompatibleAdapter,
    type ChatProviderProfile,
} from "./openai-compatible.ts";
import type { OpenRouterChatRequest } from "./openrouter-wire.ts";
import type { FailedRequestCapture } from "./failed-request-capture.ts";
import {
    decodeOpenAiSse,
    encodeOpenAiMessage,
} from "./ollama-openai.ts";
import { providerEndpointUrl } from "./endpoint-url.ts";

export interface DeepSeekAdapterOptions {
    readonly apiKey: string;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly baseUrl?: string;
    readonly captureFailedRequest?: FailedRequestCapture;
}

const DEEPSEEK_PROFILE: ChatProviderProfile = {
    provider: "deepseek",
    api: "openai-chat-completions",
    supportsImageInput: false,
    reasoningEffort: deepSeekReasoningEffort,
    classifyError: classifyDeepSeekError,
};

export function createDeepSeekAdapter(
    options: DeepSeekAdapterOptions,
): ModelAdapter {
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const endpoint = providerEndpointUrl(
        options.baseUrl ?? "https://api.deepseek.com",
        "/chat/completions",
    );

    return new OpenAICompatibleAdapter(
        async (request, signal) => {
            const response = await fetchImplementation(endpoint, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${options.apiKey}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify(encodeRequest(request)),
                signal,
            });
            if (!response.ok) {
                const detail = (await response.text()).slice(0, 4_096).trim();
                const error = new Error(
                    `DeepSeek returned HTTP ${response.status}${
                        detail ? `: ${detail}` : ""
                    }`,
                ) as Error & { status?: number };
                error.status = response.status;
                throw error;
            }
            if (response.body === null) {
                throw new Error("DeepSeek returned an empty response body");
            }
            return decodeOpenAiSse(response.body, "DeepSeek");
        },
        undefined,
        DEEPSEEK_PROFILE,
        undefined,
        options.captureFailedRequest,
    );
}

function encodeRequest(request: OpenRouterChatRequest): Record<string, unknown> {
    const reasoning = request.reasoning?.effort;
    return {
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: request.messages.map(encodeDeepSeekMessage),
        ...(request.maxTokens === undefined
            ? {}
            : { max_tokens: request.maxTokens }),
        ...(reasoning === undefined
            ? {}
            : reasoning === "disabled"
                ? { thinking: { type: "disabled" } }
                : {
                    thinking: { type: "enabled" },
                    reasoning_effort: reasoning,
                }),
        ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : { tools: request.tools }),
    };
}

function encodeDeepSeekMessage(message: ChatMessages): Record<string, unknown> {
    const encoded = encodeOpenAiMessage(message);
    if (encoded.reasoning === undefined) {
        return encoded;
    }
    const { reasoning, ...rest } = encoded;
    return { ...rest, reasoning_content: reasoning };
}

function deepSeekReasoningEffort(
    effort: ModelReasoningEffort,
): string | undefined {
    // DeepSeek's native API has two thinking states and currently accepts high
    // or max effort. Keep Vera's off switch explicit, and map lower Vera
    // levels to the provider's nearest available setting.
    if (effort === "off") return "disabled";
    if (effort === "xhigh" || effort === "max") return "max";
    if (effort === "minimal" || effort === "low" || effort === "medium") {
        return "high";
    }
    return effort;
}

function classifyDeepSeekError(value: unknown): ProviderFailure {
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
