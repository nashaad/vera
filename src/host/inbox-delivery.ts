import type { ConsumerHandle, ConsumerRegistry } from "./consumers.ts";
import type { InboxEntry } from "../store/inbox.ts";
import { SOURCE_GAP_KIND } from "../watch/source.ts";
import type { PendingDelivery } from "../store/session-store.ts";

/**
 * Turns inbox entries into the host's existing durable deliveries.
 *
 * The guarantee is at-least-once, and the durable artifact is the recorded
 * delivery, not the turn. A delivery is written before the consumer offset
 * moves, so a crash in between leaves the delivery pending and the offset
 * behind; `attach` walks the offset forward over pending deliveries at boot,
 * and the session store's own pending-delivery replay runs the turn. A
 * delivery whose turn already completed is no longer pending and the offset is
 * already past it, so it is never replayed.
 */

/** The `sourceAgentId` every inbox delivery carries. */
export const INBOX_DELIVERY_SOURCE = "inbox";

/** How many entries one wake may carry. */
export const DEFAULT_MAX_ENTRIES_PER_WAKE = 50;

const DELIVERY_ID_PATTERN = /^inbox:(\d+)-(\d+)$/;

export interface InboxDeliveryTarget {
    recordDelivery(delivery: PendingDelivery): Promise<boolean>;
    pendingDeliveryIds(): readonly string[];
}

export interface AttachInboxConsumerRequest {
    /** Durable consumer label. Stable for the life of the session. */
    readonly label: string;
    /**
     * The actor the session's own turns write into entries. Self-echo matches
     * on the (actor, session) pair, so a null actor suppresses nothing.
     */
    readonly actor?: string | null;
    /** The session id entries caused by this session carry. */
    readonly session: string;
    readonly target: InboxDeliveryTarget;
    /** Wakes the session. Called only after a delivery is durably recorded. */
    readonly triggerTurn: () => void;
    readonly minWakeIntervalMs?: number;
}

export interface InboxPumpFailure {
    /** `nodeId/label` of the consumer whose pump failed. */
    readonly consumer: string;
    readonly error: unknown;
}

export interface InboxDeliveryOptions {
    readonly maxEntriesPerWake?: number;
    /**
     * Reports a pump that could not record its delivery. The offset stays put
     * when this fires, so the entries are retried rather than lost; without a
     * hook the failure would be invisible and the consumer would look idle.
     */
    readonly onPumpError?: (failure: InboxPumpFailure) => void;
    readonly now?: () => number;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
}

/**
 * One session's slice of the delivery path. Pumps are serialized so two
 * overlapping wakes cannot read the same entries into two deliveries.
 */
export class InboxDeliverySession {
    private readonly coordinator: InboxDeliveryCoordinator;
    private readonly handle: ConsumerHandle;
    private readonly target: InboxDeliveryTarget;
    private readonly triggerTurn: () => void;
    private queue: Promise<void> = Promise.resolve();
    private timer: unknown = null;
    private released = false;

    /** @internal Minted by `InboxDeliveryCoordinator.attach`. */
    constructor(
        coordinator: InboxDeliveryCoordinator,
        handle: ConsumerHandle,
        request: AttachInboxConsumerRequest,
    ) {
        this.coordinator = coordinator;
        this.handle = handle;
        this.target = request.target;
        this.triggerTurn = request.triggerTurn;
    }

    get consumer(): ConsumerHandle {
        return this.handle;
    }

    /** Records and wakes for whatever the consumer has not seen yet. */
    pump(): Promise<void> {
        if (this.released) {
            return Promise.resolve();
        }
        const next = this.queue.then(() => this.drain());
        this.queue = next.then(
            () => undefined,
            () => undefined,
        );
        return this.queue;
    }

    release(): void {
        if (this.released) {
            return;
        }
        this.released = true;
        this.cancelTimer();
        this.handle.release();
        this.coordinator.forget(this);
    }

    /**
     * Moves the offset over deliveries that were already recorded, so a crash
     * between recording and advancing does not hand the same entries out
     * twice. Monotonic, so it is a no-op when the offset is already ahead.
     */
    reconcile(): void {
        let highest = 0;
        for (const id of this.target.pendingDeliveryIds()) {
            const match = DELIVERY_ID_PATTERN.exec(id);
            if (match !== null) {
                highest = Math.max(highest, Number(match[2]));
            }
        }
        // Clamped to the tail the log actually holds. Delivery ids are text
        // carried on a stored session, so a stale or edited one naming a seq
        // beyond the log would otherwise skip every entry written after it.
        const target = Math.min(highest, this.handle.tail());
        if (target > 0) {
            this.handle.advance(target);
        }
    }

    private async drain(): Promise<void> {
        while (!this.released) {
            const limit = this.coordinator.maxEntriesPerWake;
            // Addressed entries are for their consumer. Addressing is a filter,
            // not a private channel, but the default read is the accepted
            // semantic: unaddressed entries plus this consumer's own.
            const read = this.handle.read({
                limit,
                addresses: [this.handle.label],
            });
            if (read.length === 0) {
                return;
            }
            // Gap records are status only: they stay visible in the log but
            // never become a delivery or a wake. The offset still moves past
            // them, or a gap-only stretch would pin every later read behind it.
            const entries = read.filter((entry) => entry.kind !== SOURCE_GAP_KIND);
            if (entries.length === 0) {
                this.handle.advance(read[read.length - 1]!.seq);
                if (read.length < limit) {
                    return;
                }
                continue;
            }
            const now = this.coordinator.now();
            if (!this.handle.mayWake(now)) {
                this.scheduleWake(this.handle.wakeCooldownMs(now));
                return;
            }
            const first = entries[0]!;
            const last = entries[entries.length - 1]!;
            const after = this.handle.offset();
            const delivery: PendingDelivery = {
                id: `inbox:${Math.min(after, first.seq - 1)}-${last.seq}`,
                sourceAgentId: INBOX_DELIVERY_SOURCE,
                content: renderEntries(entries),
            };
            let recorded: boolean;
            try {
                recorded = await this.target.recordDelivery(delivery);
            } catch (error) {
                // The offset does not move: the entries stay unread and the
                // next pump retries them rather than skipping the batch.
                this.coordinator.reportPumpFailure({
                    consumer: this.handle.toString(),
                    error,
                });
                return;
            }
            // Past the whole read, not just the delivered entries, so a
            // trailing gap record is consumed by the batch that saw it.
            this.handle.advance(read[read.length - 1]!.seq);
            if (this.released) {
                return;
            }
            if (recorded) {
                this.handle.recordWake(this.coordinator.now());
                this.triggerTurn();
            }
            if (read.length < limit) {
                return;
            }
        }
    }

    /**
     * Over the rate limit nothing is dropped: unread entries stay in the log
     * and the next permitted pump folds all of them into one wake.
     */
    private scheduleWake(delayMs: number): void {
        if (this.timer !== null || this.released) {
            return;
        }
        this.timer = this.coordinator.startTimer(() => {
            this.timer = null;
            void this.pump();
        }, Math.max(1, delayMs));
    }

    private cancelTimer(): void {
        if (this.timer !== null) {
            this.coordinator.stopTimer(this.timer);
            this.timer = null;
        }
    }
}

export class InboxDeliveryCoordinator {
    readonly maxEntriesPerWake: number;

    private readonly consumers: ConsumerRegistry;
    private readonly sessions = new Set<InboxDeliverySession>();
    private readonly clock: () => number;
    private readonly setTimer: (run: () => void, ms: number) => unknown;
    private readonly clearTimer: (timer: unknown) => void;
    private spawnScan: (() => Promise<void>) | null = null;
    private readonly onPumpError: (failure: InboxPumpFailure) => void;

    constructor(consumers: ConsumerRegistry, options: InboxDeliveryOptions = {}) {
        this.consumers = consumers;
        this.maxEntriesPerWake = Math.max(
            1,
            options.maxEntriesPerWake ?? DEFAULT_MAX_ENTRIES_PER_WAKE,
        );
        this.clock = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer
            ?? ((run, ms) => {
                const timer = setTimeout(run, ms);
                timer.unref?.();
                return timer;
            });
        this.clearTimer = options.clearTimer
            ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
        this.onPumpError = options.onPumpError ?? reportPumpFailure;
    }

    /** Mints the consumer handle for a session and reconciles its offset. */
    attach(request: AttachInboxConsumerRequest): InboxDeliverySession {
        const handle = this.consumers.hello({
            label: request.label,
            selfEcho: {
                actor: request.actor ?? null,
                session: request.session,
            },
            ...(request.minWakeIntervalMs === undefined
                ? {}
                : { wake: { minWakeIntervalMs: request.minWakeIntervalMs } }),
        });
        const session = new InboxDeliverySession(this, handle, request);
        this.sessions.add(session);
        session.reconcile();
        return session;
    }

    /**
     * The spawn scan, when the host installed one. It runs after the live
     * sessions have pumped, so an entry a running session was going to take
     * never looks like one nothing is attached to handle.
     */
    setSpawnScan(scan: (() => Promise<void>) | null): void {
        this.spawnScan = scan;
    }

    /** Every attached session pumps. This is what an appended entry calls. */
    async pumpAll(): Promise<void> {
        await Promise.all([...this.sessions].map((session) => session.pump()));
        await this.spawnScan?.();
    }

    close(): void {
        for (const session of [...this.sessions]) {
            session.release();
        }
    }

    /** @internal Called by a pump that could not record its delivery. */
    reportPumpFailure(failure: InboxPumpFailure): void {
        try {
            this.onPumpError(failure);
        } catch {
            // Diagnostics must not take the delivery path down with them.
        }
    }

    /** @internal */
    now(): number {
        return this.clock();
    }

    /** @internal */
    startTimer(run: () => void, ms: number): unknown {
        return this.setTimer(run, ms);
    }

    /** @internal */
    stopTimer(timer: unknown): void {
        this.clearTimer(timer);
    }

    /** @internal Called by `InboxDeliverySession.release`. */
    forget(session: InboxDeliverySession): void {
        this.sessions.delete(session);
    }
}

function reportPumpFailure(failure: InboxPumpFailure): void {
    const detail = failure.error instanceof Error
        ? failure.error.message
        : String(failure.error);
    console.error(
        `Vera could not record an inbox delivery for ${failure.consumer}: ${detail}`,
    );
}

/**
 * Payloads are inert: they are printed verbatim and never interpolated. No
 * seq, offset or cursor appears here, so nothing asks the model to track
 * delivery state.
 */
function renderEntries(entries: readonly InboxEntry[]): string {
    const heading = entries.length === 1
        ? "1 new inbox entry."
        : `${entries.length} new inbox entries.`;
    const body = entries.map((entry) => {
        const origin = entry.actor === null ? "" : ` by ${entry.actor}`;
        return `- [${entry.source}/${entry.kind}]${origin} at ${entry.ts}\n  ${entry.payload}`;
    });
    return [heading, "", ...body].join("\n");
}
