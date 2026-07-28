import type { EngineEventBus } from "../engine/events.ts";
import type { PendingDelivery } from "../store/session-store.ts";

export interface DeliveryRecorder {
    recordDelivery(delivery: PendingDelivery): Promise<boolean>;
}

export async function recordDeliveryAndNotify(
    recorder: DeliveryRecorder,
    events: EngineEventBus,
    delivery: PendingDelivery,
): Promise<boolean> {
    const recorded = await recorder.recordDelivery(delivery);
    if (recorded) {
        events.emit({
            type: "task_notification",
            deliveryId: delivery.id,
            sourceAgentId: delivery.sourceAgentId,
            content: delivery.content,
            kind: delivery.kind ?? "completion",
        });
    }
    return recorded;
}
