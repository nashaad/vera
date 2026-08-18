import { expect, test } from "bun:test";
import { TextAttributes, type StyledText } from "@opentui/core";

import {
    appendTuiExtensionBlock,
    appendTuiDiagnostic,
    appendTuiNotice,
    appendTuiThought,
    toggleTuiThinking,
    toggleTuiToolDetails,
    applyAgentUpdate,
    beginNextQueuedTuiTurn,
    beginTuiAdmission,
    dropTuiAdmission,
    beginTuiTurn,
    createTuiState,
    tuiPoolListing,
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
import { resolveTuiDiagnostic } from "../../clients/tui/diagnostic-severity.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { renderTuiStatusDetailsLine } from "../../clients/tui/status.ts";

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

test("what an extension injected is not drawn, and survives a rebuild", () => {
    // The model is sent the note and the message; the band is what the user
    // said, so the note is left out of it. Losing this makes an extension's
    // machinery read as the user's own words.
    const note = "<system-note>\ndugg joined\n</system-note>\n\n";
    let state = beginTuiTurn(
        createTuiState(),
        `${note}hi @all`,
        undefined,
        note.length,
    );
    expect(plainText(renderTuiEntry(state.entries[0]!))).toBe("hi @all");

    // A history rebuild carries the replaced text and knows nothing about the
    // injection, so the live entry hands the measure back.
    state = applyAgentUpdate(state, {
        type: "history",
        entries: [{ kind: "user", text: `${note}hi @all` }],
        seq: 2,
    });
    expect(plainText(renderTuiEntry(state.entries[0]!))).toBe("hi @all");
});

test("soft harness prose stays visible when history is rebuilt", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [{
            kind: "harness",
            text: "Caught up with 2 new turns.",
            tone: "soft",
        }],
        seq: 1,
    });

    expect(state.entries).toEqual([{
        kind: "notice",
        text: "Caught up with 2 new turns.",
        tone: "soft",
    }]);
    expect(plainText(renderTuiEntry(state.entries[0]!)))
        .toBe("Caught up with 2 new turns.");
    expect(renderTuiEntry(state.entries[0]!).chunks[0]?.attributes)
        .toBe(TextAttributes.ITALIC);
});

test("ask_user completion is semantic in live and replayed transcripts", () => {
    const output = JSON.stringify({
        choice_id: "preview-channel",
        label: "Preview",
        notes: "ship after lunch",
    });
    let live = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "ask_user",
        args: { question: "Which channel?" },
        seq: 1,
    });
    live = applyAgentUpdate(live, {
        type: "tool_finished",
        tool: "ask_user",
        output,
        seq: 2,
    });
    const liveResult = live.entries.find((entry) =>
        entry.kind === "tool" && entry.result === true
    );
    expect(liveResult?.text).toBe("Answered: Preview (notes: ship after lunch)");
    expect(liveResult?.text).not.toContain("choice_id");

    const replayed = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [
            { kind: "tool", tool: "ask_user", args: { question: "Which channel?" } },
            { kind: "tool_result", tool: "ask_user", output, isError: false },
        ],
        seq: 3,
    });
    const replayResult = replayed.entries.find((entry) =>
        entry.kind === "tool" && entry.result === true
    );
    expect(replayResult?.text).toBe(liveResult?.text);
});

test("a completion with no reasoning behind it gets a playful verb and no fold marker", () => {
    const state = appendTuiThought(createTuiState(), 3.04);

    expect(state.entries).toEqual([{
        kind: "thought",
        text: "Sautéed for 3.0s",
    }]);
    expect(plainText(renderTuiEntry(state.entries[0]!))).toBe("Sautéed for 3.0s");
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
        text: "▸ Reasoning: 12.4s",
        reasoning: "weighing the two orderings",
    }]);
    expect(state.pendingThinking).toBeUndefined();
    expect(plainText(renderTuiEntry(state.entries[0]!)))
        .toBe("▸ Reasoning: 12.4s  ctrl+o reasoning");
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
        text: "▾ Reasoning: 12.4s",
        reasoning: "weighing the two orderings",
        expanded: true,
    });
    expect(plainText(renderTuiEntry(state.entries[0]!)))
        .toBe("▾ Reasoning: 12.4s  ctrl+o hide reasoning\n\nweighing the two orderings");

    // The flag holds, so a later summary arrives already open.
    state = applyAgentUpdate(state, {
        type: "assistant_thinking",
        text: "second burst",
        seq: 2,
    });
    state = appendTuiThought(state, 1.5);
    expect(state.entries[1]).toMatchObject({
        text: "▾ Reasoning: 1.5s",
        expanded: true,
    });

    expect(toggleTuiThinking(state).entries[0]).toMatchObject({
        text: "▸ Reasoning: 12.4s",
        expanded: false,
    });
});

test("expanded reasoning does not show Markdown heading markers", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "assistant_thinking",
        text: "**Estimating remaining work**\n---\n\n## Checking shipped slices ##",
        seq: 1,
    });
    state = toggleTuiThinking(appendTuiThought(state, 3.3));

    expect(plainText(renderTuiEntry(state.entries[0]!))).toBe(
        "▾ Reasoning: 3.3s  ctrl+o hide reasoning"
        + "\n\nEstimating remaining work\n\nChecking shipped slices",
    );
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

test("turn completion moves checkpointed thoughts before the final answer", () => {
    const state = applyAgentUpdate({
        ...createTuiState(),
        working: true,
        entries: [
            { kind: "user", text: "how much work is left?" },
            { kind: "assistant", text: "Five release slices remain." },
            {
                kind: "thought",
                text: "▸ Reasoning: 6.6s",
                reasoning: "Estimating the remaining work",
            },
        ],
    }, { type: "turn_finished", seq: 1 });

    expect(state.entries.map((entry) => entry.kind)).toEqual([
        "user",
        "thought",
        "assistant",
    ]);
    expect(state.entries[1]).toMatchObject({
        reasoning: "Estimating the remaining work",
    });
});

test("idle status also keeps a late reasoning row before the final answer", () => {
    const state = applyAgentUpdate({
        ...createTuiState(),
        working: true,
        entries: [
            { kind: "user", text: "how much work is left?" },
            { kind: "assistant", text: "Five release slices remain." },
            {
                kind: "thought",
                text: "▸ Reasoning: 4.6s",
                reasoning: "Summarizing active unfinished tasks",
            },
        ],
    }, { type: "status", state: "idle", seq: 1 });

    expect(state.working).toBe(false);
    expect(state.entries.map((entry) => entry.kind)).toEqual([
        "user",
        "thought",
        "assistant",
    ]);
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
            text: "▸ Reasoning: 8.3s",
            reasoning: "weighing the two orderings",
        },
        { kind: "user", text: "which ordering?" },
        { kind: "assistant", text: "move the flush above the check" },
    ]);
});

test("client notices do not push later reasoning summaries to the tail", () => {
    let state = createTuiState();
    state = applyAgentUpdate(state, {
        type: "history",
        entries: [
            { kind: "user", text: "first" },
            { kind: "assistant", text: "first answer" },
        ],
        seq: 1,
    });
    state = {
        ...state,
        entries: [
            { kind: "user", text: "first" },
            { kind: "thought", text: "Baked for 1.0s" },
            { kind: "assistant", text: "first answer" },
        ],
    };
    state = appendTuiNotice(state, "Switched models.", "soft");
    state = {
        ...state,
        entries: [
            ...state.entries,
            { kind: "user", text: "second" },
            { kind: "thought", text: "Worked for 2.0s" },
            { kind: "assistant", text: "second answer" },
        ],
    };

    state = applyAgentUpdate(state, {
        type: "history",
        entries: [
            { kind: "user", text: "first" },
            { kind: "assistant", text: "first answer" },
            { kind: "user", text: "second" },
            { kind: "assistant", text: "second answer" },
        ],
        seq: 2,
    });

    expect(state.entries.map((entry) => entry.text)).toEqual([
        "first",
        "Baked for 1.0s",
        "first answer",
        "Switched models.",
        "second",
        "Worked for 2.0s",
        "second answer",
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
        "+ Ran",
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

test("TUI shows an inbox count without exposing message metadata", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "notice",
        key: "inbox",
        count: 3,
        seq: 1,
    });

    expect(state.entries).toEqual([{
        kind: "inbox",
        text: "3 unread inbox entries",
    }]);
    expect(plainText(renderTuiEntry(state.entries[0]!))).toBe(
        "〰 Agent inbox 〰\n  3 unread inbox entries",
    );
});

test("TUI replaces an old inbox count with the current count", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "notice",
        key: "inbox",
        count: 1,
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "notice",
        key: "inbox",
        count: 2,
        seq: 2,
    });

    expect(state.entries).toEqual([{
        kind: "inbox",
        text: "2 unread inbox entries",
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
        text: "",
        diagnostic: resolveTuiDiagnostic(
            "model_request_failed",
            "Model error: Kimi only supports reasoning max",
        ),
    });
});

test("TUI draws attachment failures as errors", () => {
    const state = applyAgentUpdate(
        beginTuiTurn(createTuiState(), "inspect image"),
        {
            type: "turn_finished",
            error: "Image attachment unavailable: the selected model provider "
                + "does not support image input",
            seq: 1,
        },
    );

    expect(state.entries.at(-1)).toEqual({
        kind: "notice",
        text: "",
        diagnostic: resolveTuiDiagnostic(
            "attachment_failed",
            "Attachment error: the selected model provider does not "
                + "support image input",
        ),
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
        text: "",
        diagnostic: resolveTuiDiagnostic(
            "resident_agent_stopped",
            "Resident agent stopped unexpectedly",
        ),
    });
});

test("TUI connection failure stops work and clears unsendable prompts", () => {
    const connected = applyAgentUpdate(
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
    );
    const state = failTuiConnection(connected);

    expect(state.working).toBe(false);
    expect(state.queuedPrompts).toEqual([]);
    expect(entryLine(state.entries[1]!)).toBe("Ran");
    // Disconnection is status-line state, so the transcript gains no row.
    expect(state.entries).toHaveLength(connected.entries.length);
});

test("TUI keeps model failures restored from canonical history", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [{ kind: "error", detail: "rate limited after retries" }],
        seq: 1,
    });

    expect(state.entries).toEqual([{
        kind: "notice",
        text: "",
        diagnostic: resolveTuiDiagnostic(
            "model_request_failed",
            "Model error: rate limited after retries",
        ),
    }]);

    const fallback = applyAgentUpdate(createTuiState(), {
        type: "history",
        entries: [{ kind: "error" }],
        seq: 2,
    });
    expect(fallback.entries.at(-1)).toEqual({
        kind: "notice",
        text: "",
        diagnostic: resolveTuiDiagnostic(
            "model_request_failed",
            "Model error: Model request failed",
        ),
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

test("a refusal is left to the caller that knows what was asked for", () => {
    // The notice naming the provider, model and effort is written where the
    // request was made. A line here could only say that something was refused.
    for (const reason of ["invalid", "unavailable"] as const) {
        const state = applyAgentUpdate(createTuiState(), {
            type: "model_settings_rejected",
            requestId: `settings-${reason}`,
            reason,
            seq: 1,
        });
        expect(state.entries).toEqual([]);
    }
});

test("admission progress rewrites one checklist entry in place", () => {
    let state = beginTuiAdmission(
        createTuiState(),
        "pool-1",
        "openrouter/z-ai/glm-5.2",
    );
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.text).toBe("Verifying openrouter/z-ai/glm-5.2…");

    state = applyAgentUpdate(state, {
        type: "pool_admission_progress",
        requestId: "pool-1",
        step: "reach",
        label: "endpoint reachable",
        status: "running",
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "pool_admission_progress",
        requestId: "pool-1",
        step: "reach",
        label: "endpoint reachable",
        status: "passed",
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "pool_admission_progress",
        requestId: "pool-1",
        step: "tools",
        label: "tool calls",
        status: "running",
        seq: 3,
    });

    // One entry, rewritten: a step that ran and passed holds one row, not two.
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.text).toBe(
        "Verifying openrouter/z-ai/glm-5.2…\n"
            + "  ✓ endpoint reachable\n"
            + "  … tool calls",
    );
});

test("an added verdict waits for the snapshot to report verified levels", () => {
    let state = beginTuiAdmission(createTuiState(), "pool-1", "or/glm");
    state = applyAgentUpdate(state, {
        type: "pool_admission_result",
        requestId: "pool-1",
        provider: "or",
        model: "glm",
        verdict: "added",
        seq: 1,
    });
    expect(state.entries[0]?.text).toContain("Pinned to your shortlist");

    state = applyAgentUpdate(state, {
        type: "model_settings",
        requestId: "settings-1",
        settings: {
            model: "glm",
            reasoningEffort: "high",
            pooled: [{
                provider: "or",
                model: "glm",
                label: "GLM",
                available: true,
                verified: true,
                levels: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High" },
                ],
            }],
        },
        pending: false,
        seq: 2,
    });
    expect(state.entries[0]?.text)
        .toContain("Pinned to your shortlist (2 levels verified)");
    // Settled rather than dropped: the dialog showing this verdict still
    // renders from the record.
    expect(state.admission?.settled).toBe(true);
    expect(state.admission?.verifiedLevels).toBe(2);
});

test("failed admission verdicts carry the reason and invite a retry", () => {
    let state = beginTuiAdmission(createTuiState(), "pool-1", "or/glm");
    state = applyAgentUpdate(state, {
        type: "pool_admission_result",
        requestId: "pool-1",
        provider: "or",
        model: "glm",
        verdict: "incompatible",
        reason: "no tool calling",
        seq: 1,
    });
    expect((state.entries[0] as { diagnostic?: { message: string } })
        ?.diagnostic?.message)
        .toContain("Not pinned, incompatible: no tool calling");
    expect(state.admission?.settled).toBe(true);

    let retried = beginTuiAdmission(createTuiState(), "pool-2", "or/glm");
    retried = applyAgentUpdate(retried, {
        type: "pool_admission_result",
        requestId: "pool-2",
        provider: "or",
        model: "glm",
        verdict: "unavailable",
        reason: "provider timeout",
        statusCode: 503,
        seq: 1,
    });
    expect((retried.entries[0] as { diagnostic?: { message: string } })
        ?.diagnostic?.message).toContain(
        "Provider unavailable (HTTP 503): provider timeout. "
            + "Select the model again to retry.",
    );
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
    expect(plainText(renderTuiEntry({
        kind: "notice",
        text: "",
        diagnostic: resolveTuiDiagnostic(
            "model_request_failed",
            "Model request failed",
        ),
    }))).toBe("× Model request failed");
    expect(plainText(renderTuiEntry({
        kind: "notice",
        text: "",
        diagnostic: resolveTuiDiagnostic(
            "resident_agent_stopped",
            "Resident agent stopped unexpectedly",
        ),
    }))).toBe("× stopped  Resident agent stopped unexpectedly");
});

test("identical diagnostics collapse in place with a count", () => {
    let state = createTuiState();
    for (let attempt = 0; attempt < 10; attempt += 1) {
        state = appendTuiDiagnostic(
            state,
            "file_skipped",
            "Skipped a file",
        );
    }

    expect(state.entries).toHaveLength(1);
    expect(plainText(renderTuiEntry(state.entries[0]!)))
        .toBe("Skipped a file (×10)");
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

test("a folded tool header bounds the command it shows", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "bash",
        args: { command: "x".repeat(200) },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "bash",
        output: Array.from({ length: 8 }, () => "output").join("\n"),
        seq: 2,
    });

    const header = state.entries[0];
    expect(header?.kind).toBe("tool_header");
    expect(header?.kind === "tool_header" ? header.command : undefined)
        .toBe(`${"x".repeat(95)}…`);
});

test("a long completed tool group folds and the detail toggle reopens it", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "list",
        args: { path: "/workspace" },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "list",
        output: Array.from(
            { length: 10 },
            (_, index) => `file-${index}`,
        ).join("\n"),
        seq: 2,
    });

    expect(state.entries[0]).toMatchObject({
        kind: "tool_header",
        text: "+ Explored",
        command: "List /workspace",
        detailLines: 11,
        detailPreview: "  └ file-0",
        expanded: false,
    });
    expect(plainText(renderTuiEntry(state.entries[0]!)))
        .toBe([
            "  Explored  List /workspace  ctrl+e details",
            "  └ file-0",
        ].join("\n"));
    expect(state.entries.slice(1).every((entry) =>
        entry.kind === "tool" && entry.hidden === true
    )).toBe(true);

    state = toggleTuiToolDetails(state);
    expect(state.entries[0]).toMatchObject({
        text: "- Explored",
        expanded: true,
    });
    expect(state.entries[0]).not.toHaveProperty("detailPreview");
    expect(state.entries[0]).not.toHaveProperty("command");
    expect(state.entries.slice(1).every((entry) =>
        entry.kind === "tool" && entry.hidden === undefined
    )).toBe(true);

    state = toggleTuiToolDetails(state);
    expect(state.entries[0]).toMatchObject({
        text: "+ Explored",
        expanded: false,
    });
    expect(state.entries.slice(1).every((entry) =>
        entry.kind === "tool" && entry.hidden === true
    )).toBe(true);
});

test("a folded multi-file preview keeps filenames instead of doubly truncating paths", () => {
    const first = "/Users/nash/Projects/Obsidian/Private/PROJECTS/Vera Agent/Vera 2 - In flight.md";
    const second = "/Users/nash/Projects/Obsidian/Private/PROJECTS/Vera Agent/index.md";
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "read",
        args: { path: first },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "read",
        args: { path: second },
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "read",
        output: "first",
        seq: 3,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "read",
        output: "second",
        seq: 4,
    });

    expect(state.entries[0]).toMatchObject({
        kind: "tool_header",
        detailPreview: "  └ Read Vera 2 - In flight.md, Read index.md",
    });
    expect(state.entries.filter((entry) => entry.kind === "tool")
        .map((entry) => entry.text))
        .toEqual([
            `Read ${first}`,
            `Read ${second}`,
            "first",
            "second",
        ]);
});

test("a folded multi-file preview distinguishes matching filenames", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "read",
        args: { path: "/one/index.md" },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_started",
        tool: "read",
        args: { path: "/two/index.md" },
        seq: 2,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "read",
        output: "first",
        seq: 3,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "read",
        output: "second",
        seq: 4,
    });

    expect(state.entries[0]).toMatchObject({
        detailPreview: "  └ Read one/index.md, Read two/index.md",
    });
});

test("a short completed tool group uses the same compact header", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "edit",
        args: { path: "/workspace/note.txt" },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "edit",
        output: "ok",
        seq: 2,
    });

    expect(state.entries[0]).toMatchObject({
        kind: "tool_header",
        text: "+ Edited",
        command: "Edit /workspace/note.txt",
        detailLines: 2,
        detailPreview: "  └ ok",
        inlineDetailPreview: true,
        expanded: false,
    });
    expect(plainText(renderTuiEntry(state.entries[0]!)))
        .toBe("  Edited  Edit /workspace/note.txt  └ ok  ctrl+e details");
    expect(state.entries.slice(1).every((entry) =>
        entry.kind === "tool" && entry.hidden === true
    )).toBe(true);
});

test("a folded tool header reserves a blank marker and an expanded one uses a chevron", () => {
    expect(plainText(renderTuiEntry({
        kind: "tool_header",
        text: "+ Ran",
        command: "pwd",
        detailLines: 9,
        expanded: false,
        hint: true,
    }))).toBe("  Ran  pwd  ctrl+e details");
    expect(plainText(renderTuiEntry({
        kind: "tool_header",
        text: "- Ran",
        command: "pwd",
        detailLines: 9,
        expanded: true,
        hint: true,
    }))).toBe("▾ Ran  pwd  ctrl+e details");
});

test("the first detail toggle hides completed activity that is currently visible", () => {
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "read",
        args: { path: "first.ts" },
        seq: 1,
    });
    state = applyAgentUpdate(state, {
        type: "tool_finished",
        tool: "read",
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

    state = toggleTuiToolDetails(state);

    expect(state.toolDetailsExpanded).toBe(false);
    expect(state.entries
        .filter((entry) => entry.kind === "tool")
        .every((entry) => entry.kind === "tool" && entry.hidden === true))
        .toBe(true);
    expect(state.entries.filter((entry) => entry.kind === "tool_header")
        .map((entry) => entry.text))
        .toEqual(["+ Explored", "+ Ran"]);
    expect(state.entries.filter((entry) => entry.kind === "tool_header")
        .map((entry) => entry.kind === "tool_header" ? entry.hint : undefined))
        .toEqual([true, undefined]);
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
        { kind: "tool_header", header: "Explored", text: "Explored" },
        {
            kind: "tool",
            header: "Explored",
            prefix: "  └ ",
            text: "Read note.txt",
        },
        { kind: "tool_header", header: "Ran", text: "Ran" },
        { kind: "tool", header: "Ran", prefix: "  └ ", text: "ls" },
        { kind: "assistant", text: "Done." },
    ] as const;

    expect(entries.map((_, index) => tuiEntryMarginTop(entries, index)))
        .toEqual([0, 1, 0, 0, 0, 0, 0, 1]);
});

test("TUI spacing accepts separate message and activity-group gaps", () => {
    const entries = [
        { kind: "user", text: "inspect" },
        { kind: "tool_header", header: "Ran", text: "Ran" },
        { kind: "tool", header: "Ran", prefix: "  └ ", text: "pwd" },
        { kind: "tool_header", header: "Explored", text: "Explored" },
        { kind: "assistant", text: "Done." },
    ] as const;

    expect(entries.map((_, index) =>
        tuiEntryMarginTop(entries, index, { message: 2, toolGroup: 1 })
    )).toEqual([0, 2, 0, 1, 2]);
});

test("notices of one weight sit flush, and a receipt replaces its own", () => {
    const entries: readonly TuiTranscriptEntry[] = [
        { kind: "user", text: "theme" },
        { kind: "notice", text: "theme changed: synthwave", tone: "soft" },
        { kind: "notice", text: "theme changed: system", tone: "soft" },
        { kind: "notice", text: "sign in at https://example.test" },
        { kind: "notice", text: "connected", tone: "soft" },
    ];

    expect(entries.map((_, index) => tuiEntryMarginTop(entries, index)))
        .toEqual([0, 1, 0, 1, 1]);

    let state = createTuiState();
    for (const theme of ["synthwave", "system", "midnight-blue"]) {
        state = appendTuiNotice(state, `theme changed: ${theme}`, "soft", "theme");
    }
    expect(state.entries).toEqual([{
        kind: "notice",
        text: "theme changed: midnight-blue",
        tone: "soft",
        supersedes: "theme",
        liveOnly: true,
    }]);

    // A receipt only overwrites the one directly above it: anything in between
    // means the earlier receipt is history the user watched happen.
    state = appendTuiNotice(state, "connected", "soft");
    state = appendTuiNotice(state, "theme changed: synthwave", "soft", "theme");
    expect(state.entries).toHaveLength(3);
});

test("diagnostics stay compact while a fatal keeps a blank row above", () => {
    const entries: readonly TuiTranscriptEntry[] = [
        {
            kind: "notice",
            text: "",
            diagnostic: resolveTuiDiagnostic(
                "file_skipped",
                "Skipped a file",
            ),
        },
        {
            kind: "notice",
            text: "",
            diagnostic: resolveTuiDiagnostic(
                "model_request_failed",
                "Model request failed",
            ),
        },
        {
            kind: "notice",
            text: "",
            diagnostic: resolveTuiDiagnostic(
                "resident_agent_stopped",
                "Resident agent stopped",
            ),
        },
    ];

    const noGeneralSpacing = { message: 0, toolGroup: 0 };
    expect(entries.map((_, index) =>
        tuiEntryMarginTop(entries, index, noGeneralSpacing)
    )).toEqual([0, 0, 1]);
});

test("a tool header follows its thought without a spacer row", () => {
    const entries = [
        { kind: "user", text: "inspect" },
        { kind: "thought", text: "Baked for 0.0s", seconds: 0 },
        { kind: "tool_header", header: "Ran", text: "Ran" },
        { kind: "tool", header: "Ran", prefix: "  └ ", text: "pwd" },
        { kind: "assistant", text: "Done." },
    ] as const;

    expect(entries.map((_, index) => tuiEntryMarginTop(entries, index)))
        .toEqual([0, 1, 0, 0, 1]);
});

test("a tool header leaves a row after expanded reasoning", () => {
    const entries = [
        {
            kind: "thought",
            text: "▾ Reasoning: 3.6s",
            reasoning: "Inspecting Obsidian file in-flight",
            expanded: true,
        },
        { kind: "tool_header", header: "Explored", text: "+ Explored" },
        { kind: "tool", header: "Explored", prefix: "  └ ", text: "Read file" },
    ] as const;

    expect(entries.map((_, index) => tuiEntryMarginTop(entries, index)))
        .toEqual([0, 1, 0]);
    expect(tuiEntryMarginTop(entries, 1, { message: 0, toolGroup: 0 })).toBe(1);
});

test("a continued tool run also leaves a row after expanded reasoning", () => {
    const entries = [
        { kind: "tool_header", header: "Explored", text: "Explored" },
        { kind: "tool", header: "Explored", prefix: "  └ ", text: "Read first" },
        {
            kind: "thought",
            text: "▾ Reasoning: 3.6s",
            reasoning: "Checking the next file",
            expanded: true,
        },
        { kind: "tool", header: "Explored", prefix: "    ", text: "Read next" },
    ] as const;

    expect(entries.map((_, index) => tuiEntryMarginTop(entries, index)))
        .toEqual([0, 0, 1, 1]);
});

test("a new tool header is separated from the rendered diff above it", () => {
    const entries = [
        {
            kind: "diff",
            text: "note.ts\n1 + changed",
            path: "note.ts",
            patch: "@@ -1 +1 @@\n-old\n+changed",
        },
        { kind: "tool_header", header: "Ran", text: "Ran" },
        { kind: "tool", header: "Ran", prefix: "  └ ", text: "git diff" },
    ] as const;

    expect(entries.map((_, index) => tuiEntryMarginTop(entries, index)))
        .toEqual([0, 1, 0]);
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
        text: "",
        diagnostic: resolveTuiDiagnostic(
            "permission_denied",
            "Reviewer denied bash (critical risk):"
                + " Deletes files outside the workspace.",
        ),
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

const EFFORT_SUBSTITUTION = {
    type: "model_substitution",
    source: "turn" as const,
    model: "deepseek-v4-flash",
    requested: "low",
    using: "high",
    reason: "the provider refuses low on this model",
    scope: "effort",
    seq: 1,
} as const satisfies AgentUpdate;

const LOW_ON_FLASH = {
    model: "deepseek-v4-flash",
    reasoningEffort: "low",
} as const;

function settingsUpdate(
    settings: { readonly model: string; readonly reasoningEffort: string },
): AgentUpdate {
    return {
        type: "model_settings",
        seq: 2,
        requestId: "req",
        pending: false,
        settings,
    } as unknown as AgentUpdate;
}

function turnFinished(seq: number): AgentUpdate {
    return { type: "turn_finished", seq } as AgentUpdate;
}

test("the status line reports the level a turn ran at beside the one asked for", () => {
    const state = applyAgentUpdate(
        applyAgentUpdate(createTuiState(), settingsUpdate(LOW_ON_FLASH)),
        EFFORT_SUBSTITUTION,
    );

    expect(state.effortSubstitution).toEqual({
        model: "deepseek-v4-flash",
        requested: "low",
        effective: "high",
    });
    expect(renderTuiStatusDetailsLine(
        state.modelSettings,
        "auto",
        undefined,
        "/workspace",
        0,
        state.effortSubstitution,
    )).toContain("HIGH (ASKED LOW)");

    // The stored setting is untouched: the line reports, it does not change.
    expect(state.modelSettings?.reasoningEffort).toBe("low");

    // A turn that sent no reasoning level at all says so in the same place.
    const none = applyAgentUpdate(state, {
        ...EFFORT_SUBSTITUTION,
        using: undefined,
    } as AgentUpdate);
    expect(renderTuiStatusDetailsLine(
        none.modelSettings,
        "auto",
        undefined,
        "/workspace",
        0,
        none.effortSubstitution,
    )).toContain("NONE (ASKED LOW)");

    // A different model is a different question, so the evidence is dropped.
    const moved = applyAgentUpdate(state, settingsUpdate({
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
    }));
    expect(moved.effortSubstitution).toBeUndefined();
    expect(renderTuiStatusDetailsLine(
        moved.modelSettings,
        "auto",
        undefined,
        "/workspace",
        0,
        moved.effortSubstitution,
    )).toContain("LOW ·");
});

test("the same substitution is announced once, and again when it changes", () => {
    const started = applyAgentUpdate(
        createTuiState(),
        settingsUpdate(LOW_ON_FLASH),
    );
    const first = applyAgentUpdate(started, EFFORT_SUBSTITUTION);
    const afterTurn = applyAgentUpdate(first, turnFinished(3));
    const second = applyAgentUpdate(afterTurn, EFFORT_SUBSTITUTION);

    const substitutions = (state: typeof second) =>
        state.entries.filter((entry) => entry.kind === "substitution");
    expect(substitutions(second)).toHaveLength(1);

    // A different model is a different fact, and it is announced.
    const elsewhere = applyAgentUpdate(second, {
        ...EFFORT_SUBSTITUTION,
        model: "gpt-5.6-sol",
    });
    expect(substitutions(elsewhere)).toHaveLength(2);
    // And so is coming back to the first one.
    const back = applyAgentUpdate(
        applyAgentUpdate(elsewhere, turnFinished(4)),
        EFFORT_SUBSTITUTION,
    );
    expect(substitutions(back)).toHaveLength(3);
});

test("a turn that runs at the requested level says so once", () => {
    const substituted = applyAgentUpdate(
        applyAgentUpdate(createTuiState(), settingsUpdate(LOW_ON_FLASH)),
        EFFORT_SUBSTITUTION,
    );
    const recovered = applyAgentUpdate(
        applyAgentUpdate(substituted, turnFinished(3)),
        turnFinished(4),
    );

    expect(recovered.effortSubstitution).toBeUndefined();
    const notices = recovered.entries.filter((entry) =>
        entry.kind === "notice"
        && entry.text.includes("is available again")
    );
    expect(notices).toHaveLength(1);
    // And nothing more is said while it keeps working.
    expect(applyAgentUpdate(recovered, turnFinished(5)).entries)
        .toEqual(recovered.entries);
});

test("a substitution gets its own transcript row, live and on replay", () => {
    const live = applyAgentUpdate(createTuiState(), {
        type: "model_substitution",
        source: "turn" as const,
        model: "openai/gpt-5",
        requested: "high",
        using: "medium",
        reason: "unsupported value for reasoning_effort",
        scope: "effort",
        seq: 1,
    });
    expect(live.entries).toEqual([{
        kind: "substitution",
        text: 'Requested reasoning effort "high" on openai/gpt-5, ran at'
            + ' "medium" instead, because unsupported value for'
            + " reasoning_effort.",
    }]);

    const replayed = applyAgentUpdate(createTuiState(), {
        type: "history",
        seq: 1,
        entries: [{
            kind: "model_substitution",
            substitution: {
                model: "openai/gpt-5",
                requested: "high",
                using: "medium",
                reason: "unsupported value for reasoning_effort",
                scope: "effort",
            },
        }],
    });
    expect(replayed.entries).toEqual(live.entries);

    // Distinct from a plain notice: the marker is what sets it apart.
    expect(plainText(renderTuiEntry(live.entries[0]!))).toBe(
        '⇄ Requested reasoning effort "high" on openai/gpt-5, ran at'
        + ' "medium" instead, because unsupported value for'
        + " reasoning_effort.",
    );
});

test("the pool listing names the effort, the probe state and the provider", () => {
    expect(tuiPoolListing([
        {
            provider: "openrouter",
            model: "z-ai/glm-5.2",
            label: "GLM-5.2",
            available: true,
            verified: true,
            levels: [],
            defaultLevel: "medium",
        },
        {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            label: "GPT-5.6-Sol",
            available: false,
            verified: false,
            levels: [],
        },
    ])).toBe([
        "Shortlist (2):",
        "  z-ai/glm-5.2 · medium · verified · openrouter",
        "  gpt-5.6-sol · provider default · unverified · openai-codex,"
            + " unavailable right now",
    ].join("\n"));
    expect(tuiPoolListing([])).toContain("Your shortlist is empty");
});

test("a named pool entry lists by its name, with the model id behind it", () => {
    expect(tuiPoolListing([
        {
            provider: "openrouter",
            model: "z-ai/glm-5.2",
            label: "GLM-5.2",
            poolName: "frosty",
            available: true,
            verified: true,
            levels: [],
        },
    ])).toContain("  frosty (z-ai/glm-5.2) · provider default");
});

test("an extension block keeps its label out of the markdown", () => {
    const state = appendTuiExtensionBlock(
        createTuiState(),
        "[m1] (gpt-5.5)",
        "answer with [brackets]",
    );
    const entries = state.entries.slice(-2);
    expect(entries[0]).toEqual({
        kind: "extension_label",
        text: "[m1] (gpt-5.5)",
    });
    expect(entries[1]).toEqual({
        kind: "notification",
        text: "answer with [brackets]",
    });
    expect(plainText(renderTuiEntry(entries[0]!))).toBe("[m1] (gpt-5.5)");
});

test("TUI shows a compaction budget warning when the run starts", () => {
    const warned = applyAgentUpdate(createTuiState(), {
        type: "compaction",
        phase: "started",
        strategy: "vera/full-summary",
        warning: "Compaction targets 90000 tokens, above trigger_tokens (5000).",
        seq: 1,
    });
    const quiet = applyAgentUpdate(createTuiState(), {
        type: "compaction",
        phase: "started",
        strategy: "vera/full-summary",
        seq: 1,
    });

    expect(warned.entries.at(-1)).toEqual({
        kind: "notice",
        text: "Compaction targets 90000 tokens, above trigger_tokens (5000).",
        liveOnly: true,
    });
    expect(quiet.entries).toEqual([]);
});

test("dropping an admission takes its checklist entry with it", () => {
    let state = beginTuiAdmission(createTuiState(), "pool-3", "or/glm");
    state = applyAgentUpdate(state, {
        type: "pool_admission_result",
        requestId: "pool-3",
        provider: "or",
        model: "glm",
        verdict: "unavailable",
        reason: "provider timeout",
        seq: 1,
    });
    expect(state.entries.length).toBe(1);

    const dropped = dropTuiAdmission(state, "pool-3");
    expect(dropped.entries.length).toBe(0);
    expect(dropped.admission).toBeUndefined();
});
