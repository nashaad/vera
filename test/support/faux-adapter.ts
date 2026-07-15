import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantContent,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ToolCallContent,
} from "../../src/model/types.ts";

export interface FauxAdapterOptions {
    readonly chunkSize?: number;
    readonly delayMs?: number;
}

export class FauxAdapter implements ModelAdapter {
    private readonly responses: AssistantMessage[];
    private readonly chunkSize: number;
    private readonly delayMs: number;

    constructor(
        responses: readonly AssistantMessage[],
        options: FauxAdapterOptions = {},
    ) {
        this.responses = [...responses];
        this.chunkSize = validChunkSize(options.chunkSize);
        this.delayMs = validDelay(options.delayMs);
    }

    stream(request: ModelRequest): ModelEventStream {
        const stream = new ModelEventStream();
        void this.produce(request, stream);
        return stream;
    }

    private async produce(
        request: ModelRequest,
        stream: ModelEventStream,
    ): Promise<void> {
        stream.push({ type: "start" });
        let response: AssistantMessage | undefined;
        const emittedContent: AssistantContent[] = [];

        try {
            assertNotAborted(request.signal);
            response = this.responses.shift();
            if (response === undefined) {
                throw new Error("Faux adapter has no scripted response left");
            }

            for (const [contentIndex, block] of response.content.entries()) {
                assertNotAborted(request.signal);

                if (block.type === "text") {
                    emittedContent[contentIndex] = { type: "text", text: "" };
                    stream.push({ type: "text_start", contentIndex });
                    for (const text of chunksOf(block.text, this.chunkSize)) {
                        await this.pause(request.signal);
                        const emitted: AssistantContent | undefined =
                            emittedContent[contentIndex];
                        if (emitted?.type !== "text") {
                            throw new Error("Faux text stream has an invalid content index");
                        }
                        emittedContent[contentIndex] = {
                            ...emitted,
                            text: emitted.text + text,
                        };
                        stream.push({ type: "text_delta", contentIndex, text });
                    }
                    stream.push({ type: "text_end", contentIndex });
                } else if (block.type === "thinking") {
                    emittedContent[contentIndex] = {
                        type: "thinking",
                        text: "",
                        ...(block.signature === undefined
                            ? {}
                            : { signature: block.signature }),
                    };
                    stream.push({ type: "thinking_start", contentIndex });
                    for (const text of chunksOf(block.text, this.chunkSize)) {
                        await this.pause(request.signal);
                        const emitted: AssistantContent | undefined =
                            emittedContent[contentIndex];
                        if (emitted?.type !== "thinking") {
                            throw new Error("Faux thinking stream has an invalid content index");
                        }
                        emittedContent[contentIndex] = {
                            ...emitted,
                            text: emitted.text + text,
                        };
                        stream.push({ type: "thinking_delta", contentIndex, text });
                    }
                    stream.push({ type: "thinking_end", contentIndex });
                } else {
                    await this.emitToolCall(block, contentIndex, request.signal, stream);
                    emittedContent[contentIndex] = block;
                }
            }

            stream.push({ type: "done", message: response });
        } catch (value) {
            const error = value instanceof Error ? value : new Error(String(value));
            const stopReason: "aborted" | "error" = request.signal?.aborted
                ? "aborted"
                : "error";
            const message = response === undefined
                ? fauxErrorMessage(request.model, stopReason, error.message)
                : {
                    ...response,
                    content: emittedContent.filter((block) => block !== undefined),
                    stopReason,
                    errorMessage: error.message,
                };
            stream.push({
                type: "error",
                error,
                message,
            });
        }
    }

    private async emitToolCall(
        toolCall: ToolCallContent,
        contentIndex: number,
        signal: AbortSignal | undefined,
        stream: ModelEventStream,
    ): Promise<void> {
        stream.push({
            type: "tool_call_start",
            contentIndex,
        });
        const serializedInput = JSON.stringify(toolCall.input);
        for (const argumentsDelta of chunksOf(serializedInput, this.chunkSize)) {
            await this.pause(signal);
            stream.push({ type: "tool_call_delta", contentIndex, argumentsDelta });
        }
        stream.push({ type: "tool_call_end", contentIndex, toolCall });
    }

    private async pause(signal: AbortSignal | undefined): Promise<void> {
        assertNotAborted(signal);
        if (this.delayMs > 0) {
            await Bun.sleep(this.delayMs);
        }
        assertNotAborted(signal);
    }
}

function chunksOf(value: string, size: number): string[] {
    if (value.length === 0) {
        return [];
    }
    if (!Number.isFinite(size)) {
        return [value];
    }

    const chunks: string[] = [];
    for (let index = 0; index < value.length; index += size) {
        chunks.push(value.slice(index, index + size));
    }
    return chunks;
}

function validChunkSize(value: number | undefined): number {
    if (value === undefined) {
        return Number.POSITIVE_INFINITY;
    }
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error("Faux adapter chunkSize must be a positive integer");
    }
    return value;
}

function validDelay(value: number | undefined): number {
    if (value === undefined) {
        return 0;
    }
    if (!Number.isFinite(value) || value < 0) {
        throw new Error("Faux adapter delayMs must be a non-negative number");
    }
    return value;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw signal.reason ?? new Error("Model request aborted");
    }
}

function fauxErrorMessage(
    model: string,
    stopReason: "aborted" | "error",
    errorMessage: string,
): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        source: { provider: "faux", api: "scripted", model },
        usage: emptyUsage(),
        stopReason,
        errorMessage,
    };
}
