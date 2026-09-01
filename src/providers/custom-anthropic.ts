import type {
    ChatMessages,
    ChatStreamChunk,
} from "@openrouter/sdk/models";

import type { ModelAdapter } from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import type { ImageSupportLookup } from "../model/image-support.ts";
import {
    OpenAICompatibleAdapter,
    type ChatProviderProfile,
} from "./openai-compatible.ts";
import type { OpenRouterChatRequest } from "./openrouter-wire.ts";
import type { FailedRequestCapture } from "./failed-request-capture.ts";
import { providerEndpointUrl } from "./endpoint-url.ts";

export interface CustomAnthropicAdapterOptions {
    readonly provider: string;
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly supportsImageInput?: boolean;
    readonly imageSupport?: ImageSupportLookup;
    readonly defaultMaxTokens?: number;
    readonly adaptiveThinking?: boolean;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly captureFailedRequest?: FailedRequestCapture;
}

/** A named endpoint speaking Anthropic's Messages protocol. */
export function createCustomAnthropicAdapter(
    options: CustomAnthropicAdapterOptions,
): ModelAdapter {
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const endpoint = providerEndpointUrl(options.baseUrl, "/messages");
    const profile: ChatProviderProfile = {
        provider: options.provider,
        api: "anthropic-messages",
        ...(options.supportsImageInput === undefined
            ? {}
            : { supportsImageInput: options.supportsImageInput }),
        supportsBodyExtensions: true,
        reasoningEffort: options.adaptiveThinking === true
            ? anthropicAdaptiveEffort
            : undefined,
        classifyError: classifyCustomProviderError,
    };

    return new OpenAICompatibleAdapter(
        async (request, signal) => {
            const response = await fetchImplementation(endpoint, {
                method: "POST",
                headers: {
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                    ...(options.apiKey === undefined
                        ? {}
                        : { "x-api-key": options.apiKey }),
                },
                body: JSON.stringify(encodeRequest(
                    request,
                    options.defaultMaxTokens ?? 8_192,
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
            return decodeAnthropicSse(response.body);
        },
        undefined,
        profile,
        undefined,
        options.captureFailedRequest,
        options.imageSupport,
    );
}

function anthropicAdaptiveEffort(effort: string): string | undefined {
    return ["low", "medium", "high", "xhigh", "max"].includes(effort)
        ? effort
        : undefined;
}

function encodeRequest(
    request: OpenRouterChatRequest,
    defaultMaxTokens: number,
): Record<string, unknown> {
    const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => typeof message.content === "string" ? message.content : "")
        .filter((text) => text.length > 0)
        .join("\n\n");
    const messages = request.messages
        .filter((message) => message.role !== "system")
        .map(encodeMessage);
    return {
        ...(request.bodyExtensions ?? {}),
        model: request.model,
        stream: true,
        max_tokens: request.maxTokens ?? defaultMaxTokens,
        ...(request.reasoning === undefined
            ? {}
            : {
                thinking: { type: "adaptive" },
                output_config: { effort: request.reasoning.effort },
            }),
        ...(system.length === 0 ? {} : { system }),
        messages,
        ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : {
                tools: request.tools.flatMap((tool) =>
                    "function" in tool
                        ? [{
                            name: tool.function.name,
                            description: tool.function.description,
                            input_schema: tool.function.parameters,
                        }]
                        : []
                ),
            }),
    };
}

function encodeMessage(message: ChatMessages): Record<string, unknown> {
    const raw = message as unknown as Record<string, unknown>;
    if (message.role === "tool") {
        return {
            role: "user",
            content: [{
                type: "tool_result",
                tool_use_id: raw.toolCallId,
                content: raw.content,
            }],
        };
    }
    if (message.role === "user") {
        return { role: "user", content: encodeUserContent(raw.content) };
    }

    const blocks: Record<string, unknown>[] = [];
    const reasoningDetails = Array.isArray(raw.reasoningDetails)
        ? raw.reasoningDetails
        : [];
    for (const detail of reasoningDetails) {
        if (!isRecord(detail) || detail.type !== "reasoning.text") continue;
        blocks.push({
            type: "thinking",
            thinking: typeof detail.text === "string" ? detail.text : "",
            ...(typeof detail.signature === "string"
                ? { signature: detail.signature }
                : {}),
        });
    }
    if (reasoningDetails.length === 0 && typeof raw.reasoning === "string") {
        blocks.push({ type: "thinking", thinking: raw.reasoning });
    }
    if (typeof raw.content === "string" && raw.content.length > 0) {
        blocks.push({ type: "text", text: raw.content });
    }
    if (Array.isArray(raw.toolCalls)) {
        for (const value of raw.toolCalls) {
            if (!isRecord(value) || !isRecord(value.function)) continue;
            blocks.push({
                type: "tool_use",
                id: value.id,
                name: value.function.name,
                input: parseObject(value.function.arguments),
            });
        }
    }
    return { role: "assistant", content: blocks };
}

function encodeUserContent(value: unknown): unknown {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.flatMap((part): Record<string, unknown>[] => {
        if (!isRecord(part)) return [];
        if (part.type === "text") {
            return [{ type: "text", text: part.text }];
        }
        if (part.type === "image_url" && isRecord(part.imageUrl)) {
            const url = part.imageUrl.url;
            if (typeof url !== "string") return [];
            const match = /^data:([^;]+);base64,(.*)$/.exec(url);
            if (match === null) return [];
            return [{
                type: "image",
                source: {
                    type: "base64",
                    media_type: match[1],
                    data: match[2],
                },
            }];
        }
        return [];
    });
}

async function* decodeAnthropicSse(
    body: ReadableStream<Uint8Array>,
): AsyncIterable<ChatStreamChunk> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    let model: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    const translate = (data: Record<string, unknown>): ChatStreamChunk | undefined => {
        const type = data.type;
        if (type === "message_start" && isRecord(data.message)) {
            model = typeof data.message.model === "string" ? data.message.model : model;
            if (isRecord(data.message.usage)) {
                inputTokens = numeric(data.message.usage.input_tokens);
            }
            return chunk(model, {});
        }
        if (type === "content_block_start" && isRecord(data.content_block)) {
            const index = numeric(data.index);
            const block = data.content_block;
            if (block.type === "tool_use") {
                return chunk(model, {
                    toolCalls: [{
                        index,
                        id: block.id,
                        type: "function",
                        function: { name: block.name, arguments: "" },
                    }],
                });
            }
            return undefined;
        }
        if (type === "content_block_delta" && isRecord(data.delta)) {
            const index = numeric(data.index);
            const delta = data.delta;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
                return chunk(model, { content: delta.text });
            }
            if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                return chunk(model, {
                    reasoning: delta.thinking,
                    reasoningDetails: [{
                        type: "reasoning.text",
                        index,
                        format: "anthropic-claude-v1",
                        text: delta.thinking,
                    }],
                });
            }
            if (delta.type === "signature_delta" && typeof delta.signature === "string") {
                return chunk(model, {
                    reasoningDetails: [{
                        type: "reasoning.text",
                        index,
                        format: "anthropic-claude-v1",
                        signature: delta.signature,
                    }],
                });
            }
            if (
                delta.type === "input_json_delta"
                && typeof delta.partial_json === "string"
            ) {
                return chunk(model, {
                    toolCalls: [{
                        index,
                        function: { arguments: delta.partial_json },
                    }],
                });
            }
            return undefined;
        }
        if (type === "message_delta") {
            if (isRecord(data.usage)) {
                outputTokens = numeric(data.usage.output_tokens);
            }
            const stop = isRecord(data.delta) && typeof data.delta.stop_reason === "string"
                ? anthropicStopReason(data.delta.stop_reason)
                : undefined;
            return chunk(model, {}, stop, {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
            });
        }
        if (type === "error") {
            throw new Error(
                isRecord(data.error) && typeof data.error.message === "string"
                    ? data.error.message
                    : "Anthropic stream returned an error",
            );
        }
        return undefined;
    };

    for await (const bytes of body) {
        buffered += decoder.decode(bytes, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffered)) !== null) {
            const event = buffered.slice(0, match.index);
            buffered = buffered.slice(match.index + match[0].length);
            const data = parseSseData(event);
            if (data !== undefined) {
                const translated = translate(data);
                if (translated !== undefined) yield translated;
            }
        }
    }
    buffered += decoder.decode();
    const data = parseSseData(buffered);
    if (data !== undefined) {
        const translated = translate(data);
        if (translated !== undefined) yield translated;
    }
}

function chunk(
    model: string | undefined,
    delta: Record<string, unknown>,
    finishReason?: string,
    usage?: Record<string, number>,
): ChatStreamChunk {
    return {
        ...(model === undefined ? {} : { model }),
        choices: [{
            index: 0,
            delta,
            ...(finishReason === undefined ? {} : { finishReason }),
        }],
        ...(usage === undefined ? {} : { usage }),
    } as unknown as ChatStreamChunk;
}

function parseSseData(event: string): Record<string, unknown> | undefined {
    const data = event.replace(/\r\n?/g, "\n").split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    if (data.length === 0) return undefined;
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) throw new Error("Anthropic returned invalid stream data");
    return parsed;
}

function anthropicStopReason(value: string): string {
    if (value === "tool_use") return "tool_calls";
    if (value === "max_tokens") return "length";
    return "stop";
}

function parseObject(value: unknown): Record<string, unknown> {
    if (typeof value !== "string") return {};
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
}

function numeric(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
