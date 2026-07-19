import { expect, test } from "bun:test";

import { parseAgentUpdate } from "../../src/host/agent-update-wire.ts";

test("host wire validates task notifications", () => {
    expect(parseAgentUpdate({
        type: "task_notification",
        deliveryId: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
        seq: 7,
    })).toEqual({
        type: "task_notification",
        deliveryId: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
        seq: 7,
    });
    expect(parseAgentUpdate({
        type: "task_notification",
        deliveryId: "",
        sourceAgentId: "child-1",
        content: "The tests pass.",
        seq: 7,
    })).toBeUndefined();
});

test("host wire validates model settings results", () => {
    expect(parseAgentUpdate({
        type: "model_settings",
        requestId: "settings-1",
        settings: { model: "next-model", reasoningEffort: "high" },
        pending: true,
        seq: 8,
    })).toEqual({
        type: "model_settings",
        requestId: "settings-1",
        settings: { model: "next-model", reasoningEffort: "high" },
        pending: true,
        seq: 8,
    });
    expect(parseAgentUpdate({
        type: "model_settings",
        requestId: "settings-2",
        settings: { model: "next-model", reasoningEffort: "turbo" },
        pending: false,
        seq: 9,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "model_settings_rejected",
        requestId: "settings-3",
        reason: "invalid",
        seq: 10,
    })).toEqual({
        type: "model_settings_rejected",
        requestId: "settings-3",
        reason: "invalid",
        seq: 10,
    });
});
