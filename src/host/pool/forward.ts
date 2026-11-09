import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { MAX_FRAME_BYTES } from "../connection.ts";

export function forwardSessionConnection(
    client: Socket,
    socketPath: string,
    firstLine: string,
    followLocationChange = false,
): Promise<Socket> {
    if (followLocationChange) return forwardWithRedirect(client, socketPath, firstLine);
    return new Promise((resolve, reject) => {
        const upstream = createConnection(socketPath);
        const timer = setTimeout(() => upstream.destroy(new Error("Worker connection timed out")), 5_000);
        let connected = false;
        const clientClosed = (): void => {
            upstream.destroy();
            if (!connected) fail(new Error("Client disconnected"));
        };
        client.once("close", clientClosed);
        client.once("end", clientClosed);
        upstream.once("error", fail);
        upstream.once("connect", () => {
            connected = true;
            clearTimeout(timer);
            upstream.off("error", fail);
            upstream.on("error", () => client.destroy());
            upstream.once("close", () => {
                client.removeListener("close", clientClosed);
                client.removeListener("end", clientClosed);
                if (!upstream.readableEnded) client.destroy();
            });
            upstream.pipe(client);
            upstream.write(`${firstLine}\n`);
            resolve(upstream);
        });
        function fail(error: Error): void {
            clearTimeout(timer);
            client.removeListener("close", clientClosed);
            client.removeListener("end", clientClosed);
            upstream.destroy();
            reject(error);
        }
    });
}

async function forwardWithRedirect(client: Socket, socketPath: string, firstLine: string): Promise<Socket> {
    let upstream: Socket | undefined;
    const clientClosed = (): void => { upstream?.destroy(); };
    client.once("close", clientClosed);
    client.once("end", clientClosed);
    try {
        let destination = socketPath;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (client.destroyed || client.readableEnded) throw new Error("Client disconnected");
            upstream = createConnection(destination);
            const initial = await readInitialResponse(upstream, firstLine);
            if (attempt === 0 && initial.redirect !== undefined) {
                destination = initial.redirect;
                upstream.destroy();
                upstream = undefined;
                continue;
            }
            if (client.destroyed || client.readableEnded) throw new Error("Client disconnected");
            const connected = upstream;
            connected.on("error", () => client.destroy());
            connected.once("close", () => {
                client.removeListener("close", clientClosed);
                client.removeListener("end", clientClosed);
                if (!connected.readableEnded) client.destroy();
            });
            client.write(initial.bytes);
            connected.pipe(client);
            connected.resume();
            return connected;
        }
        throw new Error("Session location changed repeatedly");
    } catch (error) {
        client.removeListener("close", clientClosed);
        client.removeListener("end", clientClosed);
        upstream?.destroy();
        throw error;
    }
}

function readInitialResponse(socket: Socket, firstLine: string): Promise<{ bytes: Buffer; redirect?: string }> {
    return new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        const timer = setTimeout(() => socket.destroy(new Error("Worker connection timed out")), 5_000);
        const fail = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const closed = (): void => fail(new Error("Worker connection closed"));
        const connected = (): void => {
            clearTimeout(timer);
            socket.write(`${firstLine}\n`);
        };
        const data = (chunk: Buffer): void => {
            bytes = Buffer.concat([bytes, chunk]);
            const newline = bytes.indexOf(0x0a);
            if (newline < 0) {
                if (bytes.length > MAX_FRAME_BYTES) fail(new Error("Worker response is too large"));
                return;
            }
            if (newline > MAX_FRAME_BYTES) {
                fail(new Error("Worker response is too large"));
                return;
            }
            socket.pause();
            cleanup();
            let redirect: string | undefined;
            try {
                const frame: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
                if (typeof frame === "object" && frame !== null && !Array.isArray(frame)) {
                    const record = frame as Record<string, unknown>;
                    if (record.type === "agent_location_changed" && typeof record.socket_path === "string"
                        && isAbsolute(record.socket_path)) redirect = record.socket_path;
                }
            } catch {
            }
            resolve({ bytes, ...(redirect === undefined ? {} : { redirect }) });
        };
        function cleanup(): void {
            clearTimeout(timer);
            socket.off("connect", connected);
            socket.off("data", data);
            socket.off("error", fail);
            socket.off("close", closed);
        }
        socket.once("connect", connected);
        socket.on("data", data);
        socket.once("error", fail);
        socket.once("close", closed);
    });
}
