import { expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";

import {
    appendTuiThought,
    applyAgentUpdate,
    beginNextQueuedTuiTurn,
    beginTuiTurn,
    createTuiState,
    failTuiConnection,
    queueTuiPrompt,
    renderTuiEntry,
    renderTuiQueuedPrompt,
    tuiEntryMarginTop,
} from "../../clients/tui/state.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

function plainText(styled: StyledText): string {
    return styled.chunks.map((chunk) => chunk.text).join("");
}

test("TUI renders a compact completed thought duration", () => {
    const state = appendTuiThought(createTuiState(), 3.04);

    expect(state.entries).toEqual([{
        kind: "thought",
        text: "+ Thought: 3.0s",
    }]);
    expect(plainText(renderTuiEntry(state.entries[0]!))).toBe("+ Thought: 3.0s");
});

test("TUI state tracks a streamed turn and tool activity", () => {
    let state = beginTuiTurn(createTuiState(), "inspect the project");
    state = applyAgentUpdate(state, {
        type: "assistant_delta",
        text: "I will ",
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "assistant_delta",
        text: "check.",
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "bash",
        args: { command: "pwd" },
        seq: 3,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "bash",
        seq: 4,
    });
    state = applyAgentUpdate(state, {
        type: "assistant_delta",
        text: "Done.",
        seq: 5,
    });
    state = applyAgentUpdate(state, { type: "turn_finished", seq: 6 });

    expect(state.working).toBe(false);
    expect(state.entries).toEqual([
        { kind: "user", text: "inspect the project" },
        { kind: "assistant", text: "I will check." },
        { kind: "tool", text: "∗ bash pwd" },
        { kind: "assistant", text: "Done." },
    ]);
});

test("TUI shows the same edit diff live and from history", () => {
    const presentation = {
        kind: "unified_diff" as const,
        path: "notes.txt",
        patch: "--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    };
    const live = applyAgentUpdate(createTuiState(), {
        type: "tool_presentation",
        tool: "edit",
        presentation,
        seq: 1,
    });
    const replayed = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [{ kind: "presentation", presentation }],
        seq: 1,
    });

    expect(live.entries).toEqual(replayed.entries);
    expect(live.entries).toEqual([{
        kind: "diff",
        text: "notes.txt",
        path: "notes.txt",
        patch: presentation.patch,
    }]);
});

test("TUI shows model failures when a turn finishes", () => {
    const state = applyAgentUpdate(
        beginTuiTurn(createTuiState(), "testing"),
        {
            type: "turn_finished",
            error: "Kimi only supports reasoning max",
            seq: 1,
        },
    );

    expect(state.working).toBe(false);
    expect(state.entries.at(-1)).toEqual({
        kind: "notice",
        text: "Model error: Kimi only supports reasoning max",
    });
});

test("TUI stops working when the resident agent fails", () => {
    const state = applyAgentUpdate(
        queueTuiPrompt(
            beginTuiTurn(createTuiState(), "testing"),
            "do not send after failure",
        ),
        {
            type: "agent_failed",
            failureId: "failure-1",
            detail: "Resident agent stopped unexpectedly",
            seq: 1,
        },
    );

    expect(state.working).toBe(false);
    expect(state.queuedPrompts).toEqual([]);
    expect(state.entries.at(-1)).toEqual({
        kind: "notice",
        text: "Agent error: Resident agent stopped unexpectedly",
    });
});

test("TUI connection failure stops work and clears unsendable prompts", () => {
    const state = failTuiConnection(
        queueTuiPrompt(
            beginTuiTurn(createTuiState(), "active prompt"),
            "queued prompt",
        ),
        "Host sent a non-contiguous agent update sequence",
    );

    expect(state.working).toBe(false);
    expect(state.queuedPrompts).toEqual([]);
    expect(state.entries.at(-1)).toEqual({
        kind: "notice",
        text: "Connection error: Host sent a non-contiguous agent update sequence",
    });
});

test("TUI keeps model failures restored from canonical history", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [{ kind: "error", detail: "rate limited after retries" }],
        seq: 1,
    });

    expect(state.entries).toEqual([{
        kind: "notice",
        text: "Model error: rate limited after retries",
    }]);

    const fallback = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [{ kind: "error" }],
        seq: 2,
    });
    expect(fallback.entries.at(-1)).toEqual({
        kind: "notice",
        text: "Model error: Model request failed",
    });
});

test("TUI applies canonical history and prompts from other clients", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [
            { kind: "user", text: "inspect" },
            { kind: "assistant", text: "Checking." },
            { kind: "tool", tool: "read", args: { path: "note.txt" } },
        ],
        seq: 3,
    });
    state = applyAgentUpdate(state, {
        type: "user_prompt",
        content: "continue",
        seq: 4,
    });

    expect(state.entries).toEqual([
        { kind: "user", text: "inspect" },
        { kind: "assistant", text: "Checking." },
        { kind: "tool", text: "∗ read note.txt" },
        { kind: "user", text: "continue" },
    ]);
});

test("TUI renders a background completion without starting a turn", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "task_notification",
        deliveryId: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
        seq: 1,
    });

    expect(state.working).toBe(false);
    expect(state.entries).toEqual([{
        kind: "notification",
        text: "Background agent child-1 completed:\nThe tests pass.",
    }]);
    const working = applyAgentUpdate(
        beginTuiTurn(createTuiState(), "keep working"),
        {
            type: "task_notification",
            deliveryId: "completion:child-1",
            sourceAgentId: "child-1",
            content: "The tests pass.",
            seq: 1,
        },
    );
    expect(working.working).toBe(true);
});

test("TUI state keeps host-reported model settings", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "model_settings",
        requestId: "settings-1",
        settings: { model: "next-model", reasoningEffort: "high" },
        pending: false,
        seq: 1,
    });

    expect(state.modelSettings).toEqual({
        model: "next-model",
        reasoningEffort: "high",
    });
    expect(state.entries).toEqual([]);
});

test("a refused settings change says so, an unwired engine does not", () => {
    // The change was already announced optimistically when it was sent, so an
    // "invalid" reply that stays silent leaves the transcript claiming it
    // happened. "unavailable" fires during a normal startup read instead, and
    // is not something a reader can act on.
    const refused = applyAgentUpdate(createTuiState(), {
        type: "model_settings_rejected",
        requestId: "settings-1",
        reason: "invalid",
        seq: 1,
    });
    expect(refused.entries).toEqual([{
        kind: "notice",
        text: "model settings change rejected: that combination is not supported",
    }]);

    const unwired = applyAgentUpdate(createTuiState(), {
        type: "model_settings_rejected",
        requestId: "settings-2",
        reason: "unavailable",
        seq: 1,
    });
    expect(unwired.entries).toEqual([]);
});

test("TUI state keeps host-reported permissions", () => {
    const inspection = {
        selected: {
            name: "full_access",
            rules: [],
            defaultOutcome: "allow",
        },
        availableModes: ["ask", "auto", "full_access"],
        activeGrants: [],
    } as const;
    const state = applyAgentUpdate(createTuiState(), {
        type: "permissions",
        requestId: "permissions-1",
        mode: "full_access",
        pending: false,
        inspection,
        seq: 1,
    });

    expect(state.approvalMode).toBe("full_access");
    expect(state.permissionInspection).toEqual(inspection);
    expect(state.entries).toEqual([]);
});

test("TUI state keeps context usage across completion and replay", () => {
    let state = applyAgentUpdate(beginTuiTurn(createTuiState(), "go"), {
        type: "turn_finished",
        contextInputTokens: 64_500,
        seq: 1,
    });
    expect(state.contextInputTokens).toBe(64_500);

    state = applyAgentUpdate(state, {
        type: "history",
        entries: [],
        contextInputTokens: 70_000,
        seq: 1,
    });
    expect(state.contextInputTokens).toBe(70_000);
});

test("TUI does not duplicate its optimistic user prompt", () => {
    const state = applyAgentUpdate(
        beginTuiTurn(createTuiState(), "inspect"),
        { type: "user_prompt", content: "inspect", seq: 1 },
    );

    expect(state.entries).toEqual([{ kind: "user", text: "inspect" }]);
});

test("TUI entries render with kind-specific prefixes", () => {
    expect(plainText(renderTuiEntry({ kind: "user", text: "hi\nthere" })))
        .toBe("▌ hi\n  there");
    expect(plainText(renderTuiEntry({ kind: "tool", text: "∗ bash pwd" })))
        .toBe("∗ bash pwd");
    expect(plainText(renderTuiEntry({ kind: "notice", text: "Engine error" })))
        .toBe("Engine error");
});

test("TUI tool entries truncate long arguments", () => {
    const state = applyAgentUpdate(beginTuiTurn(createTuiState(), "go"), {
        type: "tool_started",
        tool: "bash",
        args: { command: "x".repeat(100) },
        seq: 1,
    });

    expect(state.entries.at(-1)?.text).toBe(`∗ bash ${"x".repeat(63)}…`);
});

test("TUI spacing compacts consecutive tools but preserves message boundaries", () => {
    const entries = [
        { kind: "user", text: "inspect" },
        { kind: "tool", text: "∗ bash pwd" },
        { kind: "tool", text: "∗ read clients/tui/main.ts" },
        { kind: "assistant", text: "Done." },
    ] as const;

    expect(entries.map((_, index) => tuiEntryMarginTop(entries, index)))
        .toEqual([0, 1, 0, 1]);
});

test("TUI queues a follow-up without interrupting the active transcript", () => {
    let state = beginTuiTurn(createTuiState(), "first");
    state = applyAgentUpdate(state, {
        type: "assistant_delta",
        text: "current ",
        seq: 1,
    });
    state = queueTuiPrompt(state, "steer next");
    state = applyAgentUpdate(state, {
        type: "assistant_delta",
        text: "answer",
        seq: 2,
    });

    expect(state.entries).toEqual([
        { kind: "user", text: "first" },
        { kind: "assistant", text: "current answer" },
    ]);
    expect(renderTuiQueuedPrompt(state)).toBe("queued · steer next");

    state = applyAgentUpdate(state, { type: "turn_finished", seq: 3 });
    state = beginNextQueuedTuiTurn(state);

    expect(state.working).toBe(true);
    expect(state.queuedPrompts).toEqual([]);
    expect(state.entries.at(-1)).toEqual({ kind: "user", text: "steer next" });
});

test("TUI queue preview compacts prompts and counts the remainder", () => {
    let state = queueTuiPrompt(
        createTuiState(),
        `explain   ${"x".repeat(60)}`,
    );
    state = queueTuiPrompt(state, "then test it");

    expect(renderTuiQueuedPrompt(state))
        .toBe(`queued · explain ${"x".repeat(39)}… · +1`);
});

test("TUI state leaves timeline replies for the future picker", () => {
    const initial = createTuiState();
    const replies: AgentUpdate[] = [
        {
            type: "timeline",
            requestId: "list-1",
            boundaries: [],
        },
        {
            type: "timeline_action_preview",
            requestId: "preview-1",
            plan: {
                planId: "plan-1",
                expectedHeadId: "message-1",
                boundary: {
                    userMessageId: "message-1",
                    timestamp: "2026-07-19T12:00:00.000Z",
                    prompt: "first request",
                    position: 0,
                },
                keptMessageCount: 0,
                setAsideMessageCount: 2,
            },
        },
        {
            type: "timeline_action_applied",
            requestId: "apply-1",
            planId: "plan-1",
        },
        {
            type: "timeline_action_rejected",
            requestId: "apply-2",
            operation: "apply",
            reason: "plan_expired",
        },
    ];

    expect(replies.reduce(applyAgentUpdate, initial)).toEqual(initial);
});

test("TUI history and live prompts show attached images", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [{
            kind: "user",
            text: "compare",
            attachments: [{ id: "one.png" }, { id: "two.png" }],
        }],
        seq: 1,
    });
    expect(state.entries).toEqual([{
        kind: "user",
        text: "compare",
        attachments: ["attached image", "attached image"],
    }]);

    state = applyAgentUpdate(state, {
        type: "user_prompt",
        content: "new image",
        attachments: [{ id: "three.png" }],
        seq: 2,
    });
    expect(state.entries.at(-1)).toEqual({
        kind: "user",
        text: "new image",
        attachments: ["attached image"],
    });
});

test("a named attachment is shown by its file name", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "user_prompt",
        content: "look",
        attachments: [
            { id: "named-id", name: "Screenshot at 11.08.54 AM.png" },
            { id: "unnamed-id" },
        ],
        seq: 1,
    });
    expect(state.entries.at(-1)).toEqual({
        kind: "user",
        text: "look",
        attachments: ["Screenshot at 11.08.54 AM.png", "attached image"],
    });
    expect(plainText(renderTuiEntry(state.entries.at(-1)!))).toBe(
        "▌ look\n   File  Screenshot at 11.08.54 AM.png\n   File  attached image",
    );
});

test("an image sent with no prose starts the entry at the file chip", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "user_prompt",
        content: "",
        attachments: [{ id: "named-id", name: "diagram.png" }],
        seq: 1,
    });
    expect(plainText(renderTuiEntry(state.entries.at(-1)!)))
        .toBe("▌  File  diagram.png");
});

test("reviewer decisions remain visible with their risk and authorization", () => {
    let state = createTuiState();
    state = applyAgentUpdate(state, {
        type: "tool_review",
        tool: "bash",
        decision: "allow",
        reason: "Read-only listing of a sibling project.",
        riskLevel: "low",
        userAuthorization: "unknown",
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_review",
        tool: "bash",
        decision: "deny",
        reason: "Deletes files outside the workspace.",
        riskLevel: "critical",
        userAuthorization: "unknown",
        seq: 2,
    });

    expect(state.entries[0]).toEqual({
        kind: "review",
        text: "Auto review approved bash (risk: low, authorization: unknown):"
            + " Read-only listing of a sibling project.",
    });
    expect(state.entries[1]).toEqual({
        kind: "notice",
        text: "Reviewer denied bash (critical risk):"
            + " Deletes files outside the workspace.",
    });
});

test("a matching history checkpoint preserves a live auto-review notice", () => {
    let state = createTuiState();
    state = applyAgentUpdate(state, {
        type: "user_prompt",
        content: "run it",
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_review",
        tool: "bash",
        decision: "allow",
        reason: "The command matches the request.",
        riskLevel: "low",
        userAuthorization: "high",
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "bash",
        args: { command: "printf done" },
        seq: 3,
    });
    state = applyAgentUpdate(state, {
        type: "assistant_delta",
        text: "done",
        seq: 4,
    });

    state = applyAgentUpdate(state, {
        type: "history",
        entries: [
            { kind: "user", text: "run it" },
            {
                kind: "tool",
                tool: "bash",
                args: { command: "printf done" },
            },
            { kind: "assistant", text: "done" },
        ],
        seq: 5,
    });

    expect(state.entries.map((entry) => entry.kind)).toEqual([
        "user",
        "review",
        "tool",
        "assistant",
    ]);
});

test("a divergent history checkpoint drops stale auto-review notices", () => {
    let state = createTuiState();
    state = applyAgentUpdate(state, {
        type: "tool_review",
        tool: "bash",
        decision: "allow",
        reason: "Allowed before rewind.",
        riskLevel: "low",
        userAuthorization: "high",
        seq: 1,
    });

    state = applyAgentUpdate(state, {
        type: "history",
        entries: [{ kind: "user", text: "different history" }],
        seq: 2,
    });

    expect(state.entries).toEqual([{
        kind: "user",
        text: "different history",
    }]);
});
