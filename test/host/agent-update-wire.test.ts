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

test("host wire validates permission results", () => {
    expect(parseAgentUpdate({
        type: "permissions",
        requestId: "permissions-1",
        mode: "full_access",
        pending: false,
        seq: 11,
    })).toEqual({
        type: "permissions",
        requestId: "permissions-1",
        mode: "full_access",
        pending: false,
        seq: 11,
    });
    expect(parseAgentUpdate({
        type: "permissions",
        requestId: "permissions-2",
        mode: "always_allow",
        pending: false,
        seq: 12,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "permissions_rejected",
        requestId: "permissions-3",
        reason: "unavailable",
        seq: 13,
    })).toEqual({
        type: "permissions_rejected",
        requestId: "permissions-3",
        reason: "unavailable",
        seq: 13,
    });
});

test("host wire validates checkpoint results", () => {
    const entry = {
        type: "checkpoint",
        timestamp: "2026-07-19T00:00:00.000Z",
        checkpointId: "cp-abc",
        path: "/work/file.ts",
        existedBefore: true,
        tool: "edit",
    } as const;
    expect(parseAgentUpdate({
        type: "checkpoints",
        requestId: "checkpoints-1",
        checkpoints: [entry],
        seq: 14,
    })).toEqual({
        type: "checkpoints",
        requestId: "checkpoints-1",
        checkpoints: [entry],
        seq: 14,
    });
    expect(parseAgentUpdate({
        type: "checkpoints",
        requestId: "checkpoints-2",
        checkpoints: [{ ...entry, tool: "bash" }],
        seq: 15,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "checkpoint_restored",
        requestId: "checkpoints-3",
        result: {
            checkpointId: "cp-abc",
            path: "/work/file.ts",
            action: "restored",
        },
        seq: 16,
    })).toEqual({
        type: "checkpoint_restored",
        requestId: "checkpoints-3",
        result: {
            checkpointId: "cp-abc",
            path: "/work/file.ts",
            action: "restored",
        },
        seq: 16,
    });
    expect(parseAgentUpdate({
        type: "checkpoint_restored",
        requestId: "checkpoints-4",
        result: {
            checkpointId: "cp-abc",
            path: "/work/file.ts",
            action: "deleted",
        },
        seq: 17,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "checkpoint_rejected",
        requestId: "checkpoints-5",
        reason: "conflict",
        seq: 18,
    })).toEqual({
        type: "checkpoint_rejected",
        requestId: "checkpoints-5",
        reason: "conflict",
        seq: 18,
    });
    expect(parseAgentUpdate({
        type: "checkpoint_rejected",
        requestId: "checkpoints-6",
        reason: "busy",
        seq: 19,
    })).toEqual({
        type: "checkpoint_rejected",
        requestId: "checkpoints-6",
        reason: "busy",
        seq: 19,
    });
    expect(parseAgentUpdate({
        type: "checkpoint_rejected",
        requestId: "checkpoints-7",
        reason: "invalid",
        seq: 20,
    })).toBeUndefined();
});
