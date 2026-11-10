import { Socket } from "node:net";

export interface ObservedAttachment {
    readonly id: string;
    readonly socketPath: string | undefined;
    readonly connection: number;
    readonly state: "attached" | "closed";
    readonly capabilities: readonly string[];
    readonly interactive: boolean;
}

export function observeAttachments(observer: (event: ObservedAttachment) => void): () => void {
    const paths = new WeakMap<Socket, string>();
    const originalConnect = Socket.prototype.connect;
    const originalWrite = Socket.prototype.write;
    let sequence = 0;
    Socket.prototype.connect = function(this: Socket, ...args: unknown[]): Socket {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const path = typeof first === "string" ? first
            : typeof first === "object" && first !== null && "path" in first ? first.path : undefined;
        if (typeof path === "string") paths.set(this, path);
        return Reflect.apply(originalConnect, this, args) as Socket;
    } as typeof Socket.prototype.connect;
    Socket.prototype.write = function(this: Socket, ...args: unknown[]): boolean {
        const chunk = args[0];
        if (typeof chunk === "string" && chunk.startsWith('{"type":"attach",')) {
            const value: unknown = JSON.parse(chunk);
            if (typeof value === "object" && value !== null && "agent_id" in value && typeof value.agent_id === "string") {
                const capabilities = "requested_capabilities" in value && Array.isArray(value.requested_capabilities)
                    && value.requested_capabilities.every((item: unknown) => typeof item === "string")
                    ? value.requested_capabilities as string[] : [];
                const interactive = "attachment_kind" in value && value.attachment_kind === "interactive";
                watchAttach(this, value.agent_id, paths.get(this), ++sequence, capabilities, interactive, observer);
            }
        }
        return Reflect.apply(originalWrite, this, args) as boolean;
    } as typeof Socket.prototype.write;
    return () => {
        Socket.prototype.connect = originalConnect;
        Socket.prototype.write = originalWrite;
    };
}

function watchAttach(
    socket: Socket,
    id: string,
    socketPath: string | undefined,
    connection: number,
    capabilities: readonly string[],
    interactive: boolean,
    observer: (event: ObservedAttachment) => void,
): void {
    const parts: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
        socket.off("data", onData);
        socket.off("close", cleanup);
    };
    const onData = (chunk: Buffer): void => {
        const newline = chunk.indexOf(10);
        const first = newline === -1 ? chunk : chunk.subarray(0, newline);
        bytes += first.length;
        if (bytes > 1_024 * 1_024) { cleanup(); return; }
        parts.push(first);
        if (newline === -1) return;
        cleanup();
        let response: unknown;
        try { response = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return; }
        if (typeof response !== "object" || response === null || !("type" in response)
            || response.type !== "attached" || !("agent_id" in response) || response.agent_id !== id) return;
        observer({ id, socketPath, connection, state: "attached", capabilities, interactive });
        socket.once("close", () => observer({ id, socketPath, connection, state: "closed", capabilities, interactive }));
    };
    socket.on("data", onData);
    socket.once("close", cleanup);
}
