import type { TelemetryEvent } from "./events.ts";
import type { TelemetrySink } from "./sinks/sink.ts";

export const QUEUE_LIMIT = 1000;
export const FLUSH_AT = 100;

export interface BatcherOptions {
    readonly flushSeconds: number;
    /** The event sent for events dropped since the last flush. */
    readonly dropped: (count: number) => TelemetryEvent;
    readonly queueLimit?: number;
    readonly flushAt?: number;
    readonly onSinkError?: (error: unknown) => void;
}

/**
 * A memory queue with a timed flush. A failed send is kept for exactly one
 * retry at the next flush and then dropped; nothing is spooled to disk.
 */
export class Batcher {
    private readonly queueLimit: number;
    private readonly flushAt: number;
    private queue: TelemetryEvent[] = [];
    private retry: TelemetryEvent[] | undefined;
    private droppedCount = 0;
    private timer: Timer | undefined;
    private draining: Promise<void> | undefined;
    private flushAgain = false;
    private stopped = false;

    constructor(
        private readonly sink: TelemetrySink,
        private readonly options: BatcherOptions,
    ) {
        this.queueLimit = options.queueLimit ?? QUEUE_LIMIT;
        this.flushAt = options.flushAt ?? FLUSH_AT;
    }

    get size(): number {
        return this.queue.length;
    }

    get pendingDrops(): number {
        return this.droppedCount;
    }

    start(): void {
        if (this.timer !== undefined) return;
        this.timer = setInterval(() => {
            void this.flush();
        }, Math.max(1, this.options.flushSeconds * 1000));
        // Telemetry must never be the reason the host stays alive.
        this.timer.unref();
    }

    push(event: TelemetryEvent): void {
        if (this.stopped) return;
        if (this.queue.length >= this.queueLimit) {
            this.queue.shift();
            this.droppedCount += 1;
        }
        this.queue.push(event);
        if (this.queue.length >= this.flushAt) void this.flush();
    }

    /** Sends everything queued, including a batch that failed on its first attempt. */
    async flush(): Promise<void> {
        this.flushAgain = true;
        if (this.draining !== undefined) return this.draining;
        const run = this.drain();
        this.draining = run;
        try {
            await run;
        } finally {
            this.draining = undefined;
        }
    }

    /** Stops the timer and makes one last attempt to send what is queued. */
    async stop(): Promise<void> {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.stopped = true;
        await this.flush();
        this.retry = undefined;
    }

    private async drain(): Promise<void> {
        while (this.flushAgain) {
            this.flushAgain = false;
            await this.sendOnce();
        }
    }

    private async sendOnce(): Promise<void> {
        const retrying = this.retry;
        this.retry = undefined;
        const events = retrying === undefined ? this.queue : [...retrying, ...this.queue];
        this.queue = [];
        if (this.droppedCount > 0) {
            const count = this.droppedCount;
            this.droppedCount = 0;
            try {
                events.push(this.options.dropped(count));
            } catch (error) {
                this.options.onSinkError?.(error);
            }
        }
        if (events.length === 0) return;
        try {
            await this.sink.send(events);
        } catch (error) {
            this.options.onSinkError?.(error);
            // The first failure keeps the batch; a failed retry drops it.
            if (retrying === undefined) this.retry = events;
        }
    }
}
