import type { OwnedWatchContribution } from "../extensions/contribution-set.ts";
import { WatchFloodError, type WatchAdmission } from "./admission.ts";
import {
    WatchFatalError,
    type SourceCheckpoint,
    type SourceEvent,
    type WatchConnector,
    type WatchRuntimeContext,
} from "./source.ts";

/**
 * One supervised async task per contributed watch. Supervision is per watch:
 * a connector that crashes, hangs on a dead upstream, or floods never reaches
 * another watch, the inbox, or delivery.
 *
 * Restart versus quarantine is the distinction that matters. Anything a retry
 * could fix backs off and retries; anything a retry cannot fix stops and waits
 * for the user, because a restart loop against a permanent failure only hides
 * a broken integration.
 */

export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;
/** How long a run must last before the backoff ladder resets. */
export const HEALTHY_RUN_MS = 60_000;
export const FAILURE_WINDOW_MS = 5 * 60_000;
export const FAILURES_BEFORE_QUARANTINE = 5;

export type WatchState = "starting" | "running" | "backoff" | "quarantined" | "stopped";

export interface WatchStatus {
    readonly watchId: string;
    readonly extensionId: string;
    readonly sourceFamily: string;
    readonly state: WatchState;
    readonly failures: number;
    readonly lastError: string | null;
    readonly nextRetryInMs: number | null;
}

export interface WatchSupervisorOptions {
    readonly watch: OwnedWatchContribution;
    readonly connector: WatchConnector;
    readonly admission: WatchAdmission;
    readonly now?: () => number;
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly random?: () => number;
    readonly onStateChange?: (status: WatchStatus) => void;
}

export class SupervisedWatch {
    readonly watchId: string;

    private readonly watch: OwnedWatchContribution;
    private readonly connector: WatchConnector;
    private readonly admission: WatchAdmission;
    private readonly clock: () => number;
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    private readonly random: () => number;
    private readonly onStateChange: (status: WatchStatus) => void;

    private controller: AbortController | null = null;
    private loop: Promise<void> | null = null;
    private state: WatchState = "stopped";
    private consecutiveFailures = 0;
    private failureTimes: number[] = [];
    private lastError: string | null = null;
    private nextRetryInMs: number | null = null;

    constructor(options: WatchSupervisorOptions) {
        this.watch = options.watch;
        this.watchId = options.watch.id;
        this.connector = options.connector;
        this.admission = options.admission;
        this.clock = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? defaultSleep;
        this.random = options.random ?? Math.random;
        this.onStateChange = options.onStateChange ?? ((): void => undefined);
    }

    status(): WatchStatus {
        return {
            watchId: this.watchId,
            extensionId: this.watch.extensionId,
            sourceFamily: this.watch.definition.source_family,
            state: this.state,
            failures: this.consecutiveFailures,
            lastError: this.lastError,
            nextRetryInMs: this.nextRetryInMs,
        };
    }

    start(): void {
        if (this.loop !== null) {
            return;
        }
        this.controller = new AbortController();
        this.loop = this.supervise(this.controller.signal);
    }

    /** Stops the task and waits for the connector to unwind. */
    async stop(): Promise<void> {
        this.controller?.abort();
        const loop = this.loop;
        this.loop = null;
        this.controller = null;
        if (loop !== null) {
            // The loop already records its own crash as a quarantine; closing
            // must not raise it a second time at the caller.
            await loop.catch(() => undefined);
        }
        this.enter("stopped");
    }

    /**
     * Wrapped whole. An unhandled rejection here would kill the task while
     * `status()` still reported the last state it reached, so a watch that
     * silently stopped would read as running.
     */
    private async supervise(signal: AbortSignal): Promise<void> {
        try {
            await this.superviseLoop(signal);
        } catch (error) {
            this.lastError = errorMessage(error);
            this.enterUnconditionally("quarantined");
        }
    }

    private async superviseLoop(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            this.enter("starting");
            const startedAt = this.clock();
            try {
                this.enter("running");
                await this.connector.run(this.contextFor(signal));
                if (signal.aborted) {
                    return;
                }
                // A clean return from a standing watch is still a stop that
                // wants restarting; only an abort ends the loop.
                this.noteFailure("connector returned before it was stopped");
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                if (error instanceof WatchFatalError || error instanceof WatchFloodError) {
                    this.lastError = error.message;
                    this.enter("quarantined");
                    return;
                }
                this.noteFailure(errorMessage(error));
            }

            if (this.ranLongEnough(startedAt)) {
                // A run that lasted forgets the window as well as the ladder.
                // Pruning only the ladder let five long healthy runs, each
                // ending in one failure, still reach the quarantine threshold.
                this.resetFailureLadder(1);
            }
            if (this.shouldQuarantine()) {
                this.enter("quarantined");
                return;
            }
            const delay = this.backoffMs();
            this.nextRetryInMs = delay;
            this.enter("backoff");
            await this.sleep(delay, signal);
            this.nextRetryInMs = null;
        }
    }

    private contextFor(signal: AbortSignal): WatchRuntimeContext {
        const definition = this.watch.definition;
        return {
            watchId: this.watchId,
            sourceFamily: definition.source_family,
            config: definition.config,
            address: definition.address ?? null,
            flood: definition.flood,
            signal,
            cursor: (): string | null => this.admission.cursor(),
            admit: async (events: readonly SourceEvent[]): Promise<void> => {
                this.admission.admit(events);
            },
            checkpoint: (checkpoint: SourceCheckpoint): void => {
                this.admission.checkpoint(checkpoint.cursor);
            },
            recordGap: (
                reason: string,
                detail: Record<string, string | number>,
            ): void => {
                this.admission.recordGap(reason, detail);
            },
            healthy: (): void => {
                this.resetFailureLadder(0);
                this.lastError = null;
            },
        };
    }

    private noteFailure(message: string): void {
        this.lastError = message;
        this.consecutiveFailures += 1;
        const now = this.clock();
        this.failureTimes.push(now);
        this.failureTimes = this.failureTimes.filter(
            (at) => now - at <= FAILURE_WINDOW_MS,
        );
    }

    /** The one place both healthy paths clear the window and the ladder. */
    private resetFailureLadder(consecutive: number): void {
        this.consecutiveFailures = consecutive;
        this.failureTimes = [];
    }

    private ranLongEnough(startedAt: number): boolean {
        return this.clock() - startedAt >= HEALTHY_RUN_MS;
    }

    private shouldQuarantine(): boolean {
        return this.failureTimes.length >= FAILURES_BEFORE_QUARANTINE;
    }

    /** Exponential with full jitter, so restarts of many watches do not align. */
    private backoffMs(): number {
        const step = Math.min(
            MAX_BACKOFF_MS,
            BASE_BACKOFF_MS * 2 ** Math.max(0, this.consecutiveFailures - 1),
        );
        return Math.max(1, Math.floor(this.random() * step));
    }

    private enter(state: WatchState): void {
        if (this.state === state) {
            return;
        }
        this.enterUnconditionally(state);
    }

    /** The state is recorded before the listener runs, so a listener that
     * throws cannot leave `status()` describing a state the watch has left. */
    private enterUnconditionally(state: WatchState): void {
        this.state = state;
        try {
            this.onStateChange(this.status());
        } catch {
            // A status listener is a diagnostic, never part of supervision.
        }
    }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        timer.unref?.();
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
