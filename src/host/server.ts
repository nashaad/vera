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
    parseAttachedClientMessage,
    parseHostRequest,
    type HostIdentity,
} from "./protocol.ts";
import type { AgentAttachment, ResidentAgent } from "./resident-agent.ts";

const MAX_REQUEST_BYTES = 64 * 1_024;
const REQUEST_TIMEOUT_MS = 1_000;

export interface StartHostServerOptions {
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly findAgent?: (agentId: string) => ResidentAgent | undefined;
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
        receiveConnection(
            socket,
            identity,
            options.findAgent ?? (() => undefined),
        );
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

function receiveConnection(
    socket: Socket,
    identity: HostIdentity,
    findAgent: (agentId: string) => ResidentAgent | undefined,
): void {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const deadline = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    let attachment: AgentAttachment | undefined;
    let buffered = Buffer.alloc(0);
    let finished = false;
    let writes: Promise<void> = Promise.resolve();

    const send = (message: object): Promise<void> => {
        const next = writes.then(() => writeSocketMessage(socket, message));
        writes = next.catch(() => undefined);
        return next;
    };

    socket.once("close", () => {
        clearTimeout(deadline);
        attachment?.detach();
        attachment = undefined;
    });
    socket.once("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
        if (finished) {
            return;
        }
        buffered = Buffer.concat([buffered, chunk]);
        receiveLines();
    });

    function receiveLines(): void {
        while (!finished) {
            const newlineAt = buffered.indexOf(0x0a);
            if (newlineAt === -1) {
                if (buffered.length > MAX_REQUEST_BYTES) {
                    socket.destroy();
                }
                return;
            }
            if (newlineAt > MAX_REQUEST_BYTES) {
                socket.destroy();
                return;
            }
            const line = decode(buffered.subarray(0, newlineAt));
            buffered = buffered.subarray(newlineAt + 1);
            if (line === undefined) {
                socket.destroy();
                return;
            }
            receiveLine(line);
        }
    }

    function receiveLine(line: string): void {
        if (attachment === undefined) {
            receiveInitialRequest(line);
            return;
        }

        const message = parseAttachedClientMessage(line);
        if (message === undefined) {
            socket.destroy();
            return;
        }
        if (message.type === "detach") {
            finished = true;
            attachment.detach();
            attachment = undefined;
            void send({ type: "detached" }).then(
                () => socket.end(),
                () => socket.destroy(),
            );
            return;
        }
        try {
            attachment.send(message);
        } catch {
            socket.destroy();
        }
    }

    function receiveInitialRequest(line: string): void {
        const request = parseHostRequest(line);
        if (request?.type === "host_identity") {
            finished = true;
            void send({
                type: "host_identity",
                pid: identity.pid,
                started_at: identity.started_at,
            }).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type !== "attach") {
            socket.destroy();
            return;
        }

        let agent: ResidentAgent | undefined;
        try {
            agent = findAgent(request.agent_id);
        } catch {
            socket.destroy();
            return;
        }
        if (agent === undefined) {
            finished = true;
            void send({
                type: "attach_failed",
                agent_id: request.agent_id,
                reason: "not_found",
            }).then(() => socket.end(), () => socket.destroy());
            return;
        }

        if (agent.closed) {
            finished = true;
            void send({
                type: "attach_failed",
                agent_id: request.agent_id,
                reason: "unavailable",
            }).then(() => socket.end(), () => socket.destroy());
            return;
        }

        clearTimeout(deadline);
        let attached: AgentAttachment;
        try {
            attached = agent.attach();
        } catch {
            finished = true;
            void send({
                type: "attach_failed",
                agent_id: request.agent_id,
                reason: "unavailable",
            }).then(() => socket.end(), () => socket.destroy());
            return;
        }
        attachment = attached;
        void send({
            type: "attached",
            agent_id: agent.id,
            workspace: agent.workspace,
        }).then(
            () => forwardAgentUpdates(attached),
            () => socket.destroy(),
        );
    }

    async function forwardAgentUpdates(
        attached: AgentAttachment,
    ): Promise<void> {
        try {
            while (attachment === attached) {
                const update = await attached.receive();
                await send(update);
            }
        } catch {
            if (attachment === attached) {
                socket.destroy();
            }
        }
    }

    function decode(bytes: Buffer): string | undefined {
        try {
            return decoder.decode(bytes);
        } catch {
            return undefined;
        }
    }
}

function writeSocketMessage(socket: Socket, message: object): Promise<void> {
    if (socket.destroyed) {
        return Promise.reject(new Error("Host socket is closed"));
    }
    const flushed = socket.write(`${JSON.stringify(message)}\n`);
    if (flushed) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const cleanup = (): void => {
            socket.off("drain", onDrain);
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        const onDrain = (): void => {
            cleanup();
            resolve();
        };
        const onError = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const onClose = (): void => {
            cleanup();
            reject(new Error("Host socket is closed"));
        };
        socket.once("drain", onDrain);
        socket.once("error", onError);
        socket.once("close", onClose);
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
