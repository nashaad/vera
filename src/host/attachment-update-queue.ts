import { AsyncQueue, type FailAsyncQueueOptions } from "../engine/async-queue.ts";
import type { AgentUpdate } from "../engine/protocol.ts";

/** The server's bound on updates waiting for one client, counted from push until taken. */
export const MAX_ATTACHMENT_QUEUE_BYTES = 16 * 1_024 * 1_024;
export const MAX_ATTACHMENT_QUEUE_UPDATES = 32_768;

export interface PendingAttachmentUpdate {
    readonly type: AgentUpdate["type"];
    take(): AgentUpdate | undefined;
}

export interface AttachmentQueueLimits {
    readonly maxBytes?: number;
    readonly maxUpdates?: number;
}

export const CLIENT_ATTACHMENT_QUEUE_LIMITS: AttachmentQueueLimits = {
    maxBytes: MAX_ATTACHMENT_QUEUE_BYTES,
    maxUpdates: MAX_ATTACHMENT_QUEUE_UPDATES,
};

export interface AttachmentPushOptions {
    /** The attach-time replay is sent before the client can fall behind, so it is not counted. */
    readonly counted?: boolean;
}

export class AttachmentQueueOverflowError extends Error {
    constructor(readonly bytes: number, readonly updates: number) {
        super(`Client fell behind: ${updates} updates (${bytes} bytes) waiting`);
        this.name = "AttachmentQueueOverflowError";
    }
}

// History updates are shared by every attachment, so their size is measured once.
const measuredBytes = new WeakMap<AgentUpdate, number>();

function updateBytes(update: AgentUpdate): number {
    const cached = measuredBytes.get(update);
    if (cached !== undefined) return cached;
    const bytes = JSON.stringify(update).length;
    measuredBytes.set(update, bytes);
    return bytes;
}

class PendingUpdate implements PendingAttachmentUpdate {
    readonly type: AgentUpdate["type"];

    private update: AgentUpdate | undefined;

    constructor(
        update: AgentUpdate,
        private readonly bytes: number,
        private readonly onTaken: (bytes: number) => void,
    ) {
        this.type = update.type;
        this.update = update;
    }

    take(): AgentUpdate | undefined {
        const update = this.update;
        if (update === undefined) return undefined;
        this.update = undefined;
        this.onTaken(this.bytes);
        return update;
    }
}

export class AttachmentUpdateQueue {
    private readonly queue = new AsyncQueue<PendingAttachmentUpdate>();
    private readonly maxBytes: number;
    private readonly maxUpdates: number;
    private queuedBytes = 0;
    private queuedUpdates = 0;
    private failed = false;
    private pendingHistory: PendingUpdate | undefined;
    private firstHistory = true;

    constructor(limits: AttachmentQueueLimits = {}) {
        this.maxBytes = limits.maxBytes ?? Infinity;
        this.maxUpdates = limits.maxUpdates ?? Infinity;
    }

    push(update: AgentUpdate, options: AttachmentPushOptions = {}): void {
        if (this.failed) return;
        if (update.type === "history") {
            // A newer page replaces one still waiting; the first page and unsent prompts are kept.
            this.pendingHistory?.take();
            this.pendingHistory = undefined;
        }
        const counted = options.counted !== false;
        const bytes = counted && this.maxBytes !== Infinity ? updateBytes(update) : 0;
        if (counted) {
            this.queuedBytes += bytes;
            this.queuedUpdates += 1;
            if (this.queuedBytes > this.maxBytes || this.queuedUpdates > this.maxUpdates) {
                this.fail(
                    new AttachmentQueueOverflowError(this.queuedBytes, this.queuedUpdates),
                    { discardBuffered: true },
                );
                return;
            }
        }
        const holder = new PendingUpdate(update, bytes, (taken) => {
            if (!counted) return;
            this.queuedBytes -= taken;
            this.queuedUpdates -= 1;
        });
        if (update.type === "history") {
            const protectedHistory = this.firstHistory || update.unsentPrompts !== undefined;
            this.firstHistory = false;
            if (!protectedHistory) this.pendingHistory = holder;
        }
        this.queue.push(holder);
    }

    receivePending(signal?: AbortSignal): Promise<PendingAttachmentUpdate> {
        return this.queue.receive(signal);
    }

    async receive(signal?: AbortSignal): Promise<AgentUpdate> {
        while (true) {
            const update = (await this.receivePending(signal)).take();
            if (update !== undefined) return update;
        }
    }

    fail(error: unknown, options?: FailAsyncQueueOptions): void {
        if (this.failed) return;
        this.failed = true;
        if (options?.discardBuffered === true) {
            this.pendingHistory?.take();
            this.pendingHistory = undefined;
        }
        this.queue.fail(error, options);
    }
}
