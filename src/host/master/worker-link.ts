import type { ControlChannel, ControlEventHandler, ControlHandler, ControlPeer } from "./control.ts";
import { HostConnectionClosedError } from "../connection.ts";

export class WorkerControlLink implements ControlChannel {
    private peer?: ControlPeer;
    private accepting = false;
    private handler: ControlHandler = async () => { throw new Error("Control request is unavailable"); };
    private onEvent: ControlEventHandler = () => {};

    get connected(): boolean { return this.peer !== undefined && this.accepting; }

    bind(peer: ControlPeer, accepting = true): void {
        if (this.peer !== undefined) throw new Error("Worker control is already connected");
        peer.setHandler(this.handler);
        peer.setEventHandler(this.onEvent);
        this.peer = peer;
        this.accepting = accepting;
    }

    unbind(peer: ControlPeer): void {
        if (this.peer === peer) { this.peer = undefined; this.accepting = false; }
    }

    activate(): void { if (this.peer !== undefined) this.accepting = true; }

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

    event(event: string, value?: unknown): Promise<void> {
        if (this.peer === undefined) return Promise.reject(new HostConnectionClosedError(false));
        return this.peer.event(event, value);
    }
}
