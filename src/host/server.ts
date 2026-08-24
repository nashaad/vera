import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
    createHostLockfile,
    defaultHostLockPath,
    defaultHostSocketPath,
    readHostLockRecordFile,
    type HostLockRecord,
} from "./lockfile.ts";
import type { SessionFactName } from "../store/session-facts.ts";
import { pageSessionListing } from "./session-listing.ts";
import {
    processIsAlive,
    recordMatchesRunningProcess,
} from "./process-identity.ts";
import {
    HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
    HOST_PROTOCOL_VERSION,
    parseAttachedClientMessage,
    parseHostRequest,
    requestHostIdentity,
    type HostIdentity,
    type ShutdownIfIdleResponse,
    type ShutdownForReplacementResponse,
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
import {
    EMPTY_WORK_INDEX,
    sameWorkIndex,
    type WorkIndexSnapshot,
} from "./work-index.ts";
import type {
    SessionSearchQuery,
    SessionSearchResults,
} from "../store/session-search.ts";
import { acquireHostStartupClaim } from "./startup-claim.ts";
import {
    ExtensionCommandUnavailableError,
    InvalidExtensionCommandResultError,
    parseExtensionCommandResult,
    type ExtensionCommandDescriptor,
} from "../extensions/commands.ts";
import { ExtensionOperationTimeoutError } from "../extensions/operation.ts";
import {
    ProviderUnavailableError,
    UserFacingError,
    userFacingMessage,
} from "../user-facing-error.ts";
import type { ScheduleOperation } from "../scheduler/types.ts";
import {
    HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
    HOST_CAPABILITY_AGENT_ATTACH_RESUME,
    HOST_CAPABILITY_AGENT_BRANCH_COMPACTION_BARRIERS,
    HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES,
    HOST_CAPABILITY_AGENT_BRANCH_OPTIONS,
    HOST_CAPABILITY_AGENT_CONTEXT_SYNC,
    HOST_CAPABILITY_WORK_INDEX,
    negotiateHostCapabilities,
    parseHostCapabilities,
} from "./capabilities.ts";
import { MAX_FRAME_BYTES } from "./connection.ts";
import {
    InteractiveAttachmentRegistry,
    type InteractiveAttachmentLease,
} from "./interactive-attachments.ts";

// Both directions share one ceiling: a client that may send a frame this
// large must not meet a server that silently drops it at a smaller one.
const MAX_REQUEST_BYTES = MAX_FRAME_BYTES;
const MAX_PENDING_EXTENSION_REQUESTS = 16;
// Idle time, not elapsed time: a frame carrying a large transcript or an
// attachment streams for longer than this and must not be mistaken for a
// stalled client. The ceiling below still bounds a client that dribbles bytes
// slowly enough to stay under the idle timer forever.
const REQUEST_TIMEOUT_MS = 1_000;
const REQUEST_CEILING_MS = 60_000;
const INTERACTIVE_DISCONNECT_GRACE_MS = 6_000;

/**
 * What the host made of a close request.
 *
 * `sessionRetained` is only meaningful when the close succeeded, and is absent
 * for a close that never reached an agent.
 */
export interface CloseAgentOutcome {
    readonly status: "closed" | "not_found" | "not_owned" | "failed";
    readonly sessionRetained?: boolean;
}

export interface StartHostServerOptions {
    readonly socketPath?: string;
    readonly lockPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    /** Absolute path of the entrypoint this host was started from. */
    readonly entrypoint?: string;
    /** Project whose project-scoped extensions this host loaded. */
    readonly projectRoot?: string;
    readonly startupClaimPath?: string;
    readonly capabilities?: readonly string[];
    /**
     * Frame ceiling and request timers. Present so tests can drive the
     * refusal paths without moving tens of megabytes or waiting a minute.
     */
    readonly limits?: {
        readonly maxRequestBytes?: number;
        readonly requestIdleMs?: number;
        readonly requestCeilingMs?: number;
        readonly interactiveDisconnectGraceMs?: number;
    };
    readonly findAgent?: (
        agentId: string,
    ) => ResidentAgent | undefined | Promise<ResidentAgent | undefined>;
    /** Root plus every live owned descendant, used by stop-if-last. */
    readonly readAgentTree?: (rootAgentId: string) => readonly string[];
    readonly listAgents?: () =>
        | readonly RegisteredAgentSummary[]
        | Promise<readonly RegisteredAgentSummary[]>;
    /**
     * Fills in the optional facts named by `include`, for one page of rows.
     * Injected rather than computed here: the server knows how to page a
     * listing, not how to read a session file or resolve a context window.
     */
    readonly readSessionFacts?: (
        sessions: readonly RegisteredAgentSummary[],
        include: readonly SessionFactName[],
    ) => Promise<readonly RegisteredAgentSummary[]>;
    readonly listBackgroundAgents?: () => readonly RegisteredAgentSummary[];
    /**
     * The machine-wide work inbox as it stands now.
     *
     * Read on attach and again whenever the roster changes, never stored: the
     * index is a projection of live host state, so the only correct copy is
     * the one taken at the moment a client is told.
     */
    readonly readWorkIndex?: () => WorkIndexSnapshot;
    /**
     * Scan the transcripts on disk. Absent when the host has no session
     * directory, which answers `unavailable` rather than an empty result: a
     * client must not tell someone their past holds nothing when it was never
     * looked at.
     */
    readonly searchSessions?: (
        query: SessionSearchQuery,
    ) => Promise<SessionSearchResults>;
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
        options: Pick<
            CreateRegisteredAgentOptions,
            "workspace" | "approvalMode" | "ephemeral" | "startupProfile"
        >,
    ) => Promise<ResidentAgent>;
    readonly resumeAgent?: (sessionPath: string) => Promise<ResidentAgent>;
    readonly branchAgent?: (
        options: BranchRegisteredAgentOptions,
    ) => Promise<BranchedRegisteredAgent | undefined>;
    readonly discardBranch?: (agentId: string) => Promise<void>;
    readonly commitBranch?: (agentId: string) => boolean;
    readonly syncAgentContext?: (agentId: string) => Promise<{
        readonly status:
            | "synced"
            | "unchanged"
            | "busy"
            | "stale_cursor"
            | "not_found";
        readonly turns: number;
    }>;
    readonly trashSession?: (
        targetAgentId: string,
    ) => Promise<"trashed" | "busy" | "not_found" | "failed">;
    readonly closeAgent?: (
        targetAgentId: string,
    ) => Promise<CloseAgentOutcome>;
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
    readonly canReplace?: () => boolean;
    readonly onShutdownAccepted?: () => void | Promise<void>;
    readonly onAgentStartFailure?: (
        operation: "create" | "resume",
        error: unknown,
    ) => void;
}

export interface HostServer {
    readonly identity: HostIdentity;
    readonly lock: HostLockRecord;
    readonly socketPath: string;
    close(): Promise<void>;
}

interface HostLimits {
    readonly maxRequestBytes: number;
    readonly requestIdleMs: number;
    readonly requestCeilingMs: number;
    readonly interactiveDisconnectGraceMs: number;
}

function resolveHostLimits(
    limits: StartHostServerOptions["limits"],
): HostLimits {
    return {
        maxRequestBytes: limits?.maxRequestBytes ?? MAX_REQUEST_BYTES,
        requestIdleMs: limits?.requestIdleMs ?? REQUEST_TIMEOUT_MS,
        requestCeilingMs: limits?.requestCeilingMs ?? REQUEST_CEILING_MS,
        interactiveDisconnectGraceMs: limits?.interactiveDisconnectGraceMs
            ?? INTERACTIVE_DISCONNECT_GRACE_MS,
    };
}

export async function startHostServer(
    options: StartHostServerOptions = {},
): Promise<HostServer> {
    const socketPath = options.socketPath ?? defaultHostSocketPath();
    const capabilities = parseHostCapabilities(options.capabilities ?? []);
    if (capabilities === undefined) {
        throw new Error("Host capabilities are invalid");
    }
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
    const interactiveAttachments = new InteractiveAttachmentRegistry();
    let shutdownFenced = false;
    let activeAttachments = 0;
    let activeServerOperations = 0;
    let shutdownNotified = false;
    const operationOpened = (): (() => void) => {
        activeServerOperations += 1;
        let closed = false;
        return (): void => {
            if (closed) return;
            closed = true;
            activeServerOperations -= 1;
        };
    };
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
    const requestReplacement = (
        requested: HostIdentity & { readonly requester_protocol_version: number },
    ): ShutdownForReplacementResponse => {
        if (
            requested.pid !== identity.pid
            || requested.started_at !== identity.started_at
        ) {
            return {
                type: "shutdown_for_replacement_refused",
                reason: "identity_mismatch",
            };
        }
        if (requested.requester_protocol_version <= HOST_PROTOCOL_VERSION) {
            return {
                type: "shutdown_for_replacement_refused",
                reason: "requester_not_newer",
            };
        }
        if (shutdownFenced || activeServerOperations > 0) {
            return { type: "shutdown_for_replacement_refused", reason: "busy" };
        }
        let replaceable = false;
        try {
            replaceable = options.canReplace?.() ?? false;
        } catch {
            replaceable = false;
        }
        if (!replaceable) {
            return { type: "shutdown_for_replacement_refused", reason: "busy" };
        }
        shutdownFenced = true;
        return {
            type: "shutdown_for_replacement_accepted",
            pid: identity.pid,
            started_at: identity.started_at,
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
            capabilities,
            options.findAgent ?? (() => undefined),
            options.listAgents ?? (() => []),
            options.readSessionFacts ?? ((sessions) => Promise.resolve(sessions)),
            options.listBackgroundAgents ?? (() => {
                const agents = options.listAgents?.();
                return Array.isArray(agents) ? agents : [];
            }),
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
            options.discardBranch ?? (() => Promise.resolve()),
            options.commitBranch ?? (() => false),
            options.syncAgentContext ?? (() => Promise.resolve({
                status: "not_found" as const,
                turns: 0,
            })),
            options.trashSession ?? (() => Promise.resolve("not_found")),
            options.closeAgent
                ?? (() => Promise.resolve({ status: "not_found" as const })),
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
            requestReplacement,
            attachmentOpened,
            operationOpened,
            notifyShutdownAccepted,
            options.onRosterChanged ?? (() => () => undefined),
            options.onAgentStartFailure ?? (() => undefined),
            options.readWorkIndex ?? (() => EMPTY_WORK_INDEX),
            options.searchSessions,
            interactiveAttachments,
            options.readAgentTree ?? ((agentId) => [agentId]),
            resolveHostLimits(options.limits),
        );
    });
    try {
        await prepareSocketDirectory(socketPath);
        await listenAfterRemovingStaleSocket(
            server,
            socketPath,
            options.lockPath ?? defaultHostLockPath(),
        );
        await chmod(socketPath, 0o600);
        const lock = await createHostLockfile({
            path: options.lockPath ?? defaultHostLockPath(),
            socketPath,
            pid: identity.pid,
            startedAt: identity.started_at,
            ...(options.entrypoint === undefined
                ? {}
                : { entrypoint: options.entrypoint }),
            ...(options.projectRoot === undefined
                ? {}
                : { projectRoot: options.projectRoot }),
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
    capabilities: readonly string[],
    findAgent: (
        agentId: string,
    ) => ResidentAgent | undefined | Promise<ResidentAgent | undefined>,
    listAgents: () =>
        | readonly RegisteredAgentSummary[]
        | Promise<readonly RegisteredAgentSummary[]>,
    readSessionFacts: (
        sessions: readonly RegisteredAgentSummary[],
        include: readonly SessionFactName[],
    ) => Promise<readonly RegisteredAgentSummary[]>,
    listBackgroundAgents: () => readonly RegisteredAgentSummary[],
    runScheduleOperation: (
        operation: ScheduleOperation,
    ) => Promise<Record<string, unknown>>,
    createAgent: (
        options: Pick<
            CreateRegisteredAgentOptions,
            "workspace" | "approvalMode" | "ephemeral" | "startupProfile"
        >,
    ) => Promise<ResidentAgent>,
    resumeAgent: (sessionPath: string) => Promise<ResidentAgent>,
    branchAgent: (
        options: BranchRegisteredAgentOptions,
    ) => Promise<BranchedRegisteredAgent | undefined>,
    discardBranch: (agentId: string) => Promise<void>,
    commitBranch: (agentId: string) => boolean,
    syncAgentContext: (agentId: string) => Promise<{
        readonly status:
            | "synced"
            | "unchanged"
            | "busy"
            | "stale_cursor"
            | "not_found";
        readonly turns: number;
    }>,
    trashSession: (
        targetAgentId: string,
    ) => Promise<"trashed" | "busy" | "not_found" | "failed">,
    closeAgent: (
        targetAgentId: string,
    ) => Promise<CloseAgentOutcome>,
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
    requestReplacement: (
        identity: HostIdentity & { readonly requester_protocol_version: number },
    ) => ShutdownForReplacementResponse,
    attachmentOpened: () => () => void,
    operationOpened: () => () => void,
    notifyShutdownAccepted: () => void,
    onRosterChanged: (listener: () => void) => () => void,
    onAgentStartFailure: (
        operation: "create" | "resume",
        error: unknown,
    ) => void,
    readWorkIndex: () => WorkIndexSnapshot,
    searchSessions:
        | ((query: SessionSearchQuery) => Promise<SessionSearchResults>)
        | undefined,
    interactiveAttachments: InteractiveAttachmentRegistry,
    readAgentTree: (rootAgentId: string) => readonly string[],
    limits: HostLimits,
): void {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // Armed while a request is still arriving. The idle timer restarts on
    // every chunk so a large frame streams freely; the ceiling is what a
    // client dribbling bytes under the idle timer eventually hits.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    function armDeadline(): void {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => socket.destroy(), limits.requestIdleMs);
        ceilingTimer ??= setTimeout(
            () => socket.destroy(),
            limits.requestCeilingMs,
        );
    }
    function clearDeadline(): void {
        clearTimeout(idleTimer);
        idleTimer = undefined;
        clearTimeout(ceilingTimer);
        ceilingTimer = undefined;
    }
    armDeadline();
    let attachment: AgentAttachment | undefined;
    let buffered = Buffer.alloc(0);
    let discardingOversized = false;
    let finished = false;
    let initialRequestPending = false;
    let writes: Promise<void> = Promise.resolve();
    let attachmentClosed: (() => void) | undefined;
    let interactiveAttachment: InteractiveAttachmentLease | undefined;
    let attachedAgentId: string | undefined;
    let attachedClientId: string | undefined;
    let attachedCapabilities: readonly string[] = [];
    let attachedWorkspace: string | undefined;
    let stopWatchingRoster: (() => void) | undefined;
    let sentWorkIndex: WorkIndexSnapshot | undefined;
    let sentBackgroundAgents = NO_BACKGROUND_AGENTS;
    const extensionRequests = new Set<AbortController>();
    const extensionRequestIds = new Set<string>();
    let pendingBranchId: string | undefined;

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
        clearDeadline();
        stopWatchingRoster?.();
        stopWatchingRoster = undefined;
        attachment?.detach();
        attachment = undefined;
        const abandonedAgentId = attachedAgentId;
        attachedAgentId = undefined;
        attachedClientId = undefined;
        attachedCapabilities = [];
        const abandonedInteractiveAttachment = interactiveAttachment;
        interactiveAttachment = undefined;
        abandonedInteractiveAttachment?.release();
        if (abandonedAgentId !== undefined
            && abandonedInteractiveAttachment !== undefined) {
            interactiveAttachments.deferStop(abandonedAgentId);
            const timer = setTimeout(() => {
                for (const rootId of interactiveAttachments.readyDeferredStops(
                    abandonedAgentId,
                    readAgentTree,
                )) {
                    void closeAgent(rootId).catch(() => undefined);
                }
            }, limits.interactiveDisconnectGraceMs);
            timer.unref();
        }
        attachedWorkspace = undefined;
        for (const controller of extensionRequests) {
            controller.abort();
        }
        extensionRequests.clear();
        extensionRequestIds.clear();
        attachmentClosed?.();
        attachmentClosed = undefined;
        if (pendingBranchId !== undefined) {
            discardPendingBranch();
        }
    });
    socket.once("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
        if (finished) {
            return;
        }
        buffered = Buffer.concat([buffered, chunk]);
        if (idleTimer !== undefined) armDeadline();
        receiveLines();
    });

    function receiveLines(): void {
        while (!finished && !initialRequestPending) {
            const newlineAt = buffered.indexOf(0x0a);
            // An overlong frame is dropped as its bytes arrive and answered
            // once its newline does. Destroying the socket instead would take
            // the whole session down over one unreadable message, and give the
            // client nothing to report but a vanished connection.
            if (discardingOversized) {
                if (newlineAt === -1) {
                    buffered = buffered.subarray(buffered.length);
                    return;
                }
                buffered = buffered.subarray(newlineAt + 1);
                discardingOversized = false;
                refuseOversizedFrame();
                continue;
            }
            if (newlineAt === -1) {
                if (buffered.length > limits.maxRequestBytes) {
                    discardingOversized = true;
                    buffered = buffered.subarray(buffered.length);
                }
                return;
            }
            if (newlineAt > limits.maxRequestBytes) {
                buffered = buffered.subarray(newlineAt + 1);
                refuseOversizedFrame();
                continue;
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

    function refuseOversizedFrame(): void {
        void send({ type: "protocol_error", reason: "frame_too_large" })
            .catch(() => socket.destroy());
    }

    function receiveLine(line: string): void {
        if (attachment === undefined) {
            initialRequestPending = true;
            void receiveInitialRequest(line).catch(() => socket.destroy())
                .finally(() => {
                    initialRequestPending = false;
                    receiveLines();
                });
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
            const detachedAgentId = attachedAgentId;
            attachment.detach();
            attachment = undefined;
            const detachedInteractive = interactiveAttachment;
            detachedInteractive?.release();
            interactiveAttachment = undefined;
            attachedAgentId = undefined;
            attachedClientId = undefined;
            attachedCapabilities = [];
            if (
                detachedAgentId !== undefined
                && detachedInteractive !== undefined
            ) {
                for (const rootId of interactiveAttachments.readyDeferredStops(
                    detachedAgentId,
                    readAgentTree,
                )) {
                    void closeAgent(rootId).catch(() => undefined);
                }
            }
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
        if (message.type === "release_attachment") {
            if (
                interactiveAttachment === undefined
                || attachedAgentId === undefined
                || attachedClientId === undefined
                || !attachedCapabilities.includes(
                    HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
                )
            ) {
                finished = true;
                attachment.detach();
                attachment = undefined;
                void send({
                    type: "protocol_error",
                    reason: "unsupported_or_invalid_command",
                }).then(() => socket.end(), () => socket.destroy());
                return;
            }
            finished = true;
            stopWatchingRoster?.();
            stopWatchingRoster = undefined;
            const releasedAgentId = attachedAgentId;
            const releasedClientId = attachedClientId;
            attachment.detach();
            attachment = undefined;
            attachedAgentId = undefined;
            attachedClientId = undefined;
            attachedCapabilities = [];
            interactiveAttachment.release();
            interactiveAttachment = undefined;
            const remaining = interactiveAttachments.clientCount(
                readAgentTree(releasedAgentId),
                releasedClientId,
            );
            attachedWorkspace = undefined;
            for (const controller of extensionRequests) controller.abort();
            extensionRequests.clear();
            extensionRequestIds.clear();
            let rootsToStop: readonly string[] = [];
            if (message.policy === "keep_running") {
                interactiveAttachments.keepRunning(
                    releasedAgentId,
                    readAgentTree,
                );
            } else if (message.policy === "force_stop") {
                rootsToStop = interactiveAttachments.forceStop(
                    releasedAgentId,
                    readAgentTree,
                );
            } else {
                rootsToStop = interactiveAttachments.stopIfLast(
                    releasedAgentId,
                    releasedClientId,
                    readAgentTree,
                ).rootsToStop;
            }
            if (rootsToStop.length === 0) {
                void send({
                    type: "attachment_released",
                    agent_id: releasedAgentId,
                    outcome: "detached",
                    remaining_interactive_clients: remaining,
                }).then(() => socket.end(), () => socket.destroy());
                return;
            }
            // `closeAgent` fences synchronously before its first await, so no
            // attach can slip between the zero count and whole-tree close.
            void Promise.all(rootsToStop.map((rootId) => closeAgent(rootId))).then(
                (results) => results.every((result) => result.status === "closed")
                    ? send({
                        type: "attachment_released",
                        agent_id: releasedAgentId,
                        outcome: "stopped",
                        remaining_interactive_clients: remaining,
                        session_retained: results.every((result) =>
                            result.sessionRetained !== false
                        ),
                    })
                    : send({
                        type: "attachment_release_rejected",
                        agent_id: releasedAgentId,
                        reason: results.find((result) =>
                            result.status !== "closed"
                        )?.status ?? "failed",
                    }),
                () => send({
                    type: "attachment_release_rejected",
                    agent_id: releasedAgentId,
                    reason: "failed",
                }),
            ).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (isShutdownFenced()) {
            socket.destroy();
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
            const operationClosed = operationOpened();
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
                    operationClosed();
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
                operationClosed();
            });
            return;
        }
        try {
            attachment.send(message);
        } catch {
            socket.destroy();
        }
    }

    async function receiveInitialRequest(line: string): Promise<void> {
        const request = parseHostRequest(line);
        if (request?.type === "host_identity") {
            clearDeadline();
            finished = true;
            void send({
                type: "host_identity",
                pid: identity.pid,
                started_at: identity.started_at,
                protocol_version: HOST_PROTOCOL_VERSION,
                minimum_compatible_protocol_version:
                    HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
            }).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type === "shutdown_if_idle") {
            clearDeadline();
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
        if (request?.type === "shutdown_for_replacement") {
            clearDeadline();
            finished = true;
            const response = requestReplacement({
                pid: request.pid,
                started_at: request.started_at,
                protocol_version: HOST_PROTOCOL_VERSION,
                requester_protocol_version:
                    request.requester_protocol_version,
            });
            void send(response).then(() => {
                if (response.type === "shutdown_for_replacement_accepted") {
                    socket.once("close", notifyShutdownAccepted);
                }
                socket.end();
            }, () => socket.destroy());
            return;
        }
        if (request?.type === "list_agents") {
            clearDeadline();
            finished = true;
            const listRequest = request;
            void Promise.resolve().then(listAgents).then(async (agents) => {
                const page = pageSessionListing(agents, listRequest);
                const rows = listRequest.include === undefined
                    ? page.agents
                    : await readSessionFacts(page.agents, listRequest.include);
                return send({
                    type: "agent_list",
                    agents: rows,
                    ...(page.next_cursor === undefined
                        ? {}
                        : { next_cursor: page.next_cursor }),
                    total: page.total,
                });
            }).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (isShutdownFenced()) {
            socket.destroy();
            return;
        }
        if (request?.type === "search_sessions") {
            clearDeadline();
            finished = true;
            const operationClosed = operationOpened();
            const scan = searchSessions === undefined
                ? Promise.resolve(undefined)
                : searchSessions(request.query).catch(() => undefined);
            void scan.then((results) => send(results === undefined
                ? { type: "session_search_unavailable" }
                : { type: "session_search_results", results }))
                .then(() => socket.end(), () => socket.destroy())
                .finally(operationClosed);
            return;
        }
        if (request?.type === "schedule_operation") {
            clearDeadline();
            finished = true;
            const operationClosed = operationOpened();
            void runScheduleOperation(request.operation).then(
                (result) => send({ type: "schedule_result", result }),
                (error) => send({
                    type: "schedule_failed",
                    reason: userFacingMessage(error) ?? "Schedule operation failed",
                }),
            ).then(() => socket.end(), () => socket.destroy())
                .finally(operationClosed);
            return;
        }
        if (request?.type === "create_agent") {
            clearDeadline();
            finished = true;
            startAgent("create", () => createAgent({
                workspace: request.workspace,
                ...(request.approval_mode === undefined
                    ? {}
                    : { approvalMode: request.approval_mode }),
                ...(request.lifetime === "ephemeral"
                    ? { ephemeral: true }
                    : {}),
                ...(request.startup_profile === undefined
                    ? {}
                    : { startupProfile: request.startup_profile }),
            }));
            return;
        }
        if (request?.type === "resume_agent") {
            clearDeadline();
            finished = true;
            startAgent("resume", () => resumeAgent(request.session_path));
            return;
        }
        if (request?.type === "branch_agent") {
            clearDeadline();
            finished = true;
            const hasOptions = request.approval_mode !== undefined
                || request.lifetime === "ephemeral"
                || (request.initial_messages?.length ?? 0) > 0
                || request.hide_inherited_messages === true;
            const requiresCommit = request.lifetime === "ephemeral";
            if (
                hasOptions
                && !capabilities.includes(HOST_CAPABILITY_AGENT_BRANCH_OPTIONS)
            ) {
                void send({
                    type: "agent_branch_failed",
                    reason: "unsupported_options",
                }).then(() => socket.end(), () => socket.destroy());
                return;
            }
            if (
                (request.initial_messages?.length ?? 0) > 0
                && !capabilities.includes(
                    HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES,
                )
            ) {
                void send({
                    type: "agent_branch_failed",
                    reason: "unsupported_options",
                }).then(() => socket.end(), () => socket.destroy());
                return;
            }
            if (
                request.hide_inherited_messages === true
                && !capabilities.includes(HOST_CAPABILITY_AGENT_CONTEXT_SYNC)
            ) {
                void send({
                    type: "agent_branch_failed",
                    reason: "unsupported_options",
                }).then(() => socket.end(), () => socket.destroy());
                return;
            }
            if (
                request.initial_messages?.some((message) =>
                    message.compactionBarrier === true
                ) === true
                && !capabilities.includes(
                    HOST_CAPABILITY_AGENT_BRANCH_COMPACTION_BARRIERS,
                )
            ) {
                void send({
                    type: "agent_branch_failed",
                    reason: "unsupported_options",
                }).then(() => socket.end(), () => socket.destroy());
                return;
            }
            const branchAbort = new AbortController();
            socket.once("close", () => branchAbort.abort());
            void branchAgent({
                sourceId: request.source_agent_id,
                position: request.position,
                ...(request.entry_id === undefined
                    ? {}
                    : { entryId: request.entry_id }),
                ...(request.approval_mode === undefined
                    ? {}
                    : { approvalMode: request.approval_mode }),
                ...(request.lifetime === "ephemeral"
                    ? { ephemeral: true }
                    : {}),
                ...(request.initial_messages === undefined
                    ? {}
                    : { initialMessages: request.initial_messages }),
                ...(request.hide_inherited_messages === true
                    ? { hideInheritedMessages: true }
                    : {}),
                signal: branchAbort.signal,
                ...(requiresCommit ? { deferPublication: true } : {}),
            }).then(
                (result) => result === undefined
                    ? send({
                        type: "agent_branch_failed",
                        reason: "source_unavailable",
                    })
                    : requiresCommit
                        ? beginBranchCommit(result)
                        : send({
                            type: "agent_branched",
                            agent_id: result.agent.id,
                            workspace: result.agent.workspace,
                            ...(result.prompt === undefined
                                ? {}
                                : { prompt: result.prompt }),
                        }),
                () => send({ type: "agent_branch_failed", reason: "failed" }),
            ).then(() => {
                if (!requiresCommit || pendingBranchId === undefined) {
                    socket.end();
                }
            }, () => {
                discardPendingBranch();
                socket.destroy();
            });
            return;
        }
        if (request?.type === "sync_agent_context") {
            clearDeadline();
            finished = true;
            void syncAgentContext(request.agent_id).then(
                (result) => send({
                    type: "agent_context_synced",
                    outcome: result.status,
                    turns: result.turns,
                }),
                () => send({
                    type: "agent_context_synced",
                    outcome: "failed",
                    turns: 0,
                }),
            ).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type === "commit_agent_branch") {
            if (request.agent_id !== pendingBranchId) {
                socket.destroy();
                return;
            }
            const committedId = pendingBranchId;
            if (!commitBranch(committedId)) {
                socket.destroy();
                return;
            }
            clearDeadline();
            pendingBranchId = undefined;
            finished = true;
            void send({
                type: "agent_branch_committed",
                agent_id: committedId,
            }).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type === "trash_session") {
            clearDeadline();
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
        if (request?.type === "close_agent") {
            clearDeadline();
            finished = true;
            // The acknowledgement is a quiescence boundary, so it is only sent
            // after the close has reached its terminal state, never before.
            void closeAgent(
                request.target_agent_id,
            ).then(
                (result) => result.status === "closed"
                    ? send({
                        type: "agent_closed",
                        agent_id: request.target_agent_id,
                        session_retained: result.sessionRetained !== false,
                    })
                    : send({
                        type: "agent_close_rejected",
                        agent_id: request.target_agent_id,
                        reason: result.status,
                    }),
                () => send({
                    type: "agent_close_rejected",
                    agent_id: request.target_agent_id,
                    reason: "failed",
                }),
            ).then(() => socket.end(), () => socket.destroy());
            return;
        }
        if (request?.type === "rename_session") {
            clearDeadline();
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
            clearDeadline();
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
                ...(request.startup_profile === undefined
                    ? {}
                    : { startupProfile: request.startup_profile }),
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
        clearDeadline();

        let agent: ResidentAgent | undefined;
        try {
            agent = await findAgent(request.agent_id);
        } catch (error) {
            finished = true;
            void send({
                type: "attach_failed",
                agent_id: request.agent_id,
                reason: "unavailable",
                ...(error instanceof ProviderUnavailableError
                    ? {
                        unavailable_reason: "provider_unavailable" as const,
                        provider: error.provider,
                    }
                    : {}),
            }).then(() => socket.end(), () => socket.destroy());
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
        if (request.after_seq !== undefined
            && (!request.requested_capabilities?.includes(
                HOST_CAPABILITY_AGENT_ATTACH_RESUME,
            )
                || !capabilities.includes(
                    HOST_CAPABILITY_AGENT_ATTACH_RESUME,
                ))) {
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
            attached = agent.attach(request.after_seq);
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
        attachedAgentId = agent.id;
        attachedClientId = request.client_id;
        attachedWorkspace = agent.workspace;
        attachmentClosed = attachmentOpened();
        const attachedId = agent.id;
        sentBackgroundAgents = readBackgroundAgents(attachedId);
        const negotiated = negotiateHostCapabilities(
            request.requested_capabilities ?? [],
            capabilities,
        ).filter((capability) =>
            capability !== HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE
            || request.attachment_kind === "interactive"
        );
        attachedCapabilities = negotiated;
        if (request.attachment_kind === "interactive") {
            interactiveAttachment = interactiveAttachments.open(
                agent.id,
                request.client_id!,
            );
        }
        // A client that never asked for the work index is never sent one, so
        // an older client sees the attachment it has always seen rather than a
        // message it would have to reject.
        const wantsWorkIndex = negotiated.includes(HOST_CAPABILITY_WORK_INDEX);
        stopWatchingRoster = onRosterChanged(() => {
            sendBackgroundAgents(attachedId);
            if (wantsWorkIndex) sendWorkIndex();
        });
        void send({
            type: "attached",
            agent_id: attachedId,
            workspace: agent.workspace,
            ...(agent.failed ? { failed: true as const } : {}),
            background_agents: sentBackgroundAgents,
            capabilities: negotiated,
        }).then(
            () => {
                // Directly behind the attach reply, so a client has an inbox
                // to draw from its first frame rather than from its first
                // change. Ordered by the same write queue, so it can never
                // overtake the reply that announced the capability.
                if (wantsWorkIndex) sendWorkIndex();
                return forwardAgentUpdates(agent, attached);
            },
            () => socket.destroy(),
        );
    }

    function beginBranchCommit(
        result: BranchedRegisteredAgent,
    ): Promise<void> {
        pendingBranchId = result.agent.id;
        return send({
            type: "agent_branched",
            agent_id: result.agent.id,
            workspace: result.agent.workspace,
            requires_commit: true,
            ...(result.prompt === undefined ? {} : { prompt: result.prompt }),
        }).then(() => {
            finished = false;
            armDeadline();
            receiveLines();
        });
    }

    function discardPendingBranch(): void {
        const id = pendingBranchId;
        pendingBranchId = undefined;
        if (id !== undefined) {
            void discardBranch(id);
        }
    }

    function readBackgroundAgents(
        attachedAgentId: string,
    ): BackgroundAgentsSnapshot {
        try {
            return backgroundAgentsSnapshot(
                listBackgroundAgents(),
                attachedAgentId,
            );
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

    /**
     * Send the work index, unless the client already has it.
     *
     * The roster reports that something changed, not what, and most changes it
     * reports leave every row identical, so the comparison is what keeps a
     * client from repainting its inbox on every keystroke elsewhere.
     */
    function sendWorkIndex(): void {
        if (finished || attachment === undefined) {
            return;
        }
        let next: WorkIndexSnapshot;
        try {
            next = readWorkIndex();
        } catch {
            return;
        }
        if (sentWorkIndex !== undefined && sameWorkIndex(next, sentWorkIndex)) {
            return;
        }
        sentWorkIndex = next;
        void send({ type: "work_index", index: next },
            () => !finished && attachment !== undefined)
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
            (error: unknown) => {
                if (userFacingMessage(error) === undefined) {
                    try {
                        onAgentStartFailure(operation, error);
                    } catch {
                        // Diagnostics cannot replace the startup outcome.
                    }
                }
                return send({
                    type: "agent_start_failed",
                    operation,
                    // Only messages explicitly written for a person cross the
                    // socket. Internal detail stays in the host diagnostic log.
                    ...reasonOf(error),
                }).then(
                    () => socket.end(),
                    () => socket.destroy(),
                );
            },
        );
    }

    function reasonOf(error: unknown): {
        readonly reason?: string;
        readonly reason_code?: "provider_unavailable";
        readonly provider?: string;
    } {
        const reason = userFacingMessage(error);
        return {
            ...(reason === undefined ? {} : { reason }),
            ...(error instanceof ProviderUnavailableError
                ? {
                    reason_code: "provider_unavailable" as const,
                    provider: error.provider,
                }
                : {}),
        };
    }

    async function forwardAgentUpdates(
        agent: ResidentAgent,
        attached: AgentAttachment,
    ): Promise<void> {
        try {
            while (attachment === attached) {
                const update = await attached.receive();
                await send(update);
            }
        } catch {
            // A failed resident has no more agent updates, but the attachment
            // still owns host-level requests and a clean detach. Keep that
            // control channel alive while its terminal transcript is viewed.
            if (attachment === attached && !agent.failed) {
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

export class HostSocketHeldError extends Error {
    constructor(readonly pid: number, socketPath: string, answering = false) {
        super(
            answering
                ? `Resident Vera host PID ${pid} is already serving `
                    + `${socketPath}, so a new host did not take it. Stop it`
                    + " with 'vera host stop'."
                : `Resident Vera host PID ${pid} still holds ${socketPath} but`
                    + " is not answering, so a new host did not take it. Stop"
                    + " it with 'vera host stop --force'.",
        );
        this.name = "HostSocketHeldError";
    }
}

async function listenAfterRemovingStaleSocket(
    server: Server,
    socketPath: string,
    lockPath: string,
): Promise<void> {
    // Ownership is settled before binding rather than after a failed bind:
    // binding an occupied unix socket path does not reliably report
    // EADDRINUSE, and a silent rebind steals a live host's socket.
    await clearSocketPathOrRefuse(socketPath, lockPath);
    try {
        await listen(server, socketPath);
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
            throw error;
        }
    }
    await clearSocketPathOrRefuse(socketPath, lockPath);
    await listen(server, socketPath);
}

/**
 * Removes the socket path when nothing owns it, and throws when something
 * does. Silence is not proof the socket is abandoned: a wedged host holds its
 * socket open and answers nothing, which looks identical from here, so the
 * lockfile decides. Only a socket no live recorded host owns is stale.
 */
async function clearSocketPathOrRefuse(
    socketPath: string,
    lockPath: string,
): Promise<void> {
    try {
        await stat(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const identity = await requestHostIdentity(socketPath);
        if (identity !== undefined) {
            throw new HostSocketHeldError(identity.pid, socketPath, true);
        }
    }
    const owner = await readHostLockRecordFile(lockPath);
    // A record naming this very process describes an earlier incarnation of
    // the host inside it, which is gone; only another process can hold a
    // socket against us.
    if (
        owner !== undefined
        && owner.socket_path === socketPath
        && owner.pid !== process.pid
        && processIsAlive(owner.pid)
        && recordMatchesRunningProcess(owner)
    ) {
        throw new HostSocketHeldError(owner.pid, socketPath);
    }

    try {
        await unlink(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
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
