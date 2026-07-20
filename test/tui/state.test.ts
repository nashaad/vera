import { expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";

import {
    appendTuiThought,
    applyAgentUpdate,
    beginNextQueuedTuiTurn,
    beginTuiTurn,
    createTuiState,
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
        kind: "notice",
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

test("TUI state keeps host-reported permissions", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "permissions",
        requestId: "permissions-1",
        mode: "full_access",
        pending: false,
        seq: 1,
    });

    expect(state.approvalMode).toBe("full_access");
    expect(state.entries).toEqual([]);
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
