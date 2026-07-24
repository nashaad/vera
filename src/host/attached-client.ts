import type {
    AgentUpdate,
    ClientCommand,
} from "../engine/protocol.ts";
import { AsyncQueue } from "../engine/async-queue.ts";
import {
    isExtensionCommandName,
    parseExtensionCommandResult,
    type ExtensionCommandDescriptor,
    type ExtensionCommandResult,
} from "../extensions/commands.ts";
import { parseAgentUpdate } from "./agent-update-wire.ts";
import { connectHost, type HostConnection } from "./connection.ts";

const DEFAULT_MAX_PENDING_UPDATES = 1_024;
const MAX_PENDING_EXTENSION_REQUESTS = 16;

export interface AttachAgentOptions {
    readonly socketPath: string;
    readonly agentId: string;
    readonly maxPendingUpdates?: number;
}

export interface AttachedAgentClient {
    readonly agentId: string;
    readonly workspace: string;
    send(command: ClientCommand): Promise<void>;
    receive(signal?: AbortSignal): Promise<AgentUpdate>;
    listExtensionCommands(): Promise<readonly ExtensionCommandDescriptor[]>;
    runExtensionCommand(
        command: string,
        argumentsText: string,
    ): Promise<ExtensionCommandResult>;
    detach(): Promise<void>;
    close(): void;
    readonly closed: boolean;
}

export class ExtensionCommandError extends Error {
    constructor(
        message: string,
        readonly source: string,
        readonly reason:
            | "unavailable"
            | "handler_failed"
            | "timeout"
            | "cancelled"
            | "invalid_result",
    ) {
        super(message);
        this.name = "ExtensionCommandError";
    }
}

export class AgentAttachError extends Error {
    constructor(
        message: string,
        readonly reason?: "not_found" | "unavailable",
    ) {
        super(message);
        this.name = "AgentAttachError";
    }
}

export async function attachAgent(
    options: AttachAgentOptions,
): Promise<AttachedAgentClient> {
    const maxPendingUpdates = positiveInteger(
        options.maxPendingUpdates ?? DEFAULT_MAX_PENDING_UPDATES,
        "maximum pending agent updates",
    );
    const connection = await connectHost({ socketPath: options.socketPath });
    try {
        await connection.send({
            type: "attach",
            agent_id: options.agentId,
        });
        const response = await connection.receive();
        if (isAttachFailure(response, options.agentId)) {
            throw new AgentAttachError(
                `Could not attach to agent ${options.agentId}: ${response.reason}`,
                response.reason,
            );
        }
        if (!isAttached(response, options.agentId)) {
            throw new AgentAttachError(
                `Host returned an invalid attach response for ${options.agentId}`,
            );
        }
        return createAttachedClient(
            connection,
            response.agent_id,
            response.workspace,
            maxPendingUpdates,
        );
    } catch (error) {
        connection.close();
        throw error;
    }
}

function createAttachedClient(
    connection: HostConnection,
    agentId: string,
    workspace: string,
    maxPendingUpdates: number,
): AttachedAgentClient {
    const updates = new AsyncQueue<AgentUpdate>();
    let isClosed = false;
    let isDetaching = false;
    let detachPromise: Promise<void> | undefined;
    let resolveDetached: (() => void) | undefined;
    let rejectDetached: ((error: Error) => void) | undefined;
    let pendingUpdateCount = 0;
    let resumeReading: (() => void) | undefined;
    let lastSequence: number | undefined;
    let nextExtensionRequestId = 1;
    const extensionRequests = new Map<string, {
        readonly kind: "list" | "run";
        readonly resolve: (value: unknown) => void;
        readonly reject: (error: Error) => void;
    }>();
    const detached = new Promise<void>((resolve, reject) => {
        resolveDetached = resolve;
        rejectDetached = reject;
    });
    void detached.catch(() => undefined);
    void readMessages();
    void connection.closedReason().then((error) => {
        failExtensionRequests(error);
        rejectDetached?.(error);
    });

    return {
        agentId,
        workspace,
        send(command): Promise<void> {
            if (isClosed || connection.closed || isDetaching) {
                return Promise.reject(new Error("Agent attachment is closed"));
            }
            return connection.send(command);
        },
        receive(signal): Promise<AgentUpdate> {
            return updates.receive(signal).then((update) => {
                if (pendingUpdateCount > 0) {
                    pendingUpdateCount -= 1;
                }
                resumeReading?.();
                resumeReading = undefined;
                return update;
            });
        },
        listExtensionCommands(): Promise<
            readonly ExtensionCommandDescriptor[]
        > {
            return requestExtension("list", (requestId) => ({
                type: "list_extension_commands",
                request_id: requestId,
            })) as Promise<readonly ExtensionCommandDescriptor[]>;
        },
        runExtensionCommand(
            command: string,
            argumentsText: string,
        ): Promise<ExtensionCommandResult> {
            if (!isExtensionCommandName(command)) {
                return Promise.reject(
                    new Error("Extension command name is invalid"),
                );
            }
            return requestExtension("run", (requestId) => ({
                type: "run_extension_command",
                request_id: requestId,
                command,
                arguments_text: argumentsText,
            })) as Promise<ExtensionCommandResult>;
        },
        detach(): Promise<void> {
            if (detachPromise !== undefined) {
                return detachPromise;
            }
            if (isClosed || connection.closed) {
                return Promise.reject(new Error("Agent attachment is closed"));
            }
            isDetaching = true;
            resumeReading?.();
            resumeReading = undefined;
            detachPromise = connection.send({ type: "detach" }).then(
                () => detached,
            );
            return detachPromise;
        },
        close(): void {
            fail(new Error("Agent attachment is closed"));
        },
        get closed(): boolean {
            return isClosed || connection.closed;
        },
    };

    async function readMessages(): Promise<void> {
        try {
            while (!isClosed) {
                if (
                    !isDetaching
                    && extensionRequests.size === 0
                    && pendingUpdateCount >= maxPendingUpdates
                ) {
                    await new Promise<void>((resolve) => resumeReading = resolve);
                    continue;
                }
                const value = await connection.receive();
                if (isDetaching && isDetached(value)) {
                    isClosed = true;
                    pendingUpdateCount = 0;
                    failExtensionRequests(
                        new Error("Agent attachment is detached"),
                    );
                    updates.fail(new Error("Agent attachment is detached"), {
                        discardBuffered: true,
                    });
                    connection.close();
                    resolveDetached?.();
                    return;
                }
                if (isProtocolError(value)) {
                    throw new Error(
                        "Host rejected an unsupported or invalid client command",
                    );
                }
                if (receiveExtensionResponse(value)) {
                    continue;
                }
                const update = parseAgentUpdate(value);
                if (update === undefined) {
                    throw new Error("Host sent an invalid agent update");
                }
                if (pendingUpdateCount >= maxPendingUpdates) {
                    throw new Error(
                        "Agent updates exceeded the client buffer while an extension request was pending",
                    );
                }
                if ("seq" in update) {
                    if (lastSequence === undefined) {
                        if (update.type !== "history") {
                            throw new Error(
                                "Host sent an agent update before its history checkpoint",
                            );
                        }
                    } else {
                        const expected = update.type === "history"
                            ? lastSequence
                            : lastSequence + 1;
                        if (update.seq !== expected) {
                            throw new Error(
                                "Host sent a non-contiguous agent update sequence",
                            );
                        }
                    }
                    lastSequence = update.seq;
                }
                pendingUpdateCount += 1;
                updates.push(update);
            }
        } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
        }
    }

    function fail(error: Error): void {
        if (isClosed) {
            return;
        }
        isClosed = true;
        pendingUpdateCount = 0;
        resumeReading?.();
        resumeReading = undefined;
        updates.fail(error);
        failExtensionRequests(error);
        rejectDetached?.(error);
        connection.close();
    }

    function requestExtension(
        kind: "list" | "run",
        request: (requestId: string) => object,
    ): Promise<unknown> {
        if (isClosed || connection.closed || isDetaching) {
            return Promise.reject(new Error("Agent attachment is closed"));
        }
        if (extensionRequests.size >= MAX_PENDING_EXTENSION_REQUESTS) {
            return Promise.reject(
                new Error("Too many pending extension requests"),
            );
        }
        const requestId = `extension-${nextExtensionRequestId}`;
        nextExtensionRequestId += 1;
        return new Promise((resolve, reject) => {
            extensionRequests.set(requestId, { kind, resolve, reject });
            resumeReading?.();
            resumeReading = undefined;
            void connection.send(request(requestId)).catch((error) => {
                const pending = extensionRequests.get(requestId);
                if (pending !== undefined) {
                    extensionRequests.delete(requestId);
                    pending.reject(asError(error));
                }
            });
        });
    }

    function receiveExtensionResponse(value: unknown): boolean {
        const response = asRecord(value);
        if (
            response === undefined
            || !isExtensionResponseType(response.type)
        ) {
            return false;
        }
        if (typeof response.request_id !== "string") {
            throw new Error("Host sent an invalid extension response");
        }
        const pending = extensionRequests.get(response.request_id);
        if (pending === undefined) {
            throw new Error("Host sent an unknown extension response");
        }
        if (response.type === "extension_command_failed") {
            const failure = parseExtensionFailure(response);
            if (failure === undefined) {
                throw new Error("Host sent an invalid extension response");
            }
            extensionRequests.delete(response.request_id);
            pending.reject(new ExtensionCommandError(
                failure.message
                    ?? `Extension command failed: ${failure.reason}`,
                failure.source,
                failure.reason,
            ));
            return true;
        }
        if (pending.kind === "list") {
            const commands = parseExtensionCommandList(response);
            if (commands === undefined) {
                throw new Error("Host sent an invalid extension response");
            }
            extensionRequests.delete(response.request_id);
            pending.resolve(commands);
            return true;
        }
        const result = response.type === "extension_command_result"
            && hasExactKeys(
                response,
                ["type", "request_id", "result"],
            )
            ? parseExtensionCommandResult(response.result)
            : undefined;
        if (result === undefined) {
            throw new Error("Host sent an invalid extension response");
        }
        extensionRequests.delete(response.request_id);
        pending.resolve(result);
        return true;
    }

    function failExtensionRequests(error: Error): void {
        for (const pending of extensionRequests.values()) {
            pending.reject(error);
        }
        extensionRequests.clear();
    }
}

function isAttached(
    value: unknown,
    expectedAgentId: string,
): value is {
    readonly type: "attached";
    readonly agent_id: string;
    readonly workspace: string;
} {
    const response = asRecord(value);
    return response?.type === "attached"
        && response.agent_id === expectedAgentId
        && typeof response.workspace === "string"
        && response.workspace.length > 0;
}

function isAttachFailure(
    value: unknown,
    expectedAgentId: string,
): value is {
    readonly type: "attach_failed";
    readonly agent_id: string;
    readonly reason: "not_found" | "unavailable";
} {
    const response = asRecord(value);
    return response?.type === "attach_failed"
        && response.agent_id === expectedAgentId
        && (response.reason === "not_found" || response.reason === "unavailable");
}

function isDetached(value: unknown): boolean {
    return asRecord(value)?.type === "detached";
}

function isProtocolError(value: unknown): boolean {
    const response = asRecord(value);
    return response?.type === "protocol_error"
        && response.reason === "unsupported_or_invalid_command";
}

function isExtensionResponseType(
    value: unknown,
): value is
    | "extension_command_list"
    | "extension_command_result"
    | "extension_command_failed" {
    return value === "extension_command_list"
        || value === "extension_command_result"
        || value === "extension_command_failed";
}

function parseExtensionCommandList(
    value: Record<string, unknown>,
): readonly ExtensionCommandDescriptor[] | undefined {
    if (
        !hasExactKeys(value, ["type", "request_id", "commands"])
        || value.type !== "extension_command_list"
        || !Array.isArray(value.commands)
    ) {
        return undefined;
    }
    const commands: ExtensionCommandDescriptor[] = [];
    for (const item of value.commands) {
        const command = asRecord(item);
        if (
            command === undefined
            || !hasExactKeys(
                command,
                ["name", "description", "usage", "source"],
            )
            || typeof command.name !== "string"
            || !isExtensionCommandName(command.name)
            || typeof command.description !== "string"
            || command.description.trim().length === 0
            || typeof command.usage !== "string"
            || command.usage.trim().length === 0
            || typeof command.source !== "string"
            || command.source.trim().length === 0
        ) {
            return undefined;
        }
        commands.push({
            name: command.name,
            description: command.description,
            usage: command.usage,
            source: command.source,
        });
    }
    return commands;
}

function parseExtensionFailure(
    value: Record<string, unknown>,
): {
    readonly source: string;
    readonly reason: ExtensionCommandError["reason"];
    readonly message?: string;
} | undefined {
    if (
        !hasExactKeys(value, ["type", "request_id", "failure"])
        || value.type !== "extension_command_failed"
    ) {
        return undefined;
    }
    const failure = asRecord(value.failure);
    if (
        failure === undefined
        || !hasOnlyKeys(failure, ["source", "reason", "message"])
        || typeof failure.source !== "string"
        || failure.source.trim().length === 0
        || !isExtensionFailureReason(failure.reason)
        || (
            failure.message !== undefined
            && typeof failure.message !== "string"
        )
    ) {
        return undefined;
    }
    return {
        source: failure.source,
        reason: failure.reason,
        ...(
            failure.message === undefined
            || failure.message.trim().length === 0
            ? {}
            : { message: failure.message as string }),
    };
}

function isExtensionFailureReason(
    value: unknown,
): value is ExtensionCommandError["reason"] {
    return value === "unavailable"
        || value === "handler_failed"
        || value === "timeout"
        || value === "cancelled"
        || value === "invalid_result";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.length
        && keys.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
): boolean {
    return Object.keys(value).every((key) => keys.includes(key));
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}
