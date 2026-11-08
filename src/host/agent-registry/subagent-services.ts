import type { ToolApprovalUiRequestUpdate } from "../../engine/protocol.ts";
import type { PendingDelivery } from "../../store/session-store.ts";
import type { MessageSubagentEffect, ToolOutput } from "../../tools/types.ts";
import type { CloseAgentOutcome } from "../server.ts";

export type ParentDeliveryOutcome = "recorded" | "duplicate" | "suppressed" | "unavailable";

export interface SubagentAdmission {
    reserveSubagentStart(parentId: string, limit: number): Promise<boolean>;
    releaseSubagentStart(parentId: string): Promise<void>;
}

export interface SubagentSessionServices {
    messageSubagent(parentId: string, effect: MessageSubagentEffect): Promise<ToolOutput>;
    closeSubagent(callerId: string, targetId: string): Promise<CloseAgentOutcome>;
    notifyParent(parentId: string, delivery: PendingDelivery): Promise<boolean>;
    deliverCompletion(parentId: string, delivery: PendingDelivery, parentPath?: string): Promise<ParentDeliveryOutcome>;
    completionFailure(parentId: string, delivery: PendingDelivery): Promise<void>;
    childApproval(parentId: string, update: ToolApprovalUiRequestUpdate, childId: string, task: string): Promise<"allow_once" | "deny">;
    parentClosing(parentId: string): Promise<boolean>;
}
