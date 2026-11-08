import type { StopWaitEvent, StopWaitObserver } from "../stop-when-idle.ts";

export class StopWaitRelay {
    private current: Extract<StopWaitEvent, { type: "wait" }> | undefined;
    private readonly observers = new Set<StopWaitObserver>();

    observe(observer: StopWaitObserver): () => void {
        this.observers.add(observer);
        if (this.current !== undefined) {
            try { void Promise.resolve(observer(this.current)).catch(() => {}); } catch {}
        }
        return () => { this.observers.delete(observer); };
    }

    async publish(event: StopWaitEvent): Promise<void> {
        if (event.type === "wait") this.current = event;
        else if (event.type === "wait_cleared") this.current = undefined;
        await Promise.all([...this.observers].map(async (observer) => {
            try { await observer(event); } catch {}
        }));
    }
}
