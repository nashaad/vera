import { OpenRouter } from "@openrouter/sdk";
import type { ChatRequestEffort } from "@openrouter/sdk/models";

import { classifyOpenRouterError } from "./openrouter-error-classifier.ts";
import { OpenRouterStreamDecoder } from "./openrouter-stream.ts";
import { ProviderFailureError } from "../model/provider-failure.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import {
    effortSubstitutionNotice,
    resolveReasoningSelection,
} from "../model/reasoning-effort.ts";
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
    ModelReasoningEffort,
    ModelSource,
} from "../model/types.ts";

export type { SendOpenRouterChat } from "./openrouter-wire.ts";

export interface OpenRouterAdapterOptions {
    readonly apiKey: string;
    readonly reasoningMappings?: ReadonlyMap<
        string,
        ReadonlyMap<ModelReasoningEffort, string>
    >;
}

export interface ChatProviderProfile {
    readonly provider: string;
    readonly api: string;
    readonly supportsImageInput?: boolean;
    readonly reasoningEffort?: (
        effort: ModelReasoningEffort,
        model: string,
    ) => string | undefined;
    readonly classifyError?: (value: unknown) => ProviderFailure;
}

const OPENROUTER_PROFILE: ChatProviderProfile = {
    provider: "openrouter",
    api: "openrouter-chat",
    supportsImageInput: true,
};

export class OpenRouterAdapter implements ModelAdapter {
    readonly supportsImageInput: boolean;
    constructor(
        private readonly sendChat: SendOpenRouterChat,
        private readonly reasoningMappings?: ReadonlyMap<
            string,
            ReadonlyMap<ModelReasoningEffort, string>
        >,
        private readonly profile: ChatProviderProfile = OPENROUTER_PROFILE,
    ) {
        this.supportsImageInput = profile.supportsImageInput ?? false;
    }

    stream(request: ModelRequest): ModelEventStream {
        const stream = new ModelEventStream();
        void this.produce(request, stream);
        return stream;
    }

    private async produce(request: ModelRequest, stream: ModelEventStream): Promise<void> {
        const source: ModelSource = {
            provider: this.profile.provider,
            api: this.profile.api,
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
            const profileEffort = request.reasoningEffort === undefined
                ? undefined
                : this.profile.reasoningEffort?.(
                    request.reasoningEffort,
                    request.model,
                );
            const verifiedMapping = request.reasoningEffort === undefined
                ? undefined
                : profileEffort ?? this.reasoningMappings
                    ?.get(request.model)
                    ?.get(request.reasoningEffort);
            const reasoning = request.reasoningEffort === undefined
                ? undefined
                : verifiedMapping === undefined
                    ? this.profile.provider === "openrouter"
                        ? await resolveReasoningSelection(
                            "openrouter",
                            request.model,
                            request.reasoningEffort,
                        )
                        : undefined
                    : { providerEffort: verifiedMapping };
            const substituted = reasoning === undefined
                    || !("inferred" in reasoning)
                ? undefined
                : effortSubstitutionNotice(reasoning);
            if (substituted !== undefined) {
                stream.push(substituted);
            }
            const providerRequest = {
                model: request.model,
                ...(request.maxTokens === undefined
                    ? {}
                    : { maxTokens: request.maxTokens }),
                messages: encodeOpenRouterMessages(request.systemPrompt, messages),
                ...(reasoning?.providerEffort === undefined
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
                : value instanceof ProviderFailureError
                    ? value
                    : new ProviderFailureError(
                        this.profile.classifyError?.(value)
                            ?? classifyOpenRouterError(value),
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
    }, options.reasoningMappings, OPENROUTER_PROFILE);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw signal.reason ?? new Error("Model request aborted");
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
