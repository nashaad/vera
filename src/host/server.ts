import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
    createHostLockfile,
    defaultHostLockPath,
    defaultHostSocketPath,
    type HostLockRecord,
} from "./lockfile.ts";
import {
    encodeHostResponse,
    parseHostRequest,
    type HostIdentity,
} from "./protocol.ts";

const MAX_REQUEST_BYTES = 64 * 1_024;
const REQUEST_TIMEOUT_MS = 1_000;

export interface StartHostServerOptions {
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
}

export interface HostServer {
    readonly identity: HostIdentity;
    readonly lock: HostLockRecord;
    readonly socketPath: string;
    close(): Promise<void>;
}

export async function startHostServer(
    options: StartHostServerOptions = {},
): Promise<HostServer> {
    const socketPath = options.socketPath ?? defaultHostSocketPath();
    const identity: HostIdentity = {
        pid: options.pid ?? process.pid,
        started_at: options.startedAt ?? currentProcessStartedAt(),
    };
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        receiveRequest(socket, identity);
    });
    await prepareSocketDirectory(socketPath);
    try {
        await listen(server, socketPath);
        await chmod(socketPath, 0o600);
        const lock = await createHostLockfile({
            path: options.lockPath ?? defaultHostLockPath(),
            socketPath,
            pid: identity.pid,
            startedAt: identity.started_at,
        }).publish();

        return {
            identity,
            lock,
            socketPath,
            async close(): Promise<void> {
                for (const socket of sockets) {
                    socket.destroy();
                }
                await closeServer(server);
            },
        };
    } catch (error) {
        for (const socket of sockets) {
            socket.destroy();
        }
        await closeServer(server);
        throw error;
    }
}

function receiveRequest(socket: Socket, identity: HostIdentity): void {
    socket.setEncoding("utf8");
    const deadline = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    socket.once("close", () => clearTimeout(deadline));
    socket.once("error", () => socket.destroy());
    let buffered = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
        if (handled) {
            return;
        }
        buffered += chunk;
        if (Buffer.byteLength(buffered) > MAX_REQUEST_BYTES) {
            socket.destroy();
            return;
        }
        const newline = buffered.indexOf("\n");
        if (newline === -1) {
            return;
        }
        handled = true;
        const request = parseHostRequest(buffered.slice(0, newline));
        if (request?.type === "host_identity") {
            socket.end(encodeHostResponse({
                type: "host_identity",
                pid: identity.pid,
                started_at: identity.started_at,
            }));
            return;
        }
        socket.destroy();
    });
}

function listen(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
    });
}

function closeServer(server: Server): Promise<void> {
    if (!server.listening) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });
}

async function prepareSocketDirectory(socketPath: string): Promise<void> {
    const directory = dirname(socketPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (socketPath === defaultHostSocketPath()) {
        await chmod(directory, 0o700);
    }
}

function currentProcessStartedAt(): string {
    return new Date(Date.now() - process.uptime() * 1_000).toISOString();
}
