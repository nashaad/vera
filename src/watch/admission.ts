import type { Inbox, InboxEntryInput } from "../store/inbox.ts";
import type { WatchFloodPolicy } from "../extensions/contributions.ts";
import { SOURCE_GAP_KIND, type SourceEvent } from "./source.ts";

export const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024;
export const DEFAULT_MAX_EVENTS_PER_SEC = 50;
export const DEFAULT_BURST_EVENTS = 500;
export const DEFAULT_DEDUP_WINDOW = 1_000;
export const FLOOD_WINDOW_MS = 1_000;

export interface AdmissionLimits {
    readonly maxPayloadBytes: number;
    readonly maxEventsPerSec: number;
    readonly burstEvents: number;
    readonly dedupWindow: number;
}

export interface AdmissionCounters {
    admitted: number;
    droppedMalformed: number;
    droppedOversize: number;
    droppedDuplicate: number;
    droppedFlood: number;
}

export class WatchFloodError extends Error {
    readonly dropped: number;

    constructor(watchId: string, dropped: number) {
        super(`Watch ${watchId} exceeded its event rate cap, dropping ${dropped}`);
        this.name = "WatchFloodError";
        this.dropped = dropped;
    }
}

export interface WatchAdmissionOptions {
    readonly inbox: Inbox;
    readonly watchId: string;
    readonly address: string | null;
    readonly flood: WatchFloodPolicy;
    readonly limits?: Partial<AdmissionLimits>;
    readonly now?: () => number;
    readonly onAppended?: () => void;
}

export class WatchAdmission {
    readonly watchId: string;
    readonly limits: AdmissionLimits;

    private readonly inbox: Inbox;
    private readonly address: string | null;
    private readonly flood: WatchFloodPolicy;
    private readonly clock: () => number;
    private readonly onAppended: () => void;
    private readonly seenIds = new Set<string>();
    private readonly seenOrder: string[] = [];
    private tokens: number;
    private lastRefillMs: number;
    private shedUntilMs = 0;
    private gapForShedUntilMs = 0;
    private readonly counters: AdmissionCounters = {
        admitted: 0,
        droppedMalformed: 0,
        droppedOversize: 0,
        droppedDuplicate: 0,
        droppedFlood: 0,
    };

    constructor(options: WatchAdmissionOptions) {
        this.inbox = options.inbox;
        this.watchId = options.watchId;
        this.address = options.address;
        this.flood = options.flood;
        this.clock = options.now ?? (() => Date.now());
        this.onAppended = options.onAppended ?? ((): void => undefined);
        this.limits = {
            maxPayloadBytes: options.limits?.maxPayloadBytes
                ?? DEFAULT_MAX_PAYLOAD_BYTES,
            maxEventsPerSec: options.limits?.maxEventsPerSec
                ?? DEFAULT_MAX_EVENTS_PER_SEC,
            burstEvents: options.limits?.burstEvents ?? DEFAULT_BURST_EVENTS,
            dedupWindow: options.limits?.dedupWindow ?? DEFAULT_DEDUP_WINDOW,
        };
        this.tokens = this.limits.burstEvents;
        this.lastRefillMs = this.clock();
    }

    stats(): Readonly<AdmissionCounters> {
        return { ...this.counters };
    }

    cursor(): string | null {
        return this.inbox.watchCursor(this.watchId);
    }

    checkpoint(cursor: string): void {
        this.inbox.setWatchCursor(this.watchId, cursor);
    }

    recordGap(reason: string, detail: Record<string, string | number>): void {
        this.appendEntries([
            {
                source: this.watchId,
                kind: SOURCE_GAP_KIND,
                actor: `source:${this.watchId}`,
                session: null,
                address: this.address,
                payload: JSON.stringify({ reason, ...detail }),
            },
        ]);
    }

    admit(events: readonly SourceEvent[]): void {
        const entries: InboxEntryInput[] = [];
        const admittedIds: string[] = [];
        let cursor: string | null = null;
        let shedInBatch = 0;
        let malformedInBatch = 0;
        let oversizeInBatch = 0;

        for (const event of events) {
            if (!isWellFormed(event)) {
                this.counters.droppedMalformed += 1;
                malformedInBatch += 1;
                continue;
            }
            if (this.seenIds.has(event.id) || admittedIds.includes(event.id)) {
                this.counters.droppedDuplicate += 1;
                if (event.cursor !== undefined) {
                    cursor = event.cursor;
                }
                continue;
            }
            const payload = JSON.stringify(event.payload);
            if (Buffer.byteLength(payload, "utf8") > this.limits.maxPayloadBytes) {
                this.counters.droppedOversize += 1;
                oversizeInBatch += 1;
                continue;
            }
            if (!this.takeToken()) {
                this.counters.droppedFlood += 1;
                shedInBatch += 1;
                continue;
            }
            admittedIds.push(event.id);
            entries.push({
                source: this.watchId,
                kind: event.kind,
                actor: event.actor,
                session: event.session,
                address: this.address,
                payload,
                ts: event.ts,
            });
            if (event.cursor !== undefined) {
                cursor = event.cursor;
            }
        }

        if (entries.length > 0) {
            this.appendEntries(entries);
            this.counters.admitted += entries.length;
            for (const id of admittedIds) {
                this.remember(id);
            }
        }
        if (cursor !== null) {
            this.inbox.setWatchCursor(this.watchId, cursor);
        }
        if (malformedInBatch > 0 || oversizeInBatch > 0) {
            this.recordGap("dropped", {
                watch: this.watchId,
                malformed: malformedInBatch,
                oversize: oversizeInBatch,
                detail: oversizeInBatch > 0
                    ? `payload over ${this.limits.maxPayloadBytes} bytes, or malformed event shape`
                    : "malformed event shape",
            });
        }
        if (shedInBatch > 0) {
            if (this.shedUntilMs !== this.gapForShedUntilMs) {
                this.gapForShedUntilMs = this.shedUntilMs;
                this.recordGap("flood", {
                    watch: this.watchId,
                    dropped: shedInBatch,
                });
            }
            if (this.flood === "quarantine") {
                throw new WatchFloodError(this.watchId, shedInBatch);
            }
        }
    }

    private appendEntries(entries: readonly InboxEntryInput[]): void {
        this.inbox.appendAll(entries);
        this.onAppended();
    }

    private takeToken(): boolean {
        const now = this.clock();
        if (now < this.shedUntilMs) {
            return false;
        }
        const elapsed = Math.max(0, now - this.lastRefillMs);
        this.lastRefillMs = now;
        this.tokens = Math.min(
            this.limits.burstEvents,
            this.tokens + (elapsed / 1000) * this.limits.maxEventsPerSec,
        );
        if (this.tokens < 1) {
            this.shedUntilMs = now + FLOOD_WINDOW_MS;
            return false;
        }
        this.tokens -= 1;
        return true;
    }

    private remember(id: string): void {
        this.seenIds.add(id);
        this.seenOrder.push(id);
        while (this.seenOrder.length > this.limits.dedupWindow) {
            const oldest = this.seenOrder.shift();
            if (oldest !== undefined) {
                this.seenIds.delete(oldest);
            }
        }
    }
}

function isWellFormed(event: SourceEvent): boolean {
    return typeof event.id === "string" && event.id.length > 0
        && typeof event.kind === "string" && event.kind.length > 0
        && typeof event.actor === "string" && event.actor.length > 0
        && typeof event.ts === "string" && !Number.isNaN(Date.parse(event.ts))
        && typeof event.payload === "object" && event.payload !== null;
}
