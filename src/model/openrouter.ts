import { OpenRouter } from "@openrouter/sdk";

import { classifyOpenRouterError } from "./openrouter-error-classifier.ts";
import { OpenRouterStreamDecoder } from "./openrouter-stream.ts";
import {
    DEFAULT_PROVIDER_RETRY_POLICY,
    retryBeforeStreamStart,
    type WaitForRetry,
} from "./retry.ts";
import { ModelEventStream } from "./stream.ts";
import { transformMessages } from "./transform.ts";
import {
    encodeOpenRouterMessages,
    encodeOpenRouterTools,
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

export interface OpenRouterAdapterDependencies {
    readonly waitForRetry?: WaitForRetry;
}

export class OpenRouterAdapter implements ModelAdapter {
    private readonly sendChat: SendOpenRouterChat;
    private readonly waitForRetry?: WaitForRetry;

    constructor(
        sendChat: SendOpenRouterChat,
        dependencies: OpenRouterAdapterDependencies = {},
    ) {
        this.sendChat = sendChat;
        this.waitForRetry = dependencies.waitForRetry;
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
            const providerRequest = {
                model: request.model,
                messages: encodeOpenRouterMessages(request.systemPrompt, messages),
                ...(request.tools === undefined || request.tools.length === 0
                    ? {}
                    : { tools: encodeOpenRouterTools(request.tools) }),
            };

            await retryBeforeStreamStart(
                async (markStreamStarted) => {
                    const chunks = await this.sendChat(providerRequest, request.signal);

                    for await (const chunk of chunks) {
                        throwIfAborted(request.signal);
                        markStreamStarted();
                        decoder.accept(chunk);
                    }
                },
                {
                    policy: DEFAULT_PROVIDER_RETRY_POLICY,
                    classifyFailure: classifyOpenRouterError,
                    signal: request.signal,
                    ...(this.waitForRetry === undefined
                        ? {}
                        : { wait: this.waitForRetry }),
                },
            );

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
    const client = new OpenRouter({
        apiKey: options.apiKey,
        retryConfig: { strategy: "none" },
    });

    return new OpenRouterAdapter(async (request, signal) => {
        return client.chat.send(
            {
                chatRequest: {
                    model: request.model,
                    messages: request.messages,
                    ...(request.tools === undefined || request.tools.length === 0
                        ? {}
                        : { tools: request.tools }),
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
