import type { RestartRecord } from "../store/restart-records.ts";

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

export type StopWaitObserver = (event: StopWaitEvent) => void | Promise<void>;

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

export interface StopRequestOptions {
    // Cuts the waited sessions as soon as the wait opens.
    readonly cutFirst?: boolean;
}

export type StopCause = "stop" | "update";

export interface StopCutFailure {
    readonly session_id: string;
    readonly message: string;
}

export type CutStopWaitResult =
    | {
        readonly status: "done";
        readonly cut: readonly string[];
        readonly failed: readonly StopCutFailure[];
    }
    | { readonly status: "refused"; readonly reason: "no_wait"; readonly message: string };

export interface StopWhenIdleControl {
    request(
        listener: StopWhenIdleListener,
        buildId?: string | null,
        options?: StopRequestOptions,
    ): StopRequestResult;
    // Calls the observer with the current wait, if one is announced, then with each change.
    observe(observer: StopWaitObserver): () => void;
    cutWait(): Promise<CutStopWaitResult>;
}

export interface StopWhenIdleOptions {
    readonly waitingOn: () => readonly StopWaitTarget[];
    readonly waitingOnAsync?: () => Promise<readonly StopWaitTarget[]>;
    readonly setTurnsHeld?: (held: boolean) => Promise<void>;
    readonly replyBeforeWorkerCheck?: boolean;
    readonly onStopped: () => void | Promise<void>;
    readonly pollIntervalMs?: number;
    // Checked when a request names a build. A message refuses the request.
    readonly targetProblem?: (buildId: string) => string | undefined;
    // Runs once nothing waits, before "stopped" is sent. A message abandons the stop and turns resume.
    readonly prepare?: (buildId: string | null) => string | undefined;
    // Halts one session and clears the halt again. False when the session did not confirm.
    readonly cutSession?: (sessionId: string, reason: string) => Promise<boolean>;
    // Receives one record per session per wait, after the session confirms the cut.
    readonly recordCut?: (record: RestartRecord) => void | Promise<void>;
    readonly now?: () => Date;
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
    // One record per session per wait; a repeat cut in the same wait still halts the session.
    private readonly recordedThisWait = new Set<string>();
    private checks: Promise<void> = Promise.resolve();
    private holdChange: Promise<void> = Promise.resolve();

    constructor(private readonly options: StopWhenIdleOptions) {}

    get holdsTurns(): boolean {
        return this.held;
    }

    request(
        listener: StopWhenIdleListener,
        buildId: string | null = null,
        requestOptions: StopRequestOptions = {},
    ): StopRequestResult {
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
        const newWait = this.pending === undefined;
        this.pending = buildId;
        this.held = true;
        if (newWait && this.options.setTurnsHeld !== undefined) {
            this.holdChange = Promise.resolve().then(() => this.options.setTurnsHeld!(true));
        }
        this.listeners.add(listener);
        if (this.options.waitingOnAsync !== undefined) {
            if (this.options.replyBeforeWorkerCheck === true) {
                void deliver(listener, { type: "waiting", waiting_on: [] });
            }
            this.ensureTimer();
            this.enqueueCheck(listener, requestOptions.cutFirst === true);
            return { accepted: true, unsubscribe: () => { this.listeners.delete(listener); } };
        }
        const waiting = this.options.waitingOn();
        if (waiting.length === 0) {
            void this.finish();
        } else {
            this.lastKey = keyOf(waiting);
            void deliver(listener, { type: "waiting", waiting_on: waiting });
            this.announce(waiting);
            this.ensureTimer();
            if (requestOptions.cutFirst === true) void this.cutWait();
        }
        return {
            accepted: true,
            unsubscribe: () => {
                this.listeners.delete(listener);
            },
        };
    }

    // Halts each waited session once, then clears the halt. Queued prompts are dropped
    // with a "Not started" line; the active turn ends. The wait itself stays open.
    async cutWait(): Promise<CutStopWaitResult> {
        if (this.finished || this.pending === undefined) {
            return {
                status: "refused",
                reason: "no_wait",
                message: "No stop is waiting, so there is nothing to cut.",
            };
        }
        const cause: StopCause = this.pending === null ? "stop" : "update";
        await this.holdChange;
        const reason = this.pending === null
            ? "Vera is stopping"
            : `Vera is updating to ${this.pending}`;
        const cut: string[] = [];
        const failed: StopCutFailure[] = [];
        const waiting = this.options.waitingOnAsync === undefined
            ? this.options.waitingOn() : await this.options.waitingOnAsync();
        for (const target of waiting) {
            try {
                const applied = this.options.cutSession !== undefined
                    && await this.options.cutSession(target.session_id, reason);
                if (!applied) {
                    failed.push({
                        session_id: target.session_id,
                        message: "The session did not confirm the cut.",
                    });
                    continue;
                }
            } catch (error) {
                failed.push({
                    session_id: target.session_id,
                    message: error instanceof Error ? error.message : String(error),
                });
                continue;
            }
            cut.push(target.session_id);
            if (this.recordedThisWait.has(target.session_id)) continue;
            this.recordedThisWait.add(target.session_id);
            const recorded = this.recordCut(target.session_id, cause);
            if (recorded !== undefined) await recorded;
        }
        return { status: "done", cut, failed };
    }

    // A failed write does not undo the cut or the stop.
    private recordCut(sessionId: string, cause: StopCause): void | Promise<void> {
        const record: RestartRecord = {
            session_id: sessionId,
            cause,
            ...(typeof this.pending === "string" ? { target_build_id: this.pending } : {}),
            at: (this.options.now?.() ?? new Date()).toISOString(),
        };
        try {
            const recorded = this.options.recordCut?.(record);
            if (recorded !== undefined) return recorded.catch(() => {});
        } catch {
            // The writer reports its own failures; the cut continues.
        }
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
        if (this.options.waitingOnAsync !== undefined) {
            this.enqueueCheck();
            return;
        }
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

    private enqueueCheck(listener?: StopWhenIdleListener, cutFirst = false): void {
        this.checks = this.checks.then(async () => {
            if (this.finished || this.pending === undefined) return;
            await this.holdChange;
            if (this.finished || this.pending === undefined) return;
            const waiting = await this.options.waitingOnAsync!();
            if (this.finished || this.pending === undefined) return;
            if (waiting.length === 0) {
                await this.finish();
                return;
            }
            const key = keyOf(waiting);
            if (listener !== undefined) {
                this.lastKey = key;
                await deliver(listener, { type: "waiting", waiting_on: waiting });
                this.announce(waiting);
                if (cutFirst) void this.cutWait();
            } else if (key !== this.lastKey) {
                this.lastKey = key;
                await this.broadcast({ type: "waiting", waiting_on: waiting });
                this.announce(waiting);
            }
        }).catch(async () => {
            if (!this.finished && this.pending !== undefined) await this.abandon("The host could not check running sessions.");
        });
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
        this.recordedThisWait.clear();
        this.clearTimer();
        const announced = this.announced !== undefined;
        this.announced = undefined;
        if (announced || this.pending === null) {
            await this.emit({ type: "wait_cleared", reason: "stopped" });
        }
        if (this.pending !== null && this.pending !== undefined) {
            await this.emit({ type: "restarting", build_id: this.pending });
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
        this.recordedThisWait.clear();
        this.clearTimer();
        try {
            await this.options.setTurnsHeld?.(false);
        } catch {
        }
        this.held = false;
        this.pending = undefined;
        this.lastKey = undefined;
        if (this.announced !== undefined) {
            this.announced = undefined;
            await this.emit({ type: "wait_cleared", reason: "abandoned", message });
        }
        await this.broadcast({ type: "abandoned", message });
    }

    private async emit(event: StopWaitEvent): Promise<void> {
        await Promise.all([...this.observers].map(async (observer) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.resolve().then(() => observer(event)),
                    new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); }),
                ]);
            } catch {
            } finally {
                clearTimeout(timer);
            }
        }));
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
        void Promise.resolve(observer(event)).catch(() => {});
    } catch {
        // An observer that throws must not hold up the stop.
    }
}

function keyOf(waiting: readonly StopWaitTarget[]): string {
    return JSON.stringify(waiting);
}
