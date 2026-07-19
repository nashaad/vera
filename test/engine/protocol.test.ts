import { expect, test } from "bun:test";

import {
    createProtocolEncoder,
    parseClientCommand,
    projectTranscript,
    type AgentUpdate,
} from "../../src/engine/protocol.ts";
import {
    emptyUsage,
    type ModelMessage,
} from "../../src/model/types.ts";

const messages: ModelMessage[] = [
    {
        role: "user",
        content: [{ type: "text", text: "inspect it" }],
    },
    {
        role: "assistant",
        content: [
            { type: "thinking", text: "private reasoning" },
            { type: "text", text: "I will read it." },
            {
                type: "tool_call",
                id: "call_1",
                name: "read",
                input: { path: "note.txt" },
            },
        ],
        source: { provider: "faux", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    },
    {
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
    },
    {
        role: "user",
        content: [{ type: "text", text: "continue internally" }],
        internal: true,
    },
    {
        role: "assistant",
        content: [{ type: "text", text: "It says contents." }],
        source: { provider: "faux", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    },
];

test("stored model messages project to a client transcript", () => {
    expect(projectTranscript(messages)).toEqual([
        { kind: "user", text: "inspect it" },
        { kind: "assistant", text: "I will read it." },
        { kind: "tool", tool: "read", args: { path: "note.txt" } },
        { kind: "assistant", text: "It says contents." },
    ]);
});

test("projected tool arguments cannot mutate canonical history", () => {
    const input = { nested: { path: "note.txt" } };
    const transcript = projectTranscript([{
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_1",
            name: "read",
            input,
        }],
        source: { provider: "faux", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    }]);

    const tool = transcript[0];
    if (tool?.kind !== "tool") {
        throw new Error("Expected a projected tool call");
    }
    (tool.args.nested as { path: string }).path = "changed.txt";

    expect(input.nested.path).toBe("note.txt");
});

test("protocol checkpoints keep the current update sequence", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    protocol.checkpoint([]);
    protocol({
        type: "turn_started",
        message: {
            role: "user",
            content: [{ type: "text", text: "inspect it" }],
        },
    });
    protocol.checkpoint(messages);

    expect(updates).toEqual([
        { type: "history", entries: [], seq: 0 },
        { type: "user_prompt", content: "inspect it", seq: 1 },
        {
            type: "history",
            entries: projectTranscript(messages),
            seq: 1,
        },
    ]);
});

test("task notifications share the ordered agent update sequence", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    protocol({
        type: "task_notification",
        deliveryId: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
    });
    protocol.checkpoint([]);

    expect(updates).toEqual([
        {
            type: "task_notification",
            deliveryId: "completion:child-1",
            sourceAgentId: "child-1",
            content: "The tests pass.",
            seq: 1,
        },
        { type: "history", entries: [], seq: 1 },
    ]);
});

test("model settings results share the ordered agent update sequence", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    protocol({
        type: "model_settings_changed",
        requestId: "settings-1",
        settings: { model: "next-model", reasoningEffort: "high" },
        pending: true,
    });
    protocol({
        type: "model_settings_rejected",
        requestId: "settings-2",
        reason: "invalid",
    });

    expect(updates).toEqual([
        {
            type: "model_settings",
            requestId: "settings-1",
            settings: { model: "next-model", reasoningEffort: "high" },
            pending: true,
            seq: 1,
        },
        {
            type: "model_settings_rejected",
            requestId: "settings-2",
            reason: "invalid",
            seq: 2,
        },
    ]);
});

test("permission commands parse only known modes", () => {
    expect(parseClientCommand({
        type: "get_permissions",
        requestId: "permissions-1",
    })).toEqual({
        type: "get_permissions",
        requestId: "permissions-1",
    });
    expect(parseClientCommand({
        type: "update_permissions",
        requestId: "permissions-2",
        mode: "full_access",
    })).toEqual({
        type: "update_permissions",
        requestId: "permissions-2",
        mode: "full_access",
    });
    expect(parseClientCommand({
        type: "update_permissions",
        requestId: "permissions-3",
        mode: "always_allow",
    })).toBeUndefined();
});

test("permission results share the ordered agent update sequence", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    protocol({
        type: "permissions_changed",
        requestId: "permissions-1",
        mode: "full_access",
        pending: true,
    });
    protocol({
        type: "permissions_rejected",
        requestId: "permissions-2",
        reason: "invalid",
    });

    expect(updates).toEqual([
        {
            type: "permissions",
            requestId: "permissions-1",
            mode: "full_access",
            pending: true,
            seq: 1,
        },
        {
            type: "permissions_rejected",
            requestId: "permissions-2",
            reason: "invalid",
            seq: 2,
        },
    ]);
});

test("checkpoint commands parse only with a request and target id", () => {
    expect(parseClientCommand({
        type: "list_checkpoints",
        requestId: "checkpoints-1",
    })).toEqual({
        type: "list_checkpoints",
        requestId: "checkpoints-1",
    });
    expect(parseClientCommand({
        type: "restore_checkpoint",
        requestId: "checkpoints-2",
        checkpointId: "cp-abc",
    })).toEqual({
        type: "restore_checkpoint",
        requestId: "checkpoints-2",
        checkpointId: "cp-abc",
    });
    expect(parseClientCommand({
        type: "restore_checkpoint",
        requestId: "checkpoints-3",
        checkpointId: "",
    })).toBeUndefined();
});

test("checkpoint results share the ordered agent update sequence", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    protocol({
        type: "checkpoints_listed",
        requestId: "checkpoints-1",
        checkpoints: [
            {
                type: "checkpoint",
                timestamp: "2026-07-19T00:00:00.000Z",
                checkpointId: "cp-abc",
                path: "/work/file.ts",
                existedBefore: true,
                tool: "edit",
            },
        ],
    });
    protocol({
        type: "checkpoint_restored",
        requestId: "checkpoints-2",
        result: {
            checkpointId: "cp-abc",
            path: "/work/file.ts",
            action: "restored",
        },
    });
    protocol({
        type: "checkpoint_rejected",
        requestId: "checkpoints-3",
        reason: "not_found",
    });

    expect(updates).toEqual([
        {
            type: "checkpoints",
            requestId: "checkpoints-1",
            checkpoints: [
                {
                    type: "checkpoint",
                    timestamp: "2026-07-19T00:00:00.000Z",
                    checkpointId: "cp-abc",
                    path: "/work/file.ts",
                    existedBefore: true,
                    tool: "edit",
                },
            ],
            seq: 1,
        },
        {
            type: "checkpoint_restored",
            requestId: "checkpoints-2",
            result: {
                checkpointId: "cp-abc",
                path: "/work/file.ts",
                action: "restored",
            },
            seq: 2,
        },
        {
            type: "checkpoint_rejected",
            requestId: "checkpoints-3",
            reason: "not_found",
            seq: 3,
        },
    ]);
});
