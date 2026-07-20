import type {
    AgentUpdate,
    ClientCommand,
} from "../engine/protocol.ts";
import { AsyncQueue } from "../engine/async-queue.ts";
import { parseAgentUpdate } from "./agent-update-wire.ts";
import { connectHost, type HostConnection } from "./connection.ts";

const DEFAULT_MAX_PENDING_UPDATES = 1_024;

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
    detach(): Promise<void>;
    close(): void;
    readonly closed: boolean;
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
    const detached = new Promise<void>((resolve, reject) => {
        resolveDetached = resolve;
        rejectDetached = reject;
    });
    void detached.catch(() => undefined);
    void readMessages();

    return {
        agentId,
        workspace,
        send(command): Promise<void> {
            if (isClosed || isDetaching) {
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
        detach(): Promise<void> {
            if (detachPromise !== undefined) {
                return detachPromise;
            }
            if (isClosed) {
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
            return isClosed;
        },
    };

    async function readMessages(): Promise<void> {
        try {
            while (!isClosed) {
                if (!isDetaching && pendingUpdateCount >= maxPendingUpdates) {
                    await new Promise<void>((resolve) => resumeReading = resolve);
                    continue;
                }
                const value = await connection.receive();
                if (isDetaching && isDetached(value)) {
                    isClosed = true;
                    pendingUpdateCount = 0;
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
                const update = parseAgentUpdate(value);
                if (update === undefined) {
                    throw new Error("Host sent an invalid agent update");
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
        updates.fail(error, { discardBuffered: true });
        rejectDetached?.(error);
        connection.close();
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}
