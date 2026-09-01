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
import { effectiveCatalog } from "../model/catalog.ts";
import {
    enableThinkingFromEffort,
    joinSettingsOverlay,
    overlayWireForEffort,
    type SettingsOverlay,
} from "../model/settings-overlay.ts";

export interface CustomOpenAIAdapterOptions {
    readonly provider: string;
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly supportsImageInput?: boolean;
    readonly imageSupport?: ImageSupportLookup;
    /** Named, data-selected request compatibility operations. */
    readonly requestLayers?: readonly string[];
    /** Test seam. Absent reads the shipped overlay. */
    readonly overlay?: SettingsOverlay;
    /** Test seam. Absent reads the default provider catalog cache. */
    readonly cacheDir?: string;
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
                body: JSON.stringify(encodeRequest(
                    request,
                    options.requestLayers ?? [],
                    options.provider,
                    options.overlay,
                    options.cacheDir,
                )),
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
    provider: string,
    overlay?: SettingsOverlay,
    cacheDir?: string,
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
    const overlayRow = joinSettingsOverlay({
        provider,
        listingId: request.model,
        ...(overlay === undefined ? {} : { overlay }),
    });
    const reasoningFields = overlayThinkingFields(reasoning, overlayRow)
        ?? (layers.includes("thinking-object")
            ? thinkingObjectFields(reasoning, mappedProviderEffort(reasoning, layers))
            : layers.includes("cerebras-effort")
                ? cerebrasEffortFields(reasoning, request.model)
                : catalogThinkingFields(
                    provider,
                    request.model,
                    reasoning,
                    overlay,
                    cacheDir,
                ));
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

function catalogThinkingFields(
    provider: string,
    model: string,
    effort: string | undefined,
    overlay?: SettingsOverlay,
    cacheDir?: string,
): Record<string, unknown> {
    if (effort === undefined) return {};
    const level = effectiveCatalog(provider, {
        ...(overlay === undefined ? {} : { overlay }),
        ...(cacheDir === undefined ? {} : { cacheDir }),
    }).models.find((candidate) => candidate.id === model)
        ?.levels.find((candidate) =>
            candidate.id === effort || (candidate.wire ?? candidate.id) === effort
        );
    if (level === undefined) return {};
    return { reasoning_effort: level.wire ?? level.id };
}

function overlayThinkingFields(
    effort: string | undefined,
    row: ReturnType<typeof joinSettingsOverlay>,
): Record<string, unknown> | undefined {
    if (row === undefined) return undefined;
    if (row.thinking.request_layer === "enable-thinking-kwargs") {
        const enabled = enableThinkingFromEffort(effort);
        if (enabled === undefined) return {};
        return { chat_template_kwargs: { enable_thinking: enabled } };
    }
    const wire = overlayWireForEffort(row, effort);
    if (wire === undefined) return {};
    return { reasoning_effort: wire };
}

function thinkingObjectFields(
    reasoning: string | undefined,
    providerEffort: string | undefined,
): Record<string, unknown> {
    if (reasoning === undefined) return {};
    if (reasoning === "off") return { thinking: { type: "disabled" } };
    return {
        thinking: { type: "enabled" },
        ...(providerEffort === undefined ? {} : { reasoning_effort: providerEffort }),
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
