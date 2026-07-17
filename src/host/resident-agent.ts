import { AsyncQueue } from "../engine/async-queue.ts";
import type {
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

export interface AgentAttachment
    extends MessageChannel<ClientCommand, AgentUpdate> {
    detach(): void;
}

export class ResidentAgent {
    readonly id: string;
    readonly workspace: string;
    readonly engine: MessageChannel<AgentUpdate, ClientCommand>;

    private readonly inbound = new AsyncQueue<ClientCommand>();
    private readonly attachments = new Set<AsyncQueue<AgentUpdate>>();
    private checkpoint: HistoryUpdate = {
        type: "history",
        entries: [],
        seq: 0,
    };
    private updatesAfterCheckpoint: AgentUpdate[] = [];
    private closed = false;

    constructor(id: string, workspace: string) {
        this.id = nonEmpty(id, "agent ID");
        this.workspace = nonEmpty(workspace, "agent workspace");
        this.engine = {
            send: (update): void => this.broadcast(update),
            receive: (signal): Promise<ClientCommand> => {
                if (this.closed) {
                    return Promise.reject(new ResidentAgentClosedError());
                }
                return this.inbound.receive(signal);
            },
        };
    }

    attach(): AgentAttachment {
        if (this.closed) {
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
                if (this.closed) {
                    throw new ResidentAgentClosedError();
                }
                this.inbound.push(clone(command));
            },
            receive: (signal): Promise<AgentUpdate> => {
                if (!attached) {
                    return Promise.reject(new AgentDetachedError());
                }
                if (this.closed) {
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
                outgoing.fail(new AgentDetachedError());
            },
        };
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const error = new ResidentAgentClosedError();
        this.inbound.fail(error);
        for (const outgoing of this.attachments) {
            outgoing.fail(error);
        }
        this.attachments.clear();
    }

    private broadcast(update: AgentUpdate): void {
        if (this.closed) {
            throw new ResidentAgentClosedError();
        }
        const snapshot = clone(update);
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
