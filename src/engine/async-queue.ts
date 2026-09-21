interface WaitingReceiver<T> {
    readonly resolve: (value: T) => void;
    readonly reject: (error: unknown) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
}

export interface FailAsyncQueueOptions {
    readonly discardBuffered?: boolean;
}

export class AsyncQueue<T> {
    private readonly values: T[] = [];
    private readonly receivers: WaitingReceiver<T>[] = [];
    private failure: unknown;
    private failed = false;

    push(value: T): void {
        if (this.failed) {
            throw this.failure;
        }

        const receiver = this.receivers.shift();
        if (receiver !== undefined) {
            removeAbortListener(receiver);
            receiver.resolve(value);
            return;
        }

        this.values.push(value);
    }

    receive(signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) {
            return Promise.reject(abortReason(signal));
        }

        const value = this.values.shift();
        if (value !== undefined) {
            return Promise.resolve(value);
        }

        if (this.failed) {
            return Promise.reject(this.failure);
        }

        return new Promise((resolve, reject) => {
            const receiver: WaitingReceiver<T> = {
                resolve,
                reject,
                ...(signal === undefined
                    ? {}
                    : {
                        signal,
                        onAbort: () => {
                            const index = this.receivers.indexOf(receiver);
                            if (index !== -1) {
                                this.receivers.splice(index, 1);
                            }
                            reject(abortReason(signal));
                        },
                    }),
            };
            this.receivers.push(receiver);
            receiver.signal?.addEventListener("abort", receiver.onAbort!, {
                once: true,
            });
        });
    }

    clear(): void {
        this.values.length = 0;
    }

    fail(error: unknown, options: FailAsyncQueueOptions = {}): void {
        if (this.failed) {
            return;
        }

        this.failed = true;
        this.failure = error;
        if (options.discardBuffered === true) {
            this.values.length = 0;
        }
        for (const receiver of this.receivers.splice(0)) {
            removeAbortListener(receiver);
            receiver.reject(error);
        }
    }
}

function removeAbortListener<T>(receiver: WaitingReceiver<T>): void {
    if (receiver.signal !== undefined && receiver.onAbort !== undefined) {
        receiver.signal.removeEventListener("abort", receiver.onAbort);
    }
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error("Receive aborted");
}
