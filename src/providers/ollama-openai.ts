import type { ChatMessages, ChatStreamChunk } from "@openrouter/sdk/models";

import type { ModelAdapter, ModelReasoningEffort } from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import {
    OpenRouterAdapter,
    type ChatProviderProfile,
} from "./openrouter.ts";
import type { OpenRouterChatRequest } from "./openrouter-wire.ts";

export interface OllamaAdapterOptions {
    readonly host?: string;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
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
    const endpoint = `${normalizeHost(options.host ?? "http://127.0.0.1:11434")}/v1/chat/completions`;
    return new OpenRouterAdapter(
        async (request, signal) => {
            const response = await fetchImplementation(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(encodeRequest(request)),
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
            return decodeSse(response.body);
        },
        undefined,
        OLLAMA_PROFILE,
    );
}

function encodeRequest(request: OpenRouterChatRequest): Record<string, unknown> {
    return {
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: request.messages.map(encodeMessage),
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

function encodeMessage(message: ChatMessages): Record<string, unknown> {
    const value = message as unknown as Record<string, unknown>;
    return {
        role: value.role,
        content: value.content,
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

async function* decodeSse(
    body: ReadableStream<Uint8Array>,
): AsyncIterable<ChatStreamChunk> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    for await (const bytes of body) {
        buffered += decoder.decode(bytes, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffered)) !== null) {
            const event = buffered.slice(0, match.index);
            buffered = buffered.slice(match.index + match[0].length);
            const chunk = parseEvent(event);
            if (chunk !== undefined) yield chunk;
        }
    }
    buffered += decoder.decode();
    if (buffered.trim().length > 0) {
        const chunk = parseEvent(buffered);
        if (chunk !== undefined) yield chunk;
    }
}

function parseEvent(event: string): ChatStreamChunk | undefined {
    const data = event.replace(/\r\n?/g, "\n").split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    if (data.length === 0 || data === "[DONE]") return undefined;
    return normalizeChunk(JSON.parse(data));
}

function normalizeChunk(value: unknown): ChatStreamChunk {
    if (typeof value !== "object" || value === null) {
        throw new Error("Ollama returned an invalid stream chunk");
    }
    const chunk = value as Record<string, unknown>;
    const choices = Array.isArray(chunk.choices)
        ? chunk.choices.map((choice) => {
            const record = choice as Record<string, unknown>;
            const delta = record.delta as Record<string, unknown> | undefined;
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
                            ...(delta.tool_calls === undefined
                                ? {}
                                : { toolCalls: delta.tool_calls }),
                        },
                    }),
            };
        })
        : [];
    const usage = chunk.usage as Record<string, unknown> | undefined;
    return {
        ...chunk,
        choices,
        ...(usage === undefined
            ? {}
            : {
                usage: {
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    totalTokens: usage.total_tokens,
                },
            }),
    } as unknown as ChatStreamChunk;
}

function normalizeHost(value: string): string {
    const withScheme = /^https?:\/\//.test(value) ? value : `http://${value}`;
    return withScheme.replace(/\/+$/, "");
}

function ollamaReasoningEffort(effort: ModelReasoningEffort): string {
    return effort === "off" ? "none" : effort === "max" ? "high" : effort;
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
