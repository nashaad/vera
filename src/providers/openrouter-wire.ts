import type {
    ChatContentItems,
    ChatMessages,
    ChatFunctionTool,
    ChatStreamChunk,
    ChatUsage,
    ReasoningDetailUnion,
} from "@openrouter/sdk/models";

import type {
    ModelInputMessage,
    ModelInputUserMessage,
    ModelStopReason,
    ModelTool,
    ModelUsage,
} from "../model/types.ts";
import type { ProviderReasoningEffort } from "../model/reasoning-effort.ts";
import type { JsonValue } from "../sdk/hooks.ts";
import { normalizeGoogleToolSchema } from "./google-tool-schema.ts";

export interface OpenRouterChatRequest {
    readonly model: string;
    readonly maxTokens?: number;
    readonly messages: ChatMessages[];
    readonly reasoning?: {
        readonly effort: ProviderReasoningEffort;
    };
    readonly tools?: ChatFunctionTool[];
    readonly bodyExtensions?: Readonly<Record<string, JsonValue>>;
}

export type SendOpenRouterChat = (
    request: OpenRouterChatRequest,
    signal?: AbortSignal,
) => Promise<AsyncIterable<ChatStreamChunk>>;

export function encodeOpenRouterMessages(
    systemPrompt: string | undefined,
    messages: readonly ModelInputMessage[],
): ChatMessages[] {
    const encoded: ChatMessages[] = [];
    if (systemPrompt) {
        encoded.push({ role: "system", content: systemPrompt });
    }

    for (const message of messages) {
        if (message.role === "user") {
            encoded.push({
                role: "user",
                content: encodeUserContent(message.content),
            });
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
            // OpenRouter accepts plaintext reasoning or the signed detail
            // sequence, not both. Claude tool continuations require the exact
            // signed sequence returned by the preceding request.
            ...(reasoning && reasoningDetails.length === 0 ? { reasoning } : {}),
            ...(reasoningDetails.length > 0 ? { reasoningDetails } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
    }

    return encoded;
}

export function encodeOpenRouterTools(
    tools: readonly ModelTool[],
    model?: string,
): ChatFunctionTool[] {
    const normalize = model?.toLowerCase().startsWith("google/gemini-") === true
        ? normalizeGoogleToolSchema
        : (schema: Readonly<Record<string, unknown>>) => schema;
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: normalize(tool.inputSchema),
        },
    }));
}

export function normalizeOpenRouterToolCallId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Returns undefined for a word outside the OpenAI vocabulary. The caller then
 * reads the stop reason off the content it received, which is a better answer
 * than failing a request the server considered successful: an unrecognised
 * word is a gap in this table, not a statement that the turn went wrong.
 */
export function openRouterStopReason(reason: string): ModelStopReason | undefined {
    const reasons: Readonly<Partial<Record<string, ModelStopReason>>> = {
        stop: "stop",
        length: "length",
        tool_calls: "tool_use",
        content_filter: "content_filter",
        error: "error",
    };
    return reasons[reason];
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

function encodeUserContent(
    content: ModelInputUserMessage["content"],
): string | ChatContentItems[] {
    if (content.every((block) => block.type === "text")) {
        return joinText(content);
    }

    return content.map((block) => {
        if (block.type === "text") {
            return { type: "text" as const, text: block.text };
        }
        if (block.type === "image_attachment") {
            throw new Error("Image attachment was not hydrated");
        }
        return {
            type: "image_url" as const,
            imageUrl: {
                url: `data:${block.mediaType};base64,${
                    Buffer.from(block.data).toString("base64")
                }`,
            },
        };
    });
}

function joinText(content: readonly { readonly type: string; readonly text?: string }[]): string {
    return content.flatMap((block) => block.type === "text" && block.text !== undefined
        ? [block.text]
        : []).join("");
}
