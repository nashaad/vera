import { randomUUID } from "node:crypto";

import type { SessionMessageEntry } from "../store/session-store.ts";
import {
    rewindConversationBefore,
    type ConversationRewindState,
} from "./conversation-rewind.ts";
import type {
    ClientCommand,
    ProtocolEncoder,
    TimelineActionRejectionReason,
    TimelineActionPlan,
    TimelineBoundary,
    TimelineCommand,
    TimelineReplyUpdate,
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

export type EngineCommand =
    | ClientCommand
    | OwnedTimelineCommand
    | TimelineOwnerDetachedCommand;

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
                boundaries: timelineBoundaries(
                    this.options.state.store.activeEntries(),
                ),
            });
            return;
        }

        if (this.options.isBlocked()) {
            this.reject(ownerId, command.requestId, command.type, "busy");
            return;
        }
        if (command.type === "preview_timeline_action") {
            try {
                this.preview(ownerId, command.requestId, command.boundaryId);
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

    private preview(
        ownerId: string,
        requestId: string,
        boundaryId: string,
    ): void {
        const activeEntries = this.options.state.store.activeEntries();
        const boundaryIndex = activeEntries.findIndex(
            (entry) => isExternalUserBoundary(entry, boundaryId),
        );
        const expectedHeadId = this.options.state.store.activeHeadId();
        if (boundaryIndex === -1 || expectedHeadId === null) {
            this.reject(
                ownerId,
                requestId,
                "preview_timeline_action",
                "boundary_missing",
            );
            return;
        }
        const boundaryEntry = activeEntries[boundaryIndex]!;
        const planId = this.createPlanId();
        if (planId.length === 0 || this.usedPlanIds.has(planId)) {
            throw new Error("Timeline plan IDs must be unique and non-empty");
        }
        const plan: TimelineActionPlan = {
            planId,
            expectedHeadId,
            boundary: toTimelineBoundary(boundaryEntry, boundaryIndex),
            keptMessageCount: boundaryIndex,
            setAsideMessageCount: activeEntries.length - boundaryIndex,
        };
        this.usedPlanIds.add(planId);
        this.plans.set(planId, {
            ownerId,
            boundaryId,
            expectedHeadId,
        });
        this.send(ownerId, {
            type: "timeline_action_preview",
            requestId,
            plan,
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
        const boundaryExists = this.options.state.store.activeEntries().some(
            (entry) => isExternalUserBoundary(entry, plan.boundaryId),
        );
        if (!boundaryExists) {
            this.plans.delete(planId);
            this.reject(
                ownerId,
                requestId,
                "apply_timeline_action",
                "boundary_missing",
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

function timelineBoundaries(
    activeEntries: readonly SessionMessageEntry[],
): TimelineBoundary[] {
    return activeEntries.flatMap((entry, position) =>
        isExternalUserBoundary(entry, entry.id)
            ? [toTimelineBoundary(entry, position)]
            : []
    );
}

function toTimelineBoundary(
    entry: SessionMessageEntry,
    position: number,
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
        ...attachmentIds(entry.message.content),
        position,
    };
}

function attachmentIds(
    content: readonly { readonly type: string; readonly attachmentId?: string }[],
): { attachmentIds?: readonly string[] } {
    const ids = content.flatMap((block) =>
        block.type === "image_attachment" && block.attachmentId !== undefined
            ? [block.attachmentId]
            : []
    );
    return ids.length === 0 ? {} : { attachmentIds: ids };
}

function isExternalUserBoundary(
    entry: SessionMessageEntry,
    boundaryId: string,
): boolean {
    return entry.id === boundaryId
        && entry.message.role === "user"
        && entry.message.internal !== true;
}
