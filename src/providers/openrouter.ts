import { OpenRouter } from "@openrouter/sdk";
import type { ChatRequestEffort } from "@openrouter/sdk/models";

import { classifyOpenRouterError } from "./openrouter-error-classifier.ts";
import { OpenRouterStreamDecoder } from "./openrouter-stream.ts";
import type {
    FailedRequestCapture,
    FailedRequestOutcome,
} from "./failed-request-capture.ts";
import { ProviderFailureError } from "../model/provider-failure.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import type {
    OpenRouterAllowanceGuard,
    OpenRouterAllowanceRequest,
} from "./openrouter-allowance-guard.ts";
import {
    effortSubstitutionNotice,
    resolveReasoningSelection,
} from "../model/reasoning-effort.ts";
import type { EffortLevelsLookup } from "../model/effort-levels.ts";
import type { ImageSupportLookup } from "../model/image-support.ts";
import { ModelEventStream } from "../model/stream.ts";
import { transformMessages } from "../model/transform.ts";
import {
    encodeOpenRouterMessages,
    encodeOpenRouterTools,
    normalizeOpenRouterToolCallId,
    type SendOpenRouterChat,
} from "./openrouter-wire.ts";
import type {
    AssistantMessage,
    ModelAdapter,
    ModelRequest,
    ModelReasoningEffort,
    ModelSource,
} from "../model/types.ts";

export type { SendOpenRouterChat } from "./openrouter-wire.ts";

export interface OpenRouterAdapterOptions {
    readonly apiKey: string;
    /** Where requests go, when it is not the endpoint the SDK ships with. */
    readonly baseUrl?: string;
    readonly reasoningMappings?: ReadonlyMap<
        string,
        ReadonlyMap<ModelReasoningEffort, string>
    >;
    /**
     * The model's levels, as resolved by whoever owns that data. Supplied as a
     * callback so this layer never reads a pool file or a catalog itself. When
     * it answers, its answer is the one the request uses; only a model it has
     * nothing for falls back to a live lookup.
     */
    readonly effortLevels?: EffortLevelsLookup;
    /** The model's image support, resolved by whoever owns that data. */
    readonly imageSupport?: ImageSupportLookup;
    /** Where a failed request is kept. Absent keeps nothing. */
    readonly captureFailedRequest?: FailedRequestCapture;
    readonly allowanceGuard?: OpenRouterAllowanceGuard;
    readonly allowanceScope?: string;
}

export interface ChatProviderProfile {
    readonly provider: string;
    readonly api: string;
    readonly supportsImageInput?: boolean;
    readonly supportsBodyExtensions?: boolean;
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
        private readonly effortLevels?: EffortLevelsLookup,
        private readonly captureFailedRequest?: FailedRequestCapture,
        private readonly imageSupport?: ImageSupportLookup,
        private readonly allowanceGuard?: OpenRouterAllowanceGuard,
        private readonly allowanceScope?: string,
    ) {
        this.supportsImageInput = profile.supportsImageInput ?? false;
    }

    imageInputSupport(model: string): boolean | undefined {
        return this.imageSupport?.(model);
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
        // Held by reference and never encoded unless the request fails, so a
        // turn that works pays two array writes and nothing else.
        const rawChunks: unknown[] = [];
        let rawTruncated = false;
        let sentRequest: unknown;
        let allowanceRequest: OpenRouterAllowanceRequest | undefined;
        const capture = (
            outcome: FailedRequestOutcome,
            detail: { error?: string; failure?: ProviderFailure },
        ): string | undefined =>
            this.captureFailedRequest?.({
                provider: this.profile.provider,
                api: this.profile.api,
                model: request.model,
                outcome,
                ...detail,
                request: sentRequest,
                response: rawChunks,
                ...(rawTruncated ? { responseTruncated: true } : {}),
            });

        try {
            throwIfAborted(request.signal);
            if (
                request.bodyExtensions !== undefined
                && !this.profile.supportsBodyExtensions
            ) {
                throw new Error(
                    `Provider ${this.profile.provider} does not support model request contributions`,
                );
            }
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
                            this.effortLevels?.(
                                request.model,
                                request.reasoningEffort,
                            ) ?? {},
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
                messages: encodeOpenRouterMessages(
                    request.systemPrompt,
                    messages,
                    request.model,
                ),
                ...(reasoning?.providerEffort === undefined
                    ? {}
                    : { reasoning: { effort: reasoning.providerEffort } }),
                ...(request.tools === undefined || request.tools.length === 0
                    ? {}
                    : { tools: encodeOpenRouterTools(request.tools, request.model) }),
                ...(request.bodyExtensions === undefined
                    ? {}
                    : { bodyExtensions: request.bodyExtensions }),
            };

            allowanceRequest = this.allowanceScope === undefined
                ? undefined
                : {
                    scope: this.allowanceScope,
                    model: request.model,
                    promptBytes: Buffer.byteLength(
                        JSON.stringify(providerRequest),
                        "utf8",
                    ),
                    ...(request.maxTokens === undefined
                        ? {}
                        : { maxTokens: request.maxTokens }),
                };
            const preflight = allowanceRequest === undefined
                ? undefined
                : this.allowanceGuard?.preflight(allowanceRequest);
            if (preflight !== undefined) {
                throw new ProviderFailureError(
                    preflight,
                    new Error(preflight.message),
                );
            }

            sentRequest = request.bodyExtensions === undefined
                ? providerRequest
                : {
                    ...providerRequest,
                    bodyExtensions: Object.fromEntries(
                        Object.keys(request.bodyExtensions)
                            .map((namespace) => [namespace, "[redacted]"]),
                    ),
                };

            const chunks = await this.sendChat(providerRequest, request.signal);
            for await (const chunk of chunks) {
                throwIfAborted(request.signal);
                if (this.captureFailedRequest !== undefined) {
                    if (rawChunks.length < MAX_CAPTURED_CHUNKS) {
                        rawChunks.push(chunk);
                    } else {
                        rawTruncated = true;
                    }
                }
                decoder.accept(chunk);
            }

            const message = decoder.finish();
            if (message.stopReason === "error") {
                const path = capture("provider_error", {
                    error: "the provider ended the stream with an error",
                });
                const error = new Error(
                    withCapturePath("OpenRouter stopped with an error", path),
                );
                stream.push({
                    type: "error",
                    error,
                    message: { ...message, errorMessage: error.message },
                });
            } else {
                // A turn that produced nothing readable is a failure the user
                // can see and the logs cannot explain, so the request is kept
                // even though the stream itself never reported an error. The
                // turn's own outcome is left alone.
                if (isEmptyResponse(message)) {
                    capture("empty_response", {
                        error: `the provider returned no content (stop reason ${message.stopReason})`,
                    });
                }
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
            if (
                error instanceof ProviderFailureError
                && error.failure.allowance !== undefined
                && error.failure.providerErrorType !== "cached_allowance"
                && allowanceRequest !== undefined
            ) {
                this.allowanceGuard?.observe(
                    allowanceRequest,
                    error.failure.allowance,
                );
            }
            const stopReason = request.signal?.aborted ? "aborted" : "error";
            // An abort is the user's own doing, not a provider failure, so it
            // writes nothing.
            const path = stopReason === "aborted"
                ? undefined
                : capture("provider_error", {
                    error: error.message,
                    ...(error instanceof ProviderFailureError
                        ? { failure: error.failure }
                        : {}),
                });
            stream.push({
                type: "error",
                error,
                message: decoder.partial(
                    stopReason,
                    withCapturePath(error.message, path),
                ),
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
        ...(options.baseUrl === undefined ? {} : { serverURL: options.baseUrl }),
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
    },
    options.reasoningMappings,
    OPENROUTER_PROFILE,
    options.effortLevels,
    options.captureFailedRequest,
    options.imageSupport,
    options.allowanceGuard,
    options.allowanceScope);
}

/**
 * How much of a stream is kept for a capture. The chunks that explain a
 * failure are at one end or the other, and a long answer that then fails is
 * not worth holding in full.
 */
const MAX_CAPTURED_CHUNKS = 200;

/**
 * A turn that ends with nothing to read. Reasoning alone counts as empty
 * because it is not what the client renders as the answer, which is the shape
 * a "no visible response" turn arrives in.
 */
function isEmptyResponse(message: AssistantMessage): boolean {
    if (message.stopReason === "aborted") {
        return false;
    }
    return message.content.every((block) =>
        block.type === "thinking"
        || (block.type === "text" && block.text.trim().length === 0)
    );
}

/** Names the capture so whoever reads the error can open the request. */
function withCapturePath(message: string, path: string | undefined): string {
    return path === undefined ? message : `${message} (request captured at ${path})`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw signal.reason ?? new Error("Model request aborted");
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
