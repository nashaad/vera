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

test("host wire validates requester-owned session name results", () => {
    expect(parseAgentUpdate({
        type: "session_name",
        requestId: "name-1",
        name: "Planning",
    })).toEqual({
        type: "session_name",
        requestId: "name-1",
        name: "Planning",
    });
    expect(parseAgentUpdate({
        type: "session_name",
        requestId: "name-1",
        name: null,
        seq: 1,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "session_name_rejected",
        requestId: "name-2",
        reason: "invalid",
    })).toBeDefined();
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

test("host wire accepts only complete tool presentations", () => {
    const update = {
        type: "tool_presentation" as const,
        tool: "edit",
        presentation: {
            kind: "unified_diff" as const,
            path: "notes.txt",
            patch: "--- notes.txt\n+++ notes.txt\n",
        },
        seq: 1,
    };
    expect(parseAgentUpdate(update)).toEqual(update);
    expect(parseAgentUpdate({
        ...update,
        presentation: { ...update.presentation, patch: "" },
    })).toBeUndefined();
});

test("host wire validates context measurements", () => {
    expect(parseAgentUpdate({
        type: "context",
        measurement: { tokens: 64_500, capacity: 258_000, estimated: true },
        seq: 1,
    })).toBeDefined();
    // A window is optional, but a nonsensical one is not passed through as if
    // it were absent: it would render a percentage of nothing.
    expect(parseAgentUpdate({
        type: "context",
        measurement: { tokens: 64_500, capacity: 0, estimated: true },
        seq: 1,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "context",
        measurement: { tokens: -1, estimated: true },
        seq: 1,
    })).toBeUndefined();
    // The label is what separates a counted number from a guessed one, so an
    // unlabelled measurement is refused rather than assumed exact.
    expect(parseAgentUpdate({
        type: "context",
        measurement: { tokens: 64_500 },
        seq: 1,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "history",
        entries: [],
        context: { tokens: -1, estimated: false },
        seq: 1,
    })).toBeUndefined();
});

test("host wire validates subagent model diagnostics", () => {
    const update = {
        type: "model_settings" as const,
        requestId: "settings-1",
        pending: false,
        settings: {
            model: "parent-model",
            subagentDefault: {
                mode: "fixed" as const,
                model: "child-model",
                reasoningEffort: "low",
            },
        },
        seq: 1,
    };

    expect(parseAgentUpdate(update)).toEqual(update);
    expect(parseAgentUpdate({
        ...update,
        settings: {
            ...update.settings,
            subagentDefault: { mode: "fixed" },
        },
    })).toBeUndefined();
});

test("host wire validates model activity", () => {
    const retry = {
        type: "model_activity" as const,
        phase: "retrying" as const,
        model: "openai/gpt-5.6-sol",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        retryAt: "2026-07-29T17:00:00.000Z",
        failure: {
            kind: "server" as const,
            statusCode: 503,
        },
        seq: 4,
    };

    expect(parseAgentUpdate(retry)).toEqual(retry);
    expect(parseAgentUpdate({ ...retry, nextAttempt: 4 })).toBeUndefined();
    expect(parseAgentUpdate({
        ...retry,
        failure: { ...retry.failure, kind: "made_up" },
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
    expect(parseAgentUpdate({
        type: "task_notification",
        deliveryId: "attention:child-1:message-1",
        sourceAgentId: "child-1",
        content: "Which file?",
        kind: "attention",
        seq: 8,
    })).toMatchObject({ kind: "attention" });
    expect(parseAgentUpdate({
        type: "task_notification",
        deliveryId: "attention:child-1:message-1",
        sourceAgentId: "child-1",
        content: "Which file?",
        kind: "other",
        seq: 8,
    })).toBeUndefined();
});

test("host wire validates model settings results", () => {
    const availableModels = [{
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        description: "fast fallback model",
        levels: [{ id: "high", label: "High", description: "slow and careful" }],
        defaultLevel: "high",
    }];
    const pinned = [{
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        label: "gpt-5.6-sol",
        available: false,
        levels: [],
    }];
    expect(parseAgentUpdate({
        type: "model_settings",
        requestId: "settings-1",
        settings: {
            model: "next-model",
            reasoningEffort: "high",
            availableModels,
            pinned,
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
            pinned,
        },
        pending: true,
        seq: 8,
    });
    expect(parseAgentUpdate({
        type: "model_settings",
        requestId: "settings-2",
        settings: { model: "next-model", reasoningEffort: "" },
        pending: false,
        seq: 9,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "model_settings",
        requestId: "settings-2",
        settings: {
            model: "next-model",
            availableModels: [{
                provider: "openrouter",
                model: "z-ai/glm-5.2",
                label: "GLM-5.2",
                description: "fast fallback model",
            }],
        },
        pending: false,
        seq: 9,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "model_settings",
        requestId: "settings-2",
        settings: {
            model: "next-model",
            pinned: [{
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                label: "gpt-5.6-sol",
                levels: [],
            }],
        },
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
        mode: "../always-allow",
        pending: false,
        seq: 12,
    })).toBeUndefined();
    expect(parseAgentUpdate({
        type: "permissions",
        requestId: "permissions-2",
        mode: "auto",
        pending: false,
        inspection: {
            selected: {
                name: "auto",
                rules: [],
                defaultOutcome: "review",
            },
            availableModes: ["auto"],
            activeGrants: [{ id: "", kind: "action", when: {} }],
        },
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

test("host wire migrates legacy permission inspections from a resident host", () => {
    const update = parseAgentUpdate({
        type: "permissions",
        requestId: "permissions-legacy",
        mode: "auto",
        pending: false,
        inspection: {
            selected: {
                name: "auto",
                rules: [{
                    name: "routine.read",
                    when: { capability: "read", confidence: "exact" },
                    then: "allow",
                }],
                defaultOutcome: "review",
                reviewerProfile: "default",
            },
            availableProfiles: ["auto"],
            activeGrants: [{
                id: "grant-1",
                kind: "capability",
                when: { capability: "write", confidence: "exact" },
                scope: "session",
                lifetime: "session",
            }],
        },
        seq: 1,
    });
    expect(update).toMatchObject({
        type: "permissions",
        inspection: {
            selected: {
                rules: [{ when: { verb: "read" } }],
            },
            activeGrants: [{ kind: "action", when: { verb: "write" } }],
        },
    });
});

test("host wire validates semantic session grants on approvals", () => {
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
            permissionGrants: [{
                kind: "action",
                when: { operation: "git.push" },
                scope: "session",
                lifetime: "session",
            }],
        },
        seq: 1,
    } as const;

    expect(parseAgentUpdate(approval)).toEqual(approval);
    expect(parseAgentUpdate({
        ...approval,
        request: {
            ...approval.request,
            permissionGrants: [],
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

test("host wire validates reviewer decisions", () => {
    const update = {
        type: "tool_review" as const,
        tool: "bash",
        decision: "allow" as const,
        riskLevel: "low" as const,
        userAuthorization: "unknown" as const,
        reason: "Read-only listing of a sibling project.",
        seq: 3,
    };

    expect(parseAgentUpdate(update)).toEqual(update);
    expect(parseAgentUpdate({ ...update, decision: "deny" }))
        .toEqual({ ...update, decision: "deny" });
    expect(parseAgentUpdate({ ...update, decision: "maybe" })).toBeUndefined();
    expect(parseAgentUpdate({ ...update, reason: 42 })).toBeUndefined();
    expect(parseAgentUpdate({ ...update, tool: undefined })).toBeUndefined();
    expect(parseAgentUpdate({ ...update, riskLevel: "spicy" })).toBeUndefined();
    expect(parseAgentUpdate({ ...update, userAuthorization: undefined }))
        .toBeUndefined();
});
