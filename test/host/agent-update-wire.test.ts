import { expect, test } from "bun:test";

import { parseAgentUpdate } from "../../src/host/agent-update-wire.ts";

test("host wire validates requester-owned image attachment results", () => {
    const attached = {
        type: "image_attached" as const,
        requestId: "request-1",
        attachment: {
            id: "hash.png",
            name: "screen.png",
            mediaType: "image/png",
            bytes: 3,
            width: 2,
            height: 1,
        },
    };
    expect(parseAgentUpdate(attached)).toEqual(attached);
    expect(parseAgentUpdate({ ...attached, seq: 1 })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "image_attachment_rejected",
        requestId: "request-2",
        error: "unsupported image",
    })).toEqual({
        type: "image_attachment_rejected",
        requestId: "request-2",
        error: "unsupported image",
    });
});

test("turn finished accepts an optional model error", () => {
    const update = {
        type: "turn_finished" as const,
        outcome: "error" as const,
        error: "unsupported reasoning effort",
        seq: 1,
    };

    expect(parseAgentUpdate(update)).toEqual(update);
    expect(parseAgentUpdate({ ...update, error: 42 })).toBeUndefined();
    expect(parseAgentUpdate({ ...update, error: "   " })).toBeUndefined();
});

test("host wire validates context token counts", () => {
    expect(parseAgentUpdate({
        type: "turn_finished",
        contextInputTokens: 64_500,
        seq: 1,
    })).toBeDefined();
    expect(parseAgentUpdate({
        type: "turn_finished",
        contextInputTokens: -1,
        seq: 1,
    })).toBeUndefined();
});

test("host wire validates terminal resident failures", () => {
    const update = {
        type: "agent_failed" as const,
        failureId: "failure-1",
        detail: "Resident agent stopped unexpectedly",
        seq: 2,
    };
    expect(parseAgentUpdate(update)).toEqual(update);
    expect(parseAgentUpdate({ ...update, failureId: "" })).toBeUndefined();
    expect(parseAgentUpdate({ ...update, detail: "   " })).toBeUndefined();
});

test("history accepts durable model errors", () => {
    const update = {
        type: "history" as const,
        entries: [{ kind: "error" as const, detail: "rate limited" }],
        seq: 1,
    };

    expect(parseAgentUpdate(update)).toEqual(update);
    expect(parseAgentUpdate({
        ...update,
        entries: [{ kind: "error", detail: "" }],
    })).toBeUndefined();
    expect(parseAgentUpdate({
        ...update,
        entries: [{ kind: "error", detail: "   " }],
    })).toBeUndefined();
});

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
    const availableModels = [{
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        description: "fast fallback model",
    }];
    expect(parseAgentUpdate({
        type: "model_settings",
        requestId: "settings-1",
        settings: {
            model: "next-model",
            reasoningEffort: "high",
            availableModels,
        },
        pending: true,
        seq: 8,
    })).toEqual({
        type: "model_settings",
        requestId: "settings-1",
        settings: {
            model: "next-model",
            reasoningEffort: "high",
            availableModels,
        },
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

test("host wire validates semantic command prefixes on approvals", () => {
    const approval = {
        type: "ui_request",
        requestId: "approval-1",
        request: {
            type: "tool_approval",
            toolCall: {
                id: "call-1",
                name: "bash",
                input: { command: "git push origin main" },
            },
            reason: "This command may access the network.",
            warning: "This command runs with your full user permissions.",
            commandPrefix: { tokens: ["git", "push", "origin", "main"] },
        },
        seq: 1,
    } as const;

    expect(parseAgentUpdate(approval)).toEqual(approval);
    expect(parseAgentUpdate({
        ...approval,
        request: {
            ...approval.request,
            commandPrefix: { tokens: [] },
        },
    })).toBeUndefined();
});

test("host wire validates targeted timeline replies", () => {
    const boundary = {
        userMessageId: "message-1",
        timestamp: "2026-07-19T12:00:00.000Z",
        prompt: "first request",
        position: 0,
    };
    expect(parseAgentUpdate({
        type: "timeline",
        requestId: "list-1",
        boundaries: [boundary],
    })).toEqual({
        type: "timeline",
        requestId: "list-1",
        boundaries: [boundary],
    });
    expect(parseAgentUpdate({
        type: "timeline_action_preview",
        requestId: "preview-1",
        plan: {
            planId: "plan-1",
            expectedHeadId: "message-2",
            boundary,
            keptMessageCount: 0,
            setAsideMessageCount: 2,
        },
    })?.type).toBe("timeline_action_preview");
    expect(parseAgentUpdate({
        type: "timeline_action_applied",
        requestId: "apply-1",
        planId: "plan-1",
    })?.type).toBe("timeline_action_applied");
    expect(parseAgentUpdate({
        type: "timeline_action_rejected",
        requestId: "apply-2",
        operation: "apply",
        reason: "session_changed",
    })?.type).toBe("timeline_action_rejected");

    expect(parseAgentUpdate({
        type: "timeline",
        requestId: "list-1",
        boundaries: [boundary],
        seq: 14,
    })).toBeUndefined();

    expect(parseAgentUpdate({
        type: "timeline",
        requestId: "list-1",
        boundaries: [{ ...boundary, position: -1 }],
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "timeline_action_preview",
        requestId: "preview-1",
        plan: {
            planId: "plan-1",
            expectedHeadId: "",
            boundary,
            keptMessageCount: 0,
            setAsideMessageCount: 2,
        },
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "timeline_action_rejected",
        requestId: "apply-2",
        operation: "apply",
        reason: "overwrite_files",
    })).toBeUndefined();
});
