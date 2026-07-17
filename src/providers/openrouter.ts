import { OpenRouter } from "@openrouter/sdk";
import type { ChatRequestEffort } from "@openrouter/sdk/models";

import { classifyOpenRouterError } from "./openrouter-error-classifier.ts";
import { OpenRouterStreamDecoder } from "./openrouter-stream.ts";
import { ProviderFailureError } from "../model/provider-failure.ts";
import { resolveReasoningSelection } from "../model/reasoning-effort.ts";
import { ModelEventStream } from "../model/stream.ts";
import { transformMessages } from "../model/transform.ts";
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
} from "../model/types.ts";

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
            const reasoning = request.reasoningEffort === undefined
                ? undefined
                : await resolveReasoningSelection(
                    "openrouter",
                    request.model,
                    request.reasoningEffort,
                );
            const providerRequest = {
                model: request.model,
                ...(request.maxTokens === undefined
                    ? {}
                    : { maxTokens: request.maxTokens }),
                messages: encodeOpenRouterMessages(request.systemPrompt, messages),
                ...(reasoning === undefined
                    ? {}
                    : { reasoning: { effort: reasoning.providerEffort } }),
                ...(request.tools === undefined || request.tools.length === 0
                    ? {}
                    : { tools: encodeOpenRouterTools(request.tools) }),
            };

            const chunks = await this.sendChat(providerRequest, request.signal);
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
            const error = request.signal?.aborted
                ? toError(value)
                : new ProviderFailureError(
                    classifyOpenRouterError(value),
                    value,
                );
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
                    ...(request.maxTokens === undefined
                        ? {}
                        : { maxTokens: request.maxTokens }),
                    messages: request.messages,
                    ...(request.reasoning === undefined
                        ? {}
                        : {
                            reasoning: {
                                // Model metadata can advertise effort names newer than the SDK.
                                effort: request.reasoning.effort as ChatRequestEffort,
                            },
                        }),
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
