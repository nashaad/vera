import { expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";

import {
    appendTuiThought,
    toggleTuiThinking,
    applyAgentUpdate,
    beginNextQueuedTuiTurn,
    beginTuiTurn,
    createTuiState,
    dropTuiThinking,
    failTuiConnection,
    queueTuiPrompt,
    renderTuiEntry,
    renderTuiQueuedPrompt,
    setTuiWorkspaceRoot,
    tuiDisplayPath,
    tuiEntryMarginTop,
    tuiToolRowText,
} from "../../clients/tui/state.ts";
import type { TuiTranscriptEntry } from "../../clients/tui/state.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

/** A transcript row as one line, gutter included. */
function entryLine(entry: TuiTranscriptEntry): string {
    if (entry.kind === "diff") {
        return entry.text;
    }
    return `${entry.prefix ?? ""}${tuiToolRowText(entry)}`;
}

function plainText(styled: StyledText): string {
    return styled.chunks.map((chunk) => chunk.text).join("");
}

test("a thought with no reasoning behind it carries no fold marker", () => {
    const state = appendTuiThought(createTuiState(), 3.04);

    expect(state.entries).toEqual([{
        kind: "thought",
        text: "Thought: 3.0s",
    }]);
    expect(plainText(renderTuiEntry(state.entries[0]!))).toBe("Thought: 3.0s");
});

test("streamed reasoning shows live and is rebuilt from what arrived", () => {
    let state = createTuiState();
    for (const text of ["first ", "part"]) {
        state = applyAgentUpdate(state, {
            type: "assistant_thinking",
            text,
            seq: 1,
        });
    }

    // Deltas are fragments, so they join exactly as they arrived, and the live
    // row carries the whole of it rather than the last delta.
    expect(state.entries).toEqual([{ kind: "thinking", text: "first part" }]);
    expect(state.pendingThinking).toBe("first part");
});

test("the thought summary folds the reasoning it collected", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "assistant_thinking",
        text: "weighing the two orderings",
        seq: 1,
    });
    state = appendTuiThought(state, 12.4);

    expect(state.entries).toEqual([{
        kind: "thought",
        text: "+ Thought: 12.4s",
        reasoning: "weighing the two orderings",
    }]);
    expect(state.pendingThinking).toBeUndefined();
    expect(plainText(renderTuiEntry(state.entries[0]!)))
        .toBe("+ Thought: 12.4s");
});

test("toggling reasoning opens every fold and every later one", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "assistant_thinking",
        text: "weighing the two orderings",
        seq: 1,
    });
    state = toggleTuiThinking(appendTuiThought(state, 12.4));

    expect(state.entries[0]).toEqual({
        kind: "thought",
        text: "- Thought: 12.4s",
        reasoning: "weighing the two orderings",
        expanded: true,
    });
    expect(plainText(renderTuiEntry(state.entries[0]!)))
        .toBe("- Thought: 12.4s\n\nweighing the two orderings");

    // The flag holds, so a later summary arrives already open.
    state = applyAgentUpdate(state, {
        type: "assistant_thinking",
        text: "second burst",
        seq: 2,
    });
    state = appendTuiThought(state, 1.5);
    expect(state.entries[1]).toMatchObject({
        text: "- Thought: 1.5s",
        expanded: true,
    });

    expect(toggleTuiThinking(state).entries[0]).toMatchObject({
        text: "+ Thought: 12.4s",
        expanded: false,
    });
});

test("dropping live reasoning leaves settled rows alone", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "assistant_delta",
        text: "here is the fix",
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "assistant_thinking",
        text: "second reasoning burst",
        seq: 2,
    });

    const dropped = dropTuiThinking(state);
    expect(dropped.entries).toEqual([{
        kind: "assistant",
        text: "here is the fix",
    }]);
    expect(dropped.pendingThinking).toBeUndefined();
});

test("a thought summary survives a history rebuild in place", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "assistant_thinking",
        text: "weighing the two orderings",
        seq: 1,
    });
    state = appendTuiThought(state, 8.3);
    state = applyAgentUpdate(state, {
        type: "assistant_delta",
        text: "move the flush above the check",
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "history",
        entries: [
            { kind: "user", text: "which ordering?" },
            { kind: "assistant", text: "move the flush above the check" },
        ],
        seq: 3,
    });

    // The summary has no backing message, so the rebuild has to re-place it.
    expect(state.entries).toEqual([
        {
            kind: "thought",
            text: "+ Thought: 8.3s",
            reasoning: "weighing the two orderings",
        },
        { kind: "user", text: "which ordering?" },
        { kind: "assistant", text: "move the flush above the check" },
    ]);
});

test("reasoning collected mid-turn survives a history rebuild", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "assistant_thinking",
        text: "weighing the two orderings",
        seq: 1,
    });
    // A turn emits history while it is still streaming. The rebuild drops the
    // live row, and it is put back from the reasoning that already arrived.
    state = applyAgentUpdate(state, {
        type: "history",
        entries: [{ kind: "user", text: "which ordering?" }],
        seq: 2,
    });

    expect(state.entries).toEqual([
        { kind: "user", text: "which ordering?" },
        { kind: "thinking", text: "weighing the two orderings" },
    ]);
    expect(state.pendingThinking).toBe("weighing the two orderings");
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
        { kind: "tool_header", header: "Ran", text: "Ran" },
        { kind: "tool", header: "Ran", prefix: "  └ ", text: "pwd" },
        { kind: "assistant", text: "Done." },
    ]);
});

test("TUI tool headers are bold and change tense when work finishes", () => {
    let state = applyAgentUpdate(beginTuiTurn(createTuiState(), "run it"), {
        type: "tool_started",
        tool: "bash",
        args: { command: "bun test" },
        seq: 1,
    });

    expect(state.entries.map(entryLine)).toEqual([
        "run it",
        "Running",
        "  └ bun test",
    ]);
    const liveHeader = state.entries[1]!;
    expect(renderTuiEntry(liveHeader).chunks[0]?.attributes).not.toBe(0);

    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "bash",
        output: "",
        isError: false,
        seq: 2,
    });

    expect(state.entries.map(entryLine)).toEqual([
        "run it",
        "Ran",
        "  │ bun test",
        "  └ (no output)",
    ]);
});

test("TUI describes a live subagent as delegating", () => {
    const state = applyAgentUpdate(beginTuiTurn(createTuiState(), "delegate"), {
        type: "tool_started",
        tool: "subagent",
        args: { description: "Inspect the renderer" },
        seq: 1,
    });

    expect(state.entries.map(entryLine)).toEqual([
        "delegate",
        "Delegating",
        "  └ Inspect the renderer",
    ]);
});

test("a group stays live until every tool in it finishes", () => {
    let state = beginTuiTurn(createTuiState(), "inspect");
    for (const [command, seq] of [["pwd", 1], ["ls", 2]] as const) {
        state = applyAgentUpdate(state, {
            type: "tool_started",
            tool: "bash",
            args: { command },
            seq,
        });
    }

    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "bash",
        seq: 3,
    });
    expect(entryLine(state.entries[1]!)).toBe("Running");

    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "bash",
        seq: 4,
    });
    expect(state.entries.map(entryLine)).toEqual([
        "inspect",
        "Ran",
        "  └ pwd",
        "    ls",
    ]);
});

test("TUI clears retry activity when a turn finishes", () => {
    const retrying = applyAgentUpdate(createTuiState(), {
        type: "model_activity",
        phase: "retrying",
        model: "test",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        retryAt: "2026-07-29T17:00:00.500Z",
        failure: { kind: "timeout" },
        seq: 1,
    });

    const finished = applyAgentUpdate(retrying, {
        type: "turn_finished",
        seq: 2,
    });

    expect(finished.modelActivity).toBeUndefined();
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

test("TUI shows multiline tool notices live and from history", () => {
    const presentation = {
        kind: "tool_notice" as const,
        text: "┌──────┐\n│ Vera │\n└──────┘",
    };
    const live = applyAgentUpdate(createTuiState(), {
        type: "tool_presentation",
        tool: "render_d2",
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
        kind: "notice",
        text: presentation.text,
    }]);
    expect(plainText(renderTuiEntry(live.entries[0]!))).toBe(
        presentation.text,
    );
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
        applyAgentUpdate(
            queueTuiPrompt(
                beginTuiTurn(createTuiState(), "active prompt"),
                "queued prompt",
            ),
            {
                type: "tool_started",
                tool: "bash",
                args: { command: "sleep 1" },
                seq: 1,
            },
        ),
        "Host sent a non-contiguous agent update sequence",
    );

    expect(state.working).toBe(false);
    expect(state.queuedPrompts).toEqual([]);
    expect(entryLine(state.entries[1]!)).toBe("Ran");
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
        { kind: "tool_header", header: "Explored", text: "Explored" },
        {
            kind: "tool",
            header: "Explored",
            prefix: "  └ ",
            text: "Read note.txt",
        },
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
        text: "Async subagent child-1:\nThe tests pass.",
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

test("TUI identifies an async subagent attention request", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "task_notification",
        deliveryId: "attention:child-1:message-1",
        sourceAgentId: "child-1",
        content: "Which file should I inspect?",
        kind: "attention",
        seq: 1,
    });

    expect(state.entries).toEqual([{
        kind: "notification",
        text: "Async subagent child-1 needs attention:\nWhich file should I inspect?",
    }]);
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

test("TUI state keeps context usage across measurement and replay", () => {
    let state = applyAgentUpdate(beginTuiTurn(createTuiState(), "go"), {
        type: "context",
        measurement: { tokens: 64_500, capacity: 258_000, estimated: true },
        seq: 1,
    });
    expect(state.context).toEqual({
        tokens: 64_500,
        capacity: 258_000,
        estimated: true,
    });

    // The provider's own count for the same request supersedes the estimate.
    state = applyAgentUpdate(state, {
        type: "context",
        measurement: { tokens: 61_902, capacity: 258_000, estimated: false },
        seq: 2,
    });
    expect(state.context?.estimated).toBe(false);

    state = applyAgentUpdate(state, {
        type: "history",
        entries: [],
        context: { tokens: 70_000, capacity: 258_000, estimated: false },
        seq: 1,
    });
    expect(state.context?.tokens).toBe(70_000);
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
        .toBe("hi\nthere");
    expect(plainText(renderTuiEntry({ kind: "tool_header", text: "Ran" })))
        .toBe("Ran");
    expect(
        plainText(renderTuiEntry({ kind: "tool", prefix: "  └ ", text: "pwd" })),
    )
        .toBe("  └ pwd");
    expect(plainText(renderTuiEntry({ kind: "notice", text: "Engine error" })))
        .toBe("Engine error");
});

test("TUI tool entries keep their whole argument", () => {
    const state = applyAgentUpdate(beginTuiTurn(createTuiState(), "go"), {
        type: "tool_started",
        tool: "bash",
        args: { command: "x".repeat(100) },
        seq: 1,
    });

    expect(state.entries.at(-1)?.text).toBe("x".repeat(100));
});

test("a pathological tool argument is still bounded", () => {
    const state = applyAgentUpdate(beginTuiTurn(createTuiState(), "go"), {
        type: "tool_started",
        tool: "bash",
        args: { command: "x".repeat(9000) },
        seq: 1,
    });

    expect(state.entries.at(-1)?.text).toBe(`${"x".repeat(1999)}…`);
});

test("a run of tool calls hangs off the first one", () => {
    let state = beginTuiTurn(createTuiState(), "go");
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "bash",
        args: { command: "pwd" },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "read",
        args: { path: "note.txt" },
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "assistant_delta",
        text: "ok",
        seq: 3,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "bash",
        args: { command: "ls" },
        seq: 4,
    });

    expect(state.entries.map(entryLine)).toEqual([
        "go",
        "Running",
        "  └ pwd",
        "Exploring",
        "  └ Read note.txt",
        "ok",
        "Running",
        "  └ ls",
    ]);
});

test("a review between two calls does not break the run", () => {
    let state = beginTuiTurn(createTuiState(), "go");
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "bash",
        args: { command: "pwd" },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_review",
        tool: "bash",
        decision: "allow",
        reason: "Reads only.",
        riskLevel: "low",
        userAuthorization: "high",
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "bash",
        args: { command: "ls" },
        seq: 3,
    });

    expect(entryLine(state.entries.at(-1)!)).toBe("    ls");
});

test("a checkpoint over a reviewed run keeps the run and the review", () => {
    let state = beginTuiTurn(createTuiState(), "go");
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "bash",
        args: { command: "pwd" },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_review",
        tool: "read",
        decision: "allow",
        reason: "Reads only.",
        riskLevel: "low",
        userAuthorization: "high",
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "read",
        args: { path: "note.txt" },
        seq: 3,
    });
    state = applyAgentUpdate(state, {
        type: "history",
        entries: [
            { kind: "user", text: "go" },
            { kind: "tool", tool: "bash", args: { command: "pwd" } },
            { kind: "tool", tool: "read", args: { path: "note.txt" } },
        ],
        seq: 4,
    });

    expect(state.entries.map((entry) => entry.kind)).toEqual([
        "user",
        "tool_header",
        "tool",
        "review",
        "tool_header",
        "tool",
    ]);
});

test("history threads a run the same way the live turn did", () => {
    let state = beginTuiTurn(createTuiState(), "go");
    state = applyAgentUpdate(state, {
        type: "history",
        entries: [
            { kind: "user", text: "go" },
            { kind: "tool", tool: "bash", args: { command: "pwd" } },
            { kind: "tool", tool: "read", args: { path: "note.txt" } },
        ],
        seq: 1,
    });

    expect(state.entries.map(entryLine)).toEqual([
        "go",
        "Ran",
        "  └ pwd",
        "Explored",
        "  └ Read note.txt",
    ]);
});

test("TUI spacing compacts consecutive tools but preserves message boundaries", () => {
    const entries = [
        { kind: "user", text: "inspect" },
        { kind: "tool_header", header: "Ran", text: "Ran" },
        { kind: "tool", header: "Ran", prefix: "  └ ", text: "pwd" },
        { kind: "tool", header: "Ran", prefix: "    ", text: "ls" },
        { kind: "assistant", text: "Done." },
    ] as const;

    expect(entries.map((_, index) => tuiEntryMarginTop(entries, index)))
        .toEqual([0, 1, 0, 0, 1]);
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
});

test("an image sent with no prose still carries its file name", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "user_prompt",
        content: "",
        attachments: [{ id: "named-id", name: "diagram.png" }],
        seq: 1,
    });
    expect(state.entries.at(-1)).toEqual({
        kind: "user",
        text: "",
        attachments: ["diagram.png"],
    });
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
        "tool_header",
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

test("a multi-line command keeps its lines", () => {
    const state = applyAgentUpdate(beginTuiTurn(createTuiState(), "go"), {
        type: "tool_started",
        tool: "bash",
        args: { command: "cd repo\nbun test  \n" },
        seq: 1,
    });

    expect(state.entries.at(-1)?.text).toBe("cd repo\nbun test");
});

test("the same call twice in a row becomes one row with a count", () => {
    let state = beginTuiTurn(createTuiState(), "go");
    for (const seq of [1, 2, 3]) {
        state = applyAgentUpdate(state, {
            type: "tool_started",
            tool: "bash",
            args: { command: "pwd" },
            seq,
        });
    }

    expect(state.entries.map(entryLine)).toEqual([
        "go",
        "Running",
        "  └ pwd",
        "    pwd",
        "    pwd",
    ]);
});

test("a repeated call counts the same live and from history", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [
            { kind: "user", text: "go" },
            { kind: "tool", tool: "bash", args: { command: "pwd" } },
            { kind: "tool", tool: "bash", args: { command: "pwd" } },
        ],
        seq: 1,
    });

    expect(state.entries.map(entryLine)).toEqual(["go", "Ran", "  └ pwd ×2"]);
});

test("a turn that produced nothing says so", () => {
    let state = createTuiState();
    state = applyAgentUpdate(state, {
        type: "user_prompt",
        content: "do nothing",
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "turn_finished",
        empty: true,
        seq: 2,
    });
    expect(state.entries.at(-1)).toEqual({
        kind: "notice",
        text: "No response",
    });
});

test("an empty turn reads the same live and from history", () => {
    let live = createTuiState();
    live = applyAgentUpdate(live, {
        type: "turn_finished",
        empty: true,
        seq: 1,
    });
    let rebuilt = createTuiState();
    rebuilt = applyAgentUpdate(rebuilt, {
        type: "history",
        entries: [{ kind: "empty" }],
        seq: 1,
    });
    expect(rebuilt.entries).toEqual(live.entries);
});

test("paths strip the session workspace root, resolved form included", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "vera-display-"));
    try {
        setTuiWorkspaceRoot(workspace);
        expect(tuiDisplayPath(`${workspace}/notes.txt`)).toBe("notes.txt");
        const resolved = await realpath(workspace);
        expect(tuiDisplayPath(`${resolved}/deep/notes.txt`))
            .toBe("deep/notes.txt");
        expect(tuiDisplayPath("/somewhere/else.txt"))
            .toBe("/somewhere/else.txt");
    } finally {
        setTuiWorkspaceRoot(process.cwd());
        await rm(workspace, { recursive: true, force: true });
    }
});
