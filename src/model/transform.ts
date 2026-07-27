import type {
    AssistantContent,
    AssistantMessage,
    ModelInputMessage,
    ModelMessage,
    ModelSource,
    ModelInputToolResultMessage,
    ToolCallContent,
    ToolResultMessage,
} from "./types.ts";

export interface TransformMessagesOptions {
    readonly target: ModelSource;
    readonly normalizeToolCallId?: (id: string) => string;
}

interface TransformedAssistant {
    readonly message: AssistantMessage;
    readonly toolCalls: ReadonlyMap<string, ToolCallContent>;
}

export function transformMessages(
    messages: readonly ModelInputMessage[],
    options: TransformMessagesOptions,
): ModelInputMessage[] {
    const resultIds = collectToolResultIds(messages);
    const skippedToolCallIds = collectSkippedToolCallIds(messages);
    const transformedToolCallIds = new Map<string, string>();
    const usedToolCallIds = new Set<string>();
    const transformed: ModelInputMessage[] = [];

    for (const message of messages) {
        if (message.role === "assistant") {
            if (shouldSkip(message)) {
                continue;
            }

            const assistant = transformAssistant(message, options, usedToolCallIds);
            transformed.push(assistant.message);
            for (const [originalId, toolCall] of assistant.toolCalls) {
                transformedToolCallIds.set(originalId, toolCall.id);
                if (!resultIds.has(originalId)) {
                    transformed.push(missingToolResult(toolCall.id, toolCall.name));
                }
            }
            continue;
        }

        if (message.role === "tool_result") {
            if (skippedToolCallIds.has(message.toolCallId)) {
                continue;
            }

            transformed.push({
                ...message,
                toolCallId: transformedToolCallIds.get(message.toolCallId) ?? message.toolCallId,
            });
            continue;
        }

        transformed.push(message);
    }

    return transformed;
}

function transformAssistant(
    message: AssistantMessage,
    options: TransformMessagesOptions,
    usedToolCallIds: Set<string>,
): TransformedAssistant {
    const sameWireFormat =
        message.source.provider === options.target.provider &&
        message.source.api === options.target.api;
    const toolCalls = new Map<string, ToolCallContent>();
    const content = message.content.map((block): AssistantContent => {
        if (block.type === "thinking") {
            return sameWireFormat ? block : { type: "text", text: block.text };
        }

        if (block.type !== "tool_call") {
            return block;
        }

        const normalizedId = options.normalizeToolCallId?.(block.id) ?? block.id;
        if (usedToolCallIds.has(normalizedId)) {
            throw new Error(`Tool call ID normalization produced duplicate ID: ${normalizedId}`);
        }
        usedToolCallIds.add(normalizedId);
        const toolCall: ToolCallContent = {
            type: "tool_call",
            id: normalizedId,
            name: block.name,
            input: block.input,
        };
        toolCalls.set(block.id, toolCall);

        return sameWireFormat && block.signature !== undefined
            ? { ...toolCall, signature: block.signature }
            : toolCall;
    });

    return {
        message: { ...message, content },
        toolCalls,
    };
}

function collectToolResultIds(messages: readonly ModelInputMessage[]): Set<string> {
    return new Set(
        messages
            .filter((message): message is ModelInputToolResultMessage =>
                message.role === "tool_result"
            )
            .map((message) => message.toolCallId),
    );
}

function collectSkippedToolCallIds(messages: readonly ModelInputMessage[]): Set<string> {
    const ids = new Set<string>();
    for (const message of messages) {
        if (message.role !== "assistant" || !shouldSkip(message)) {
            continue;
        }
        for (const block of message.content) {
            if (block.type === "tool_call") {
                ids.add(block.id);
            }
        }
    }
    return ids;
}

function shouldSkip(message: AssistantMessage): boolean {
    return message.stopReason === "error" || message.stopReason === "aborted";
}

function missingToolResult(toolCallId: string, toolName: string): ToolResultMessage {
    return {
        role: "tool_result",
        toolCallId,
        toolName,
        content: [{ type: "text", text: "Tool call did not receive a result." }],
        isError: true,
    };
}
