import { randomUUID } from "node:crypto";

import { AsyncQueue } from "../engine/async-queue.ts";
import type {
    AgentStatus,
    AgentUpdate,
    ClientCommand,
    HistoryUpdate,
    TimelineReplyUpdate,
} from "../engine/protocol.ts";
import {
    isTimelineCommand,
    isTimelineReplyUpdate,
} from "../engine/protocol.ts";
import type { MessageChannel } from "../engine/message-channel.ts";
import type { EngineCommand } from "../engine/timeline-control.ts";

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
    readonly createAttachmentId?: () => string;
}

interface QueuedCommand {
    readonly command: EngineCommand;
    readonly countsTowardLimit: boolean;
}

export interface AgentAttachment
    extends MessageChannel<ClientCommand, AgentUpdate> {
    detach(): void;
}

export class ResidentAgent {
    readonly id: string;
    readonly workspace: string;
    readonly engine: MessageChannel<AgentUpdate, EngineCommand>;

    private readonly inbound = new AsyncQueue<QueuedCommand>();
    private readonly attachments = new Map<string, AsyncQueue<AgentUpdate>>();
    private readonly issuedAttachmentIds = new Set<string>();
    private checkpoint: HistoryUpdate = {
        type: "history",
        entries: [],
        seq: 0,
    };
    private updatesAfterCheckpoint: AgentUpdate[] = [];
    private currentStatus: AgentStatus = "idle";
    private lastSequence = 0;
    private isClosed = false;
    private pendingCommandCount = 0;
    private promptStarting = false;
    private readonly maxPendingCommands: number;
    private readonly createAttachmentId: () => string;

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
        this.createAttachmentId = options.createAttachmentId ?? randomUUID;
        this.engine = {
            send: (update): void => this.broadcast(update),
            receive: (signal): Promise<EngineCommand> => {
                if (this.isClosed) {
                    return Promise.reject(new ResidentAgentClosedError());
                }
                return this.inbound.receive(signal).then((queued) => {
                    if (queued.countsTowardLimit) {
                        this.pendingCommandCount -= 1;
                    }
                    if (queued.command.type === "prompt") {
                        this.promptStarting = true;
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
        const attachmentId = nonEmpty(
            this.createAttachmentId(),
            "attachment ID",
        );
        if (this.issuedAttachmentIds.has(attachmentId)) {
            throw new Error(`Attachment ID ${attachmentId} was already issued`);
        }
        let attached = true;
        this.issuedAttachmentIds.add(attachmentId);
        this.attachments.set(attachmentId, outgoing);
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
                        command: isTimelineCommand(command)
                            ? {
                                type: "owned_timeline_command",
                                ownerId: attachmentId,
                                command: clone(command),
                            }
                            : clone(command),
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
                return outgoing.receive(signal);
            },
            detach: (): void => {
                if (!attached) {
                    return;
                }
                attached = false;
                this.attachments.delete(attachmentId);
                outgoing.fail(new AgentDetachedError(), {
                    discardBuffered: true,
                });
                if (!this.isClosed) {
                    this.inbound.push({
                        command: {
                            type: "timeline_owner_detached",
                            ownerId: attachmentId,
                        },
                        countsTowardLimit: false,
                    });
                }
            },
        };
    }

    sendTimelineReply(
        ownerId: string,
        reply: TimelineReplyUpdate,
    ): void {
        const outgoing = this.attachments.get(ownerId);
        if (outgoing !== undefined && !this.isClosed) {
            outgoing.push(clone(reply));
        }
    }

    close(): void {
        this.closeWithError(new ResidentAgentClosedError(), true);
    }

    fail(failureId: string, detail: string): void {
        if (this.isClosed) {
            return;
        }
        this.broadcast({
            type: "agent_failed",
            failureId: nonEmpty(failureId, "failure ID"),
            detail: nonEmpty(detail, "failure detail"),
            seq: this.lastSequence + 1,
        });
        this.closeWithError(new ResidentAgentClosedError(), false);
    }

    private closeWithError(error: Error, discardBuffered: boolean): void {
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
        this.inbound.fail(error, { discardBuffered: true });
        for (const outgoing of this.attachments.values()) {
            outgoing.fail(error, { discardBuffered });
        }
        this.attachments.clear();
    }

    private broadcast(update: AgentUpdate): void {
        if (this.isClosed) {
            throw new ResidentAgentClosedError();
        }
        if (isTimelineReplyUpdate(update)) {
            throw new Error("Timeline replies must target one attachment");
        }
        const snapshot = clone(update);
        if ("seq" in snapshot && typeof snapshot.seq === "number") {
            this.lastSequence = Math.max(this.lastSequence, snapshot.seq);
        }
        if (snapshot.type === "status") {
            this.currentStatus = snapshot.state;
        } else if (snapshot.type === "user_prompt") {
            this.promptStarting = false;
            this.currentStatus = "working";
        } else if (snapshot.type === "ui_request") {
            this.currentStatus = "waiting";
        } else if (snapshot.type === "ui_request_closed") {
            this.currentStatus = "working";
        } else if (snapshot.type === "turn_finished") {
            this.currentStatus = "idle";
        } else if (snapshot.type === "agent_failed") {
            this.currentStatus = "idle";
        }
        if (snapshot.type === "history") {
            this.checkpoint = snapshot;
            this.updatesAfterCheckpoint = [];
        } else {
            this.updatesAfterCheckpoint.push(snapshot);
        }
        for (const outgoing of this.attachments.values()) {
            outgoing.push(clone(snapshot));
        }
    }

    get closed(): boolean {
        return this.isClosed;
    }

    get status(): AgentStatus {
        return this.currentStatus;
    }

    idleForShutdown(): boolean {
        return this.isClosed || (
            this.currentStatus === "idle"
            && !this.promptStarting
            && this.pendingCommandCount === 0
            && this.attachments.size === 0
        );
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
