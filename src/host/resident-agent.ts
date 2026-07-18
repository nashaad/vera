import { AsyncQueue } from "../engine/async-queue.ts";
import type {
    AgentStatus,
    AgentUpdate,
    ClientCommand,
    HistoryUpdate,
} from "../engine/protocol.ts";
import type { MessageChannel } from "../engine/message-channel.ts";

export class AgentDetachedError extends Error {
    constructor() {
        super("Agent client is detached");
        this.name = "AgentDetachedError";
    }
}

export class ResidentAgentClosedError extends Error {
    constructor() {
        super("Resident agent is closed");
        this.name = "ResidentAgentClosedError";
    }
}

export class AgentCommandQueueFullError extends Error {
    constructor() {
        super("Resident agent command queue is full");
        this.name = "AgentCommandQueueFullError";
    }
}

export interface ResidentAgentOptions {
    readonly maxPendingCommands?: number;
}

interface QueuedCommand {
    readonly command: ClientCommand;
    readonly countsTowardLimit: boolean;
}

export interface AgentAttachment
    extends MessageChannel<ClientCommand, AgentUpdate> {
    detach(): void;
}

export class ResidentAgent {
    readonly id: string;
    readonly workspace: string;
    readonly engine: MessageChannel<AgentUpdate, ClientCommand>;

    private readonly inbound = new AsyncQueue<QueuedCommand>();
    private readonly attachments = new Set<AsyncQueue<AgentUpdate>>();
    private checkpoint: HistoryUpdate = {
        type: "history",
        entries: [],
        seq: 0,
    };
    private updatesAfterCheckpoint: AgentUpdate[] = [];
    private currentStatus: AgentStatus = "idle";
    private isClosed = false;
    private pendingCommandCount = 0;
    private readonly maxPendingCommands: number;

    constructor(
        id: string,
        workspace: string,
        options: ResidentAgentOptions = {},
    ) {
        this.id = nonEmpty(id, "agent ID");
        this.workspace = nonEmpty(workspace, "agent workspace");
        this.maxPendingCommands = positiveInteger(
            options.maxPendingCommands ?? 1_024,
            "maximum pending commands",
        );
        this.engine = {
            send: (update): void => this.broadcast(update),
            receive: (signal): Promise<ClientCommand> => {
                if (this.isClosed) {
                    return Promise.reject(new ResidentAgentClosedError());
                }
                return this.inbound.receive(signal).then((queued) => {
                    if (queued.countsTowardLimit) {
                        this.pendingCommandCount -= 1;
                    }
                    return queued.command;
                });
            },
        };
    }

    attach(): AgentAttachment {
        if (this.isClosed) {
            throw new ResidentAgentClosedError();
        }

        const outgoing = new AsyncQueue<AgentUpdate>();
        let attached = true;
        this.attachments.add(outgoing);
        outgoing.push(clone(this.checkpoint));
        for (const update of this.updatesAfterCheckpoint) {
            outgoing.push(clone(update));
        }

        return {
            send: (command): void => {
                if (!attached) {
                    throw new AgentDetachedError();
                }
                if (this.isClosed) {
                    throw new ResidentAgentClosedError();
                }
                if (this.pendingCommandCount >= this.maxPendingCommands) {
                    throw new AgentCommandQueueFullError();
                }
                this.pendingCommandCount += 1;
                try {
                    this.inbound.push({
                        command: clone(command),
                        countsTowardLimit: true,
                    });
                } catch (error) {
                    this.pendingCommandCount -= 1;
                    throw error;
                }
            },
            receive: (signal): Promise<AgentUpdate> => {
                if (!attached) {
                    return Promise.reject(new AgentDetachedError());
                }
                if (this.isClosed) {
                    return Promise.reject(new ResidentAgentClosedError());
                }
                return outgoing.receive(signal);
            },
            detach: (): void => {
                if (!attached) {
                    return;
                }
                attached = false;
                this.attachments.delete(outgoing);
                outgoing.fail(new AgentDetachedError(), {
                    discardBuffered: true,
                });
            },
        };
    }

    close(): void {
        if (this.isClosed) {
            return;
        }
        // Wake an active turn before failing the engine's next receive. An
        // idle engine ignores abort, while an active one cancels its work.
        this.inbound.push({
            command: { type: "abort" },
            countsTowardLimit: false,
        });
        this.isClosed = true;
        this.pendingCommandCount = 0;
        const error = new ResidentAgentClosedError();
        this.inbound.fail(error, { discardBuffered: true });
        for (const outgoing of this.attachments) {
            outgoing.fail(error, { discardBuffered: true });
        }
        this.attachments.clear();
    }

    private broadcast(update: AgentUpdate): void {
        if (this.isClosed) {
            throw new ResidentAgentClosedError();
        }
        const snapshot = clone(update);
        if (snapshot.type === "status") {
            this.currentStatus = snapshot.state;
        } else if (snapshot.type === "user_prompt") {
            this.currentStatus = "working";
        } else if (snapshot.type === "ui_request") {
            this.currentStatus = "waiting";
        } else if (snapshot.type === "ui_request_closed") {
            this.currentStatus = "working";
        } else if (snapshot.type === "turn_finished") {
            this.currentStatus = "idle";
        }
        if (snapshot.type === "history") {
            this.checkpoint = snapshot;
            this.updatesAfterCheckpoint = [];
        } else {
            this.updatesAfterCheckpoint.push(snapshot);
        }
        for (const outgoing of this.attachments) {
            outgoing.push(clone(snapshot));
        }
    }

    get closed(): boolean {
        return this.isClosed;
    }

    get status(): AgentStatus {
        return this.currentStatus;
    }
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function nonEmpty(value: string, name: string): string {
    if (value.length === 0) {
        throw new Error(`${name} must not be empty`);
    }
    return value;
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}
