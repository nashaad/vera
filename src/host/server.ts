import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
    createHostLockfile,
    defaultHostLockPath,
    defaultHostSocketPath,
    type HostLockRecord,
} from "./lockfile.ts";
import {
    HOST_PROTOCOL_VERSION,
    parseAttachedClientMessage,
    parseHostRequest,
    requestHostIdentity,
    type HostIdentity,
    type ShutdownIfIdleResponse,
} from "./protocol.ts";
import type {
    BranchedRegisteredAgent,
    BranchRegisteredAgentOptions,
    RegisteredAgentSummary,
} from "./agent-registry.ts";
import type { AgentAttachment, ResidentAgent } from "./resident-agent.ts";
import { acquireHostStartupClaim } from "./startup-claim.ts";

const MAX_REQUEST_BYTES = 64 * 1_024;
const REQUEST_TIMEOUT_MS = 1_000;

export interface StartHostServerOptions {
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly startupClaimPath?: string;
    readonly findAgent?: (agentId: string) => ResidentAgent | undefined;
    readonly listAgents?: () => readonly RegisteredAgentSummary[];
    readonly createAgent?: (workspace: string) => Promise<ResidentAgent>;
    readonly resumeAgent?: (sessionPath: string) => Promise<ResidentAgent>;
    readonly branchAgent?: (
        options: BranchRegisteredAgentOptions,
    ) => Promise<BranchedRegisteredAgent | undefined>;
    readonly trashSession?: (
        targetAgentId: string,
    ) => Promise<"trashed" | "busy" | "not_found" | "failed">;
    readonly canShutdown?: () => boolean;
    readonly onShutdownAccepted?: () => void | Promise<void>;
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
        protocol_version: HOST_PROTOCOL_VERSION,
    };
    const startupClaim = await acquireHostStartupClaim({
        path: options.startupClaimPath ?? `${socketPath}.starting`,
        pid: identity.pid,
    });
    const sockets = new Set<Socket>();
    let shutdownFenced = false;
    let activeAttachments = 0;
    let shutdownNotified = false;
    const requestShutdown = (
        requested: HostIdentity & { readonly requester_protocol_version: number },
    ): ShutdownIfIdleResponse => {
        if (
            requested.pid !== identity.pid
            || requested.started_at !== identity.started_at
        ) {
            return {
                type: "shutdown_if_idle_refused",
                reason: "identity_mismatch",
            };
        }
        if (requested.requester_protocol_version <= HOST_PROTOCOL_VERSION) {
            return {
                type: "shutdown_if_idle_refused",
                reason: "requester_not_newer",
            };
        }
        if (shutdownFenced) {
            return { type: "shutdown_if_idle_refused", reason: "busy" };
        }

        shutdownFenced = true;
        let idle = false;
        try {
            idle = activeAttachments === 0
                && (options.canShutdown?.() ?? true);
        } catch {
            idle = false;
        }
        if (!idle) {
            shutdownFenced = false;
            return { type: "shutdown_if_idle_refused", reason: "busy" };
        }
        return {
            type: "shutdown_if_idle_accepted",
            pid: identity.pid,
            started_at: identity.started_at,
        };
    };
    const attachmentOpened = (): (() => void) => {
        activeAttachments += 1;
        let closed = false;
        return (): void => {
            if (closed) {
                return;
            }
            closed = true;
            activeAttachments -= 1;
        };
    };
    const notifyShutdownAccepted = (): void => {
        if (shutdownNotified) {
            return;
        }
        shutdownNotified = true;
        void options.onShutdownAccepted?.();
    };
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        receiveConnection(
            socket,
            identity,
            options.findAgent ?? (() => undefined),
            options.listAgents ?? (() => []),
            options.createAgent ?? (() => Promise.reject(
                new Error("Agent creation is unavailable"),
            )),
            options.resumeAgent ?? (() => Promise.reject(
                new Error("Agent resume is unavailable"),
            )),
            options.branchAgent ?? (() => Promise.resolve(undefined)),
            options.trashSession ?? (() => Promise.resolve("not_found")),
            () => shutdownFenced,
            requestShutdown,
            attachmentOpened,
            notifyShutdownAccepted,
        );
    });
    try {
        await prepareSocketDirectory(socketPath);
        await listenAfterRemovingStaleSocket(server, socketPath);
        await chmod(socketPath, 0o600);
        const lock = await createHostLockfile({
            path: options.lockPath ?? defaultHostLockPath(),
            socketPath,
            pid: identity.pid,
            startedAt: identity.started_at,
        }).publish();
        await startupClaim.release();

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
        try {
            await startupClaim.release();
        } catch {
            // Preserve the startup error after making a best-effort release.
        }
        throw error;
    }
}

function receiveConnection(
    socket: Socket,
    identity: HostIdentity,
    findAgent: (agentId: string) => ResidentAgent | undefined,
    listAgents: () => readonly RegisteredAgentSummary[],
    createAgent: (workspace: string) => Promise<ResidentAgent>,
    resumeAgent: (sessionPath: string) => Promise<ResidentAgent>,
    branchAgent: (
        options: BranchRegisteredAgentOptions,
    ) => Promise<BranchedRegisteredAgent | undefined>,
    trashSession: (
        targetAgentId: string,
    ) => Promise<"trashed" | "busy" | "not_found" | "failed">,
    isShutdownFenced: () => boolean,
    requestShutdown: (
        identity: HostIdentity & { readonly requester_protocol_version: number },
    ) => ShutdownIfIdleResponse,
    attachmentOpened: () => () => void,
    notifyShutdownAccepted: () => void,
): void {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const deadline = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    let attachment: AgentAttachment | undefined;
    let buffered = Buffer.alloc(0);
    let finished = false;
    let writes: Promise<void> = Promise.resolve();
    let attachmentClosed: (() => void) | undefined;

    const send = (message: object): Promise<void> => {
        const next = writes.then(() => writeSocketMessage(socket, message));
        writes = next.catch(() => undefined);
        return next;
    };

    socket.once("close", () => {
        clearTimeout(deadline);
        attachment?.detach();
        attachment = undefined;
        attachmentClosed?.();
        attachmentClosed = undefined;
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
            finished = true;
            attachment.detach();
            attachment = undefined;
            void send({
                type: "protocol_error",
                reason: "unsupported_or_invalid_command",
            }).then(() => socket.end(), () => socket.destroy());
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
            clearTimeout(deadline);
            finished = true;
            void send({
                type: "host_identity",
                pid: identity.pid,
                started_at: identity.started_at,
                protocol_version: HOST_PROTOCOL_VERSION,
            }).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type === "shutdown_if_idle") {
            clearTimeout(deadline);
            finished = true;
            const response = requestShutdown({
                pid: request.pid,
                started_at: request.started_at,
                protocol_version: HOST_PROTOCOL_VERSION,
                requester_protocol_version:
                    request.requester_protocol_version,
            });
            void send(response).then(() => {
                if (response.type === "shutdown_if_idle_accepted") {
                    socket.once("close", notifyShutdownAccepted);
                }
                socket.end();
            }, () => socket.destroy());
            return;
        }
        if (request?.type === "list_agents") {
            clearTimeout(deadline);
            let agents: readonly RegisteredAgentSummary[];
            try {
                agents = listAgents();
            } catch {
                socket.destroy();
                return;
            }
            finished = true;
            void send({ type: "agent_list", agents }).then(
                () => socket.end(),
                () => socket.destroy(),
            );
            return;
        }
        if (isShutdownFenced()) {
            socket.destroy();
            return;
        }
        if (request?.type === "create_agent") {
            clearTimeout(deadline);
            finished = true;
            startAgent("create", () => createAgent(request.workspace));
            return;
        }
        if (request?.type === "resume_agent") {
            clearTimeout(deadline);
            finished = true;
            startAgent("resume", () => resumeAgent(request.session_path));
            return;
        }
        if (request?.type === "branch_agent") {
            clearTimeout(deadline);
            finished = true;
            void branchAgent({
                sourceId: request.source_agent_id,
                position: request.position,
                ...(request.entry_id === undefined
                    ? {}
                    : { entryId: request.entry_id }),
            }).then(
                (result) => result === undefined
                    ? send({ type: "agent_branch_failed" })
                    : send({
                        type: "agent_branched",
                        agent_id: result.agent.id,
                        workspace: result.agent.workspace,
                        ...(result.prompt === undefined
                            ? {}
                            : { prompt: result.prompt }),
                    }),
                () => send({ type: "agent_branch_failed" }),
            ).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type === "trash_session") {
            clearTimeout(deadline);
            finished = true;
            void trashSession(
                request.target_agent_id,
            ).then(
                (result) => result === "trashed"
                    ? send({
                        type: "session_trashed",
                        agent_id: request.target_agent_id,
                    })
                    : send({
                        type: "session_trash_rejected",
                        agent_id: request.target_agent_id,
                        reason: result,
                    }),
                () => send({
                    type: "session_trash_rejected",
                    agent_id: request.target_agent_id,
                    reason: "failed",
                }),
            ).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type !== "attach") {
            socket.destroy();
            return;
        }
        clearTimeout(deadline);

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
        attachmentClosed = attachmentOpened();
        void send({
            type: "attached",
            agent_id: agent.id,
            workspace: agent.workspace,
        }).then(
            () => forwardAgentUpdates(attached),
            () => socket.destroy(),
        );
    }

    function startAgent(
        operation: "create" | "resume",
        start: () => Promise<ResidentAgent>,
    ): void {
        void Promise.resolve().then(start).then(
            (agent) => send({
                type: "agent_ready",
                agent_id: agent.id,
                workspace: agent.workspace,
            }).then(() => socket.end(), () => socket.destroy()),
            () => send({ type: "agent_start_failed", operation }).then(
                () => socket.end(),
                () => socket.destroy(),
            ),
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

async function listenAfterRemovingStaleSocket(
    server: Server,
    socketPath: string,
): Promise<void> {
    try {
        await listen(server, socketPath);
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
            throw error;
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (await requestHostIdentity(socketPath) !== undefined) {
                throw error;
            }
        }
    }

    try {
        await unlink(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    await listen(server, socketPath);
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
