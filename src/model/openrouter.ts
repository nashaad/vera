import { OpenRouter } from "@openrouter/sdk";

import { OpenRouterStreamDecoder } from "./openrouter-stream.ts";
import { ModelEventStream } from "./stream.ts";
import { transformMessages } from "./transform.ts";
import {
    encodeOpenRouterMessages,
    normalizeOpenRouterToolCallId,
    type SendOpenRouterChat,
} from "./openrouter-wire.ts";
import type {
    ModelAdapter,
    ModelRequest,
    ModelSource,
} from "./types.ts";

export type { SendOpenRouterChat } from "./openrouter-wire.ts";

export interface OpenRouterAdapterOptions {
    readonly apiKey: string;
}

export class OpenRouterAdapter implements ModelAdapter {
    private readonly sendChat: SendOpenRouterChat;

    constructor(sendChat: SendOpenRouterChat) {
        this.sendChat = sendChat;
    }

    stream(request: ModelRequest): ModelEventStream {
        const stream = new ModelEventStream();
        void this.produce(request, stream);
        return stream;
    }

    private async produce(request: ModelRequest, stream: ModelEventStream): Promise<void> {
        const source: ModelSource = {
            provider: "openrouter",
            api: "openrouter-chat",
            model: request.model,
        };
        const decoder = new OpenRouterStreamDecoder(source, stream);
        stream.push({ type: "start" });

        try {
            throwIfAborted(request.signal);
            const messages = transformMessages(request.messages, {
                target: source,
                normalizeToolCallId: normalizeOpenRouterToolCallId,
            });
            const chunks = await this.sendChat(
                {
                    model: request.model,
                    messages: encodeOpenRouterMessages(request.systemPrompt, messages),
                },
                request.signal,
            );

            for await (const chunk of chunks) {
                throwIfAborted(request.signal);
                decoder.accept(chunk);
            }

            const message = decoder.finish();
            if (message.stopReason === "error") {
                const error = new Error("OpenRouter stopped with an error");
                stream.push({
                    type: "error",
                    error,
                    message: { ...message, errorMessage: error.message },
                });
            } else {
                stream.push({ type: "done", message });
            }
        } catch (value) {
            const error = toError(value);
            const stopReason = request.signal?.aborted ? "aborted" : "error";
            stream.push({
                type: "error",
                error,
                message: decoder.partial(stopReason, error.message),
            });
        }
    }
}

export function createOpenRouterAdapter(
    options: OpenRouterAdapterOptions,
): OpenRouterAdapter {
    const client = new OpenRouter({ apiKey: options.apiKey });

    return new OpenRouterAdapter(async (request, signal) => {
        return client.chat.send(
            {
                chatRequest: {
                    model: request.model,
                    messages: request.messages,
                    stream: true,
                },
            },
            { signal },
        );
    });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw signal.reason ?? new Error("Model request aborted");
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
