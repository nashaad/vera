import type { AgentUpdate, ClientCommand } from "../engine/protocol.ts";
import {
    AgentAttachError,
    attachAgent,
    type AttachedAgentClient,
} from "./attached-client.ts";
import {
    HOST_CAPABILITIES,
    HOST_CAPABILITY_AGENT_ATTACH_RESUME,
} from "./capabilities.ts";

const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 50;

export interface ReconnectingAgentOptions {
    readonly socketPath: () => string;
    readonly agentId: string;
}

export async function attachReconnectingAgent(
    options: ReconnectingAgentOptions,
): Promise<AttachedAgentClient> {
    const attach = (
        afterSequence: number | undefined,
        signal: AbortSignal,
    ): Promise<AttachedAgentClient> =>
        attachAgent({
            socketPath: options.socketPath(),
            agentId: options.agentId,
            requestedCapabilities: HOST_CAPABILITIES,
            ...(afterSequence === undefined ? {} : { afterSequence }),
            signal,
        });
    return createReconnectingAgentClient(
        await attach(undefined, new AbortController().signal),
        attach,
    );
}

export function createReconnectingAgentClient(
    initial: AttachedAgentClient,
    attach: (
        afterSequence: number | undefined,
        signal: AbortSignal,
    ) => Promise<AttachedAgentClient>,
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

    const client: AttachedAgentClient = {
        get agentId(): string {
            return current.agentId;
        },
        get workspace(): string {
            return current.workspace;
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
        send(command) {
            const requestId = privateRequestId(command);
            if (requestId !== undefined) pendingPrivateRequests.add(requestId);
            if (command.type === "prompt") pendingPrompts.push(command.content);
            const target = reconnectInFlight === undefined
                ? Promise.resolve(current)
                : reconnectInFlight;
            return target.then((attached) => attached.send(command)).catch((error) => {
                if (requestId !== undefined) pendingPrivateRequests.delete(requestId);
                if (command.type === "prompt") {
                    removePendingPrompt(pendingPrompts, command.content);
                }
                throw error;
            });
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
        async detach(): Promise<void> {
            if (closed) return;
            closed = true;
            lifecycle.abort(new Error("Agent attachment is detached"));
            stopBackgroundAgentUpdates();
            if (!current.closed) await current.detach();
        },
        close(): void {
            if (closed) return;
            closed = true;
            lifecycle.abort(new Error("Agent attachment is closed"));
            stopBackgroundAgentUpdates();
            current.close();
        },
        get closed(): boolean {
            return closed;
        },
    };

    return client;

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
        const reconnectSignal = signal === undefined
            ? lifecycle.signal
            : AbortSignal.any([lifecycle.signal, signal]);
        let afterSequence = current.supportsHostCapability(
                HOST_CAPABILITY_AGENT_ATTACH_RESUME,
            )
            ? current.lastSequence
            : undefined;
        let lastError = originalError;
        current.close();
        for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
            if (closed) throw new Error("Agent attachment is closed");
            reconnectSignal.throwIfAborted();
            if (attempt > 1) {
                await delay(RECONNECT_DELAY_MS, reconnectSignal);
            }
            try {
                const next = await attach(afterSequence, reconnectSignal);
                if (closed) {
                    next.close();
                    throw lifecycle.signal.reason;
                }
                stopBackgroundAgentUpdates();
                stopBackgroundAgentUpdates = subscribeToBackgroundAgentUpdates(next);
                for (const listener of backgroundAgentListeners) {
                    try {
                        listener(next.backgroundAgents);
                    } catch {
                        // One client-local observer cannot invalidate a reattach.
                    }
                }
                return next;
            } catch (error) {
                if (closed || lifecycle.signal.aborted) throw error;
                if (afterSequence !== undefined
                    && error instanceof AgentAttachError
                    && error.reason === "unavailable") {
                    afterSequence = undefined;
                }
                lastError = error;
            }
        }
        throw new Error(
            `Could not reconnect agent after ${RECONNECT_ATTEMPTS} attempts: ${messageOf(lastError)}`,
        );
    }
}

function privateRequestId(command: ClientCommand): string | undefined {
    return command.type === "attach_image"
            || command.type === "consult"
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
            || update.type === "consult_result"
            || update.type === "consult_rejected"
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
    if (update.type === "prompt_rejected") {
        pending.shift();
        return;
    }
    if (update.type === "user_prompt") {
        removePendingPrompt(pending, update.content);
    }
}

function removePendingPrompt(pending: string[], content: string): void {
    const index = pending.indexOf(content);
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
