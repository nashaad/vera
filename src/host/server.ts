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
    CreateRegisteredAgentOptions,
    BranchedRegisteredAgent,
    BranchRegisteredAgentOptions,
    RegisteredAgentSummary,
    RenameSessionOutcome,
    RunOnceOptions,
    RunOnceResult,
} from "./agent-registry.ts";
import type { AgentAttachment, ResidentAgent } from "./resident-agent.ts";
import {
    backgroundAgentsSnapshot,
    sameBackgroundAgents,
    NO_BACKGROUND_AGENTS,
    type BackgroundAgentsSnapshot,
} from "./background-agents.ts";
import { acquireHostStartupClaim } from "./startup-claim.ts";
import {
    ExtensionCommandUnavailableError,
    InvalidExtensionCommandResultError,
    parseExtensionCommandResult,
    type ExtensionCommandDescriptor,
} from "../extensions/commands.ts";
import { ExtensionOperationTimeoutError } from "../extensions/operation.ts";
import { UserFacingError, userFacingMessage } from "../user-facing-error.ts";
import type { ScheduleOperation } from "../scheduler/types.ts";

const MAX_REQUEST_BYTES = 64 * 1_024;
const MAX_PENDING_EXTENSION_REQUESTS = 16;
const REQUEST_TIMEOUT_MS = 1_000;

export interface StartHostServerOptions {
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    /** Absolute path of the entrypoint this host was started from. */
    readonly entrypoint?: string;
    readonly startupClaimPath?: string;
    readonly findAgent?: (agentId: string) => ResidentAgent | undefined;
    readonly listAgents?: () => readonly RegisteredAgentSummary[];
    readonly runScheduleOperation?: (
        operation: ScheduleOperation,
    ) => Promise<Record<string, unknown>>;
    /**
     * Subscribe to registry changes, returning the unsubscribe.
     *
     * Attached clients are told about background work when it changes. Without
     * this every client would have to ask on a timer, which is what it used to
     * do, and the answer would be up to a tick stale on every screen.
     */
    readonly onRosterChanged?: (listener: () => void) => () => void;
    readonly createAgent?: (
        options: Pick<CreateRegisteredAgentOptions, "workspace" | "approvalMode">,
    ) => Promise<ResidentAgent>;
    readonly resumeAgent?: (sessionPath: string) => Promise<ResidentAgent>;
    readonly branchAgent?: (
        options: BranchRegisteredAgentOptions,
    ) => Promise<BranchedRegisteredAgent | undefined>;
    readonly trashSession?: (
        targetAgentId: string,
    ) => Promise<"trashed" | "busy" | "not_found" | "failed">;
    readonly renameSession?: (
        targetAgentId: string,
        name: string | null,
    ) => Promise<RenameSessionOutcome>;
    readonly listExtensionCommands?: () =>
        readonly ExtensionCommandDescriptor[];
    readonly runExtensionCommand?: (
        name: string,
        argumentsText: string,
        workspace: string,
        signal: AbortSignal,
    ) => Promise<unknown>;
    readonly runOnce?: (options: RunOnceOptions) => Promise<RunOnceResult>;
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
            options.runScheduleOperation ?? (() => Promise.reject(
                new UserFacingError("Scheduling is unavailable"),
            )),
            options.createAgent ?? (() => Promise.reject(
                new Error("Agent creation is unavailable"),
            )),
            options.resumeAgent ?? (() => Promise.reject(
                new Error("Agent resume is unavailable"),
            )),
            options.branchAgent ?? (() => Promise.resolve(undefined)),
            options.trashSession ?? (() => Promise.resolve("not_found")),
            options.renameSession
                ?? (() => Promise.resolve({ status: "not_found" })),
            options.runOnce ?? (() => Promise.reject(
                new Error("Bounded runs are unavailable"),
            )),
            options.listExtensionCommands ?? (() => []),
            options.runExtensionCommand ?? (() => Promise.reject(
                new Error("Extension commands are unavailable"),
            )),
            () => shutdownFenced,
            requestShutdown,
            attachmentOpened,
            notifyShutdownAccepted,
            options.onRosterChanged ?? (() => () => undefined),
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
            ...(options.entrypoint === undefined
                ? {}
                : { entrypoint: options.entrypoint }),
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
    runScheduleOperation: (
        operation: ScheduleOperation,
    ) => Promise<Record<string, unknown>>,
    createAgent: (
        options: Pick<CreateRegisteredAgentOptions, "workspace" | "approvalMode" | "ephemeral">,
    ) => Promise<ResidentAgent>,
    resumeAgent: (sessionPath: string) => Promise<ResidentAgent>,
    branchAgent: (
        options: BranchRegisteredAgentOptions,
    ) => Promise<BranchedRegisteredAgent | undefined>,
    trashSession: (
        targetAgentId: string,
    ) => Promise<"trashed" | "busy" | "not_found" | "failed">,
    renameSession: (
        targetAgentId: string,
        name: string | null,
    ) => Promise<RenameSessionOutcome>,
    runOnce: (options: RunOnceOptions) => Promise<RunOnceResult>,
    listExtensionCommands: () => readonly ExtensionCommandDescriptor[],
    runExtensionCommand: (
        name: string,
        argumentsText: string,
        workspace: string,
        signal: AbortSignal,
    ) => Promise<unknown>,
    isShutdownFenced: () => boolean,
    requestShutdown: (
        identity: HostIdentity & { readonly requester_protocol_version: number },
    ) => ShutdownIfIdleResponse,
    attachmentOpened: () => () => void,
    notifyShutdownAccepted: () => void,
    onRosterChanged: (listener: () => void) => () => void,
): void {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const deadline = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    let attachment: AgentAttachment | undefined;
    let buffered = Buffer.alloc(0);
    let finished = false;
    let writes: Promise<void> = Promise.resolve();
    let attachmentClosed: (() => void) | undefined;
    let attachedWorkspace: string | undefined;
    let stopWatchingRoster: (() => void) | undefined;
    let sentBackgroundAgents = NO_BACKGROUND_AGENTS;
    const extensionRequests = new Set<AbortController>();
    const extensionRequestIds = new Set<string>();

    const send = (
        message: object,
        shouldSend: () => boolean = () => true,
    ): Promise<void> => {
        const next = writes.then(() => {
            if (shouldSend()) {
                return writeSocketMessage(socket, message);
            }
        });
        writes = next.catch(() => undefined);
        return next;
    };

    socket.once("close", () => {
        clearTimeout(deadline);
        stopWatchingRoster?.();
        stopWatchingRoster = undefined;
        attachment?.detach();
        attachment = undefined;
        attachedWorkspace = undefined;
        for (const controller of extensionRequests) {
            controller.abort();
        }
        extensionRequests.clear();
        extensionRequestIds.clear();
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
            stopWatchingRoster?.();
            stopWatchingRoster = undefined;
            attachment.detach();
            attachment = undefined;
            attachedWorkspace = undefined;
            for (const controller of extensionRequests) {
                controller.abort();
            }
            extensionRequests.clear();
            extensionRequestIds.clear();
            void send({ type: "detached" }).then(
                () => socket.end(),
                () => socket.destroy(),
            );
            return;
        }
        if (message.type === "list_extension_commands") {
            if (
                extensionRequestIds.has(message.request_id)
                || extensionRequestIds.size >= MAX_PENDING_EXTENSION_REQUESTS
            ) {
                socket.destroy();
                return;
            }
            extensionRequestIds.add(message.request_id);
            let commands: readonly ExtensionCommandDescriptor[];
            try {
                commands = listExtensionCommands();
            } catch {
                void send({
                    type: "extension_command_failed",
                    request_id: message.request_id,
                    failure: {
                        source: "vera.extensions",
                        reason: "unavailable",
                        message: "Extension commands are unavailable",
                    },
                }, () =>
                    !finished
                    && extensionRequestIds.has(message.request_id)
                ).catch(() => socket.destroy()).finally(() => {
                    extensionRequestIds.delete(message.request_id);
                });
                return;
            }
            void send({
                type: "extension_command_list",
                request_id: message.request_id,
                commands,
            }, () =>
                !finished
                && extensionRequestIds.has(message.request_id)
            ).catch(() => socket.destroy()).finally(() => {
                extensionRequestIds.delete(message.request_id);
            });
            return;
        }
        if (message.type === "run_extension_command") {
            if (
                extensionRequestIds.has(message.request_id)
                || extensionRequestIds.size >= MAX_PENDING_EXTENSION_REQUESTS
            ) {
                socket.destroy();
                return;
            }
            extensionRequestIds.add(message.request_id);
            const workspace = attachedWorkspace;
            if (workspace === undefined) {
                socket.destroy();
                return;
            }
            const controller = new AbortController();
            extensionRequests.add(controller);
            let source = message.command;
            try {
                const descriptor = listExtensionCommands().find(
                    (command) => command.name === message.command,
                );
                if (descriptor !== undefined) {
                    source = `${descriptor.source}/${descriptor.name}`;
                }
            } catch {
                extensionRequests.delete(controller);
                void send({
                    type: "extension_command_failed",
                    request_id: message.request_id,
                    failure: {
                        source,
                        reason: "unavailable",
                        message: "Extension commands are unavailable",
                    },
                }, () =>
                    !finished
                    && extensionRequestIds.has(message.request_id)
                ).catch(() => socket.destroy()).finally(() => {
                    extensionRequestIds.delete(message.request_id);
                });
                return;
            }
            void Promise.resolve().then(() => runExtensionCommand(
                message.command,
                message.arguments_text,
                workspace,
                controller.signal,
            )).then(
                (value) => {
                    if (!finished) {
                        const result = parseExtensionCommandResult(value);
                        if (
                            result === undefined
                            || result.source !== source
                        ) {
                            return send({
                                type: "extension_command_failed",
                                request_id: message.request_id,
                                failure: {
                                    source,
                                    reason: "invalid_result",
                                    message:
                                        "Extension returned an invalid command result",
                                },
                            }, () =>
                                !finished
                                && extensionRequestIds.has(message.request_id)
                            );
                        }
                        return send({
                            type: "extension_command_result",
                            request_id: message.request_id,
                            result,
                        }, () =>
                            !finished
                            && extensionRequestIds.has(message.request_id)
                        );
                    }
                },
                (error) => {
                    if (!finished) {
                        return send({
                            type: "extension_command_failed",
                            request_id: message.request_id,
                            failure: extensionCommandFailure(
                                source,
                                error,
                            ),
                        }, () =>
                            !finished
                            && extensionRequestIds.has(message.request_id)
                        );
                    }
                },
            ).catch(() => socket.destroy()).finally(() => {
                extensionRequests.delete(controller);
                extensionRequestIds.delete(message.request_id);
            });
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
        if (request?.type === "schedule_operation") {
            clearTimeout(deadline);
            finished = true;
            void runScheduleOperation(request.operation).then(
                (result) => send({ type: "schedule_result", result }),
                (error) => send({
                    type: "schedule_failed",
                    reason: userFacingMessage(error) ?? "Schedule operation failed",
                }),
            ).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type === "create_agent") {
            clearTimeout(deadline);
            finished = true;
            startAgent("create", () => createAgent({
                workspace: request.workspace,
                ...(request.approval_mode === undefined
                    ? {}
                    : { approvalMode: request.approval_mode }),
                ...(request.lifetime === "ephemeral"
                    ? { ephemeral: true }
                    : {}),
            }));
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
        if (request?.type === "rename_session") {
            clearTimeout(deadline);
            finished = true;
            void renameSession(
                request.target_agent_id,
                request.name,
            ).then(
                (result) => result.status === "renamed"
                    ? send({
                        type: "session_renamed",
                        agent_id: request.target_agent_id,
                        name: result.name,
                    })
                    : send({
                        type: "session_rename_rejected",
                        agent_id: request.target_agent_id,
                        reason: result.status,
                    }),
                () => send({
                    type: "session_rename_rejected",
                    agent_id: request.target_agent_id,
                    reason: "failed",
                }),
            ).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type === "run_once") {
            // No request deadline: this connection is held for a whole turn,
            // and the timeout exists to drop a client that never speaks.
            clearTimeout(deadline);
            finished = true;
            void runOnce({
                workspace: request.workspace,
                prompt: request.prompt,
                ...(request.approval_mode === undefined
                    ? {}
                    : { approvalMode: request.approval_mode }),
                ...(request.model === undefined
                    ? {}
                    : { modelRef: request.model }),
                ...(request.effort === undefined
                    ? {}
                    : { reasoningEffort: request.effort }),
            }).then(
                (result) => send({
                    type: "run_once_finished",
                    agent_id: result.agentId,
                    session_path: result.sessionPath,
                    text: result.text,
                    outcome: result.outcome,
                    ...(result.error === undefined
                        ? {}
                        : { error: result.error }),
                    ...(result.notes.length === 0
                        ? {}
                        : { notes: result.notes }),
                }),
                (error: unknown) => send({
                    type: "run_once_failed",
                    ...reasonOf(error),
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
        attachedWorkspace = agent.workspace;
        attachmentClosed = attachmentOpened();
        const attachedId = agent.id;
        sentBackgroundAgents = readBackgroundAgents(attachedId);
        stopWatchingRoster = onRosterChanged(
            () => sendBackgroundAgents(attachedId),
        );
        void send({
            type: "attached",
            agent_id: attachedId,
            workspace: agent.workspace,
            background_agents: sentBackgroundAgents,
        }).then(
            () => forwardAgentUpdates(attached),
            () => socket.destroy(),
        );
    }

    function readBackgroundAgents(
        attachedAgentId: string,
    ): BackgroundAgentsSnapshot {
        try {
            return backgroundAgentsSnapshot(listAgents(), attachedAgentId);
        } catch {
            return NO_BACKGROUND_AGENTS;
        }
    }

    /**
     * Send the background-agent facts, unless the client already has them.
     *
     * The registry reports that something changed, not what: most changes it
     * reports say nothing about background work, and re-sending an identical
     * snapshot would make every client repaint for nothing.
     */
    function sendBackgroundAgents(attachedAgentId: string): void {
        if (finished || attachment === undefined) {
            return;
        }
        const next = readBackgroundAgents(attachedAgentId);
        if (sameBackgroundAgents(next, sentBackgroundAgents)) {
            return;
        }
        sentBackgroundAgents = next;
        void send({
            type: "background_agents",
            running: next.running,
            children: next.children,
            has_parent: next.has_parent,
        }, () => !finished && attachment !== undefined)
            .catch(() => socket.destroy());
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
            (error: unknown) => send({
                type: "agent_start_failed",
                operation,
                // A missing credential is the common failure here, and its
                // message already names the provider and the way to fix it.
                // Anything else stays generic.
                ...reasonOf(error),
            }).then(
                () => socket.end(),
                () => socket.destroy(),
            ),
        );
    }

    function reasonOf(error: unknown): { readonly reason?: string } {
        const reason = userFacingMessage(error);
        return reason === undefined ? {} : { reason };
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

function extensionCommandFailure(
    command: string,
    error: unknown,
): {
    readonly source: string;
    readonly reason:
        | "unavailable"
        | "handler_failed"
        | "timeout"
        | "cancelled"
        | "invalid_result";
    readonly message: string;
} {
    const message = error instanceof Error ? error.message : String(error);
    let reason:
        | "unavailable"
        | "handler_failed"
        | "timeout"
        | "cancelled"
        | "invalid_result" = "handler_failed";
    if (error instanceof Error && error.name === "AbortError") {
        reason = "cancelled";
    } else if (error instanceof ExtensionOperationTimeoutError) {
        reason = "timeout";
    } else if (error instanceof ExtensionCommandUnavailableError) {
        reason = "unavailable";
    } else if (error instanceof InvalidExtensionCommandResultError) {
        reason = "invalid_result";
    }
    return {
        source: command,
        reason,
        message,
    };
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
