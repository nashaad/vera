import {
    ProviderFailureError,
    type ProviderFailure,
} from "../model/provider-failure.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ModelStream,
    type ModelStreamEvent,
} from "../model/types.ts";
import { reasoningEffortForModel } from "./model-settings.ts";
import {
    coarsenAfterFailure,
    type EffortCoarseningOptions,
    type ModelEffortCoarsened,
} from "./effort-coarsening.ts";

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

export interface ModelEffortSubstituted {
    readonly model: string;
    readonly requested: string;
    readonly using?: string;
    readonly reason: string;
}

export interface ModelRetryPolicy {
    readonly delaysMs: readonly number[];
}

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = {
    delaysMs: [500, 1_000],
};

const DEFAULT_OVERLOAD_RETRY_POLICY: ModelRetryPolicy = {
    delaysMs: [1_000, 2_000, 4_000, 8_000, 15_000, 30_000],
};

// Long because a high reasoning effort can think for minutes before sending a byte.
export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 300_000;

// How long an adapter gets to wind down after its attempt is cancelled.
const ATTEMPT_WIND_DOWN_MS = 1_000;

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
    readonly idleTimeoutMs?: number;
    readonly onEvent: (event: ModelStreamEvent) => void;
    readonly onRetry: (retry: ModelRetryScheduled) => void;
    readonly onFallback: (fallback: ModelFallbackSelected) => void;
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
    const wait = options.wait ?? waitForModelRetry;
    let activeRequest = request;
    let requestAttempt = 0;
    let retryAttempt = 0;
    let consecutiveOverloadFailures = 0;
    let fallbackSelected = false;
    const refusedEfforts = new Set<string>();

    while (true) {
        const attempt = new AbortController();
        const stream = adapter.stream({
            ...activeRequest,
            signal: request.signal === undefined
                ? attempt.signal
                : AbortSignal.any([request.signal, attempt.signal]),
        });
        let contentStarted = false;
        let visibleTextStarted = false;
        let retry: PendingModelRetry | undefined;
        let fallback: ModelFallbackSelected | undefined;
        let coarsened: ModelEffortCoarsened | undefined;

        for await (const event of supervisedEvents(
            stream,
            attempt,
            activeRequest,
            request.signal,
            options.idleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
        )) {
            if (event.type === "start" && requestAttempt > 0) {
                continue;
            }
            if (event.type === "effort_substituted") {
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

                    const policy = options.policy ?? (
                        isOverloadFailure(failure) || isNetworkFailure(failure)
                        ? DEFAULT_OVERLOAD_RETRY_POLICY
                        : DEFAULT_MODEL_RETRY_POLICY);
                    const delayMs = policy.delaysMs[retryAttempt];
                    if (
                        failure.resolution === "retry"
                        && (
                            !contentStarted
                            || failure.partialOutputReplaceable === true
                            || (isNetworkFailure(failure) && !visibleTextStarted)
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
            if (event.type === "text_delta" && event.text.trim() !== "") {
                visibleTextStarted = true;
            }
            options.onEvent(event);
            if (event.type === "done") {
                return event.message;
            }
        }

        if (coarsened !== undefined) {
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

// Nothing the user read is lost by replaying these until visible text arrives.
function isNetworkFailure(failure: ProviderFailure): boolean {
    return failure.kind === "connection" || failure.kind === "timeout";
}

type SupervisedNext =
    | { readonly kind: "event"; readonly result: IteratorResult<ModelStreamEvent> }
    | { readonly kind: "idle" }
    | { readonly kind: "aborted" };

// Adapters await sockets, locks and token refreshes that may never settle, so
// silence and cancellation are enforced here rather than trusted to each one.
async function* supervisedEvents(
    stream: ModelStream,
    attempt: AbortController,
    request: ModelRequest,
    turnSignal: AbortSignal | undefined,
    idleTimeoutMs: number,
): AsyncGenerator<ModelStreamEvent> {
    const iterator = stream[Symbol.asyncIterator]();
    // A read that lost a race is still owed the next event; reuse it.
    let pending: Promise<IteratorResult<ModelStreamEvent>> | undefined;
    let stopped: "idle" | "aborted" | undefined;

    while (true) {
        pending ??= iterator.next();
        const next = stopped === undefined
            ? await nextWithin(pending, idleTimeoutMs, turnSignal)
            : await nextWithin(pending, ATTEMPT_WIND_DOWN_MS, undefined);

        if (next.kind === "event") {
            pending = undefined;
            if (next.result.done === true) {
                return;
            }
            const event = next.result.value;
            if (stopped === undefined) {
                yield event;
                continue;
            }
            if (event.type === "error" || event.type === "done") {
                yield stopped === "idle"
                    ? idleFailure(event.message, idleTimeoutMs)
                    : event;
                return;
            }
            continue;
        }

        if (stopped !== undefined) {
            const message = unansweredMessage(request);
            yield stopped === "idle"
                ? idleFailure(message, idleTimeoutMs)
                : {
                    type: "error",
                    error: toError(turnSignal?.reason ?? "Model request aborted"),
                    message: { ...message, stopReason: "aborted" },
                };
            return;
        }

        stopped = next.kind;
        if (next.kind === "idle") {
            attempt.abort(new Error("Model stream went idle"));
        }
    }
}

function nextWithin(
    pending: Promise<IteratorResult<ModelStreamEvent>>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
): Promise<SupervisedNext> {
    if (signal?.aborted) {
        return Promise.resolve({ kind: "aborted" });
    }
    return new Promise((resolve, reject) => {
        const cleanUp = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
            cleanUp();
            resolve({ kind: "aborted" });
        };
        const timer = setTimeout(() => {
            cleanUp();
            resolve({ kind: "idle" });
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.then(
            (result) => {
                cleanUp();
                resolve({ kind: "event", result });
            },
            (error: unknown) => {
                cleanUp();
                reject(error);
            },
        );
    });
}

function idleFailure(
    message: AssistantMessage,
    idleTimeoutMs: number,
): ModelStreamEvent {
    const failure: ProviderFailure = {
        kind: "timeout",
        resolution: "retry",
        message: `No response from ${message.source.model} for ${
            Math.round(idleTimeoutMs / 1_000)
        }s`,
    };
    return {
        type: "error",
        error: new ProviderFailureError(failure, new Error(failure.message)),
        message: {
            ...message,
            stopReason: "error",
            errorMessage: failure.message,
        },
    };
}

function unansweredMessage(request: ModelRequest): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        source: {
            provider: request.provider ?? "unknown",
            api: "unknown",
            model: request.model,
        },
        usage: emptyUsage(),
        stopReason: "error",
    };
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
