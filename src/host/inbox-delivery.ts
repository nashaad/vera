import type { ConsumerHandle, ConsumerRegistry } from "./consumers.ts";
import { SOURCE_GAP_KIND } from "../watch/source.ts";
import type { InboxEntry, InboxEntryInput } from "../store/inbox.ts";

/** Largest unread count exposed by an arrival notice. */
export const MAX_INBOX_NOTICE_COUNT = 99;

export interface InboxNotice {
    /** Bounded count only. Foreign entry metadata and content stay in the log. */
    readonly unreadCount: number;
}

export interface AttachInboxConsumerRequest {
    readonly label: string;
    readonly actor?: string | null;
    readonly session: string;
    readonly notify: (notice: InboxNotice) => void;
}

/** One live session's bookkeeping-only view of inbox arrival. */
export class InboxDeliverySession {
    private readonly coordinator: InboxDeliveryCoordinator;
    private readonly handle: ConsumerHandle;
    private readonly notify: (notice: InboxNotice) => void;
    private queue: Promise<void> = Promise.resolve();
    private released = false;

    /** @internal Minted by `InboxDeliveryCoordinator.attach`. */
    constructor(
        coordinator: InboxDeliveryCoordinator,
        handle: ConsumerHandle,
        request: AttachInboxConsumerRequest,
    ) {
        this.coordinator = coordinator;
        this.handle = handle;
        this.notify = request.notify;
    }

    get consumer(): ConsumerHandle {
        return this.handle;
    }

    /** Emits count-only UI bookkeeping. It never records content or advances. */
    pump(): Promise<void> {
        if (this.released) return Promise.resolve();
        const next = this.queue.then(() => this.inspect());
        this.queue = next.then(() => undefined, () => undefined);
        return this.queue;
    }

    release(): void {
        if (this.released) return;
        this.released = true;
        this.handle.release();
        this.coordinator.forget(this);
    }

    private inspect(): void {
        if (this.released) return;
        const unread = this.handle.unreadStatus({
            limit: MAX_INBOX_NOTICE_COUNT,
            addresses: [this.handle.label],
            excludeKinds: [SOURCE_GAP_KIND],
        }, this.coordinator.now());
        if (unread.count === 0) return;
        this.notify({
            unreadCount: Math.min(MAX_INBOX_NOTICE_COUNT, unread.count),
        });
    }
}

export interface InboxDeliveryOptions {
    readonly now?: () => number;
}

/** Coordinates count-only arrival notices for attached sessions. */
export class InboxDeliveryCoordinator {
    private readonly consumers: ConsumerRegistry;
    private readonly sessions = new Set<InboxDeliverySession>();
    private readonly clock: () => number;

    constructor(consumers: ConsumerRegistry, options: InboxDeliveryOptions = {}) {
        this.consumers = consumers;
        this.clock = options.now ?? (() => Date.now());
    }

    attach(request: AttachInboxConsumerRequest): InboxDeliverySession {
        const handle = this.consumers.hello({
            label: request.label,
            selfEcho: {
                actor: request.actor ?? null,
                session: request.session,
            },
        });
        const session = new InboxDeliverySession(this, handle, request);
        this.sessions.add(session);
        return session;
    }

    async pumpAll(): Promise<void> {
        await Promise.all([...this.sessions].map((session) => session.pump()));
    }

    async append(entry: InboxEntryInput): Promise<InboxEntry> {
        const stored = this.consumers.append(entry);
        await this.pumpAll();
        return stored;
    }

    async appendOnce(
        source: string,
        key: string,
        entry: InboxEntryInput,
    ): Promise<{ readonly entry: InboxEntry; readonly created: boolean }> {
        const stored = this.consumers.appendOnce(source, key, entry);
        if (stored.created) await this.pumpAll();
        return stored;
    }

    entry(seq: number): InboxEntry | undefined {
        return this.consumers.entry(seq);
    }

    close(): void {
        for (const session of [...this.sessions]) session.release();
    }

    /** @internal */
    now(): number {
        return this.clock();
    }

    /** @internal */
    forget(session: InboxDeliverySession): void {
        this.sessions.delete(session);
    }
}
