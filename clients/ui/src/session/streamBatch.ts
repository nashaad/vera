import type { SessionMessage } from "./wire.ts";

export interface StreamBatcherOptions {
    readonly apply: (messages: readonly SessionMessage[]) => void;
    // Read when a batch opens, so a batch opened in the background waits the background interval.
    readonly interval: () => number;
    readonly schedule?: (run: () => void, ms: number) => () => void;
}

export interface StreamBatcher {
    readonly push: (message: SessionMessage) => void;
    readonly flush: () => void;
    readonly dispose: () => void;
}

export function isStreamedText(message: SessionMessage): boolean {
    return message.type === "assistant_delta" || message.type === "assistant_thinking";
}

function scheduleTimeout(run: () => void, ms: number): () => void {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
}

// Holds streamed text until the interval ends; any other message applies at once, after the held text.
export function createStreamBatcher(options: StreamBatcherOptions): StreamBatcher {
    const schedule = options.schedule ?? scheduleTimeout;
    let pending: SessionMessage[] = [];
    let cancel: (() => void) | undefined;
    const flush = (): void => {
        cancel?.();
        cancel = undefined;
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        options.apply(batch);
    };
    return {
        push: (message) => {
            pending.push(message);
            if (!isStreamedText(message)) flush();
            else cancel ??= schedule(flush, options.interval());
        },
        flush,
        dispose: () => {
            cancel?.();
            cancel = undefined;
            pending = [];
        },
    };
}
