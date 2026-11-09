import { randomUUID } from "node:crypto";
import type { AgentUpdate, ClientCommand } from "../engine/protocol.ts";
import {
    AgentAttachError,
    AgentLocationChangedError,
    attachAgent,
    type AttachedAgentClient,
} from "./attached-client.ts";
import {
    CLIENT_CAPABILITIES,
    HOST_CAPABILITY_AGENT_ATTACH_RESUME,
    HOST_CAPABILITY_SESSION_ROUTING,
} from "./capabilities.ts";
import { connectHost } from "./connection.ts";
import { parseAgentLocationReply, requestHostIdentity, type HostIdentity, type HostStopWaitEvent } from "./protocol.ts";
import type { ReadyAgentLocation } from "./agent-start-client.ts";
import { sameWorkIndex, type WorkIndexSnapshot } from "./work-index.ts";

const RECONNECT_DEADLINE_MS = 5_000;
const RECONNECT_DELAYS_MS = [0, 50, 100, 200];
const STARTING_RETRY_DELAY_MS = 1_000;
const BUILD_CHECK_DELAYS_MS = [0, 50, 100, 200];

export interface ReconnectingAgentOptions {
    readonly socketPath: () => string;
    readonly agentId: string;
    // The build this client started as. Read the stamp once: it can change on disk while the client runs.
    readonly buildId: string;
    readonly interactive?: boolean;
    readonly clientId?: string;
    readonly failOnDisconnect?: boolean;
    /** Defaults to CLIENT_CAPABILITIES; paging clients pass PAGING_CAPABILITIES. */
    readonly requestedCapabilities?: readonly string[];
    readonly initialLocation?: ReadyAgentLocation;
}

export class HostBuildChangedError extends Error {
    constructor(
        readonly clientBuildId: string,
        readonly hostBuildId: string | undefined,
    ) {
        const host = hostBuildId === undefined
            ? "a build that did not report its ID"
            : `build ${hostBuildId}`;
        super(
            `The Vera host is now ${host} and this client is build ${clientBuildId}, `
                + "so it will not attach. Quit and reopen Vera.",
        );
        this.name = "HostBuildChangedError";
    }
}

export interface ReconnectPolicy {
    readonly deadlineMs?: number;
    readonly delaysMs?: readonly number[];
    readonly failOnDisconnect?: boolean;
    readonly retryDirectDisconnect?: () => boolean;
}

export async function attachReconnectingAgent(
    options: ReconnectingAgentOptions,
): Promise<AttachedAgentClient> {
    let initialLocation = options.initialLocation;
    let directAttached = false;
    const requestedCapabilities = options.requestedCapabilities ?? CLIENT_CAPABILITIES;
    const routing = requestedCapabilities.includes(HOST_CAPABILITY_SESSION_ROUTING);
    const attach = async (
        afterSequence: number | undefined,
        signal: AbortSignal,
    ): Promise<AttachedAgentClient> => {
        const masterSocket = options.socketPath();
        const masterIdentity = await confirmHostBuild(masterSocket, options.buildId, signal);
        let location: RoutingLocation | undefined = routing ? initialLocation : undefined;
        initialLocation = undefined;
        if (location === undefined && routing && (masterIdentity.workers_ready !== undefined || directAttached)) {
            location = await locateAgent(masterSocket, options.agentId, signal);
        }
        const attachAt = (socketPath: string): Promise<AttachedAgentClient> => attachAgent({
            socketPath,
            agentId: options.agentId,
            requestedCapabilities,
            ...(options.interactive === true
                ? { interactive: true, clientId: options.clientId }
                : {}),
            ...(afterSequence === undefined ? {} : { afterSequence }),
            signal,
        });
        if (location === undefined) {
            const client = await attachAt(masterSocket);
            directAttached = false;
            return client;
        }
        let lastError: unknown = new Error("The session worker is unavailable");
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const target = location;
            const isMaster = target.worker_id === "host" && target.socket_path === masterSocket;
            const identity = isMaster ? masterIdentity : await requestHostIdentity(target.socket_path);
            signal.throwIfAborted();
            const matches = target.build_id === undefined || target.build_id === options.buildId;
            const verified = isMaster ? matches : matches && identity?.role === "worker"
                && identity.build_id === options.buildId
                && identity.worker_id === target.worker_id
                && identity.worker_generation === target.worker_generation;
            if (verified) {
                try {
                    const client = await attachAt(target.socket_path);
                    directAttached = !isMaster;
                    return client;
                } catch (error) {
                    if (!(error instanceof AgentLocationChangedError) && !isRefusedSocket(error)) throw error;
                    lastError = error;
                }
            }
            if (attempt === 0) location = await locateAgent(masterSocket, options.agentId, signal);
        }
        throw lastError;
    };
    return createReconnectingAgentClient(
        await attach(undefined, new AbortController().signal),
        attach,
        { failOnDisconnect: options.failOnDisconnect, retryDirectDisconnect: () => directAttached },
    );
}

export function createReconnectingAgentClient(
    initial: AttachedAgentClient,
    attach: (
        afterSequence: number | undefined,
        signal: AbortSignal,
    ) => Promise<AttachedAgentClient>,
    policy: ReconnectPolicy = {},
): AttachedAgentClient {
    let current = initial;
    let closed = false;
    let receiving = false;
    let reconnectInFlight: Promise<AttachedAgentClient> | undefined;
    const lifecycle = new AbortController();
    const pendingPrivateRequests = new Set<string>();
    const pendingPrompts: string[] = [];
    const backgroundAgentListeners = new Set<
        Parameters<AttachedAgentClient["onBackgroundAgents"]>[0]
    >();
    let stopBackgroundAgentUpdates = subscribeToBackgroundAgentUpdates(current);
    const workIndexListeners = new Set<
        Parameters<AttachedAgentClient["onWorkIndex"]>[0]
    >();
    let workIndex = current.workIndex;
    let stopWorkIndexUpdates = subscribeToWorkIndexUpdates(current);
    const sessionTitleListeners = new Set<
        Parameters<AttachedAgentClient["onSessionTitle"]>[0]
    >();
    let sessionTitle = current.sessionTitle;
    let stopSessionTitleUpdates = current.onSessionTitle(publishSessionTitle);
    const stopWaitListeners = new Set<
        Parameters<AttachedAgentClient["onStopWait"]>[0]
    >();
    let stopWait = current.stopWait;
    let stopStopWaitUpdates = current.onStopWait(publishStopWait);

    const client: AttachedAgentClient = {
        get agentId(): string {
            return current.agentId;
        },
        get workspace(): string {
            return current.workspace;
        },
        get scratchDirectory(): string | undefined {
            return current.scratchDirectory;
        },
        get failed(): boolean {
            return current.failed === true;
        },
        get lastSequence(): number | undefined {
            return current.lastSequence;
        },
        get capabilities(): readonly string[] {
            return current.capabilities;
        },
        supportsHostCapability(capability): boolean {
            return current.supportsHostCapability(capability);
        },
        get backgroundAgents() {
            return current.backgroundAgents;
        },
        onBackgroundAgents(listener) {
            backgroundAgentListeners.add(listener);
            return (): void => {
                backgroundAgentListeners.delete(listener);
            };
        },
        get workIndex() {
            return workIndex;
        },
        onWorkIndex(listener) {
            workIndexListeners.add(listener);
            return (): void => {
                workIndexListeners.delete(listener);
            };
        },
        get sessionTitle() {
            return sessionTitle;
        },
        onSessionTitle(listener) {
            sessionTitleListeners.add(listener);
            return (): void => {
                sessionTitleListeners.delete(listener);
            };
        },
        get stopWait() {
            return stopWait;
        },
        onStopWait(listener) {
            stopWaitListeners.add(listener);
            return (): void => {
                stopWaitListeners.delete(listener);
            };
        },
        send(command) {
            const requestId = privateRequestId(command);
            if (requestId !== undefined) pendingPrivateRequests.add(requestId);
            const promptRequestId = command.type === "prompt" ? command.requestId ?? randomUUID() : undefined;
            if (promptRequestId !== undefined) pendingPrompts.push(promptRequestId);
            const outgoing = command.type === "prompt" ? { ...command, requestId: promptRequestId } : command;
            const target = reconnectInFlight === undefined
                ? Promise.resolve(current)
                : reconnectInFlight;
            return target.then((attached) => attached.send(outgoing)).then(() => {
                if (promptRequestId !== undefined) removePendingPrompt(pendingPrompts, promptRequestId);
            }).catch((error) => {
                if (requestId !== undefined) pendingPrivateRequests.delete(requestId);
                if (promptRequestId !== undefined) removePendingPrompt(pendingPrompts, promptRequestId);
                throw error;
            });
        },
        requestHistoryPage(before, signal) {
            if (closed) {
                return Promise.reject(new Error("Agent attachment is closed"));
            }
            return current.requestHistoryPage(before, signal);
        },
        async receive(signal): Promise<AgentUpdate> {
            if (receiving) {
                throw new Error("Agent attachment already has a pending receive");
            }
            receiving = true;
            try {
                while (!closed) {
                    try {
                        const update = await current.receive(signal);
                        const requestId = privateReplyRequestId(update);
                        if (requestId !== undefined) {
                            pendingPrivateRequests.delete(requestId);
                        }
                        settlePendingPrompt(pendingPrompts, update);
                        return update;
                    } catch (error) {
                        if (closed || signal?.aborted === true) {
                            throw error;
                        }
                        if (policy.failOnDisconnect === true && current.closed
                            && policy.retryDirectDisconnect?.() !== true) {
                            throw error;
                        }
                        if (pendingPrivateRequests.size > 0
                            || pendingPrompts.length > 0) {
                            throw new Error(
                                "Host connection closed while an attachment-private request was pending",
                            );
                        }
                        reconnectInFlight = retryReconnect(error, signal);
                        try {
                            current = await reconnectInFlight;
                        } finally {
                            reconnectInFlight = undefined;
                        }
                    }
                }
                throw new Error("Agent attachment is closed");
            } finally {
                receiving = false;
            }
        },
        listExtensionCommands() {
            return current.listExtensionCommands();
        },
        runExtensionCommand(command, argumentsText) {
            return current.runExtensionCommand(command, argumentsText);
        },
        async release(policy) {
            if (closed) throw new Error("Agent attachment is closed");
            const release = current.release;
            if (release === undefined) {
                throw new Error("Host does not support attachment release");
            }
            closed = true;
            lifecycle.abort(new Error("Agent attachment is released"));
            stopBackgroundAgentUpdates();
            stopWorkIndexUpdates();
            stopSessionTitleUpdates();
            stopStopWaitUpdates();
            return release.call(current, policy);
        },
        async detach(): Promise<void> {
            if (closed) return;
            closed = true;
            lifecycle.abort(new Error("Agent attachment is detached"));
            stopBackgroundAgentUpdates();
            stopWorkIndexUpdates();
            stopSessionTitleUpdates();
            stopStopWaitUpdates();
            if (!current.closed) await current.detach();
        },
        close(): void {
            if (!closed) {
                closed = true;
                lifecycle.abort(new Error("Agent attachment is closed"));
                stopBackgroundAgentUpdates();
                stopWorkIndexUpdates();
                stopSessionTitleUpdates();
                stopStopWaitUpdates();
            }
            // A release or detach still waiting on the host keeps the socket open until this closes it.
            current.close();
        },
        get closed(): boolean {
            return closed;
        },
    };

    return client;

    function publishStopWait(event: HostStopWaitEvent): void {
        if (event.type === "host_stop_wait") stopWait = event;
        if (event.type === "host_stop_wait_cleared") stopWait = undefined;
        for (const listener of [...stopWaitListeners]) {
            try {
                listener(event);
            } catch {
            }
        }
    }

    function subscribeToWorkIndexUpdates(
        attached: AttachedAgentClient,
    ): () => void {
        return attached.onWorkIndex(publishWorkIndex);
    }

    function publishWorkIndex(index: WorkIndexSnapshot): void {
        if (workIndex !== undefined && sameWorkIndex(workIndex, index)) return;
        workIndex = index;
        for (const listener of workIndexListeners) {
            try {
                listener(index);
            } catch {
            }
        }
    }

    function publishSessionTitle(title: string | undefined): void {
        sessionTitle = title;
        for (const listener of sessionTitleListeners) {
            try {
                listener(title);
            } catch {
            }
        }
    }

    function subscribeToBackgroundAgentUpdates(
        attached: AttachedAgentClient,
    ): () => void {
        return attached.onBackgroundAgents((agents) => {
            for (const listener of backgroundAgentListeners) {
                listener(agents);
            }
        });
    }

    async function retryReconnect(
        originalError: unknown,
        signal?: AbortSignal,
    ): Promise<AttachedAgentClient> {
        const deadline = AbortSignal.timeout(
            policy.deadlineMs ?? RECONNECT_DEADLINE_MS,
        );
        const reconnectSignal = AbortSignal.any([
            lifecycle.signal,
            deadline,
            ...(signal === undefined ? [] : [signal]),
        ]);
        let afterSequence = current.supportsHostCapability(
                HOST_CAPABILITY_AGENT_ATTACH_RESUME,
            )
            ? current.lastSequence
            : undefined;
        let lastError = originalError;
        current.close();
        const delays = policy.delaysMs ?? RECONNECT_DELAYS_MS;
        for (let attempt = 0; policy.delaysMs === undefined
            || attempt < delays.length; attempt += 1) {
            const delayMs = delays[Math.min(attempt, delays.length - 1)] ?? 0;
            if (closed) throw new Error("Agent attachment is closed");
            reconnectSignal.throwIfAborted();
            if (delayMs > 0) await delay(delayMs, reconnectSignal);
            try {
                const next = await attach(afterSequence, reconnectSignal);
                if (closed) {
                    next.close();
                    throw lifecycle.signal.reason;
                }
                stopBackgroundAgentUpdates();
                stopBackgroundAgentUpdates = subscribeToBackgroundAgentUpdates(next);
                stopWorkIndexUpdates();
                stopWorkIndexUpdates = subscribeToWorkIndexUpdates(next);
                if (next.workIndex !== undefined) {
                    publishWorkIndex(next.workIndex);
                }
                stopSessionTitleUpdates();
                stopSessionTitleUpdates = next.onSessionTitle(
                    publishSessionTitle,
                );
                stopStopWaitUpdates();
                stopStopWaitUpdates = next.onStopWait(publishStopWait);
                // The old host's wait does not carry over; the new host reports its own on attach.
                if (stopWait !== undefined && next.stopWait === undefined) {
                    publishStopWait({ type: "host_stop_wait_cleared", reason: "stopped" });
                } else if (next.stopWait !== undefined) {
                    publishStopWait(next.stopWait);
                }
                for (const listener of backgroundAgentListeners) {
                    try {
                        listener(next.backgroundAgents);
                    } catch {
                    }
                }
                return next;
            } catch (error) {
                if (closed || lifecycle.signal.aborted) throw error;
                if (error instanceof HostBuildChangedError) throw error;
                if (afterSequence !== undefined
                    && error instanceof AgentAttachError
                    && error.reason === "unavailable") {
                    afterSequence = undefined;
                }
                lastError = error;
            }
        }
        throw new Error(
            `Could not reconnect agent before its deadline: ${messageOf(lastError)}`,
        );
    }
}

// Silence is a host not ready yet, not a match: the caller retries or fails, never attaches unchecked.
async function confirmHostBuild(
    socketPath: string,
    buildId: string,
    signal: AbortSignal,
): Promise<HostIdentity> {
    for (const delayMs of BUILD_CHECK_DELAYS_MS) {
        if (delayMs > 0) await delay(delayMs, signal);
        const identity = await requestHostIdentity(socketPath);
        if (identity === undefined) continue;
        if (identity.build_id !== buildId) {
            throw new HostBuildChangedError(buildId, identity.build_id);
        }
        return identity;
    }
    throw new Error("The Vera host did not report its build, so this client did not attach.");
}

interface RoutingLocation extends ReadyAgentLocation {
    readonly build_id?: string;
}

async function locateAgent(socketPath: string, agentId: string, signal: AbortSignal): Promise<RoutingLocation> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(RECONNECT_DEADLINE_MS)]);
    let startingReplies = 0;
    for (let attempt = 0; ; attempt += 1) {
        deadline.throwIfAborted();
        let retryStarting = false;
        const connection = await connectHost({ socketPath, signal: deadline });
        const abort = (): void => connection.close();
        deadline.addEventListener("abort", abort, { once: true });
        try {
            await connection.send({ type: "locate_agent", agent_id: agentId });
            const response = parseAgentLocationReply(JSON.stringify(await connection.receive()));
            if (response === undefined) throw new Error("Host returned an invalid session location");
            if (response.type === "agent_location") return response;
            if (response.reason === "not_found") throw new Error(response.message);
            if (response.reason === "starting") {
                if (++startingReplies >= 2) throw new Error(response.message);
                retryStarting = true;
            }
        } finally {
            deadline.removeEventListener("abort", abort);
            connection.close();
        }
        const delayMs = retryStarting ? STARTING_RETRY_DELAY_MS
            : RECONNECT_DELAYS_MS[Math.min(attempt + 1, RECONNECT_DELAYS_MS.length - 1)] ?? 0;
        if (delayMs > 0) await delay(delayMs, deadline);
    }
}

function isRefusedSocket(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ECONNREFUSED" || code === "ENOENT" || code === "ECONNRESET";
}

function privateRequestId(command: ClientCommand): string | undefined {
    return command.type === "attach_image"
            || command.type === "oneshot"
            || command.type === "update_session_name"
            || command.type === "list_timeline"
            || command.type === "preview_timeline_action"
            || command.type === "apply_timeline_action"
        ? command.requestId
        : undefined;
}

function privateReplyRequestId(update: AgentUpdate): string | undefined {
    return update.type === "image_attached"
            || update.type === "image_attachment_rejected"
            || update.type === "oneshot_result"
            || update.type === "oneshot_rejected"
            || update.type === "session_name"
            || update.type === "session_name_rejected"
            || update.type === "timeline"
            || update.type === "timeline_action_preview"
            || update.type === "timeline_action_applied"
            || update.type === "timeline_action_rejected"
        ? update.requestId
        : undefined;
}

function settlePendingPrompt(pending: string[], update: AgentUpdate): void {
    if (update.type === "prompt_admission") {
        removePendingPrompt(pending, update.requestId);
        return;
    }
    if (update.type === "prompt_rejected") {
        if (update.requestId !== undefined) removePendingPrompt(pending, update.requestId);
        else pending.shift();
    }
}

function removePendingPrompt(pending: string[], requestId: string): void {
    const index = pending.indexOf(requestId);
    if (index !== -1) pending.splice(index, 1);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(finish, milliseconds);
        const abort = (): void => {
            clearTimeout(timeout);
            reject(signal?.reason instanceof Error
                ? signal.reason
                : new Error("Agent reconnect was cancelled"));
        };
        function finish(): void {
            signal?.removeEventListener("abort", abort);
            resolve();
        }
        signal?.addEventListener("abort", abort, { once: true });
    });
}

function messageOf(error: unknown): string {
    return error instanceof Error && error.message.length > 0
        ? error.message
        : "unknown host connection failure";
}
