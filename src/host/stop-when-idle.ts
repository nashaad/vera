export type StopWaitStatus = "working" | "waiting" | "queued";

export interface StopWaitTarget {
    readonly session_id: string;
    readonly name: string | null;
    readonly status: StopWaitStatus;
}

export type StopRefusalReason = "identity_mismatch" | "unavailable" | "stop_pending" | "target_unavailable";

// Host-wide facts about a wait, sent to every attached client.
export type StopWaitEvent =
    | { readonly type: "wait"; readonly kind: "stop"; readonly waiting_on: readonly StopWaitTarget[] }
    | {
        readonly type: "wait";
        readonly kind: "update";
        readonly target_build_id: string;
        readonly waiting_on: readonly StopWaitTarget[];
    }
    | { readonly type: "wait_cleared"; readonly reason: "abandoned" | "stopped"; readonly message?: string }
    | { readonly type: "restarting"; readonly build_id: string };

export type StopWaitObserver = (event: StopWaitEvent) => void;

export type StopWhenIdleEvent =
    | { readonly type: "waiting"; readonly waiting_on: readonly StopWaitTarget[] }
    | { readonly type: "stopped" }
    | { readonly type: "abandoned"; readonly message: string };

export type StopWhenIdleListener = (event: StopWhenIdleEvent) => void | Promise<void>;

export type StopRequestResult =
    | { readonly accepted: true; readonly unsubscribe: () => void }
    | {
        readonly accepted: false;
        readonly reason: "stop_pending" | "target_unavailable";
        readonly message: string;
    };

export interface StopWhenIdleControl {
    request(listener: StopWhenIdleListener, buildId?: string | null): StopRequestResult;
    // Calls the observer with the current wait, if one is announced, then with each change.
    observe(observer: StopWaitObserver): () => void;
}

export interface StopWhenIdleOptions {
    readonly waitingOn: () => readonly StopWaitTarget[];
    readonly onStopped: () => void | Promise<void>;
    readonly pollIntervalMs?: number;
    // Checked when a request names a build. A message refuses the request.
    readonly targetProblem?: (buildId: string) => string | undefined;
    // Runs once nothing waits, before "stopped" is sent. A message abandons the stop and turns resume.
    readonly prepare?: (buildId: string | null) => string | undefined;
}

export const TURNS_HELD_REFUSAL =
    "Vera is stopping, so this message was not sent. Send it after the host restarts.";

const DEFAULT_POLL_INTERVAL_MS = 200;

// Once a stop is requested the host holds new turns. A request that
// disconnects does not cancel the stop.
export class StopWhenIdle implements StopWhenIdleControl {
    private held = false;
    private finished = false;
    // undefined: no stop pending. null: plain stop. A string: stop, then move to that build.
    private pending: string | null | undefined;
    private lastKey: string | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private readonly listeners = new Set<StopWhenIdleListener>();
    private readonly observers = new Set<StopWaitObserver>();
    private announced: Extract<StopWaitEvent, { type: "wait" }> | undefined;

    constructor(private readonly options: StopWhenIdleOptions) {}

    get holdsTurns(): boolean {
        return this.held;
    }

    request(listener: StopWhenIdleListener, buildId: string | null = null): StopRequestResult {
        if (this.finished) {
            void deliver(listener, { type: "stopped" });
            return { accepted: true, unsubscribe: () => undefined };
        }
        if (this.pending !== undefined && this.pending !== buildId) {
            return {
                accepted: false,
                reason: "stop_pending",
                message: this.pendingMessage(),
            };
        }
        if (this.pending === undefined && buildId !== null) {
            const problem = this.options.targetProblem?.(buildId);
            if (problem !== undefined) {
                return { accepted: false, reason: "target_unavailable", message: problem };
            }
        }
        this.pending = buildId;
        this.held = true;
        this.listeners.add(listener);
        const waiting = this.options.waitingOn();
        if (waiting.length === 0) {
            void this.finish();
        } else {
            this.lastKey = keyOf(waiting);
            void deliver(listener, { type: "waiting", waiting_on: waiting });
            this.announce(waiting);
            this.ensureTimer();
        }
        return {
            accepted: true,
            unsubscribe: () => {
                this.listeners.delete(listener);
            },
        };
    }

    observe(observer: StopWaitObserver): () => void {
        this.observers.add(observer);
        if (this.announced !== undefined) safelyObserve(observer, this.announced);
        return () => {
            this.observers.delete(observer);
        };
    }

    private pendingMessage(): string {
        if (this.pending === null || this.pending === undefined) {
            return "Vera is already stopping. This request was not queued; wait for that stop to finish.";
        }
        return `Vera is already stopping to move to ${this.pending}. `
            + "This request was not queued; wait for that update to finish.";
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
        this.announce(waiting);
    }

    // Starts or updates the announced wait for every observer.
    private announce(waiting: readonly StopWaitTarget[]): void {
        const pending = this.pending ?? null;
        const event: Extract<StopWaitEvent, { type: "wait" }> = pending === null
            ? { type: "wait", kind: "stop", waiting_on: waiting }
            : { type: "wait", kind: "update", target_build_id: pending, waiting_on: waiting };
        this.announced = event;
        for (const observer of [...this.observers]) safelyObserve(observer, event);
    }

    private async finish(): Promise<void> {
        if (this.finished) return;
        const problem = this.prepareStop();
        if (problem !== undefined) {
            await this.abandon(problem);
            return;
        }
        this.finished = true;
        this.clearTimer();
        if (this.announced !== undefined) {
            this.announced = undefined;
            this.emit({ type: "wait_cleared", reason: "stopped" });
        }
        if (this.pending !== null && this.pending !== undefined) {
            this.emit({ type: "restarting", build_id: this.pending });
        }
        await this.broadcast({ type: "stopped" });
        await this.options.onStopped();
    }

    private prepareStop(): string | undefined {
        try {
            return this.options.prepare?.(this.pending ?? null);
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }

    // Turns resume and the next request starts a new stop.
    private async abandon(message: string): Promise<void> {
        this.held = false;
        this.pending = undefined;
        this.lastKey = undefined;
        this.clearTimer();
        if (this.announced !== undefined) {
            this.announced = undefined;
            this.emit({ type: "wait_cleared", reason: "abandoned", message });
        }
        await this.broadcast({ type: "abandoned", message });
    }

    private emit(event: StopWaitEvent): void {
        for (const observer of [...this.observers]) safelyObserve(observer, event);
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private async broadcast(event: StopWhenIdleEvent): Promise<void> {
        const deliveries = [...this.listeners].map((listener) =>
            deliver(listener, event)
        );
        if (event.type !== "waiting") this.listeners.clear();
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

function safelyObserve(observer: StopWaitObserver, event: StopWaitEvent): void {
    try {
        observer(event);
    } catch {
        // An observer that throws must not hold up the stop.
    }
}

function keyOf(waiting: readonly StopWaitTarget[]): string {
    return JSON.stringify(waiting);
}
