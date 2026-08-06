import type {
    ChatStreamChunk,
    ChatStreamToolCall,
    ReasoningDetailUnion,
} from "@openrouter/sdk/models";

import { ProviderFailureError } from "../model/provider-failure.ts";
import { ModelEventStream } from "../model/stream.ts";
import { classifyOpenRouterStreamError } from "./openrouter-error-classifier.ts";
import {
    encodeReasoningDetails,
    openRouterStopReason,
    openRouterUsage,
    parseOpenRouterToolInput,
} from "./openrouter-wire.ts";
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

export class OpenRouterStreamDecoder {
    private readonly source: ModelSource;
    private readonly output: ModelEventStream;
    private readonly content: AssistantContent[] = [];
    private readonly toolCalls = new Map<number, PendingToolCall>();
    private readonly reasoningDetails: ReasoningDetailUnion[] = [];
    private readonly reasoningDetailIndexes = new Map<string, number>();
    private nextContentIndex = 0;
    private textIndex?: number;
    private thinkingIndex?: number;
    private finishReason?: ModelStopReason;
    private responseModel?: string;
    private usage: ModelUsage = emptyUsage();

    constructor(source: ModelSource, output: ModelEventStream) {
        this.source = source;
        this.output = output;
    }

    accept(chunk: ChatStreamChunk): void {
        if (chunk.error !== undefined) {
            const failure = classifyOpenRouterStreamError(chunk.error);
            throw new ProviderFailureError(failure, new Error(failure.message));
        }

        this.responseModel ??= chunk.model;
        this.usage = chunk.usage === undefined ? this.usage : openRouterUsage(chunk.usage);

        const choice = chunk.choices[0];
        if (choice === undefined) {
            return;
        }
        if (choice.delta.content) {
            this.appendText(choice.delta.content);
        }
        if (choice.delta.reasoning) {
            this.appendThinking(choice.delta.reasoning);
        }
        if (choice.delta.reasoningDetails !== undefined) {
            this.appendReasoningDetails(choice.delta.reasoningDetails);
        }
        for (const delta of choice.delta.toolCalls ?? []) {
            this.appendToolCall(delta);
        }
        if (choice.finishReason) {
            this.finishReason = openRouterStopReason(choice.finishReason);
        }
    }

    finish(): AssistantMessage {
        if (this.finishReason === undefined) {
            throw new Error("OpenRouter stream ended without finish_reason");
        }
        if (this.thinkingIndex === undefined && this.reasoningDetails.length > 0) {
            this.ensureThinking();
        }
        if (this.textIndex !== undefined) {
            this.output.push({ type: "text_end", contentIndex: this.textIndex });
        }
        if (this.thinkingIndex !== undefined) {
            const block = this.content[this.thinkingIndex];
            if (block?.type === "thinking" && this.reasoningDetails.length > 0) {
                this.content[this.thinkingIndex] = {
                    ...block,
                    signature: encodeReasoningDetails(this.reasoningDetails),
                };
            }
            this.output.push({ type: "thinking_end", contentIndex: this.thinkingIndex });
        }
        this.finishToolCalls();
        return this.message(this.finishReason);
    }

    partial(stopReason: "aborted" | "error", errorMessage: string): AssistantMessage {
        return this.message(stopReason, errorMessage);
    }

    private appendText(text: string): void {
        if (this.textIndex === undefined) {
            this.textIndex = this.nextContentIndex++;
            this.content[this.textIndex] = { type: "text", text: "" };
            this.output.push({ type: "text_start", contentIndex: this.textIndex });
        }

        const block = this.content[this.textIndex];
        if (block?.type !== "text") {
            throw new Error("OpenRouter text stream has an invalid content index");
        }
        this.content[this.textIndex] = { ...block, text: block.text + text };
        this.output.push({ type: "text_delta", contentIndex: this.textIndex, text });
    }

    private appendThinking(text: string): void {
        const contentIndex = this.ensureThinking();

        const block = this.content[contentIndex];
        if (block?.type !== "thinking") {
            throw new Error("OpenRouter thinking stream has an invalid content index");
        }
        this.content[contentIndex] = { ...block, text: block.text + text };
        this.output.push({ type: "thinking_delta", contentIndex, text });
    }

    private appendReasoningDetails(details: readonly ReasoningDetailUnion[]): void {
        for (const detail of details) {
            const index = reasoningDetailIndex(detail);
            if (index === undefined) {
                this.reasoningDetails.push(detail);
                continue;
            }
            const key = `${detail.type}:${index}`;
            const existingIndex = this.reasoningDetailIndexes.get(key);
            if (existingIndex === undefined) {
                this.reasoningDetailIndexes.set(key, this.reasoningDetails.length);
                this.reasoningDetails.push(detail);
                continue;
            }
            const existing = this.reasoningDetails[existingIndex];
            if (existing === undefined) {
                throw new Error("OpenRouter reasoning stream has an invalid index");
            }
            this.reasoningDetails[existingIndex] = mergeReasoningDetail(
                existing,
                detail,
            );
        }
    }

    private ensureThinking(): number {
        if (this.thinkingIndex !== undefined) {
            return this.thinkingIndex;
        }
        this.thinkingIndex = this.nextContentIndex++;
        this.content[this.thinkingIndex] = { type: "thinking", text: "" };
        this.output.push({ type: "thinking_start", contentIndex: this.thinkingIndex });
        return this.thinkingIndex;
    }

    private appendToolCall(delta: ChatStreamToolCall): void {
        let pending = this.toolCalls.get(delta.index);
        if (pending === undefined) {
            pending = {
                contentIndex: this.nextContentIndex++,
                id: delta.id ?? "",
                name: delta.function?.name ?? "",
                arguments: "",
            };
            this.toolCalls.set(delta.index, pending);
            this.output.push({
                type: "tool_call_start",
                contentIndex: pending.contentIndex,
            });
        }

        pending.id ||= delta.id ?? "";
        pending.name ||= delta.function?.name ?? "";
        const argumentsDelta = delta.function?.arguments ?? "";
        pending.arguments += argumentsDelta;
        if (argumentsDelta) {
            this.output.push({
                type: "tool_call_delta",
                contentIndex: pending.contentIndex,
                argumentsDelta,
            });
        }
    }

    private finishToolCalls(): void {
        const ordered = [...this.toolCalls].sort(([left], [right]) => left - right);
        for (const [providerIndex, pending] of ordered) {
            if (!pending.id || !pending.name) {
                throw new Error(
                    `OpenRouter returned incomplete tool call at index ${providerIndex}`,
                );
            }
            const toolCall = {
                type: "tool_call" as const,
                id: pending.id,
                name: pending.name,
                input: parseOpenRouterToolInput(pending.arguments, providerIndex),
            };
            this.content[pending.contentIndex] = toolCall;
            this.output.push({
                type: "tool_call_end",
                contentIndex: pending.contentIndex,
                toolCall,
            });
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

function reasoningDetailIndex(detail: ReasoningDetailUnion): number | undefined {
    switch (detail.type) {
        case "reasoning.text":
        case "reasoning.summary":
        case "reasoning.encrypted":
        case "reasoning.server_tool_call":
            return detail.index;
        default:
            return undefined;
    }
}

function mergeReasoningDetail(
    existing: ReasoningDetailUnion,
    incoming: ReasoningDetailUnion,
): ReasoningDetailUnion {
    if (existing.type !== incoming.type) {
        throw new Error("OpenRouter reasoning stream changed detail type");
    }
    if (existing.type === "reasoning.text" && incoming.type === "reasoning.text") {
        return {
            ...existing,
            ...incoming,
            text: `${existing.text ?? ""}${incoming.text ?? ""}`,
            signature: incoming.signature ?? existing.signature,
        };
    }
    if (
        existing.type === "reasoning.summary"
        && incoming.type === "reasoning.summary"
    ) {
        return {
            ...existing,
            ...incoming,
            summary: existing.summary + incoming.summary,
        };
    }
    if (
        existing.type === "reasoning.encrypted"
        && incoming.type === "reasoning.encrypted"
    ) {
        return {
            ...existing,
            ...incoming,
            data: existing.data + incoming.data,
        };
    }
    if (
        existing.type === "reasoning.server_tool_call"
        && incoming.type === "reasoning.server_tool_call"
    ) {
        return {
            ...existing,
            ...incoming,
            arguments: existing.arguments + incoming.arguments,
            result: existing.result + incoming.result,
            toolName: incoming.toolName || existing.toolName,
            toolCallId: incoming.toolCallId ?? existing.toolCallId,
        };
    }
    throw new Error("OpenRouter reasoning stream has an unsupported detail type");
}
