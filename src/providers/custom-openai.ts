import type { ModelAdapter } from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import {
    OpenAICompatibleAdapter,
    type ChatProviderProfile,
} from "./openai-compatible.ts";
import type { OpenRouterChatRequest } from "./openrouter-wire.ts";
import type { FailedRequestCapture } from "./failed-request-capture.ts";
import { decodeOpenAiSse, encodeOpenAiMessage } from "./ollama-openai.ts";

export interface CustomOpenAIAdapterOptions {
    readonly provider: string;
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly supportsImageInput?: boolean;
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
    const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const profile: ChatProviderProfile = {
        provider: options.provider,
        api: "openai-chat-completions",
        supportsImageInput: options.supportsImageInput ?? false,
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
                body: JSON.stringify(encodeRequest(request)),
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
    );
}

function encodeRequest(request: OpenRouterChatRequest): Record<string, unknown> {
    return {
        ...(request.bodyExtensions ?? {}),
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: request.messages.map(encodeOpenAiMessage),
        ...(request.maxTokens === undefined
            ? {}
            : { max_tokens: request.maxTokens }),
        ...(request.reasoning === undefined
            ? {}
            : { reasoning_effort: request.reasoning.effort }),
        ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : { tools: request.tools }),
    };
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
