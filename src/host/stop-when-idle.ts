export type StopWaitStatus = "working" | "waiting" | "queued";

export interface StopWaitTarget {
    readonly session_id: string;
    readonly name: string | null;
    readonly status: StopWaitStatus;
}

export type StopWhenIdleEvent =
    | { readonly type: "waiting"; readonly waiting_on: readonly StopWaitTarget[] }
    | { readonly type: "stopped" };

export type StopWhenIdleListener = (event: StopWhenIdleEvent) => void | Promise<void>;

export interface StopWhenIdleControl {
    request(listener: StopWhenIdleListener): () => void;
}

export interface StopWhenIdleOptions {
    readonly waitingOn: () => readonly StopWaitTarget[];
    readonly onStopped: () => void | Promise<void>;
    readonly pollIntervalMs?: number;
}

export const TURNS_HELD_REFUSAL =
    "Vera is stopping, so this message was not sent. Send it after the host restarts.";

const DEFAULT_POLL_INTERVAL_MS = 200;

// Once a stop is requested the host holds new turns. A request that
// disconnects does not cancel the stop.
export class StopWhenIdle implements StopWhenIdleControl {
    private held = false;
    private finished = false;
    private lastKey: string | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private readonly listeners = new Set<StopWhenIdleListener>();

    constructor(private readonly options: StopWhenIdleOptions) {}

    get holdsTurns(): boolean {
        return this.held;
    }

    request(listener: StopWhenIdleListener): () => void {
        if (this.finished) {
            void deliver(listener, { type: "stopped" });
            return () => undefined;
        }
        this.held = true;
        this.listeners.add(listener);
        const waiting = this.options.waitingOn();
        if (waiting.length === 0) {
            void this.finish();
        } else {
            this.lastKey = keyOf(waiting);
            void deliver(listener, { type: "waiting", waiting_on: waiting });
            this.ensureTimer();
        }
        return () => {
            this.listeners.delete(listener);
        };
    }

    private ensureTimer(): void {
        if (this.timer !== undefined || this.finished) return;
        this.timer = setInterval(
            () => this.check(),
            this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        );
    }

    private check(): void {
        if (this.finished) return;
        const waiting = this.options.waitingOn();
        if (waiting.length === 0) {
            void this.finish();
            return;
        }
        const key = keyOf(waiting);
        if (key === this.lastKey) return;
        this.lastKey = key;
        void this.broadcast({ type: "waiting", waiting_on: waiting });
    }

    private async finish(): Promise<void> {
        if (this.finished) return;
        this.finished = true;
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await this.broadcast({ type: "stopped" });
        await this.options.onStopped();
    }

    private async broadcast(event: StopWhenIdleEvent): Promise<void> {
        const deliveries = [...this.listeners].map((listener) =>
            deliver(listener, event)
        );
        if (event.type === "stopped") this.listeners.clear();
        await Promise.all(deliveries);
    }
}

function deliver(
    listener: StopWhenIdleListener,
    event: StopWhenIdleEvent,
): Promise<void> {
    return Promise.resolve()
        .then(() => listener(event))
        .catch(() => undefined);
}

function keyOf(waiting: readonly StopWaitTarget[]): string {
    return JSON.stringify(waiting);
}
