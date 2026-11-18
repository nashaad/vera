const AUTOMATIC_RECONNECT_LIMIT = 3;
const AUTOMATIC_RECONNECT_WINDOW_MS = 60_000;

interface ReconnectAttempts {
    readonly times: number[];
    readonly expiry: ReturnType<typeof setTimeout>;
}

export class ReconnectBudget {
    private readonly conversations = new Map<string, ReconnectAttempts>();

    tryStart(conversationId: string, now = performance.now()): boolean {
        const previous = this.conversations.get(conversationId);
        const times = previous?.times.filter((time) => now - time < AUTOMATIC_RECONNECT_WINDOW_MS) ?? [];
        if (times.length >= AUTOMATIC_RECONNECT_LIMIT) return false;
        if (previous !== undefined) clearTimeout(previous.expiry);
        times.push(now);
        const expiry = setTimeout(() => {
            if (this.conversations.get(conversationId)?.expiry === expiry) {
                this.conversations.delete(conversationId);
            }
        }, AUTOMATIC_RECONNECT_WINDOW_MS);
        expiry.unref?.();
        this.conversations.set(conversationId, { times, expiry });
        return true;
    }

    clear(conversationId: string): void {
        const previous = this.conversations.get(conversationId);
        if (previous === undefined) return;
        clearTimeout(previous.expiry);
        this.conversations.delete(conversationId);
    }
}
