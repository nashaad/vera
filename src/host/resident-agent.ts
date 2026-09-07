import { randomUUID } from "node:crypto";
import type { HostModelCatalogSettings } from "./model-catalog-settings.ts";

import { AsyncQueue } from "../engine/async-queue.ts";
import type {
    AgentStatus,
    AgentUpdate,
    ClientCommand,
    OneshotRejectedUpdate,
    OneshotResultUpdate,
    HistoryUpdate,
    ImageAttachedUpdate,
    SessionNameReplyUpdate,
    TimelineReplyUpdate,
} from "../engine/protocol.ts";
import {
    isTimelineCommand,
    isTimelineReplyUpdate,
    isSessionNameReplyUpdate,
    isOneshotReplyUpdate,
} from "../engine/protocol.ts";
import type { UiRequest } from "../engine/events.ts";
import type { MessageChannel } from "../engine/message-channel.ts";
import type { EngineCommand } from "../engine/timeline-control.ts";
import {
    scaleProjectionTo,
    type ContextMeasurement,
} from "../engine/context-measurement.ts";

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
    readonly modelCatalogFacts?: () => Pick<HostModelCatalogSettings, "providerCatalogs" | "selectionCleared">;
    readonly maxPendingCommands?: number;
    readonly clientPromptRefusal?: string | (() => string | undefined);
    readonly onClientPrompt?: () => void;
    readonly createAttachmentId?: () => string;
    readonly attachImage?: (
        path: string,
        signal: AbortSignal,
    ) => Promise<ImageAttachedUpdate["attachment"]>;
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
    private readonly attachmentListeners = new Set<
        (attached: boolean) => void
    >();
    private readonly issuedAttachmentIds = new Set<string>();
    private readonly imageAttachmentTasks = new Map<string, Set<AbortController>>();
    private checkpoint: HistoryUpdate = {
        type: "history",
        entries: [],
        seq: 0,
    };
    private lastContext: ContextMeasurement | undefined;
    private updatesAfterCheckpoint: AgentUpdate[] = [];
    private currentStatus: AgentStatus = "idle";
    private openRequests = new Map<string, UiRequest>();
    private readonly outOfBandRequests = new Set<string>();
    private currentTool: string | undefined;
    private lastSequence = 0;
    private terminalFailure: AgentUpdate | undefined;
    private isClosed = false;
    private pendingCommandCount = 0;
    private unstartedPrompts = 0;
    private deliveryTurnStarting = false;
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
        this.notifyAttachmentChanged(true);
        if (afterSequence === undefined || afterSequence < this.checkpoint.seq) {
            const replayed = clone(this.checkpoint);
            outgoing.push(this.currentStatus === "idle"
                ? replayed
                : { ...replayed, status: this.currentStatus });
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
                const refusal = typeof this.options.clientPromptRefusal === "function"
                    ? this.options.clientPromptRefusal() : this.options.clientPromptRefusal;
                if (command.type === "prompt" && refusal !== undefined) {
                    outgoing.push({
                        type: "prompt_rejected",
                        reason: refusal,
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
                            : command.type === "oneshot"
                                ? {
                                    type: "owned_oneshot_command",
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
                this.notifyAttachmentChanged(this.attachments.size > 0);
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

    sendOneshotReply(
        ownerId: string,
        reply: OneshotResultUpdate | OneshotRejectedUpdate,
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

    deliveryTurnDiscarded(): void {
        if (this.deliveryTurnStarting) {
            this.deliveryTurnStarting = false;
            this.notifyRunStateChanged();
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
        this.notifyRunStateChanged();
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
        this.notifyAttachmentChanged(false);
        for (const ownerId of this.imageAttachmentTasks.keys()) {
            this.abortImageAttachments(ownerId);
        }
        this.notifyRunStateChanged();
    }

    private broadcast(update: AgentUpdate): void {
        if (update.type === "model_settings" && this.options.modelCatalogFacts !== undefined) {
            update = { ...update, settings: { ...update.settings, ...this.options.modelCatalogFacts() } };
        }
        if (this.isClosed || this.terminalFailure !== undefined) {
            throw new ResidentAgentClosedError();
        }
        if (isTimelineReplyUpdate(update)) {
            throw new Error("Timeline replies must target one attachment");
        }
        if (isSessionNameReplyUpdate(update)) {
            throw new Error("Session name replies must target one attachment");
        }
        if (isOneshotReplyUpdate(update)) {
            throw new Error("Oneshot replies must target one attachment");
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
        if (snapshot.type === "context") {
            this.lastContext = snapshot.measurement;
        }
        const previousStatus = this.currentStatus;
        if (snapshot.type === "status") {
            this.currentStatus = snapshot.state;
            if (snapshot.state === "working") {
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
            if (
                snapshot.request.type === "user_question"
                && snapshot.request.outOfBand === true
            ) {
                this.outOfBandRequests.add(snapshot.requestId);
            } else {
                this.currentStatus = "waiting";
            }
            this.openRequests.set(snapshot.requestId, snapshot.request);
        } else if (snapshot.type === "ui_request_closed") {
            const outOfBand = this.outOfBandRequests.delete(snapshot.requestId);
            if (!outOfBand) {
                this.currentStatus = "working";
            }
            this.openRequests.delete(snapshot.requestId);
        } else if (snapshot.type === "tool_started") {
            this.currentTool = snapshot.tool;
        } else if (snapshot.type === "tool_finished") {
            this.currentTool = undefined;
        } else if (snapshot.type === "turn_finished") {
            this.currentStatus = "idle";
            this.currentTool = undefined;
            // A finished turn cannot still be waiting on an answer. Cleared here as well as on `ui_request_closed` because a turn that ends without closing its request would otherwise leave.
            this.openRequests.clear();
            this.outOfBandRequests.clear();
            if (this.startedTurnActive) {
                this.startedTurnActive = false;
            } else if (this.unstartedPrompts > 0) {
                this.unstartedPrompts -= 1;
            }
            this.deliveryTurnStarting = false;
        } else if (snapshot.type === "agent_failed") {
            this.currentStatus = "idle";
            this.currentTool = undefined;
            this.openRequests.clear();
            this.outOfBandRequests.clear();
            this.unstartedPrompts = 0;
            this.deliveryTurnStarting = false;
            this.startedTurnActive = false;
        }
        if (snapshot.type === "history") {
            if (snapshot.context?.projection !== undefined) {
                this.lastContext = snapshot.context;
            }
            this.checkpoint = withLastContextRecipe(snapshot, this.lastContext);
            this.updatesAfterCheckpoint = [];
        } else {
            this.updatesAfterCheckpoint.push(snapshot);
        }
        const outgoingUpdate = snapshot.type === "history"
            ? this.checkpoint
            : snapshot;
        for (const outgoing of this.attachments.values()) {
            outgoing.push(clone(outgoingUpdate));
        }
        if (
            this.currentStatus !== previousStatus
            && snapshot.type !== "agent_failed"
        ) {
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

    get pendingRequests(): readonly UiRequest[] {
        return [...this.openRequests.values()];
    }

    get activeTool(): string | undefined {
        return this.currentTool;
    }

    get attached(): boolean {
        return this.attachments.size > 0;
    }

    onAttachmentChanged(listener: (attached: boolean) => void): () => void {
        this.attachmentListeners.add(listener);
        return () => this.attachmentListeners.delete(listener);
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

    private notifyAttachmentChanged(attached: boolean): void {
        for (const listener of [...this.attachmentListeners]) {
            try {
                listener(attached);
            } catch {
                // Attachment bookkeeping must not change the session outcome.
            }
        }
    }
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function withLastContextRecipe(
    history: HistoryUpdate,
    lastContext: ContextMeasurement | undefined,
): HistoryUpdate {
    if (lastContext?.projection === undefined) {
        return history;
    }
    if (history.context === undefined) {
        return { ...history, context: lastContext };
    }
    if (history.context.projection !== undefined) {
        return history;
    }
    return {
        ...history,
        context: {
            ...history.context,
            projection: scaleProjectionTo(
                lastContext.projection,
                history.context.tokens,
            ),
            ...(history.context.compaction === undefined
                && lastContext.compaction !== undefined
                ? { compaction: lastContext.compaction }
                : {}),
        },
    };
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
