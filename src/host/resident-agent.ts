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
    TurnFinishedUpdate,
    CompactionUpdate,
} from "../engine/protocol.ts";
import {
    isTimelineCommand,
    isTimelineReplyUpdate,
    isSessionNameReplyUpdate,
    isOneshotReplyUpdate,
} from "../engine/protocol.ts";
import type { UiRequest } from "../engine/events.ts";
import type { MessageChannel } from "../engine/message-channel.ts";
import {
    historyPageFromEntries,
    type HistoryPageResult,
} from "./history-page.ts";
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

export class ResidentAgentTurnsHeldError extends Error {
    constructor() {
        super("Resident agent is not accepting turns while Vera stops");
        this.name = "ResidentAgentTurnsHeldError";
    }
}

export class ResidentAgentClosedError extends Error {
    constructor() {
        super("Resident agent is closed");
        this.name = "ResidentAgentClosedError";
    }
}

export class SessionBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SessionBlockedError";
    }
}

export class AgentCommandQueueFullError extends Error {
    constructor() {
        super("Resident agent command queue is full");
        this.name = "AgentCommandQueueFullError";
    }
}

export interface ResidentAgentAttachOptions {
    /** Send one bounded tail page instead of the full checkpoint. */
    readonly paging?: boolean;
    /** Send the page even when `afterSequence` already covers the checkpoint. */
    readonly forceCheckpoint?: boolean;
}

export interface ResidentAgentOptions {
    /** Reads a page outside the current checkpoint from the owner's store. */
    readonly historyPageSource?: (
        before: string,
    ) => HistoryPageResult | Promise<HistoryPageResult>;
    readonly modelCatalogFacts?: () => Pick<HostModelCatalogSettings, "providerCatalogs" | "selectionCleared">;
    readonly maxPendingCommands?: number;
    readonly clientPromptRefusal?: string | (() => string | undefined);
    /** Holds turns: a prompt throws and a delivery wake is left for the next host. */
    readonly turnsHeld?: () => boolean;
    readonly onClientPrompt?: () => void;
    readonly createAttachmentId?: () => string;
    readonly attachImage?: (
        path: string,
        signal: AbortSignal,
        sourcePath?: string,
    ) => Promise<ImageAttachedUpdate["attachment"]>;
    readonly onRunStateChanged?: () => void;
    /** Called after attached clients have the update. */
    readonly onTurnFinished?: (update: TurnFinishedUpdate) => void;
    /** Called after attached clients have the started update. */
    readonly onCompactionStarted?: (update: CompactionUpdate) => void;
    /** Called after an update that may change status, the open request, or context. */
    readonly onSessionFactsChanged?: (update: AgentUpdate) => void;
    /** Returns the refusal text while the session is blocked; read at each turn start. */
    readonly turnStartRefusal?: () => string | undefined;
}

const SESSION_FACT_UPDATES: ReadonlySet<AgentUpdate["type"]> = new Set([
    "status",
    "user_prompt",
    "ui_request",
    "ui_request_closed",
    "context",
    "turn_finished",
    "agent_failed",
    "history",
]);

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
    private readonly pagingAttachments = new Set<string>();
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
    // Wakes the engine took that have neither started a turn nor been discarded; one may sit queued behind a running turn.
    private outstandingDeliveryWakes = 0;
    private startedTurnActive = false;
    private deliveryTurnQueued = false;
    // While the engine's router is halted it drops prompts, so the host does not count them.
    private routerHalted = false;
    // A worker clears its own halt after the cut turn ends, which the host sees as turn_finished.
    private haltClearsOnTurnFinish = false;
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
                // No isClosed guard: the abort buffered by close must still be delivered.
                return this.inbound.receive(signal).then((queued) => {
                    if (queued.countsTowardLimit) {
                        this.pendingCommandCount -= 1;
                    }
                    if (queued.command.type === "prompt" && !this.routerHalted) {
                        this.unstartedPrompts += 1;
                    }
                    if (queued.command.type === "trigger_delivery_turn") {
                        this.deliveryTurnQueued = false;
                        this.outstandingDeliveryWakes += 1;
                    }
                    return queued.command;
                });
            },
        };
    }

    attach(
        afterSequence?: number,
        options: ResidentAgentAttachOptions = {},
    ): AgentAttachment {
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
        const paging = options.paging === true;
        if (paging) {
            this.pagingAttachments.add(attachmentId);
        }
        this.notifyAttachmentChanged(true);
        if (
            paging
            || options.forceCheckpoint === true
            || afterSequence === undefined
            || afterSequence < this.checkpoint.seq
        ) {
            const replayed = paging
                ? pagedTail(this.checkpoint)
                : clone(this.checkpoint);
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
                const refusal = this.options.turnStartRefusal?.() ?? (typeof this.options.clientPromptRefusal === "function"
                    ? this.options.clientPromptRefusal() : this.options.clientPromptRefusal);
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
                        command.sourcePath,
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
                this.pagingAttachments.delete(attachmentId);
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
        const blocked = this.options.turnStartRefusal?.();
        if (blocked !== undefined) {
            throw new SessionBlockedError(blocked);
        }
        if (this.options.turnsHeld?.() === true) {
            throw new ResidentAgentTurnsHeldError();
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

    // Persisted by the engine, which then pushes history to attached clients.
    appendHarnessMessage(text: string, tone: "primary" | "soft" | "error"): void {
        if (this.isClosed || this.terminalFailure !== undefined) return;
        this.inbound.push({
            command: { type: "append_harness_message", text, tone },
            countsTowardLimit: false,
        });
    }

    triggerDeliveryTurn(): void {
        if (this.isClosed || this.terminalFailure !== undefined) {
            throw new ResidentAgentClosedError();
        }
        // The deliveries stay in the store: a blocked session does not wake for them, and a held one is woken by the next host.
        if (
            this.options.turnStartRefusal?.() !== undefined
            || this.options.turnsHeld?.() === true
        ) {
            return;
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

    // The router dropped its queued prompts and wakes on halt, so none of them is still outstanding.
    noteRouterHalted(clearsOnTurnFinish: boolean): void {
        if (this.routerHalted) {
            // A block over a cut must hold until released, so only a cut-and-cut keeps the turn-finish release.
            this.haltClearsOnTurnFinish = this.haltClearsOnTurnFinish && clearsOnTurnFinish;
            return;
        }
        this.routerHalted = true;
        this.haltClearsOnTurnFinish = clearsOnTurnFinish;
        this.unstartedPrompts = 0;
        this.outstandingDeliveryWakes = 0;
        this.deliveryTurnQueued = false;
        this.notifyRunStateChanged();
    }

    noteRouterCleared(): void {
        this.routerHalted = false;
        this.haltClearsOnTurnFinish = false;
    }

    deliveryTurnDiscarded(): void {
        if (this.outstandingDeliveryWakes > 0) {
            this.outstandingDeliveryWakes -= 1;
            if (this.outstandingDeliveryWakes === 0) {
                this.notifyRunStateChanged();
            }
        }
    }

    private async attachImage(
        ownerId: string,
        requestId: string,
        path: string,
        sourcePath: string | undefined,
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
                sourcePath,
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

    // Cancels the running turn only; queued prompts stay queued.
    abort(): void {
        if (this.isClosed || this.terminalFailure !== undefined) return;
        this.inbound.push({
            command: { type: "abort" },
            countsTowardLimit: false,
        });
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
        // Clear before pushing: a detach just before close can leave the engine not waiting, so the abort is buffered.
        this.inbound.clear();
        if (this.terminalFailure === undefined) {
            this.inbound.push({
                command: { type: "abort" },
                countsTowardLimit: false,
            });
        }
        this.isClosed = true;
        this.pendingCommandCount = 0;
        this.inbound.fail(error);
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
                // The start settles the one wake it was claimed for; a later wake stays outstanding.
                if (this.outstandingDeliveryWakes > 0) {
                    this.outstandingDeliveryWakes -= 1;
                }
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
            // A turn that ends without announcing its start is a prompt, or a wake whose images failed to load. With both outstanding the prompt is assumed.
            if (this.startedTurnActive) {
                this.startedTurnActive = false;
            } else if (this.unstartedPrompts > 0) {
                this.unstartedPrompts -= 1;
            } else if (this.outstandingDeliveryWakes > 0) {
                this.outstandingDeliveryWakes -= 1;
            }
            if (this.haltClearsOnTurnFinish) {
                this.noteRouterCleared();
            }
        } else if (snapshot.type === "agent_failed") {
            this.currentStatus = "idle";
            this.currentTool = undefined;
            this.openRequests.clear();
            this.outOfBandRequests.clear();
            this.unstartedPrompts = 0;
            this.outstandingDeliveryWakes = 0;
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
        for (const [attachmentId, outgoing] of this.attachments) {
            if (outgoingUpdate.type === "history") {
                // History is read-only on the way out; sharing it avoids one
                // full clone per attachment. Paging clients get a bounded tail.
                outgoing.push(this.pagingAttachments.has(attachmentId)
                    ? pagedTail(outgoingUpdate)
                    : outgoingUpdate);
            } else {
                outgoing.push(clone(outgoingUpdate));
            }
        }
        if (
            this.currentStatus !== previousStatus
            && snapshot.type !== "agent_failed"
        ) {
            this.notifyRunStateChanged();
        }
        if (snapshot.type === "turn_finished") {
            try {
                this.options.onTurnFinished?.(clone(snapshot));
            } catch {
                // A listener that throws must not break the update it observed.
            }
        }
        if (snapshot.type === "compaction" && snapshot.phase === "started") {
            try {
                this.options.onCompactionStarted?.(clone(snapshot));
            } catch {
                // A listener that throws must not break the update it observed.
            }
        }
        if (SESSION_FACT_UPDATES.has(snapshot.type)) {
            try {
                this.options.onSessionFactsChanged?.(snapshot);
            } catch {
                // A listener that throws must not break the update it observed.
            }
        }
    }

    async historyPage(before: string): Promise<HistoryPageResult> {
        const fromCheckpoint = historyPageFromEntries(
            this.checkpoint.entries,
            before,
        );
        if (fromCheckpoint.kind !== "cursor_not_found") {
            return fromCheckpoint;
        }
        if (this.options.historyPageSource === undefined) {
            return fromCheckpoint;
        }
        return this.options.historyPageSource(before);
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

    /** The oldest open request that holds the turn; out-of-band questions do not. */
    get waitingRequest(): UiRequest | undefined {
        for (const [requestId, request] of this.openRequests) {
            if (!this.outOfBandRequests.has(requestId)) {
                return request;
            }
        }
        return undefined;
    }

    get context(): ContextMeasurement | undefined {
        return this.lastContext;
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

    hasPendingTurn(): boolean {
        return this.currentStatus !== "idle"
            || this.unstartedPrompts > 0
            || this.outstandingDeliveryWakes > 0
            || this.deliveryTurnQueued;
    }

    idleForReplacement(): boolean {
        return this.isClosed || this.terminalFailure !== undefined || (
            this.currentStatus === "idle"
            && this.unstartedPrompts === 0
            && this.outstandingDeliveryWakes === 0
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

function pagedTail(history: HistoryUpdate): HistoryUpdate {
    const result = historyPageFromEntries(
        history.entries,
        undefined,
        { allowOversizedTail: true },
    );
    if (result.kind !== "page") {
        throw new Error("The history tail page could not be built");
    }
    return { ...history, entries: result.entries, page: result.page };
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
