import type {
    ModelMessage,
    ModelTool,
    ModelUsage,
} from "../model/types.ts";
import type { ProviderReasoningEffort } from "../model/reasoning-effort.ts";

export interface OpenAICodexInputText {
    readonly type: "input_text";
    readonly text: string;
}

export interface OpenAICodexOutputText {
    readonly type: "output_text";
    readonly text: string;
}

export interface OpenAICodexUserInput {
    readonly type: "message";
    readonly role: "user";
    readonly content: readonly OpenAICodexInputText[];
}

export interface OpenAICodexAssistantInput {
    readonly type: "message";
    readonly role: "assistant";
    readonly content: readonly OpenAICodexOutputText[];
}

export interface OpenAICodexFunctionCallInput {
    readonly type: "function_call";
    readonly call_id: string;
    readonly name: string;
    readonly arguments: string;
}

export interface OpenAICodexFunctionOutputInput {
    readonly type: "function_call_output";
    readonly call_id: string;
    readonly output: string;
}

export interface OpenAICodexReasoningInput {
    readonly type: "reasoning";
    readonly [key: string]: unknown;
}

export type OpenAICodexInputItem =
    | OpenAICodexUserInput
    | OpenAICodexAssistantInput
    | OpenAICodexFunctionCallInput
    | OpenAICodexFunctionOutputInput
    | OpenAICodexReasoningInput;

export interface OpenAICodexTool {
    readonly type: "function";
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
}

export interface OpenAICodexRequest {
    readonly model: string;
    readonly instructions: string;
    readonly input: readonly OpenAICodexInputItem[];
    readonly tools: readonly OpenAICodexTool[];
    readonly tool_choice: "auto";
    readonly parallel_tool_calls: false;
    readonly reasoning: {
        readonly effort?: ProviderReasoningEffort;
        readonly summary: "auto";
    };
    readonly store: false;
    readonly stream: true;
    readonly include: readonly ["reasoning.encrypted_content"];
}

export interface OpenAICodexStreamEvent {
    readonly type: string;
    readonly [key: string]: unknown;
}

export type SendOpenAICodexResponse = (
    request: OpenAICodexRequest,
    signal?: AbortSignal,
) => Promise<AsyncIterable<OpenAICodexStreamEvent>>;

export function encodeOpenAICodexInput(
    messages: readonly ModelMessage[],
): OpenAICodexInputItem[] {
    const input: OpenAICodexInputItem[] = [];

    for (const message of messages) {
        if (message.role === "user") {
            input.push({
                type: "message",
                role: "user",
                content: [{
                    type: "input_text",
                    text: joinText(message.content),
                }],
            });
            continue;
        }
        if (message.role === "tool_result") {
            input.push({
                type: "function_call_output",
                call_id: message.toolCallId,
                output: joinText(message.content),
            });
            continue;
        }

        for (const block of message.content) {
            if (block.type === "tool_call") {
                input.push({
                    type: "function_call",
                    call_id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                });
                continue;
            }
            if (block.type === "thinking" && block.signature !== undefined) {
                input.push(decodeReasoningItem(block.signature));
                continue;
            }
            if (block.text) {
                input.push({
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: block.text }],
                });
            }
        }
    }

    return input;
}

export function encodeOpenAICodexTools(
    tools: readonly ModelTool[],
): OpenAICodexTool[] {
    return tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
    }));
}

export function encodeOpenAICodexReasoningItem(
    item: OpenAICodexReasoningInput,
): string {
    return JSON.stringify(item);
}

export function parseOpenAICodexToolInput(
    value: string,
    outputIndex: number,
): Readonly<Record<string, unknown>> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error(
            `OpenAI Codex returned invalid JSON for tool call at index ${outputIndex}`,
        );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(
            `OpenAI Codex returned non-object input for tool call at index ${outputIndex}`,
        );
    }
    return parsed as Record<string, unknown>;
}

export function openAICodexUsage(value: unknown): ModelUsage {
    if (typeof value !== "object" || value === null) {
        return emptyWireUsage();
    }
    const usage = value as Record<string, unknown>;
    const inputTokens = numberOrZero(usage.input_tokens);
    const outputTokens = numberOrZero(usage.output_tokens);
    const inputDetails = objectOrEmpty(usage.input_tokens_details);
    const outputDetails = objectOrEmpty(usage.output_tokens_details);
    return {
        inputTokens,
        outputTokens,
        cachedInputTokens: numberOrZero(inputDetails.cached_tokens),
        reasoningTokens: numberOrZero(outputDetails.reasoning_tokens),
        totalTokens: numberOrZero(usage.total_tokens) || inputTokens + outputTokens,
    };
}

export async function* readOpenAICodexEvents(
    body: ReadableStream<Uint8Array>,
): AsyncIterable<OpenAICodexStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                buffer += decoder.decode();
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const events = splitCompleteEvents(buffer);
            buffer = events.remainder;
            for (const source of events.sources) {
                const event = parseEvent(source);
                if (event !== undefined) {
                    yield event;
                }
            }
        }

        if (buffer.trim()) {
            const event = parseEvent(buffer);
            if (event !== undefined) {
                yield event;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

function decodeReasoningItem(value: string): OpenAICodexReasoningInput {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("Stored OpenAI Codex reasoning item is invalid JSON");
    }
    if (
        typeof parsed !== "object"
        || parsed === null
        || (parsed as Record<string, unknown>).type !== "reasoning"
    ) {
        throw new Error("Stored OpenAI Codex reasoning item is invalid");
    }
    return parsed as OpenAICodexReasoningInput;
}

interface SplitEventsResult {
    readonly sources: readonly string[];
    readonly remainder: string;
}

function splitCompleteEvents(value: string): SplitEventsResult {
    const normalized = value.replace(/\r\n|\r/g, "\n");
    const parts = normalized.split("\n\n");
    return {
        sources: parts.slice(0, -1),
        remainder: parts.at(-1) ?? "",
    };
}

function parseEvent(source: string): OpenAICodexStreamEvent | undefined {
    const data = source
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    if (!data || data === "[DONE]") {
        return undefined;
    }

    let value: unknown;
    try {
        value = JSON.parse(data);
    } catch {
        throw new Error("OpenAI Codex returned invalid stream JSON");
    }
    if (
        typeof value !== "object"
        || value === null
        || typeof (value as Record<string, unknown>).type !== "string"
    ) {
        throw new Error("OpenAI Codex returned an invalid stream event");
    }
    return value as OpenAICodexStreamEvent;
}

function joinText(content: readonly { readonly text: string }[]): string {
    return content.map((block) => block.text).join("");
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : {};
}

function numberOrZero(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyWireUsage(): ModelUsage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
    };
}
