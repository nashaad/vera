import type {
    ChatMessages,
    ChatStreamChunk,
    ChatUsage,
    ReasoningDetailUnion,
} from "@openrouter/sdk/models";

import type { ModelMessage, ModelStopReason, ModelUsage } from "./types.ts";

export interface OpenRouterChatRequest {
    readonly model: string;
    readonly messages: ChatMessages[];
}

export type SendOpenRouterChat = (
    request: OpenRouterChatRequest,
    signal?: AbortSignal,
) => Promise<AsyncIterable<ChatStreamChunk>>;

export function encodeOpenRouterMessages(
    systemPrompt: string | undefined,
    messages: readonly ModelMessage[],
): ChatMessages[] {
    const encoded: ChatMessages[] = [];
    if (systemPrompt) {
        encoded.push({ role: "system", content: systemPrompt });
    }

    for (const message of messages) {
        if (message.role === "user") {
            encoded.push({ role: "user", content: joinText(message.content) });
            continue;
        }
        if (message.role === "tool_result") {
            encoded.push({
                role: "tool",
                toolCallId: message.toolCallId,
                content: joinText(message.content),
            });
            continue;
        }

        const text = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
        const reasoning = message.content
            .filter((block) => block.type === "thinking")
            .map((block) => block.text)
            .join("");
        const reasoningDetails = message.content
            .flatMap((block) => block.type === "thinking" && block.signature !== undefined
                ? decodeReasoningDetails(block.signature)
                : []);
        const toolCalls = message.content
            .filter((block) => block.type === "tool_call")
            .map((block) => ({
                id: block.id,
                type: "function" as const,
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                },
            }));
        encoded.push({
            role: "assistant",
            content: text,
            ...(reasoning ? { reasoning } : {}),
            ...(reasoningDetails.length > 0 ? { reasoningDetails } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
    }

    return encoded;
}

export function normalizeOpenRouterToolCallId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function openRouterStopReason(reason: string): ModelStopReason {
    const reasons: Readonly<Record<string, ModelStopReason>> = {
        stop: "stop",
        length: "length",
        tool_calls: "tool_use",
        content_filter: "content_filter",
        error: "error",
    };
    return reasons[reason] ?? "stop";
}

export function openRouterUsage(usage: ChatUsage): ModelUsage {
    return {
        inputTokens: usage.promptTokens ?? 0,
        outputTokens: usage.completionTokens ?? 0,
        cachedInputTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
        reasoningTokens: usage.completionTokensDetails?.reasoningTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        ...(usage.cost == null ? {} : { cost: usage.cost }),
    };
}

export function encodeReasoningDetails(details: readonly ReasoningDetailUnion[]): string {
    return JSON.stringify(details);
}

function decodeReasoningDetails(value: string): ReasoningDetailUnion[] {
    let parsed: unknown;

    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("Stored OpenRouter reasoning details are invalid JSON");
    }
    if (!Array.isArray(parsed)) {
        throw new Error("Stored OpenRouter reasoning details must be an array");
    }
    return parsed as ReasoningDetailUnion[];
}

export function parseOpenRouterToolInput(
    value: string,
    index: number,
): Readonly<Record<string, unknown>> {
    let parsed: unknown;

    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error(`OpenRouter returned invalid JSON for tool call at index ${index}`);
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`OpenRouter returned non-object input for tool call at index ${index}`);
    }

    return parsed as Record<string, unknown>;
}

function joinText(content: readonly { readonly text: string }[]): string {
    return content.map((block) => block.text).join("");
}
