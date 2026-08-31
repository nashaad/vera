import { ModelEventStream } from "../model/stream.ts";
import { ProviderFailureError } from "../model/provider-failure.ts";
import {
    encodeOpenAICodexReasoningItem,
    malformedOpenAICodexToolCall,
    openAICodexUsage,
    parseOpenAICodexToolInput,
    type OpenAICodexReasoningInput,
    type OpenAICodexStreamEvent,
} from "./openai-codex-wire.ts";
import {
    emptyUsage,
    type AssistantContent,
    type AssistantMessage,
    type ModelSource,
    type ModelStopReason,
    type ModelUsage,
} from "../model/types.ts";

interface PendingToolCall {
    readonly contentIndex: number;
    id: string;
    name: string;
    arguments: string;
}

interface ResponseItem {
    readonly type?: string;
    readonly call_id?: string;
    readonly name?: string;
    readonly arguments?: string;
    readonly content?: unknown;
    readonly summary?: unknown;
    readonly [key: string]: unknown;
}

export class OpenAICodexStreamDecoder {
    private readonly source: ModelSource;
    private readonly output: ModelEventStream;
    private readonly content: AssistantContent[] = [];
    private readonly textBlocks = new Map<number, number>();
    private readonly thinkingBlocks = new Map<number, number>();
    private readonly toolCalls = new Map<number, PendingToolCall>();
    private nextContentIndex = 0;
    private completed = false;
    private finishReason?: ModelStopReason;
    private responseModel?: string;
    private usage: ModelUsage = emptyUsage();

    constructor(source: ModelSource, output: ModelEventStream) {
        this.source = source;
        this.output = output;
    }

    accept(event: OpenAICodexStreamEvent): void {
        if (event.type === "response.output_text.delta") {
            this.appendText(
                numberValue(event.output_index),
                stringValue(event.delta),
            );
            return;
        }
        if (event.type === "response.refusal.delta") {
            this.appendText(
                numberValue(event.output_index),
                stringValue(event.delta),
            );
            return;
        }
        if (event.type === "response.reasoning_summary_part.added") {
            this.separateThinking(numberValue(event.output_index));
            return;
        }
        if (
            event.type === "response.reasoning_summary_text.delta"
            || event.type === "response.reasoning_text.delta"
            || event.type === "response.reasoning_summary.delta"
            || event.type === "response.reasoning.delta"
        ) {
            this.appendThinking(
                numberValue(event.output_index),
                stringValue(event.delta),
            );
            return;
        }
        if (event.type === "response.output_item.added") {
            const item = responseItem(event.item);
            const outputIndex = numberValue(event.output_index);
            if (item?.type === "message") {
                this.ensureText(outputIndex);
            } else if (item?.type === "reasoning") {
                this.ensureThinking(outputIndex);
            } else if (item?.type === "function_call") {
                this.ensureToolCall(outputIndex, item);
            }
            return;
        }
        if (event.type === "response.function_call_arguments.delta") {
            const outputIndex = numberValue(event.output_index);
            const pending = this.ensureToolCall(outputIndex);
            const delta = stringValue(event.delta);
            pending.arguments += delta;
            if (delta) {
                this.output.push({
                    type: "tool_call_delta",
                    contentIndex: pending.contentIndex,
                    argumentsDelta: delta,
                });
            }
            return;
        }
        if (event.type === "response.output_item.done") {
            const item = responseItem(event.item);
            const outputIndex = numberValue(event.output_index);
            if (item?.type === "message") {
                this.finishText(outputIndex, item);
            } else if (item?.type === "reasoning") {
                this.finishReasoning(
                    outputIndex,
                    item as OpenAICodexReasoningInput,
                );
            } else if (item?.type === "function_call") {
                this.finishToolCall(outputIndex, item);
            }
            return;
        }
        if (event.type === "response.completed") {
            this.acceptCompleted(event.response);
            return;
        }
        if (event.type === "response.incomplete") {
            this.acceptIncomplete(event.response);
            return;
        }
        if (event.type === "response.failed" || event.type === "error") {
            throw new Error(openAICodexStreamError(event));
        }
    }

    finish(): AssistantMessage {
        if (!this.completed || this.finishReason === undefined) {
            throw new Error("OpenAI Codex stream ended without response.completed");
        }
        this.finishOpenBlocks();
        return this.message(this.finishReason);
    }

    partial(stopReason: "aborted" | "error", errorMessage: string): AssistantMessage {
        return this.message(stopReason, errorMessage);
    }

    private appendText(outputIndex: number, text: string): void {
        if (!text) {
            return;
        }
        const contentIndex = this.ensureText(outputIndex);
        const block = this.content[contentIndex];
        if (block?.type !== "text") {
            throw new Error("OpenAI Codex text stream has an invalid content index");
        }
        this.content[contentIndex] = { ...block, text: block.text + text };
        this.output.push({ type: "text_delta", contentIndex, text });
    }

    private ensureText(outputIndex: number): number {
        const existing = this.textBlocks.get(outputIndex);
        if (existing !== undefined) {
            return existing;
        }
        const contentIndex = this.nextContentIndex++;
        this.textBlocks.set(outputIndex, contentIndex);
        this.content[contentIndex] = { type: "text", text: "" };
        this.output.push({ type: "text_start", contentIndex });
        return contentIndex;
    }

    private finishText(outputIndex: number, item?: ResponseItem): void {
        const contentIndex = this.ensureText(outputIndex);
        const block = this.content[contentIndex];
        if (block?.type !== "text") {
            throw new Error("OpenAI Codex text item has an invalid content index");
        }
        const finalText = item === undefined ? "" : textFromMessage(item);
        if (!block.text && finalText) {
            this.content[contentIndex] = { ...block, text: finalText };
            this.output.push({ type: "text_delta", contentIndex, text: finalText });
        }
        this.output.push({ type: "text_end", contentIndex });
        this.textBlocks.delete(outputIndex);
    }

    private appendThinking(outputIndex: number, text: string): void {
        if (!text) {
            return;
        }
        const contentIndex = this.ensureThinking(outputIndex);
        const block = this.content[contentIndex];
        if (block?.type !== "thinking") {
            throw new Error("OpenAI Codex thinking stream has an invalid content index");
        }
        this.content[contentIndex] = { ...block, text: block.text + text };
        this.output.push({ type: "thinking_delta", contentIndex, text });
    }

    /**
     * A new summary part starts where the previous one ended, and the blank line
     * between them is never streamed: the non-streaming path joins the parts with
     * one, so the streaming path writes it here.
     */
    private separateThinking(outputIndex: number): void {
        const contentIndex = this.thinkingBlocks.get(outputIndex);
        if (contentIndex === undefined) {
            return;
        }
        const block = this.content[contentIndex];
        if (block?.type === "thinking" && block.text.length > 0) {
            this.appendThinking(outputIndex, "\n\n");
        }
    }

    private ensureThinking(outputIndex: number): number {
        const existing = this.thinkingBlocks.get(outputIndex);
        if (existing !== undefined) {
            return existing;
        }
        const contentIndex = this.nextContentIndex++;
        this.thinkingBlocks.set(outputIndex, contentIndex);
        this.content[contentIndex] = { type: "thinking", text: "" };
        this.output.push({
            type: "thinking_start",
            contentIndex,
        });
        return contentIndex;
    }

    private finishReasoning(
        outputIndex: number,
        item: OpenAICodexReasoningInput,
    ): void {
        const contentIndex = this.ensureThinking(outputIndex);
        const block = this.content[contentIndex];
        if (block?.type !== "thinking") {
            throw new Error("OpenAI Codex reasoning item has an invalid content index");
        }
        const finalText = reasoningText(item);
        const text = block.text || finalText;
        if (!block.text && text) {
            this.output.push({ type: "thinking_delta", contentIndex, text });
        }
        this.content[contentIndex] = {
            ...block,
            text,
            signature: encodeOpenAICodexReasoningItem(item),
        };
        this.output.push({ type: "thinking_end", contentIndex });
        this.thinkingBlocks.delete(outputIndex);
    }

    private ensureToolCall(
        outputIndex: number,
        item?: ResponseItem,
    ): PendingToolCall {
        let pending = this.toolCalls.get(outputIndex);
        if (pending === undefined) {
            pending = {
                contentIndex: this.nextContentIndex++,
                id: "",
                name: "",
                arguments: "",
            };
            this.toolCalls.set(outputIndex, pending);
            this.output.push({
                type: "tool_call_start",
                contentIndex: pending.contentIndex,
            });
        }
        pending.id ||= item?.call_id ?? "";
        pending.name ||= item?.name ?? "";
        return pending;
    }

    private finishToolCall(outputIndex: number, item: ResponseItem): void {
        const pending = this.ensureToolCall(outputIndex, item);
        const id = item.call_id ?? pending.id;
        const name = item.name ?? pending.name;
        const argumentsValue = item.arguments ?? pending.arguments;
        if (!id || !name) {
            throw malformedOpenAICodexToolCall(
                `OpenAI Codex returned incomplete tool call at index ${outputIndex}`,
                undefined,
            );
        }
        const toolCall = {
            type: "tool_call" as const,
            id,
            name,
            input: parseOpenAICodexToolInput(argumentsValue || "{}", outputIndex),
        };
        this.content[pending.contentIndex] = toolCall;
        this.output.push({
            type: "tool_call_end",
            contentIndex: pending.contentIndex,
            toolCall,
        });
        this.toolCalls.delete(outputIndex);
    }

    private acceptCompleted(value: unknown): void {
        const response = objectValue(value);
        this.completed = true;
        this.responseModel = optionalString(response.model);
        this.usage = openAICodexUsage(response.usage);
        this.finishReason = this.content.some((block) => block?.type === "tool_call")
            ? "tool_use"
            : "stop";
    }

    private acceptIncomplete(value: unknown): void {
        const response = objectValue(value);
        const details = objectValue(response.incomplete_details);
        const reason = optionalString(details.reason);
        this.completed = true;
        this.responseModel = optionalString(response.model);
        this.usage = openAICodexUsage(response.usage);
        this.finishReason = reason === "content_filter" ? "content_filter" : "length";
    }

    private finishOpenBlocks(): void {
        for (const outputIndex of sortedKeys(this.textBlocks)) {
            this.finishText(outputIndex);
        }
        for (const outputIndex of sortedKeys(this.thinkingBlocks)) {
            const contentIndex = this.thinkingBlocks.get(outputIndex);
            if (contentIndex === undefined) {
                continue;
            }
            this.output.push({
                type: "thinking_end",
                contentIndex,
            });
            this.thinkingBlocks.delete(outputIndex);
        }
        if (this.toolCalls.size > 0) {
            const outputIndex = this.toolCalls.keys().next().value;
            if (this.finishReason === "length") {
                throw new ProviderFailureError(
                    {
                        kind: "unknown",
                        resolution: "none",
                        message: "OpenAI Codex reached its output limit during a tool call",
                    },
                    undefined,
                );
            }
            throw malformedOpenAICodexToolCall(
                `OpenAI Codex returned incomplete tool call at index ${outputIndex}`,
                undefined,
            );
        }
    }

    private message(
        stopReason: ModelStopReason,
        errorMessage?: string,
    ): AssistantMessage {
        const responseModel = this.responseModel === this.source.model
            ? undefined
            : this.responseModel;
        return {
            role: "assistant",
            content: this.content.filter((block) => block !== undefined),
            source: {
                ...this.source,
                ...(responseModel === undefined ? {} : { responseModel }),
            },
            usage: this.usage,
            stopReason,
            ...(errorMessage === undefined ? {} : { errorMessage }),
        };
    }
}

function openAICodexStreamError(event: OpenAICodexStreamEvent): string {
    const response = objectValue(event.response);
    const error = objectValue(event.error ?? response.error);
    return optionalString(error.message)
        ?? optionalString(response.message)
        ?? "OpenAI Codex stream failed";
}

function responseItem(value: unknown): ResponseItem | undefined {
    return typeof value === "object" && value !== null
        ? value as ResponseItem
        : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : {};
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
    return typeof value === "number" && Number.isInteger(value) ? value : -1;
}

function textFromMessage(item: ResponseItem): string {
    if (!Array.isArray(item.content)) {
        return "";
    }
    return item.content.map((value) => {
        const part = objectValue(value);
        return optionalString(part.text) ?? optionalString(part.refusal) ?? "";
    }).join("");
}

function reasoningText(item: OpenAICodexReasoningInput): string {
    for (const field of [item.summary, item.content]) {
        if (!Array.isArray(field)) {
            continue;
        }
        const text = field.map((value) =>
            optionalString(objectValue(value).text) ?? ""
        ).join("\n\n");
        if (text) {
            return text;
        }
    }
    return "";
}

function sortedKeys<T>(map: ReadonlyMap<number, T>): number[] {
    return [...map.keys()].sort((left, right) => left - right);
}
