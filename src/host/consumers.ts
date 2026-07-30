import { hostname } from "node:os";

import type {
    ConsumerId,
    Inbox,
    InboxEntry,
} from "../store/inbox.ts";

/**
 * Consumer handles for the host inbox. A consumer is a named agent handle
 * minted at hello; identity is (nodeId, label) everywhere in storage, wire and
 * logs, and the bare label is display sugar that is never a key.
 *
 * Offsets are durable per (nodeId, label), so a label that is dormant still
 * owns its place in the log. Collision suffixing therefore runs against both
 * the live handles and the durable offset rows: a hello can never land on a
 * label some other consumer already owns an offset for, which would hand the
 * new session that consumer's place in the log.
 */

/** Labels the host keeps for itself. `hello` refuses them. */
export const RESERVED_CONSUMER_LABELS: readonly string[] = ["host:spawn"];

/** The floor between two wakes for one consumer. `0` disables rate limiting. */
export const DEFAULT_MIN_WAKE_INTERVAL_MS = 5_000;

export interface WakePolicy {
    readonly minWakeIntervalMs: number;
}

/**
 * The (actor, session) pair a consumer's own turns write into entries. Reads
 * exclude it so a turn is never woken by the events that turn caused.
 */
export interface SelfEcho {
    readonly actor: string | null;
    readonly session: string | null;
}

export interface ConsumerHelloRequest {
    /** Requested display label. A live collision gets a numeric suffix. */
    readonly label: string;
    readonly selfEcho?: SelfEcho;
    readonly wake?: Partial<WakePolicy>;
}

export interface ConsumerReadOptions {
    readonly limit: number;
    readonly addresses?: readonly string[];
    /** Set to false to see the consumer's own entries. */
    readonly excludeSelfEcho?: boolean;
}

/** What `list()` reports for both live and dormant consumers. */
export interface ConsumerStatus {
    readonly consumer: ConsumerId;
    readonly label: string;
    readonly seq: number;
    /** Entries after the consumer's offset. */
    readonly lag: number;
    readonly updatedAt: string;
    readonly live: boolean;
}

/**
 * A minted handle. It owns nothing durable itself: the offset lives in the
 * inbox, and the handle is the host-local identity plus the wake policy the
 * delivery path enforces. Handles are never sent to another node.
 */
export class ConsumerHandle {
    readonly id: ConsumerId;
    readonly wake: WakePolicy;
    readonly selfEcho: SelfEcho;

    private readonly inbox: Inbox;
    private readonly registry: ConsumerRegistry;
    private lastWakeMs: number | null = null;
    private released = false;

    /** @internal Minted by `ConsumerRegistry.hello`. */
    constructor(
        registry: ConsumerRegistry,
        inbox: Inbox,
        id: ConsumerId,
        wake: WakePolicy,
        selfEcho: SelfEcho,
    ) {
        this.registry = registry;
        this.inbox = inbox;
        this.id = id;
        this.wake = wake;
        this.selfEcho = selfEcho;
    }

    /** Display sugar. Durable records use `id`. */
    get label(): string {
        return this.id.label;
    }

    /**
     * Suppression needs the whole pair. A consumer that knows only one half
     * would otherwise match on the other alone, so an entry carrying a null
     * actor and this session id would be dropped for the very session it was
     * addressed to.
     *
     * Suppression is best-effort: actor and session on an entry are supplied
     * by whatever produced it, so an entry that carries the exact pair is
     * suppressed whether or not this session caused it. It becomes a real
     * guarantee once entries are attributed by the host rather than by their
     * producer.
     */
    private get hasSelfEcho(): boolean {
        return this.selfEcho.actor !== null && this.selfEcho.session !== null;
    }

    /** `nodeId/label`, the form durable records and logs use. */
    toString(): string {
        return `${this.id.nodeId}/${this.id.label}`;
    }

    offset(): number {
        const seq = this.inbox.offsetOf(this.id);
        if (seq === null) {
            throw new Error(`unknown inbox consumer ${this.toString()}`);
        }
        return seq;
    }

    /** The newest seq in the log, which bounds anything the handle may skip to. */
    tail(): number {
        return this.inbox.tail();
    }

    lag(): number {
        return Math.max(0, this.tail() - this.offset());
    }

    /** Entries after the offset. Reading never advances it. */
    read(options: ConsumerReadOptions): InboxEntry[] {
        this.assertLive();
        return this.inbox.read(this.id, {
            limit: options.limit,
            ...(options.addresses === undefined
                ? {}
                : { addresses: options.addresses }),
            ...(options.excludeSelfEcho === false || !this.hasSelfEcho
                ? {}
                : { excludeOrigin: this.selfEcho }),
        });
    }

    advance(seq: number): number {
        this.assertLive();
        return this.inbox.advance(this.id, seq);
    }

    /**
     * The rate limit as a decision, not a timer: the delivery path asks, then
     * stamps with `recordWake` when it actually wakes the consumer.
     */
    mayWake(nowMs: number = Date.now()): boolean {
        if (this.wake.minWakeIntervalMs <= 0 || this.lastWakeMs === null) {
            return true;
        }
        return nowMs - this.lastWakeMs >= this.wake.minWakeIntervalMs;
    }

    /** Milliseconds until `mayWake` turns true, `0` when it already is. */
    wakeCooldownMs(nowMs: number = Date.now()): number {
        if (this.mayWake(nowMs)) {
            return 0;
        }
        return this.wake.minWakeIntervalMs - (nowMs - (this.lastWakeMs ?? 0));
    }

    recordWake(nowMs: number = Date.now()): void {
        this.lastWakeMs = nowMs;
    }

    /**
     * Drops the live handle. The durable offset stays, so the same label can
     * be reclaimed later and resumes where it stopped.
     */
    release(): void {
        if (this.released) {
            return;
        }
        this.released = true;
        this.registry.forget(this);
    }

    get isLive(): boolean {
        return !this.released;
    }

    private assertLive(): void {
        if (this.released) {
            throw new Error(`released inbox consumer ${this.toString()}`);
        }
    }
}

export class ConsumerRegistry {
    readonly nodeId: string;

    private readonly inbox: Inbox;
    private readonly live = new Map<string, ConsumerHandle>();

    constructor(inbox: Inbox, nodeId: string = defaultNodeId()) {
        this.inbox = inbox;
        this.nodeId = nodeId;
    }

    /**
     * Mints the handle for a session. Registration is explicit and happens
     * here: nothing else creates an offset row, and reads on an unregistered
     * consumer throw.
     */
    hello(request: ConsumerHelloRequest): ConsumerHandle {
        const label = this.availableLabel(request.label);
        const id: ConsumerId = { nodeId: this.nodeId, label };
        this.inbox.registerConsumer(id);
        const handle = new ConsumerHandle(
            this,
            this.inbox,
            id,
            {
                minWakeIntervalMs: Math.max(
                    0,
                    request.wake?.minWakeIntervalMs ?? DEFAULT_MIN_WAKE_INTERVAL_MS,
                ),
            },
            {
                actor: request.selfEcho?.actor ?? null,
                session: request.selfEcho?.session ?? null,
            },
        );
        this.live.set(label, handle);
        return handle;
    }

    /** The live handle for a label on this node, if one is minted. */
    get(label: string): ConsumerHandle | undefined {
        return this.live.get(label);
    }

    liveHandles(): ConsumerHandle[] {
        return [...this.live.values()];
    }

    /** Every consumer the inbox knows, live and dormant, with offset and lag. */
    list(): ConsumerStatus[] {
        const tail = this.inbox.tail();
        return this.inbox.listConsumers().map((row) => ({
            consumer: row.consumer,
            label: row.consumer.label,
            seq: row.seq,
            lag: Math.max(0, tail - row.seq),
            updatedAt: row.updatedAt,
            live: row.consumer.nodeId === this.nodeId
                && this.live.get(row.consumer.label) !== undefined,
        }));
    }

    /** @internal Called by `ConsumerHandle.release`. */
    forget(handle: ConsumerHandle): void {
        if (this.live.get(handle.id.label) === handle) {
            this.live.delete(handle.id.label);
        }
    }

    private availableLabel(requested: string): string {
        const base = requested.trim();
        if (base === "") {
            throw new Error("a consumer label cannot be empty");
        }
        if (RESERVED_CONSUMER_LABELS.includes(base)) {
            throw new Error(`the consumer label ${base} is reserved for the host`);
        }
        if (!this.taken(base)) {
            return base;
        }
        for (let suffix = 2; ; suffix += 1) {
            const candidate = `${base}-${suffix}`;
            if (!this.taken(candidate)) {
                return candidate;
            }
        }
    }

    /**
     * Only a live handle blocks a label. A dormant durable row is the same
     * consumer returning: hello reattaches to it and resumes at its offset.
     */
    private taken(label: string): boolean {
        return this.live.has(label);
    }
}

/**
 * `null` when the inbox is off, so the experimental gate is checked once where
 * the inbox is opened and never again downstream.
 */
export function createConsumerRegistry(
    inbox: Inbox | null,
    nodeId: string = defaultNodeId(),
): ConsumerRegistry | null {
    return inbox === null ? null : new ConsumerRegistry(inbox, nodeId);
}

export function defaultNodeId(): string {
    return hostname();
}
