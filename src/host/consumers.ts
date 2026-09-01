import { hostname } from "node:os";

import type {
    ConsumerId,
    Inbox,
    InboxEntry,
    InboxEntryInput,
    InboxAcknowledgement,
} from "../store/inbox.ts";

export const RESERVED_CONSUMER_LABELS: readonly string[] = ["host:spawn"];

export const DEFAULT_MIN_WAKE_INTERVAL_MS = 5_000;

export interface WakePolicy {
    readonly minWakeIntervalMs: number;
}

export interface SelfEcho {
    readonly actor: string | null;
    readonly session: string | null;
}

export interface ConsumerHelloRequest {
    readonly label: string;
    readonly selfEcho?: SelfEcho;
    readonly wake?: Partial<WakePolicy>;
}

export interface ConsumerReadOptions {
    readonly limit: number;
    readonly addresses?: readonly string[];
    readonly excludeSelfEcho?: boolean;
    readonly excludeKinds?: readonly string[];
}

export interface ConsumerUnreadStatus {
    readonly count: number;
    readonly oldestAgeMs: number | null;
}

export interface ConsumerStatus {
    readonly consumer: ConsumerId;
    readonly label: string;
    readonly seq: number;
    readonly lag: number;
    readonly updatedAt: string;
    readonly live: boolean;
}

export class ConsumerHandle {
    readonly id: ConsumerId;
    readonly wake: WakePolicy;
    readonly selfEcho: SelfEcho;

    private readonly inbox: Inbox;
    private readonly registry: ConsumerRegistry;
    private lastWakeMs: number | null = null;
    private released = false;

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

    get label(): string {
        return this.id.label;
    }

    /** Suppression needs the whole pair. A consumer that knows only one half would otherwise match on the other alone, so an entry carrying a null actor and this session id would be. */
    private get hasSelfEcho(): boolean {
        return this.selfEcho.actor !== null && this.selfEcho.session !== null;
    }

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

    tail(): number {
        return this.inbox.tail();
    }

    lag(): number {
        return Math.max(0, this.tail() - this.offset());
    }

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
            ...(options.excludeKinds === undefined
                ? {}
                : { excludeKinds: options.excludeKinds }),
        });
    }

    unreadStatus(
        options: ConsumerReadOptions,
        nowMs: number = Date.now(),
    ): ConsumerUnreadStatus {
        this.assertLive();
        const stats = this.inbox.unreadStats(this.id, {
            limit: options.limit,
            ...(options.addresses === undefined
                ? {}
                : { addresses: options.addresses }),
            ...(options.excludeSelfEcho === false || !this.hasSelfEcho
                ? {}
                : { excludeOrigin: this.selfEcho }),
            ...(options.excludeKinds === undefined
                ? {}
                : { excludeKinds: options.excludeKinds }),
        });
        const oldestMs = stats.oldestTs === null ? Number.NaN : Date.parse(stats.oldestTs);
        return {
            count: stats.count,
            oldestAgeMs: Number.isFinite(oldestMs)
                ? Math.max(0, nowMs - oldestMs)
                : null,
        };
    }

    advance(seq: number): number {
        this.assertLive();
        return this.inbox.advance(this.id, seq);
    }

    acknowledge(
        seq: number,
        receipt?: InboxEntryInput,
    ): InboxAcknowledgement {
        this.assertLive();
        return this.inbox.acknowledge(this.id, seq, receipt);
    }

    mayWake(nowMs: number = Date.now()): boolean {
        if (this.wake.minWakeIntervalMs <= 0 || this.lastWakeMs === null) {
            return true;
        }
        return nowMs - this.lastWakeMs >= this.wake.minWakeIntervalMs;
    }

    wakeCooldownMs(nowMs: number = Date.now()): number {
        if (this.mayWake(nowMs)) {
            return 0;
        }
        return this.wake.minWakeIntervalMs - (nowMs - (this.lastWakeMs ?? 0));
    }

    recordWake(nowMs: number = Date.now()): void {
        this.lastWakeMs = nowMs;
    }

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

    get(label: string): ConsumerHandle | undefined {
        return this.live.get(label);
    }

    liveHandles(): ConsumerHandle[] {
        return [...this.live.values()];
    }

    append(entry: InboxEntryInput): InboxEntry {
        return this.inbox.append(entry);
    }

    appendOnce(
        source: string,
        key: string,
        entry: InboxEntryInput,
    ): { readonly entry: InboxEntry; readonly created: boolean } {
        return this.inbox.appendOnce(source, key, entry);
    }

    entry(seq: number): InboxEntry | undefined {
        return this.inbox.entry(seq);
    }

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

    private taken(label: string): boolean {
        return this.live.has(label);
    }
}

export function createConsumerRegistry(
    inbox: Inbox | null,
    nodeId: string = defaultNodeId(),
): ConsumerRegistry | null {
    return inbox === null ? null : new ConsumerRegistry(inbox, nodeId);
}

export function defaultNodeId(): string {
    return hostname();
}
