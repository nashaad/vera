import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    EngineEventBus,
    type TaskNotificationEvent,
} from "../../src/engine/events.ts";
import { recordDeliveryAndNotify } from "../../src/host/delivery-notifier.ts";
import { SessionStore } from "../../src/store/session-store.ts";

test("recording the same completion twice emits one notification", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-delivery-notifier-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "parent",
        cwd: root,
    });
    const events = new EngineEventBus();
    const notifications: TaskNotificationEvent[] = [];
    events.subscribe((event) => {
        if (event.type === "task_notification") {
            notifications.push(event);
        }
    });
    const delivery = {
        id: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
    };

    try {
        expect(
            await recordDeliveryAndNotify(store, events, delivery),
        ).toBe(true);
        expect(
            await recordDeliveryAndNotify(store, events, delivery),
        ).toBe(false);
        expect(store.pendingDeliveries()).toHaveLength(1);
        expect(notifications).toEqual([{
            type: "task_notification",
            deliveryId: "completion:child-1",
            sourceAgentId: "child-1",
            content: "The tests pass.",
            kind: "completion",
        }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("attention keeps its semantic kind in the live notification", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-attention-notifier-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "parent",
        cwd: root,
    });
    const events = new EngineEventBus();
    const notifications: TaskNotificationEvent[] = [];
    events.subscribe((event) => {
        if (event.type === "task_notification") notifications.push(event);
    });

    try {
        await recordDeliveryAndNotify(store, events, {
            id: "attention:child-1:message-1",
            sourceAgentId: "child-1",
            content: "Which file should I inspect?",
            kind: "attention",
        });
        expect(notifications[0]?.kind).toBe("attention");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
