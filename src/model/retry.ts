import {
    ProviderFailureError,
    type ProviderFailure,
} from "./provider-failure.ts";

export interface RetryPolicy {
    readonly delaysMs: readonly number[];
}

export const DEFAULT_PROVIDER_RETRY_POLICY: RetryPolicy = {
    delaysMs: [500, 1000],
};

export type ClassifyProviderFailure = (value: unknown) => ProviderFailure;
export type WaitForRetry = (
    delayMs: number,
    signal?: AbortSignal,
) => Promise<void>;
export type RetryOperation<T> = (
    markStreamStarted: () => void,
) => Promise<T>;

export interface RetryBeforeStreamStartOptions {
    readonly policy: RetryPolicy;
    readonly classifyFailure: ClassifyProviderFailure;
    readonly signal?: AbortSignal;
    readonly wait?: WaitForRetry;
}

export async function retryBeforeStreamStart<T>(
    operation: RetryOperation<T>,
    options: RetryBeforeStreamStartOptions,
): Promise<T> {
    const wait = options.wait ?? waitForRetry;

    for (let attempt = 0; ; attempt += 1) {
        throwIfAborted(options.signal);
        let streamStarted = false;

        try {
            return await operation(() => {
                streamStarted = true;
            });
        } catch (value) {
            throwIfAborted(options.signal);
            const delayMs = options.policy.delaysMs[attempt];
            const failure = options.classifyFailure(value);

            if (
                streamStarted
                || failure.resolution !== "retry"
                || delayMs === undefined
            ) {
                throw new ProviderFailureError(failure, value);
            }

            await wait(delayMs, options.signal);
        }
    }
}

async function waitForRetry(
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
