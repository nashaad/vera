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

test("attachment IDs remain ordered across commands and transcript projection", () => {
    expect(parseClientCommand({
        type: "prompt",
        content: "compare",
        attachmentIds: ["one.png", "one.png", "two.png"],
    })).toEqual({
        type: "prompt",
        content: "compare",
        attachmentIds: ["one.png", "one.png", "two.png"],
    });
    expect(projectTranscript([{
        role: "user",
        content: [
            { type: "text", text: "compare" },
            { type: "image_attachment", attachmentId: "one.png" },
            { type: "image_attachment", attachmentId: "two.png" },
        ],
    }])).toEqual([{
        kind: "user",
        text: "compare",
        attachmentIds: ["one.png", "two.png"],
    }]);
});

test("image attachment requests require a request ID and nonempty path", () => {
    expect(parseClientCommand({
        type: "attach_image",
        requestId: "image-1",
        path: "/tmp/screen.png",
    })).toEqual({
        type: "attach_image",
        requestId: "image-1",
        path: "/tmp/screen.png",
    });
    expect(parseClientCommand({
        type: "attach_image",
        requestId: "",
        path: "/tmp/screen.png",
    })).toBeUndefined();
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

test("terminal model errors survive transcript checkpoints", () => {
    expect(projectTranscript([{
        role: "assistant",
        content: [{ type: "text", text: "Partial answer." }],
        source: { provider: "faux", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: "rate limited after retries",
    }])).toEqual([
        { kind: "assistant", text: "Partial answer." },
        { kind: "error", detail: "rate limited after retries" },
    ]);

    expect(projectTranscript([{
        role: "assistant",
        content: [],
        source: { provider: "faux", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "error",
    }])).toEqual([{ kind: "error" }]);
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

test("user question responses parse selected choices and cancellation", () => {
    expect(parseClientCommand({
        type: "ui_response",
        requestId: "question-1",
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "choice-2",
        },
    })).toEqual({
        type: "ui_response",
        requestId: "question-1",
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "choice-2",
        },
    });
    expect(parseClientCommand({
        type: "ui_response",
        requestId: "question-2",
        response: {
            type: "user_question",
            outcome: "cancelled",
        },
    })).toEqual({
        type: "ui_response",
        requestId: "question-2",
        response: {
            type: "user_question",
            outcome: "cancelled",
        },
    });
});

test("malformed user question responses are rejected", () => {
    const malformed = [
        {
            type: "ui_response",
            requestId: "question-1",
            response: {
                type: "user_question",
                outcome: "selected",
            },
        },
        {
            type: "ui_response",
            requestId: "question-1",
            response: {
                type: "user_question",
                outcome: "selected",
                choiceId: "",
            },
        },
        {
            type: "ui_response",
            requestId: "question-1",
            response: {
                type: "user_question",
                outcome: "other",
                choiceId: "choice-1",
            },
        },
        {
            type: "ui_response",
            requestId: "",
            response: {
                type: "user_question",
                outcome: "cancelled",
            },
        },
    ];

    for (const command of malformed) {
        expect(parseClientCommand(command)).toBeUndefined();
    }
});

test("user question requests share the ordered agent update sequence", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    protocol({
        type: "ui_request",
        requestId: "question-1",
        request: {
            type: "user_question",
            question: "Which environment?",
            choices: [
                { id: "staging", label: "Staging" },
                { id: "production", label: "Production" },
            ],
        },
    });
    protocol({ type: "ui_request_closed", requestId: "question-1" });

    expect(updates).toEqual([
        {
            type: "ui_request",
            requestId: "question-1",
            request: {
                type: "user_question",
                question: "Which environment?",
                choices: [
                    { id: "staging", label: "Staging" },
                    { id: "production", label: "Production" },
                ],
            },
            seq: 1,
        },
        {
            type: "ui_request_closed",
            requestId: "question-1",
            seq: 2,
        },
    ]);
});

test("timeline commands parse only complete rewind requests", () => {
    expect(parseClientCommand({
        type: "list_timeline",
        requestId: "list-1",
    })).toEqual({
        type: "list_timeline",
        requestId: "list-1",
    });
    expect(parseClientCommand({
        type: "preview_timeline_action",
        requestId: "preview-1",
        boundaryId: "message-3",
        action: "rewind_conversation",
    })).toEqual({
        type: "preview_timeline_action",
        requestId: "preview-1",
        boundaryId: "message-3",
        action: "rewind_conversation",
    });
    expect(parseClientCommand({
        type: "apply_timeline_action",
        requestId: "apply-1",
        planId: "plan-1",
    })).toEqual({
        type: "apply_timeline_action",
        requestId: "apply-1",
        planId: "plan-1",
    });

    expect(parseClientCommand({
        type: "preview_timeline_action",
        requestId: "preview-1",
        boundaryId: "message-3",
        action: "restore_files",
    })).toBeUndefined();
    expect(parseClientCommand({
        type: "apply_timeline_action",
        requestId: "apply-1",
        planId: "",
    })).toBeUndefined();
    expect(parseClientCommand({
        type: "list_timeline",
        requestId: "",
    })).toBeUndefined();
});
