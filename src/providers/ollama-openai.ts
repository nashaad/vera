import type { ChatMessages, ChatStreamChunk } from "@openrouter/sdk/models";

import type { ModelAdapter, ModelReasoningEffort } from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import {
    OpenRouterAdapter,
    type ChatProviderProfile,
} from "./openrouter.ts";
import type { OpenRouterChatRequest } from "./openrouter-wire.ts";
import type { FailedRequestCapture } from "./failed-request-capture.ts";

export interface OllamaAdapterOptions {
    readonly host?: string;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly log?: (
        entry: { readonly type: string } & Record<string, unknown>,
    ) => void;
    readonly captureFailedRequest?: FailedRequestCapture;
}

const OLLAMA_PROFILE: ChatProviderProfile = {
    provider: "ollama",
    api: "openai-chat-completions",
    supportsImageInput: false,
    reasoningEffort: ollamaReasoningEffort,
    classifyError: classifyOllamaError,
};

export function createOllamaAdapter(
    options: OllamaAdapterOptions = {},
): ModelAdapter {
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const host = normalizeHost(options.host ?? "http://127.0.0.1:11434");
    const endpoint = `${host}/v1/chat/completions`;
    const thinking = new Map<string, boolean>();
    const log = options.log ?? (() => {});
    return new OpenRouterAdapter(
        async (request, signal) => {
            const supportsThinking = await resolveThinkingSupport(
                thinking,
                fetchImplementation,
                host,
                request.model,
                log,
            );
            if (request.reasoning !== undefined && !supportsThinking) {
                log({
                    type: "ollama_reasoning_effort_dropped",
                    model: request.model,
                    effort: request.reasoning.effort,
                });
            }
            const response = await fetchImplementation(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(encodeRequest(request, supportsThinking)),
                signal,
            });
            if (!response.ok) {
                const detail = (await response.text()).slice(0, 4_096).trim();
                const error = new Error(
                    `Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
                ) as Error & { status?: number };
                error.status = response.status;
                throw error;
            }
            if (response.body === null) {
                throw new Error("Ollama returned an empty response body");
            }
            return decodeOpenAiSse(response.body);
        },
        undefined,
        OLLAMA_PROFILE,
        undefined,
        options.captureFailedRequest,
    );
}

async function resolveThinkingSupport(
    cache: Map<string, boolean>,
    fetchImplementation: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>,
    host: string,
    model: string,
    log: (
        entry: { readonly type: string } & Record<string, unknown>,
    ) => void,
): Promise<boolean> {
    const cached = cache.get(model);
    if (cached !== undefined) return cached;
    let capabilities: readonly unknown[] | undefined;
    try {
        const response = await fetchImplementation(`${host}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model }),
            signal: AbortSignal.timeout(750),
        });
        if (!response.ok) {
            log({
                type: "ollama_thinking_probe",
                model,
                thinking: "unknown",
                reason: `HTTP ${response.status}`,
            });
            return true;
        }
        const body = await response.json() as { capabilities?: unknown };
        if (!Array.isArray(body.capabilities)) {
            cache.set(model, true);
            log({
                type: "ollama_thinking_probe",
                model,
                thinking: "unknown",
                reason: "no capabilities field",
            });
            return true;
        }
        capabilities = body.capabilities;
    } catch (error) {
        log({
            type: "ollama_thinking_probe",
            model,
            thinking: "unknown",
            reason: error instanceof Error ? error.message : String(error),
        });
        return true;
    }
    const supported = capabilities.includes("thinking");
    cache.set(model, supported);
    log({
        type: "ollama_thinking_probe",
        model,
        thinking: supported,
        capabilities,
    });
    return supported;
}

function encodeRequest(
    request: OpenRouterChatRequest,
    supportsThinking: boolean,
): Record<string, unknown> {
    return {
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: request.messages.map(encodeOpenAiMessage),
        ...(request.maxTokens === undefined
            ? {}
            : { max_tokens: request.maxTokens }),
        ...(request.reasoning === undefined || !supportsThinking
            ? {}
            : { reasoning_effort: request.reasoning.effort }),
        ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : { tools: request.tools }),
    };
}

export function encodeOpenAiMessage(
    message: ChatMessages,
): Record<string, unknown> {
    const value = message as unknown as Record<string, unknown>;
    return {
        role: value.role,
        content: encodeOpenAiContent(value.content),
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.toolCallId === undefined
            ? {}
            : { tool_call_id: value.toolCallId }),
        ...(value.toolCalls === undefined
            ? {}
            : { tool_calls: value.toolCalls }),
        ...(value.reasoning === undefined
            ? {}
            : { reasoning: value.reasoning }),
    };
}

// The chat SDK field is imageUrl. These servers read image_url, and an
// empty lookup is decoded as base64 and fails the whole request.
function encodeOpenAiContent(content: unknown): unknown {
    if (!Array.isArray(content)) return content;
    return content.map((part) => {
        if (typeof part !== "object" || part === null || Array.isArray(part)) {
            return part;
        }
        const record = part as Record<string, unknown>;
        if (!Object.hasOwn(record, "imageUrl")) return part;
        const { imageUrl, ...rest } = record;
        return { ...rest, image_url: imageUrl };
    });
}

export async function* decodeOpenAiSse(
    body: ReadableStream<Uint8Array>,
    provider = "Ollama",
): AsyncIterable<ChatStreamChunk> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    for await (const bytes of body) {
        buffered += decoder.decode(bytes, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffered)) !== null) {
            const event = buffered.slice(0, match.index);
            buffered = buffered.slice(match.index + match[0].length);
            const chunk = parseOpenAiSseEvent(event, provider);
            if (chunk !== undefined) yield chunk;
        }
    }
    buffered += decoder.decode();
    if (buffered.trim().length > 0) {
        const chunk = parseOpenAiSseEvent(buffered, provider);
        if (chunk !== undefined) yield chunk;
    }
}

function parseOpenAiSseEvent(
    event: string,
    provider: string,
): ChatStreamChunk | undefined {
    const data = event.replace(/\r\n?/g, "\n").split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    if (data.length === 0 || data === "[DONE]") return undefined;
    return normalizeChunk(JSON.parse(data), provider);
}

function normalizeChunk(value: unknown, provider: string): ChatStreamChunk {
    if (typeof value !== "object" || value === null) {
        throw new Error(`${provider} returned an invalid stream chunk`);
    }
    const chunk = value as Record<string, unknown>;
    const choices = Array.isArray(chunk.choices)
        ? chunk.choices.map((choice) => {
            const record = choice as Record<string, unknown>;
            const delta = record.delta as Record<string, unknown> | undefined;
            const reasoningContent = typeof delta?.reasoning_content === "string"
                ? delta.reasoning_content
                : undefined;
            return {
                ...record,
                ...(record.finish_reason === undefined
                    ? {}
                    : { finishReason: record.finish_reason }),
                ...(delta === undefined
                    ? {}
                    : {
                        delta: {
                            ...delta,
                            ...(reasoningContent === undefined
                                || delta?.reasoning !== undefined
                                ? {}
                                : { reasoning: reasoningContent }),
                            ...(delta.tool_calls === undefined
                                ? {}
                                : { toolCalls: delta.tool_calls }),
                        },
                    }),
            };
        })
        : [];
    // Pulled off the rest rather than overwritten: a provider that sends `"usage": null` would otherwise keep that null through the spread, and every reader downstream would have to.
    const { usage: rawUsage, ...rest } = chunk;
    const usage = rawUsage as Record<string, unknown> | null | undefined;
    return {
        ...rest,
        choices,
        ...(usage == null
            ? {}
            : {
                usage: {
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    totalTokens: usage.total_tokens,
                    ...(typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
                        ? { cost: usage.cost } : {}),
                },
            }),
    } as unknown as ChatStreamChunk;
}

export function normalizeOllamaHost(value: string): string {
    const withScheme = /^https?:\/\//.test(value) ? value : `http://${value}`;
    try {
        const url = new URL(withScheme);
        url.search = "";
        url.hash = "";
        url.username = "";
        url.password = "";
        url.pathname = url.pathname.replace(/\/v1\/*$/, "").replace(/\/+$/, "");
        return url.toString().replace(/\/+$/, "");
    } catch {
        return withScheme.replace(/\/+$/, "");
    }
}

function normalizeHost(value: string): string {
    return normalizeOllamaHost(value);
}

function ollamaReasoningEffort(effort: ModelReasoningEffort): string {
    return effort === "off" ? "none" : effort;
}

function classifyOllamaError(value: unknown): ProviderFailure {
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
    const kind = statusCode === 404 ? "not_found"
        : statusCode === 429 ? "rate_limit"
        : statusCode === 408 ? "timeout"
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
