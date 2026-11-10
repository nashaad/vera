import { randomUUID } from "node:crypto";

import type { SessionMessageEntry, SessionStore } from "../store/session-store.ts";
import {
    rewindConversationBefore,
    type ConversationRewindState,
} from "./conversation-rewind.ts";
import { sessionAttachmentName } from "../attachments/service.ts";
import { attachmentRefs } from "./protocol.ts";
import type {
    AttachmentNameLookup,
    ClientCommand,
    OneshotCommand,
    ProtocolEncoder,
    TimelineActionRejectionReason,
    TimelineActionPlan,
    TimelineBoundary,
    TimelineCommand,
    TimelineReplyUpdate,
    UpdateSessionNameCommand,
} from "./protocol.ts";

export interface OwnedTimelineCommand {
    readonly type: "owned_timeline_command";
    readonly ownerId: string;
    readonly command: TimelineCommand;
}

export interface TimelineOwnerDetachedCommand {
    readonly type: "timeline_owner_detached";
    readonly ownerId: string;
}

export interface TriggerDeliveryTurnCommand {
    readonly type: "trigger_delivery_turn";
}

export interface OwnedSessionNameCommand {
    readonly type: "owned_session_name_command";
    readonly ownerId: string;
    readonly command: UpdateSessionNameCommand;
}

export interface OwnedOneshotCommand {
    readonly type: "owned_oneshot_command";
    readonly ownerId: string;
    readonly command: OneshotCommand;
}

export type EngineCommand =
    | ClientCommand
    | OwnedTimelineCommand
    | OwnedSessionNameCommand
    | OwnedOneshotCommand
    | TimelineOwnerDetachedCommand
    | TriggerDeliveryTurnCommand;

interface StoredTimelinePlan {
    readonly ownerId: string;
    readonly boundaryId: string;
    readonly expectedHeadId: string;
}

export interface TimelineControllerOptions {
    readonly state: ConversationRewindState;
    readonly protocol: ProtocolEncoder;
    readonly isBlocked: () => boolean;
    readonly sendReply: (
        ownerId: string,
        reply: TimelineReplyUpdate,
    ) => void;
    readonly createPlanId?: () => string;
}

export class TimelineController {
    private readonly plans = new Map<string, StoredTimelinePlan>();
    private readonly usedPlanIds = new Set<string>();
    private readonly createPlanId: () => string;

    constructor(private readonly options: TimelineControllerOptions) {
        this.createPlanId = options.createPlanId ?? randomUUID;
    }

    async handle(ownerId: string, command: TimelineCommand): Promise<void> {
        if (command.type !== "apply_timeline_action") {
            this.expireChangedPlans();
        }
        if (command.type === "list_timeline") {
            this.send(ownerId, {
                type: "timeline",
                requestId: command.requestId,
                boundaries: await this.options.state.store.exclusively(() => timelineBoundaries(
                    this.options.state.store,
                    sessionAttachmentName(this.options.state.store),
                )),
            });
            return;
        }

        if (this.options.isBlocked()) {
            this.reject(ownerId, command.requestId, command.type, "busy");
            return;
        }
        if (command.type === "preview_timeline_action") {
            try {
                await this.preview(ownerId, command.requestId, command.boundaryId);
            } catch {
                this.reject(
                    ownerId,
                    command.requestId,
                    command.type,
                    "unavailable",
                );
            }
            return;
        }
        try {
            await this.apply(ownerId, command.requestId, command.planId);
        } catch {
            this.reject(ownerId, command.requestId, command.type, "unavailable");
        }
    }

    detachOwner(ownerId: string): void {
        for (const [planId, plan] of this.plans) {
            if (plan.ownerId === ownerId) {
                this.plans.delete(planId);
            }
        }
    }

    private async preview(
        ownerId: string,
        requestId: string,
        boundaryId: string,
    ): Promise<void> {
        const store = this.options.state.store;
        await store.exclusively(async () => {
            const headId = store.activeHeadId();
            let boundaryEntry: SessionMessageEntry | undefined;
            let boundaryIndex = -1;
            let count = 0;
            if (headId !== null) {
                for await (const entry of store.walkMessageBranch(headId)) {
                    if (isExternalUserBoundary(entry, boundaryId)) {
                        boundaryEntry = entry;
                        boundaryIndex = count;
                    }
                    count += 1;
                }
            }
            if (boundaryEntry === undefined || headId === null) {
                this.reject(ownerId, requestId, "preview_timeline_action", "boundary_missing");
                return;
            }
            const planId = this.createPlanId();
            if (planId.length === 0 || this.usedPlanIds.has(planId)) {
                throw new Error("Timeline plan IDs must be unique and non-empty");
            }
            const plan: TimelineActionPlan = {
                planId,
                expectedHeadId: headId,
                boundary: toTimelineBoundary(boundaryEntry, boundaryIndex, sessionAttachmentName(store)),
                keptMessageCount: boundaryIndex,
                setAsideMessageCount: count - boundaryIndex,
            };
            this.usedPlanIds.add(planId);
            this.plans.set(planId, { ownerId, boundaryId, expectedHeadId: headId });
            this.send(ownerId, { type: "timeline_action_preview", requestId, plan });
        });
    }

    private async apply(
        ownerId: string,
        requestId: string,
        planId: string,
    ): Promise<void> {
        const plan = this.plans.get(planId);
        if (plan === undefined) {
            this.reject(
                ownerId,
                requestId,
                "apply_timeline_action",
                "plan_expired",
            );
            return;
        }
        if (plan.ownerId !== ownerId) {
            this.reject(
                ownerId,
                requestId,
                "apply_timeline_action",
                "not_plan_owner",
            );
            return;
        }
        if (this.options.state.store.activeHeadId() !== plan.expectedHeadId) {
            this.plans.delete(planId);
            this.reject(
                ownerId,
                requestId,
                "apply_timeline_action",
                "session_changed",
            );
            return;
        }
        const boundaryExists = await this.options.state.store.exclusively(async () => {
            if (this.options.state.store.activeHeadId() !== plan.expectedHeadId) return false;
            for await (const entry of this.options.state.store.walkMessageAncestors(plan.expectedHeadId)) {
                if (isExternalUserBoundary(entry, plan.boundaryId)) return true;
            }
            return false;
        });
        if (!boundaryExists) {
            this.plans.delete(planId);
            this.reject(
                ownerId,
                requestId,
                "apply_timeline_action",
                this.options.state.store.activeHeadId() === plan.expectedHeadId ? "boundary_missing" : "session_changed",
            );
            return;
        }

        await rewindConversationBefore(
            this.options.state,
            this.options.protocol,
            plan.boundaryId,
        );
        this.plans.clear();
        this.send(ownerId, {
            type: "timeline_action_applied",
            requestId,
            planId,
        });
    }

    private reject(
        ownerId: string,
        requestId: string,
        commandType: TimelineCommand["type"],
        reason: TimelineActionRejectionReason,
    ): void {
        this.send(ownerId, {
            type: "timeline_action_rejected",
            requestId,
            operation: commandType === "preview_timeline_action"
                ? "preview"
                : "apply",
            reason,
        });
    }

    private send(
        ownerId: string,
        reply: TimelineReplyUpdate,
    ): void {
        this.options.sendReply(ownerId, reply);
    }

    private expireChangedPlans(): void {
        const activeHeadId = this.options.state.store.activeHeadId();
        for (const [planId, plan] of this.plans) {
            if (plan.expectedHeadId !== activeHeadId) {
                this.plans.delete(planId);
            }
        }
    }
}

async function timelineBoundaries(
    store: SessionStore,
    attachmentName: AttachmentNameLookup,
): Promise<TimelineBoundary[]> {
    const headId = store.activeHeadId();
    if (headId === null) return [];
    const boundaries: TimelineBoundary[] = [];
    let position = 0;
    for await (const entry of store.walkMessageBranch(headId)) {
        if (isExternalUserBoundary(entry, entry.id)) boundaries.push(toTimelineBoundary(entry, position, attachmentName));
        position += 1;
    }
    return boundaries;
}

function toTimelineBoundary(
    entry: SessionMessageEntry,
    position: number,
    attachmentName: AttachmentNameLookup,
): TimelineBoundary {
    if (entry.message.role !== "user") {
        throw new Error("Timeline boundary must be a user message");
    }
    return {
        userMessageId: entry.id,
        timestamp: entry.timestamp,
        prompt: entry.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        ...attachmentRefs(entry.message.content, attachmentName),
        position,
    };
}

function isExternalUserBoundary(
    entry: SessionMessageEntry,
    boundaryId: string,
): boolean {
    return entry.id === boundaryId
        && entry.message.role === "user"
        && entry.message.internal !== true;
}
