import type { ModelAdapter, ModelReasoningEffort } from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import {
    OpenRouterAdapter,
    type ChatProviderProfile,
} from "./openrouter.ts";
import type { OpenRouterChatRequest } from "./openrouter-wire.ts";
import {
    decodeOpenAiSse,
    encodeOpenAiMessage,
} from "./ollama-openai.ts";

export interface CerebrasAdapterOptions {
    readonly apiKey: string;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly baseUrl?: string;
}

const CEREBRAS_PROFILE: ChatProviderProfile = {
    provider: "cerebras",
    api: "openai-chat-completions",
    supportsImageInput: false,
    reasoningEffort: cerebrasReasoningEffort,
    classifyError: classifyCerebrasError,
};

export function createCerebrasAdapter(
    options: CerebrasAdapterOptions,
): ModelAdapter {
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const endpoint = `${
        (options.baseUrl ?? "https://api.cerebras.ai/v1").replace(/\/+$/, "")
    }/chat/completions`;

    return new OpenRouterAdapter(
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
                    `Cerebras returned HTTP ${response.status}${
                        detail ? `: ${detail}` : ""
                    }`,
                ) as Error & { status?: number };
                error.status = response.status;
                throw error;
            }
            if (response.body === null) {
                throw new Error("Cerebras returned an empty response body");
            }
            return decodeOpenAiSse(response.body, "Cerebras");
        },
        undefined,
        CEREBRAS_PROFILE,
    );
}

function encodeRequest(request: OpenRouterChatRequest): Record<string, unknown> {
    return {
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: request.messages.map(encodeOpenAiMessage),
        ...(request.maxTokens === undefined
            ? {}
            : { max_completion_tokens: request.maxTokens }),
        ...(request.reasoning === undefined
            ? {}
            : { reasoning_effort: request.reasoning.effort }),
        ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : { tools: request.tools }),
    };
}

function cerebrasReasoningEffort(
    effort: ModelReasoningEffort,
    model: string,
): string | undefined {
    if (model === "gpt-oss-120b") {
        return effort === "off" ? "none" : effort === "max" ? "high" : effort;
    }
    if (model.startsWith("zai-glm-")) {
        return effort === "off" ? "none" : undefined;
    }
    return undefined;
}

function classifyCerebrasError(value: unknown): ProviderFailure {
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
