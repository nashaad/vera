import { randomUUID } from "node:crypto";

import { ProviderUnavailableError, UserFacingError } from "../../user-facing-error.ts";
import type { HostConnection } from "../connection.ts";

interface ControlArgument {
    readonly value?: unknown;
}

interface ControlError {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly provider?: string;
}

interface PendingRequest {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
    readonly cleanup: () => void;
}

interface IncomingRequest {
    readonly controller: AbortController;
    cancelled: boolean;
}

export type ControlHandler = (method: string, args: readonly unknown[], signal: AbortSignal) => Promise<unknown>;
export type ControlEventHandler = (event: string, value: unknown) => void;

export class ControlPeer {
    private readonly pending = new Map<string, PendingRequest>();
    private readonly incoming = new Map<string, IncomingRequest>();
    private handler: ControlHandler = async () => { throw new Error("Control request is unavailable"); };
    private onEvent: ControlEventHandler = () => {};
    private readonly done = Promise.withResolvers<void>();

    constructor(private readonly connection: HostConnection) {
        void this.receive();
    }

    setHandler(handler: ControlHandler): void { this.handler = handler; }
    setEventHandler(handler: ControlEventHandler): void { this.onEvent = handler; }
    get closed(): Promise<void> { return this.done.promise; }

    request<T>(method: string, args: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(signal.reason);
        const id = randomUUID();
        return new Promise<T>((resolve, reject) => {
            const abort = (): void => {
                if (!this.pending.delete(id)) return;
                cleanup();
                reject(signal?.reason ?? new DOMException("Control request aborted", "AbortError"));
                void this.connection.send({ type: "cancel", id }).catch(() => {});
            };
            const cleanup = (): void => signal?.removeEventListener("abort", abort);
            this.pending.set(id, { resolve: (value) => resolve(value as T), reject, cleanup });
            signal?.addEventListener("abort", abort, { once: true });
            const encoded: ControlArgument[] = args.map((value) => value === undefined ? {} : { value });
            void this.connection.send({ type: "request", id, method, args: encoded }).catch((error: unknown) => {
                const pending = this.pending.get(id);
                if (pending === undefined) return;
                this.pending.delete(id);
                pending.cleanup();
                pending.reject(error);
            });
            if (signal?.aborted) abort();
        });
    }

    event(event: string, value?: unknown): Promise<void> {
        return this.connection.send({ type: "event", event, value });
    }

    close(): void { this.connection.close(); }

    private async receive(): Promise<void> {
        try {
            while (true) this.dispatch(await this.connection.receive());
        } catch (error) {
            this.connection.close();
            for (const pending of this.pending.values()) {
                pending.cleanup();
                pending.reject(error);
            }
            this.pending.clear();
            for (const request of this.incoming.values()) {
                request.cancelled = true;
                request.controller.abort(error);
            }
            this.incoming.clear();
            this.done.resolve();
        }
    }

    private dispatch(value: unknown): void {
        const frame = record(value);
        if (frame?.type === "response" && typeof frame.id === "string") {
            const pending = this.pending.get(frame.id);
            if (pending === undefined) return;
            this.pending.delete(frame.id);
            pending.cleanup();
            if (frame.error === undefined) pending.resolve(frame.value);
            else pending.reject(decodeError(frame.error));
            return;
        }
        if (frame?.type === "cancel" && typeof frame.id === "string") {
            const incoming = this.incoming.get(frame.id);
            if (incoming !== undefined) {
                this.incoming.delete(frame.id);
                incoming.cancelled = true;
                incoming.controller.abort(new DOMException("Control request aborted", "AbortError"));
            }
            return;
        }
        if (frame?.type === "event" && typeof frame.event === "string") {
            this.onEvent(frame.event, frame.value);
            return;
        }
        if (frame?.type !== "request" || typeof frame.id !== "string" || typeof frame.method !== "string"
            || !Array.isArray(frame.args) || this.incoming.has(frame.id)) {
            throw new Error("Invalid control message");
        }
        const args = frame.args.map((item) => {
            const argument = record(item);
            if (argument === undefined) throw new Error("Invalid control argument");
            return argument.value;
        });
        const id = frame.id;
        const request: IncomingRequest = { controller: new AbortController(), cancelled: false };
        this.incoming.set(id, request);
        void Promise.resolve().then(() => this.handler(frame.method as string, args, request.controller.signal)).then(
            (result) => this.respond(id, request, { value: result }),
            (error: unknown) => this.respond(id, request, { error: encodeError(error) }),
        );
    }

    private async respond(id: string, request: IncomingRequest, result: { value?: unknown; error?: ControlError }): Promise<void> {
        if (request.cancelled) return;
        this.incoming.delete(id);
        await this.connection.send({ type: "response", id, ...result }).catch(() => {});
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

function encodeError(error: unknown): ControlError {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
        name, message,
        ...(typeof code === "string" ? { code } : {}),
        ...(error instanceof ProviderUnavailableError ? { provider: error.provider } : {}),
    };
}

function decodeError(value: unknown): Error {
    const data = record(value);
    if (data === undefined || typeof data.message !== "string" || typeof data.name !== "string") {
        return new Error("Invalid control error");
    }
    const error = data.name === "ProviderUnavailableError" && typeof data.provider === "string"
        ? new ProviderUnavailableError(data.provider)
        : data.name === "UserFacingError" ? new UserFacingError(data.message) : new Error(data.message);
    error.name = data.name;
    if (typeof data.code === "string") (error as NodeJS.ErrnoException).code = data.code;
    return error;
}
