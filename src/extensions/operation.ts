export interface ExtensionOperationOptions {
    readonly timeoutMs?: number;
    readonly timeoutMessage: string;
    readonly abortMessage: string;
    readonly signal?: AbortSignal;
    readonly onExecutionStart?: (execution: Promise<unknown>) => void;
}

export class ExtensionOperationTimeoutError extends Error {}

export async function runExtensionOperation<T>(
    operation: (signal: AbortSignal) => T | Promise<T>,
    options: ExtensionOperationOptions,
): Promise<T> {
    if (options.signal?.aborted) {
        throw abortReason(options.signal, options.abortMessage);
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort(new ExtensionOperationTimeoutError(
                options.timeoutMessage,
            ));
        }, options.timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
            reject(abortReason(controller.signal, options.abortMessage));
        }, { once: true });
    });
    let execution: Promise<T>;
    try {
        execution = Promise.resolve(operation(controller.signal));
    } catch (error) {
        execution = Promise.reject(error);
    }
    options.onExecutionStart?.(execution);
    try {
        return await Promise.race([execution, aborted]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
    }
}

function abortReason(signal: AbortSignal, fallback: string): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error(fallback);
}
