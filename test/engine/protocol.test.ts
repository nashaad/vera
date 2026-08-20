import { expect, test } from "bun:test";

import {
    createProtocolEncoder,
    formatModelSubstitution,
    parseClientCommand,
    projectTranscript,
    summarizeSessionModelUsage,
    type AgentUpdate,
} from "../../src/engine/protocol.ts";
import {
    emptyUsage,
    type ModelMessage,
} from "../../src/model/types.ts";
import { measureMessages } from "../../src/engine/context-measurement.ts";

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
        usage: {
            ...emptyUsage(),
            inputTokens: 64_500,
            outputTokens: 120,
        },
        stopReason: "stop",
    },
];

test("session usage groups persisted calls by provider and model", () => {
    const assistant = messages.filter((message) =>
        message.role === "assistant"
    );
    const measured = assistant.map((message, index) => ({
        ...message,
        durationMs: (index + 1) * 100,
        usage: {
            ...message.usage,
            cost: index === 0 ? 0.01 : undefined,
        },
    }));

    expect(summarizeSessionModelUsage(measured)).toEqual({
        rows: [{
            provider: "faux",
            model: "test",
            calls: 2,
            durationMs: 300,
            inputTokens: 64_500,
            outputTokens: 120,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cost: 0.01,
            callsWithoutCost: 1,
        }],
    });
});

function withoutSessionUsage(
    updates: readonly AgentUpdate[],
): readonly AgentUpdate[] {
    return updates.map((update) => {
        if (update.type !== "history" && update.type !== "turn_finished") {
            return update;
        }
        const { usage: _usage, ...rest } = update;
        return rest as AgentUpdate;
    });
}

test("stored model messages project to a client transcript", () => {
    expect(projectTranscript(messages)).toEqual([
        { kind: "user", text: "inspect it" },
        { kind: "assistant", text: "I will read it." },
        { kind: "tool", tool: "read", args: { path: "note.txt" } },
        {
            kind: "tool_result",
            tool: "read",
            output: "contents",
            isError: false,
        },
        { kind: "assistant", text: "It says contents." },
    ]);
});

test("durable tool presentations replay after their tool call", () => {
    const presentation = {
        kind: "unified_diff" as const,
        path: "note.txt",
        patch: "--- note.txt\n+++ note.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    };
    const transcript = projectTranscript([
        ...messages.slice(0, 2),
        {
            role: "tool_result",
            toolCallId: "call_1",
            toolName: "edit",
            content: [{ type: "text", text: "Applied 1 edit to note.txt" }],
            isError: false,
            presentation,
        },
    ]);

    expect(transcript.at(-1)).toEqual({
        kind: "presentation",
        presentation,
    });
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
    expect(parseClientCommand({
        type: "ui_response",
        requestId: "question-3",
        response: {
            type: "user_question",
            outcome: "custom",
            text: "Show every Arc task",
        },
    })).toEqual({
        type: "ui_response",
        requestId: "question-3",
        response: {
            type: "user_question",
            outcome: "custom",
            text: "Show every Arc task",
        },
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
        attachments: [{ id: "one.png" }, { id: "two.png" }],
    }]);
});

test("a projected attachment carries the name it was attached from", () => {
    expect(projectTranscript([{
        role: "user",
        content: [
            { type: "text", text: "look" },
            { type: "image_attachment", attachmentId: "named" },
            { type: "image_attachment", attachmentId: "forgotten" },
        ],
    }], (id) => id === "named" ? "Screenshot.png" : undefined)).toEqual([{
        kind: "user",
        text: "look",
        attachments: [
            { id: "named", name: "Screenshot.png" },
            { id: "forgotten" },
        ],
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
        { kind: "error", outcome: "error", detail: "rate limited after retries" },
    ]);

    expect(projectTranscript([{
        role: "assistant",
        content: [],
        source: { provider: "faux", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "error",
    }])).toEqual([{ kind: "error", outcome: "error" }]);

    expect(projectTranscript([{
        role: "assistant",
        content: [],
        source: { provider: "faux", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "aborted",
    }])).toEqual([{ kind: "error", outcome: "aborted" }]);
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

    expect(withoutSessionUsage(updates)).toEqual([
        { type: "history", entries: [], seq: 0 },
        { type: "user_prompt", content: "inspect it", seq: 1 },
        {
            type: "history",
            entries: projectTranscript(messages),
            context: { tokens: 64_624, estimated: true },
            seq: 1,
        },
    ]);
});

test("protocol replay restores usage against the effective context cap", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder(
        { send: (update): void => void updates.push(update) },
        undefined,
        undefined,
        () => 204_800,
    );

    protocol.checkpoint(messages);

    expect(updates.at(-1)).toMatchObject({
        type: "history",
        context: {
            tokens: 64_624,
            capacity: 204_800,
            estimated: true,
        },
    });
});

test("a checkpoint can restore the persisted compaction measurement", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    protocol.checkpoint(messages, undefined, {
        tokens: 1_800,
        capacity: 100_000,
        estimated: true,
    });

    expect(updates.at(-1)).toMatchObject({
        type: "history",
        context: {
            tokens: 1_800,
            capacity: 100_000,
            estimated: true,
        },
    });
});

test("turn completion adds the reply to the provider's request count", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    const message = messages.at(-1);
    if (message?.role !== "assistant") {
        throw new Error("Expected the fixture to end with an assistant message");
    }
    protocol({
        type: "turn_finished",
        message,
    });

    expect(withoutSessionUsage(updates)).toEqual([
        {
            type: "context",
            measurement: { tokens: 64_624, estimated: true },
            seq: 1,
        },
        { type: "turn_finished", seq: 2 },
    ]);
});

test("turn completion preserves the local projection and compaction policy", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });
    const message = messages.at(-1);
    if (message?.role !== "assistant") {
        throw new Error("Expected the fixture to end with an assistant message");
    }
    const projection = {
        estimatedTokens: 64_500,
        components: [{
            kind: "message" as const,
            id: "message:1",
            owner: "session",
            source: "user",
            displayName: "user message",
            count: 1,
            estimatedTokens: 64_500,
        }],
    };
    const compaction = { triggerFraction: 0.82 };

    protocol({
        type: "context_measured",
        model: "test",
        measurement: {
            tokens: 64_500,
            capacity: 100_000,
            estimated: true,
            projection,
            compaction,
        },
    });
    protocol({ type: "turn_finished", message });

    expect(updates[1]).toMatchObject({
        type: "context",
        measurement: { projection, compaction },
    });
});

test("turn completion cannot lower the current context estimate", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });
    const message = messages.at(-1);
    if (message?.role !== "assistant") {
        throw new Error("Expected the fixture to end with an assistant message");
    }

    protocol({
        type: "context_measured",
        model: "test",
        measurement: { tokens: 70_000, capacity: 100_000, estimated: true },
    });
    protocol({ type: "turn_finished", message });
    protocol.checkpoint(messages);
    protocol.checkpoint(messages);

    expect(withoutSessionUsage(updates)).toEqual([
        {
            type: "context",
            measurement: {
                tokens: 70_000,
                capacity: 100_000,
                estimated: true,
            },
            seq: 1,
        },
        {
            type: "context",
            measurement: {
                tokens: 70_000,
                capacity: 100_000,
                estimated: true,
            },
            seq: 2,
        },
        { type: "turn_finished", seq: 3 },
        {
            type: "history",
            entries: projectTranscript(messages),
            context: {
                tokens: 70_000,
                capacity: 100_000,
                estimated: true,
            },
            seq: 3,
        },
        {
            type: "history",
            entries: projectTranscript(messages),
            context: {
                tokens: 64_624,
                capacity: 100_000,
                estimated: true,
            },
            seq: 3,
        },
    ]);
});

test("a restored checkpoint counts messages after the last provider usage", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });
    const tail: ModelMessage[] = [{
        role: "assistant",
        content: [{ type: "text", text: "Synthetic terminal detail." }],
        source: { provider: "vera", api: "engine", model: "test" },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: "provider connection closed",
    }];

    protocol.checkpoint([...messages, ...tail]);

    expect(updates[0]).toMatchObject({
        type: "history",
        context: {
            tokens: 64_624 + measureMessages(tail),
            estimated: true,
        },
    });
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
    protocol({ type: "delivery_turn_started" });
    protocol.checkpoint([]);

    expect(withoutSessionUsage(updates)).toEqual([
        {
            type: "task_notification",
            deliveryId: "completion:child-1",
            sourceAgentId: "child-1",
            content: "The tests pass.",
            seq: 1,
        },
        { type: "status", state: "working", seq: 2 },
        { type: "history", entries: [], seq: 2 },
    ]);
});

test("task notification kind crosses the protocol boundary", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    protocol({
        type: "task_notification",
        deliveryId: "attention:child-1:message-1",
        sourceAgentId: "child-1",
        content: "Which file?",
        kind: "attention",
    });

    expect(updates[0]).toMatchObject({
        type: "task_notification",
        kind: "attention",
    });
});

test("model retry activity crosses the protocol boundary", () => {
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    protocol({
        type: "model_retry_scheduled",
        model: "openai/gpt-5.6-sol",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        failure: {
            kind: "server",
            resolution: "retry",
            message: "overloaded",
            statusCode: 503,
        },
    });

    expect(updates[0]).toMatchObject({
        type: "model_activity",
        phase: "retrying",
        model: "openai/gpt-5.6-sol",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        failure: {
            kind: "server",
            statusCode: 503,
        },
        seq: 1,
    });
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
        updatedDefaults: true,
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
            updatedDefaults: true,
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

test("permission commands accept built-in and custom profile slugs", () => {
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
    })).toEqual({
        type: "update_permissions",
        requestId: "permissions-3",
        mode: "always_allow",
    });
    expect(parseClientCommand({
        type: "update_permissions",
        requestId: "permissions-4",
        mode: "../always-allow",
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

test("session name commands preserve clear semantics", () => {
    expect(parseClientCommand({
        type: "update_session_name",
        requestId: "name-1",
        name: "Human name",
    })).toEqual({
        type: "update_session_name",
        requestId: "name-1",
        name: "Human name",
    });
    expect(parseClientCommand({
        type: "update_session_name",
        requestId: "name-2",
        name: null,
    })).toEqual({
        type: "update_session_name",
        requestId: "name-2",
        name: null,
    });

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

test("a substitution with no level sent names no level at all", () => {
    expect(formatModelSubstitution({
        model: "codex-model",
        requested: "medium",
        reason: "the model has no reasoning levels",
        scope: "effort",
    })).toBe(
        'Requested reasoning effort "medium" on codex-model, ran with no'
        + " reasoning level at all, because the model has no reasoning"
        + " levels.",
    );
});

test("no substitution sentence ever prints the word undefined", () => {
    const cases = [
        { model: "", requested: "high", reason: "r", scope: "effort" as const },
        {
            model: "m",
            requested: "high",
            using: "low",
            reason: "r",
            scope: "effort" as const,
        },
        { model: "m", requested: "a/b", reason: "r", scope: "model" as const },
        {
            model: "m",
            requested: "a/b",
            using: "a/c",
            reason: "r",
            scope: "model" as const,
        },
    ];

    for (const substitution of cases) {
        const sentence = formatModelSubstitution(substitution);
        expect(sentence).not.toContain("undefined");
        expect(sentence.endsWith(".")).toBe(true);
    }
});
