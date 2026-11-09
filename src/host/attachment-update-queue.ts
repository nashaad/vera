import { AsyncQueue, type FailAsyncQueueOptions } from "../engine/async-queue.ts";
import type { AgentUpdate } from "../engine/protocol.ts";

export interface PendingAttachmentUpdate {
    readonly type: AgentUpdate["type"];
    take(): AgentUpdate | undefined;
}

class PendingUpdate implements PendingAttachmentUpdate {
    readonly type: AgentUpdate["type"];

    private update: AgentUpdate | undefined;

    constructor(update: AgentUpdate) {
        this.type = update.type;
        this.update = update;
    }

    take(): AgentUpdate | undefined {
        const update = this.update;
        this.update = undefined;
        return update;
    }
}

export class AttachmentUpdateQueue {
    private readonly queue = new AsyncQueue<PendingAttachmentUpdate>();
    private pendingHistory: PendingUpdate | undefined;
    private firstHistory = true;

    constructor(private readonly paging: boolean) {}

    push(update: AgentUpdate): void {
        const holder = new PendingUpdate(update);
        if (update.type === "history") {
            if (!this.paging && this.pendingHistory !== undefined) {
                this.pendingHistory.take();
            }
            const protectedHistory = this.firstHistory || update.unsentPrompts !== undefined;
            this.firstHistory = false;
            this.pendingHistory = !this.paging && !protectedHistory ? holder : undefined;
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
        if (options?.discardBuffered === true && this.pendingHistory !== undefined) {
            this.pendingHistory.take();
            this.pendingHistory = undefined;
        }
        this.queue.fail(error, options);
    }
}
