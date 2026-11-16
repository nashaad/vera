import type { ControlChannel, ControlEventHandler, ControlHandler, ControlPeer } from "./control.ts";
import { HostConnectionClosedError } from "../connection.ts";

export class WorkerControlLink implements ControlChannel {
    private peer?: ControlPeer;
    private accepting = false;
    private handler: ControlHandler = async () => { throw new Error("Control request is unavailable"); };
    private onEvent: ControlEventHandler = () => {};
    private readonly connectionWaiters = new Set<() => void>();

    get connected(): boolean { return this.peer !== undefined && this.accepting; }

    bind(peer: ControlPeer, accepting = true): void {
        if (this.peer !== undefined) throw new Error("Worker control is already connected");
        peer.setHandler(this.handler);
        peer.setEventHandler(this.onEvent);
        this.peer = peer;
        this.accepting = accepting;
        this.notifyConnectionWaiters();
    }

    unbind(peer: ControlPeer): void {
        if (this.peer === peer) { this.peer = undefined; this.accepting = false; }
    }

    activate(): void {
        if (this.peer !== undefined) this.accepting = true;
        this.notifyConnectionWaiters();
    }

    setHandler(handler: ControlHandler): void {
        this.handler = handler;
        this.peer?.setHandler(handler);
    }

    setEventHandler(handler: ControlEventHandler): void {
        this.onEvent = handler;
        this.peer?.setEventHandler(handler);
    }

    request<T>(method: string, args: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
        if (this.peer === undefined || (!this.accepting && method !== "ready" && method !== "attachment.restore"
            && method !== "attachment.abandon"
            && method !== "inbox.attach" && method !== "inbox.release")) {
            return Promise.reject(new HostConnectionClosedError(false));
        }
        return this.peer.request<T>(method, args, signal);
    }

    async requestReconnecting<T>(method: string, args: readonly unknown[], signal: AbortSignal): Promise<T> {
        let previous: ControlPeer | undefined;
        while (true) {
            const peer = await this.waitForPeer(previous, signal);
            try {
                return await peer.request<T>(method, args, signal);
            } catch (error) {
                signal.throwIfAborted();
                const code = (error as NodeJS.ErrnoException | undefined)?.code;
                if (!(error instanceof HostConnectionClosedError) && code !== "ECONNRESET" && code !== "EPIPE") throw error;
                previous = peer;
            }
        }
    }

    private waitForPeer(previous: ControlPeer | undefined, signal: AbortSignal): Promise<ControlPeer> {
        signal.throwIfAborted();
        const available = (): ControlPeer | undefined => this.accepting && this.peer !== previous ? this.peer : undefined;
        const current = available();
        if (current !== undefined) return Promise.resolve(current);
        return new Promise((resolve, reject) => {
            const cleanup = (): void => {
                this.connectionWaiters.delete(check);
                signal.removeEventListener("abort", abort);
            };
            const abort = (): void => { cleanup(); reject(signal.reason); };
            const check = (): void => {
                const peer = available();
                if (peer === undefined) return;
                cleanup();
                resolve(peer);
            };
            this.connectionWaiters.add(check);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            else check();
        });
    }

    private notifyConnectionWaiters(): void {
        for (const waiter of this.connectionWaiters) waiter();
    }

    event(event: string, value?: unknown): Promise<void> {
        if (this.peer === undefined) return Promise.reject(new HostConnectionClosedError(false));
        return this.peer.event(event, value);
    }
}
