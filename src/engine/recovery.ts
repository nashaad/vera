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

export interface ModelRetryPolicy {
    readonly delaysMs: readonly number[];
}

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = {
    delaysMs: [500, 1_000],
};

export interface ModelRetryScheduled {
    readonly model: string;
    readonly nextAttempt: number;
    readonly delayMs: number;
    readonly failure: ProviderFailure;
}

export type WaitForModelRetry = (
    delayMs: number,
    signal?: AbortSignal,
) => Promise<void>;

export interface ModelRecoveryOptions {
    readonly policy?: ModelRetryPolicy;
    readonly wait?: WaitForModelRetry;
    readonly onEvent: (event: ModelStreamEvent) => void;
    readonly onRetry: (retry: ModelRetryScheduled) => void;
}

interface PendingModelRetry {
    readonly scheduled: ModelRetryScheduled;
    readonly message: AssistantMessage;
}

export async function requestModelWithRecovery(
    adapter: ModelAdapter,
    request: ModelRequest,
    options: ModelRecoveryOptions,
): Promise<AssistantMessage> {
    const policy = options.policy ?? DEFAULT_MODEL_RETRY_POLICY;
    const wait = options.wait ?? waitForModelRetry;

    for (let attempt = 0; ; attempt += 1) {
        const stream = adapter.stream(request);
        let contentStarted = false;
        let retry: PendingModelRetry | undefined;

        for await (const event of stream) {
            if (event.type === "start" && attempt > 0) {
                continue;
            }
            if (event.type === "error") {
                const delayMs = policy.delaysMs[attempt];
                if (
                    !contentStarted
                    && event.error instanceof ProviderFailureError
                    && event.error.failure.resolution === "retry"
                    && delayMs !== undefined
                ) {
                    retry = {
                        scheduled: {
                            model: request.model,
                            nextAttempt: attempt + 2,
                            delayMs,
                            failure: event.error.failure,
                        },
                        message: event.message,
                    };
                    break;
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
            return abortPendingRetry(retry.message, request.signal, options, value);
        }
        if (request.signal?.aborted) {
            return abortPendingRetry(retry.message, request.signal, options);
        }
    }
}

function abortPendingRetry(
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
