import type { ToolApprovalUiRequestUpdate } from "../../engine/protocol.ts";
import { SessionStore, type PendingDelivery } from "../../store/session-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { recordDeliveryAndNotify } from "../delivery-notifier.ts";
import type { ParentDeliveryOutcome } from "./subagent-services.ts";
import { relayChildToolApproval } from "./subagent.ts";

export async function notifyParent(reg: AgentRegistry, parentId: string, delivery: PendingDelivery): Promise<boolean> {
    const parent = reg.agents.get(parentId);
    if (parent === undefined || parent.agent.closed || parent.agent.failed) return false;
    await recordDeliveryAndNotify(parent.store, parent.events, delivery);
    parent.agent.triggerDeliveryTurn();
    return true;
}

export async function deliverCompletion(reg: AgentRegistry, parentId: string, delivery: PendingDelivery, parentPath?: string): Promise<ParentDeliveryOutcome> {
    const parent = reg.agents.get(parentId);
    if (parent === undefined) {
        if (parentPath === undefined) return "unavailable";
        const store = await SessionStore.open(parentPath);
        return await store.recordDelivery(delivery) ? "recorded" : "duplicate";
    }
    if (reg.closingCompletionRecipients.has(parent.store)) return "suppressed";
    const recorded = await recordDeliveryAndNotify(parent.store, parent.events, delivery);
    if (recorded && !parent.agent.closed && !parent.agent.failed) parent.agent.triggerDeliveryTurn();
    return recorded ? "recorded" : "duplicate";
}

export async function completionFailure(reg: AgentRegistry, parentId: string, delivery: PendingDelivery): Promise<void> {
    const parent = reg.agents.get(parentId);
    if (parent === undefined || parent.agent.closed) return;
    parent.events.emit({
        type: "task_notification", deliveryId: delivery.id, sourceAgentId: delivery.sourceAgentId,
        content: delivery.content, kind: "completion",
    });
}

export async function childApproval(reg: AgentRegistry, parentId: string, update: ToolApprovalUiRequestUpdate, childId: string, task: string): Promise<"allow_once" | "deny"> {
    const parent = reg.agents.get(parentId);
    return parent === undefined ? "deny" : relayChildToolApproval(reg, parent, update, childId, task);
}
