import { randomUUID } from "node:crypto";

import { AsyncQueue } from "../engine/async-queue.ts";
import type {
    AgentStatus,
    AgentUpdate,
    ClientCommand,
    ConsultRejectedUpdate,
    ConsultResultUpdate,
    HistoryUpdate,
    ImageAttachedUpdate,
    SessionNameReplyUpdate,
    TimelineReplyUpdate,
} from "../engine/protocol.ts";
import {
    isTimelineCommand,
    isTimelineReplyUpdate,
    isSessionNameReplyUpdate,
    isConsultReplyUpdate,
} from "../engine/protocol.ts";
import type { UiRequest } from "../engine/events.ts";
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
    /**
     * Why an attached client may not prompt this agent, when it may not.
     *
     * A bounded run's turn belongs to whoever started it. Clients still
     * attach and read everything; the refusal is what keeps watching from
     * becoming steering.
     */
    readonly clientPromptRefusal?: string;
    /**
     * Called when an attached client prompts this session. The host uses it to
     * forget how deep a chain of peer messages had reached: a person typing is
     * a new starting point, not another hop.
     */
    readonly onClientPrompt?: () => void;
    readonly createAttachmentId?: () => string;
    readonly attachImage?: (
        path: string,
        signal: AbortSignal,
    ) => Promise<ImageAttachedUpdate["attachment"]>;
    /**
     * Called when this agent starts or stops running, and when it closes.
     *
     * The host reports background work to attached clients, and `status` is
     * the only thing that decides whether a background session counts as
     * running. Without this the answer would have to be polled.
     */
    readonly onRunStateChanged?: () => void;
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
    private readonly imageAttachmentTasks = new Map<string, Set<AbortController>>();
    private checkpoint: HistoryUpdate = {
        type: "history",
        entries: [],
        seq: 0,
    };
    private updatesAfterCheckpoint: AgentUpdate[] = [];
    private currentStatus: AgentStatus = "idle";
    // What this agent is blocked on and what it is doing, kept because the
    // buffered updates that carry those facts are addressed to attachments and
    // an unattended session has none. Both are recomputed from the same
    // updates every client sees, so nothing here can outlive the fact.
    private openRequests = new Map<string, UiRequest>();
    private currentTool: string | undefined;
    private lastSequence = 0;
    private terminalFailure: AgentUpdate | undefined;
    private isClosed = false;
    private pendingCommandCount = 0;
    // Turns the engine has taken off the inbound queue but has not been seen
    // starting yet. Counted, not flagged: the router drains the queue eagerly,
    // so several prompts can be accepted before the first one starts, and a
    // flag would let one prompt clear another's pending state.
    private unstartedPrompts = 0;
    private deliveryTurnStarting = false;
    // True between a turn's start update and its turn_finished. A
    // turn_finished with no started turn is a turn that died before starting
    // (a failed attachment hydration), so it retires an unstarted prompt.
    private startedTurnActive = false;
    private deliveryTurnQueued = false;
    private readonly maxPendingCommands: number;
    private readonly createAttachmentId: () => string;

    constructor(
        id: string,
        workspace: string,
        private readonly options: ResidentAgentOptions = {},
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
                        this.unstartedPrompts += 1;
                    }
                    if (queued.command.type === "trigger_delivery_turn") {
                        this.deliveryTurnQueued = false;
                        this.deliveryTurnStarting = true;
                    }
                    return queued.command;
                });
            },
        };
    }

    attach(afterSequence?: number): AgentAttachment {
        if (this.isClosed) {
            throw new ResidentAgentClosedError();
        }
        if (afterSequence !== undefined
            && (!Number.isSafeInteger(afterSequence)
                || afterSequence < 0
                || afterSequence > this.lastSequence)) {
            throw new Error("Agent replay cursor is unavailable");
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
        if (afterSequence === undefined || afterSequence < this.checkpoint.seq) {
            outgoing.push(clone(this.checkpoint));
        }
        for (const update of this.updatesAfterCheckpoint) {
            if (afterSequence === undefined
                || !("seq" in update)
                || update.seq > afterSequence) {
                outgoing.push(clone(update));
            }
        }
        if (this.terminalFailure !== undefined) {
            outgoing.fail(new ResidentAgentClosedError());
        }

        return {
            send: (command): void => {
                if (!attached) {
                    throw new AgentDetachedError();
                }
                if (this.isClosed || this.terminalFailure !== undefined) {
                    throw new ResidentAgentClosedError();
                }
                if (
                    command.type === "prompt"
                    && this.options.clientPromptRefusal !== undefined
                ) {
                    outgoing.push({
                        type: "prompt_rejected",
                        reason: this.options.clientPromptRefusal,
                    });
                    return;
                }
                if (command.type === "prompt") {
                    this.options.onClientPrompt?.();
                }
                if (command.type === "attach_image") {
                    void this.attachImage(
                        attachmentId,
                        command.requestId,
                        command.path,
                    );
                    return;
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
                            : command.type === "update_session_name"
                                ? {
                                    type: "owned_session_name_command",
                                    ownerId: attachmentId,
                                    command: clone(command),
                                }
                            : command.type === "consult"
                                ? {
                                    type: "owned_consult_command",
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
                this.abortImageAttachments(attachmentId);
                outgoing.fail(new AgentDetachedError(), {
                    discardBuffered: true,
                });
                if (!this.isClosed && this.terminalFailure === undefined) {
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

    sendConsultReply(
        ownerId: string,
        reply: ConsultResultUpdate | ConsultRejectedUpdate,
    ): void {
        const outgoing = this.attachments.get(ownerId);
        if (outgoing !== undefined && !this.isClosed) {
            outgoing.push(clone(reply));
        }
    }

    sendSessionNameReply(
        ownerId: string,
        reply: SessionNameReplyUpdate,
    ): void {
        const outgoing = this.attachments.get(ownerId);
        if (outgoing !== undefined && !this.isClosed) {
            outgoing.push(clone(reply));
        }
    }

    sendPrompt(content: string): void {
        if (this.isClosed || this.terminalFailure !== undefined) {
            throw new ResidentAgentClosedError();
        }
        if (this.pendingCommandCount >= this.maxPendingCommands) {
            throw new AgentCommandQueueFullError();
        }
        this.pendingCommandCount += 1;
        try {
            this.inbound.push({
                command: { type: "prompt", content },
                countsTowardLimit: true,
            });
        } catch (error) {
            this.pendingCommandCount -= 1;
            throw error;
        }
    }

    triggerDeliveryTurn(): void {
        if (this.isClosed || this.terminalFailure !== undefined) {
            throw new ResidentAgentClosedError();
        }
        if (this.deliveryTurnQueued) {
            return;
        }
        this.deliveryTurnQueued = true;
        try {
            this.inbound.push({
                command: { type: "trigger_delivery_turn" },
                countsTowardLimit: false,
            });
        } catch (error) {
            this.deliveryTurnQueued = false;
            throw error;
        }
    }

    private async attachImage(
        ownerId: string,
        requestId: string,
        path: string,
    ): Promise<void> {
        const outgoing = this.attachments.get(ownerId);
        if (outgoing === undefined || this.isClosed) return;
        const controller = new AbortController();
        const tasks = this.imageAttachmentTasks.get(ownerId) ?? new Set();
        tasks.add(controller);
        this.imageAttachmentTasks.set(ownerId, tasks);
        try {
            const attachment = await this.options.attachImage?.(
                path,
                controller.signal,
            );
            if (attachment === undefined) {
                throw new Error("Image attachments are unavailable");
            }
            if (this.attachments.get(ownerId) === outgoing && !this.isClosed) {
                outgoing.push({
                    type: "image_attached",
                    requestId,
                    attachment: clone(attachment),
                });
            }
        } catch (error) {
            if (this.attachments.get(ownerId) === outgoing && !this.isClosed) {
                outgoing.push({
                    type: "image_attachment_rejected",
                    requestId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        } finally {
            tasks.delete(controller);
            if (tasks.size === 0) this.imageAttachmentTasks.delete(ownerId);
        }
    }

    private abortImageAttachments(ownerId: string): void {
        for (const controller of this.imageAttachmentTasks.get(ownerId) ?? []) {
            controller.abort();
        }
        this.imageAttachmentTasks.delete(ownerId);
    }

    close(): void {
        this.closeWithError(new ResidentAgentClosedError(), true);
    }

    fail(failureId: string, detail: string): void {
        if (this.isClosed || this.terminalFailure !== undefined) {
            return;
        }
        const failure = {
            type: "agent_failed",
            failureId: nonEmpty(failureId, "failure ID"),
            detail: nonEmpty(detail, "failure detail"),
            seq: this.lastSequence + 1,
        } as const;
        this.broadcast(failure);
        this.terminalFailure = failure;
        const error = new ResidentAgentClosedError();
        this.pendingCommandCount = 0;
        this.inbound.fail(error, { discardBuffered: true });
        for (const outgoing of this.attachments.values()) {
            outgoing.fail(error);
        }
    }

    restoreFailure(
        history: HistoryUpdate,
        failureId: string,
        detail: string,
    ): void {
        if (this.isClosed || this.terminalFailure !== undefined) {
            throw new ResidentAgentClosedError();
        }
        this.checkpoint = clone(history);
        this.updatesAfterCheckpoint = [];
        this.lastSequence = history.seq;
        this.fail(failureId, detail);
    }

    private closeWithError(error: Error, discardBuffered: boolean): void {
        if (this.isClosed) {
            return;
        }
        // Wake an active turn before failing the engine's next receive. An
        // idle engine ignores abort, while an active one cancels its work.
        if (this.terminalFailure === undefined) {
            this.inbound.push({
                command: { type: "abort" },
                countsTowardLimit: false,
            });
        }
        this.isClosed = true;
        this.pendingCommandCount = 0;
        this.inbound.fail(error, { discardBuffered: true });
        for (const outgoing of this.attachments.values()) {
            outgoing.fail(error, { discardBuffered });
        }
        this.attachments.clear();
        for (const ownerId of this.imageAttachmentTasks.keys()) {
            this.abortImageAttachments(ownerId);
        }
        this.notifyRunStateChanged();
    }

    private broadcast(update: AgentUpdate): void {
        if (this.isClosed || this.terminalFailure !== undefined) {
            throw new ResidentAgentClosedError();
        }
        if (isTimelineReplyUpdate(update)) {
            throw new Error("Timeline replies must target one attachment");
        }
        if (isSessionNameReplyUpdate(update)) {
            throw new Error("Session name replies must target one attachment");
        }
        if (isConsultReplyUpdate(update)) {
            throw new Error("Consult replies must target one attachment");
        }
        if (
            update.type === "image_attached"
            || update.type === "image_attachment_rejected"
        ) {
            throw new Error("Image attachment replies must target one attachment");
        }
        if (update.type === "prompt_rejected") {
            throw new Error("Prompt refusals must target one attachment");
        }
        if (!Number.isSafeInteger(update.seq) || update.seq < 0) {
            throw new Error(
                "Invalid resident update sequence: expected a non-negative safe integer",
            );
        }
        const expectedSequence = update.type === "history"
            ? this.lastSequence
            : this.lastSequence + 1;
        if (update.seq !== expectedSequence) {
            throw new Error(
                `Invalid resident update sequence: expected ${expectedSequence}, received ${update.seq}`,
            );
        }
        const snapshot = clone(update);
        this.lastSequence = snapshot.seq;
        const previousStatus = this.currentStatus;
        if (snapshot.type === "status") {
            this.currentStatus = snapshot.state;
            if (snapshot.state === "working") {
                // The only status update the engine sends is the one that
                // opens a delivery turn.
                this.deliveryTurnStarting = false;
                this.startedTurnActive = true;
            }
        } else if (snapshot.type === "user_prompt") {
            if (this.unstartedPrompts > 0) {
                this.unstartedPrompts -= 1;
            }
            this.startedTurnActive = true;
            this.currentStatus = "working";
        } else if (snapshot.type === "ui_request") {
            this.currentStatus = "waiting";
            this.openRequests.set(snapshot.requestId, snapshot.request);
        } else if (snapshot.type === "ui_request_closed") {
            this.currentStatus = "working";
            this.openRequests.delete(snapshot.requestId);
        } else if (snapshot.type === "tool_started") {
            this.currentTool = snapshot.tool;
        } else if (snapshot.type === "tool_finished") {
            this.currentTool = undefined;
        } else if (snapshot.type === "turn_finished") {
            this.currentStatus = "idle";
            this.currentTool = undefined;
            // A finished turn cannot still be waiting on an answer. Cleared
            // here as well as on `ui_request_closed` because a turn that ends
            // without closing its request would otherwise leave the session
            // reading as needing someone for the rest of the host's life.
            this.openRequests.clear();
            if (this.startedTurnActive) {
                this.startedTurnActive = false;
            } else if (this.unstartedPrompts > 0) {
                this.unstartedPrompts -= 1;
            }
            // A wake taken off the queue before this boundary either opens the
            // next delivery turn, which sends its own status update, or is
            // discarded because this turn already drained the delivery. The
            // discard is silent, so the turn boundary is the only place the
            // host can retire it.
            this.deliveryTurnStarting = false;
        } else if (snapshot.type === "agent_failed") {
            this.currentStatus = "idle";
            this.currentTool = undefined;
            this.openRequests.clear();
            this.unstartedPrompts = 0;
            this.deliveryTurnStarting = false;
            this.startedTurnActive = false;
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
        if (this.currentStatus !== previousStatus) {
            this.notifyRunStateChanged();
        }
    }

    private notifyRunStateChanged(): void {
        try {
            this.options.onRunStateChanged?.();
        } catch {
            // A listener that throws must not break the update it observed.
        }
    }

    get closed(): boolean {
        return this.isClosed;
    }

    get failed(): boolean {
        return this.terminalFailure !== undefined;
    }

    get status(): AgentStatus {
        return this.currentStatus;
    }

    /**
     * The requests this agent is blocked on, oldest first.
     *
     * Read-only and a copy: a caller asks what is open so it can say so, and
     * answering a request stays the attachment's job.
     */
    get pendingRequests(): readonly UiRequest[] {
        return [...this.openRequests.values()];
    }

    /** The tool in flight right now, absent when none is. */
    get activeTool(): string | undefined {
        return this.currentTool;
    }

    get attached(): boolean {
        return this.attachments.size > 0;
    }

    idleForShutdown(): boolean {
        return this.idleForReplacement()
            && this.attachments.size === 0;
    }

    idleForReplacement(): boolean {
        return this.isClosed || this.terminalFailure !== undefined || (
            this.currentStatus === "idle"
            && this.unstartedPrompts === 0
            && !this.deliveryTurnStarting
            && !this.deliveryTurnQueued
            && this.pendingCommandCount === 0
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
