import {
    ProviderFailureError,
    type ProviderFailure,
} from "../model/provider-failure.ts";
import type {
    AssistantMessage,
    ModelAdapter,
    ModelRequest,
    ModelStreamEvent,
} from "../model/types.ts";
import { reasoningEffortForModel } from "./model-settings.ts";
import {
    coarsenAfterFailure,
    type EffortCoarseningOptions,
    type ModelEffortCoarsened,
} from "./effort-coarsening.ts";

/**
 * Drops a reasoning effort the fallback model cannot be asked for.
 *
 * A fallback stays on the same provider (`run-turn.ts` refuses one that does
 * not), so the only way the effort becomes unaskable is a target with no
 * efforts at all, which on `openai-codex` means a model absent from
 * `MODEL_REASONING_PROFILES`. Carrying the effort there would turn a
 * recoverable overload into a hard failure.
 */
function withSupportedReasoningEffort(
    request: ModelRequest,
    model: string,
): ModelRequest {
    const effort = reasoningEffortForModel(
        request.provider,
        model,
        request.reasoningEffort,
    );
    if (effort === request.reasoningEffort) {
        return request;
    }
    const { reasoningEffort: _dropped, ...supported } = request;
    return supported;
}

/**
 * An effort the adapter placed differently from what was asked for, named
 * against the model the request went to. Reported and then forgotten: the
 * request is already running on the placed level, so there is nothing to
 * retry.
 */
export interface ModelEffortSubstituted {
    readonly model: string;
    readonly requested: string;
    /** Absent means no reasoning level was sent at all. */
    readonly using?: string;
    readonly reason: string;
}

export interface ModelRetryPolicy {
    readonly delaysMs: readonly number[];
}

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = {
    delaysMs: [500, 1_000],
};

export const DEFAULT_MODEL_MAX_TOKENS = 8_000;
export const ESCALATED_MODEL_MAX_TOKENS = 64_000;
export const MAX_LENGTH_CONTINUATIONS = 3;
export const LENGTH_CONTINUATION_PROMPT = [
    "Output token limit hit. Resume directly — no apology, no recap.",
    "Pick up exactly where you stopped without repeating text.",
].join(" ");

export interface ModelRetryScheduled {
    readonly model: string;
    readonly nextAttempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly failure: ProviderFailure;
    /** The prior partial model attempt was rejected; this attempt replaces it. */
    readonly replacesPartialAttempt?: true;
}

export interface ModelFallbackPolicy {
    readonly provider?: string;
    readonly model: string;
    readonly afterFailures: number;
}

export interface ModelFallbackSelected {
    readonly fromModel: string;
    readonly toModel: string;
    readonly afterFailures: number;
    readonly failure: ProviderFailure;
}

export interface ModelLengthContinuation {
    readonly previousMaxTokens: number;
    readonly nextMaxTokens: number;
    readonly continuation: number;
    readonly maxContinuations: number;
    readonly prompt: string;
}

export type WaitForModelRetry = (
    delayMs: number,
    signal?: AbortSignal,
) => Promise<void>;

export interface ModelRecoveryOptions {
    readonly policy?: ModelRetryPolicy;
    readonly fallback?: ModelFallbackPolicy;
    readonly wait?: WaitForModelRetry;
    readonly onEvent: (event: ModelStreamEvent) => void;
    readonly onRetry: (retry: ModelRetryScheduled) => void;
    readonly onFallback: (fallback: ModelFallbackSelected) => void;
    /**
     * Present only where a pool is wired in. Absent leaves a capability
     * refusal on the ordinary terminal path, which is what it was before.
     */
    readonly coarsening?: EffortCoarseningOptions;
    readonly onCoarsened?: (coarsened: ModelEffortCoarsened) => void;
    readonly onEffortSubstituted?: (
        substituted: ModelEffortSubstituted,
    ) => void;
}

interface PendingModelRetry {
    readonly scheduled: ModelRetryScheduled;
    readonly message: AssistantMessage;
}

export function nextLengthContinuation(
    currentMaxTokens: number,
    completedContinuations: number,
): ModelLengthContinuation | undefined {
    if (completedContinuations >= MAX_LENGTH_CONTINUATIONS) {
        return undefined;
    }

    return {
        previousMaxTokens: currentMaxTokens,
        nextMaxTokens: ESCALATED_MODEL_MAX_TOKENS,
        continuation: completedContinuations + 1,
        maxContinuations: MAX_LENGTH_CONTINUATIONS,
        prompt: LENGTH_CONTINUATION_PROMPT,
    };
}

export async function requestModelWithRecovery(
    adapter: ModelAdapter,
    request: ModelRequest,
    options: ModelRecoveryOptions,
): Promise<AssistantMessage> {
    const policy = options.policy ?? DEFAULT_MODEL_RETRY_POLICY;
    const wait = options.wait ?? waitForModelRetry;
    let activeRequest = request;
    let requestAttempt = 0;
    let retryAttempt = 0;
    let consecutiveOverloadFailures = 0;
    let fallbackSelected = false;
    const refusedEfforts = new Set<string>();

    while (true) {
        const stream = adapter.stream(activeRequest);
        let contentStarted = false;
        let retry: PendingModelRetry | undefined;
        let fallback: ModelFallbackSelected | undefined;
        let coarsened: ModelEffortCoarsened | undefined;

        for await (const event of stream) {
            if (event.type === "start" && requestAttempt > 0) {
                continue;
            }
            if (event.type === "effort_substituted") {
                // Deliberately ahead of the content flag: a notice is not
                // content, and letting it set the flag would take the
                // coarsening path away from a refusal arriving right after.
                options.onEffortSubstituted?.({
                    model: activeRequest.model,
                    requested: event.requested,
                    ...(event.using === undefined ? {} : { using: event.using }),
                    reason: event.reason,
                });
                continue;
            }
            if (event.type === "error") {
                if (request.signal?.aborted) {
                    return abortModelRequest(
                        event.message,
                        request.signal,
                        options,
                    );
                }
                if (event.error instanceof ProviderFailureError) {
                    const failure = event.error.failure;
                    // A refused capability is evidence about the model, so it
                    // is answered before the overload counters: it is neither
                    // an overload nor something a plain retry would survive.
                    // Asked on every failure, not only on requests carrying an
                    // effort: image, tool and thinking refusals arrive on
                    // requests that named no effort at all.
                    if (!contentStarted && options.coarsening !== undefined) {
                        coarsened = coarsenAfterFailure(
                            {
                                provider: activeRequest.provider ?? "",
                                model: activeRequest.model,
                            },
                            activeRequest.reasoningEffort,
                            failure,
                            refusedEfforts,
                            options.coarsening,
                        );
                        if (coarsened !== undefined) {
                            break;
                        }
                    }
                    consecutiveOverloadFailures = isOverloadFailure(failure)
                        ? consecutiveOverloadFailures + 1
                        : 0;
                    if (
                        !contentStarted
                        && !fallbackSelected
                        && options.fallback !== undefined
                        && options.fallback.model !== activeRequest.model
                        && failure.resolution === "retry"
                        && consecutiveOverloadFailures
                            >= options.fallback.afterFailures
                    ) {
                        fallback = {
                            fromModel: activeRequest.model,
                            toModel: options.fallback.model,
                            afterFailures: consecutiveOverloadFailures,
                            failure,
                        };
                        break;
                    }

                    const delayMs = policy.delaysMs[retryAttempt];
                    if (
                        failure.resolution === "retry"
                        && (
                            !contentStarted
                            || failure.partialOutputReplaceable === true
                        )
                        && delayMs !== undefined
                    ) {
                        retry = {
                            scheduled: {
                                model: activeRequest.model,
                                nextAttempt: retryAttempt + 2,
                                maxAttempts: policy.delaysMs.length + 1,
                                delayMs,
                                failure,
                                ...(contentStarted
                                    ? { replacesPartialAttempt: true as const }
                                    : {}),
                            },
                            message: event.message,
                        };
                        break;
                    }
                }
                options.onEvent(event);
                return event.message;
            }

            if (event.type !== "start" && event.type !== "done") {
                contentStarted = true;
            }
            options.onEvent(event);
            if (event.type === "done") {
                return event.message;
            }
        }

        if (coarsened !== undefined) {
            // Non-blocking: the notice goes out and the turn continues on the
            // coarser level without waiting for an answer.
            options.onCoarsened?.(coarsened);
            refusedEfforts.add(coarsened.requested);
            activeRequest = {
                ...activeRequest,
                reasoningEffort: coarsened.using,
            };
            requestAttempt += 1;
            continue;
        }

        if (fallback !== undefined) {
            options.onFallback(fallback);
            activeRequest = {
                ...withSupportedReasoningEffort(
                    activeRequest,
                    fallback.toModel,
                ),
                model: fallback.toModel,
            };
            fallbackSelected = true;
            retryAttempt = 0;
            requestAttempt += 1;
            continue;
        }

        if (retry === undefined) {
            return await stream.result();
        }

        options.onRetry(retry.scheduled);
        try {
            await wait(retry.scheduled.delayMs, request.signal);
        } catch (value) {
            if (!request.signal?.aborted) {
                throw value;
            }
            return abortModelRequest(retry.message, request.signal, options, value);
        }
        if (request.signal?.aborted) {
            return abortModelRequest(retry.message, request.signal, options);
        }
        retryAttempt += 1;
        requestAttempt += 1;
    }
}

function isOverloadFailure(failure: ProviderFailure): boolean {
    return failure.kind === "rate_limit" || failure.kind === "server";
}

function abortModelRequest(
    retryMessage: AssistantMessage,
    signal: AbortSignal,
    options: ModelRecoveryOptions,
    waitError?: unknown,
): AssistantMessage {
    const error = toError(signal.reason ?? waitError ?? "Model request aborted");
    const message: AssistantMessage = {
        ...retryMessage,
        stopReason: "aborted",
        errorMessage: error.message,
    };
    options.onEvent({ type: "error", error, message });
    return message;
}

async function waitForModelRetry(
    delayMs: number,
    signal?: AbortSignal,
): Promise<void> {
    throwIfAborted(signal);

    await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
            clearTimeout(timeout);
            reject(signal?.reason ?? new Error("Model request aborted"));
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener("abort", onAbort, { once: true });
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
