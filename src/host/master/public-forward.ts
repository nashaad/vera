import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import { MAX_FRAME_BYTES } from "../connection.ts";
import { LineBuffer } from "../line-buffer.ts";
import { parseHostRequest, type HostRequest } from "../protocol.ts";
import type { ControlPeer } from "./control.ts";

type FrameSink = (frame: object) => Promise<void>;

export class ForwardedShutdowns {
    private readonly pending = new Set<Promise<void>>();

    async forward(request: HostRequest, run: () => Promise<void>): Promise<void> {
        if (request.type !== "shutdown_if_idle" && request.type !== "shutdown_for_replacement") {
            await run();
            return;
        }
        const done = Promise.withResolvers<void>();
        this.pending.add(done.promise);
        try {
            await run();
        } finally {
            this.pending.delete(done.promise);
            done.resolve();
        }
    }

    async wait(): Promise<void> {
        await Promise.all(this.pending);
    }
}

export function createPublicForwarder(peer: ControlPeer) {
    const sinks = new Map<string, FrameSink>();
    return {
        async forward(request: HostRequest, send: FrameSink, signal: AbortSignal): Promise<void> {
            const id = randomUUID();
            sinks.set(id, send);
            try {
                await peer.request("public.request", [id, request], signal);
            } finally {
                sinks.delete(id);
            }
        },
        async receiveFrame(args: readonly unknown[]): Promise<void> {
            const [id, frame] = args;
            const sink = typeof id === "string" ? sinks.get(id) : undefined;
            if (sink === undefined || typeof frame !== "object" || frame === null || Array.isArray(frame)) {
                throw new Error("Invalid forwarded host response");
            }
            await sink(frame);
        },
    };
}

export async function servePublicRequest(
    peer: ControlPeer,
    socketPath: string,
    args: readonly unknown[],
    signal: AbortSignal,
    shutdowns: ForwardedShutdowns,
): Promise<void> {
    const [id, value] = args;
    const encoded = JSON.stringify(value);
    const request = encoded === undefined ? undefined : parseHostRequest(encoded);
    if (typeof id !== "string" || id.length === 0 || request === undefined
        || request.type === "attach" || request.type === "branch_agent"
        || request.type === "commit_agent_branch") {
        throw new Error("Invalid forwarded host request");
    }
    await shutdowns.forward(request, () => forwardLocalRequest(socketPath, request, async (frame) => {
        await peer.request("public.frame", [id, frame], signal);
    }, signal));
}

export async function forwardLocalRequest(
    socketPath: string,
    request: HostRequest,
    send: FrameSink,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const abort = (): void => {
        socket.destroy(signal.reason instanceof Error ? signal.reason : new Error("Forwarded host request cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const lines = new LineBuffer({ maxLineBytes: MAX_FRAME_BYTES });
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });
        signal.throwIfAborted();
        socket.write(`${JSON.stringify(request)}\n`);
        for await (const chunk of socket) {
            lines.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            while (true) {
                const line = lines.next();
                if (line.kind === "need-more") break;
                if (line.kind === "oversized") throw new Error("Forwarded host response is too large");
                const frame: unknown = JSON.parse(line.bytes.toString("utf8"));
                if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
                    throw new Error("Invalid forwarded host response");
                }
                await send(frame);
            }
        }
        if (lines.bufferedBytes !== 0) throw new Error("Incomplete forwarded host response");
        signal.throwIfAborted();
        socket.end();
    } finally {
        signal.removeEventListener("abort", abort);
        socket.destroy();
    }
}
