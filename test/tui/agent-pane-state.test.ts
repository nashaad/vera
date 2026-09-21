import { expect, test } from "bun:test";

import { tuiActivityKind } from "../../clients/tui/activity-bar.ts";
import { TuiAgentPaneState } from "../../clients/tui/agent-pane-state.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

test("two panes reduce agent updates into independent transcripts", () => {
    const main = new TuiAgentPaneState();
    const sidebar = new TuiAgentPaneState();

    main.apply({ type: "user_prompt", content: "main question", seq: 1 }, 1_000);
    sidebar.apply({ type: "user_prompt", content: "side question", seq: 1 }, 2_000);
    main.apply({ type: "assistant_thinking", text: "main thinking", seq: 2 }, 1_000);
    sidebar.apply({ type: "assistant_thinking", text: "side thinking", seq: 2 }, 2_000);
    main.apply({ type: "assistant_delta", text: "main answer", seq: 3 }, 3_000);
    sidebar.apply({ type: "assistant_delta", text: "side answer", seq: 3 }, 4_000);

    expect(main.state.entries.map((entry) => entry.text)).toEqual([
        "main question",
        "Reasoning: 2.0s",
        "main answer",
    ]);
    expect(sidebar.state.entries.map((entry) => entry.text)).toEqual([
        "side question",
        "Reasoning: 2.0s",
        "side answer",
    ]);
});

test("approval queues belong to one pane", () => {
    const main = new TuiAgentPaneState();
    const sidebar = new TuiAgentPaneState();
    const first = approval("main-1");
    const second = approval("main-2");
    const side = approval("side-1");

    main.apply(first);
    main.apply(second);
    sidebar.apply(side);

    expect(main.pendingUiRequest?.requestId).toBe("main-1");
    expect(main.queuedUiRequests.map((request) => request.requestId))
        .toEqual(["main-2"]);
    expect(sidebar.pendingUiRequest?.requestId).toBe("side-1");
    expect(sidebar.queuedUiRequests).toEqual([]);

    main.apply({ type: "ui_request_closed", requestId: "main-1", seq: 3 });
    expect(main.pendingUiRequest?.requestId).toBe("main-2");
    expect(sidebar.pendingUiRequest?.requestId).toBe("side-1");
});

test("activity timing and background agents stay pane-local", () => {
    const main = new TuiAgentPaneState();
    const sidebar = new TuiAgentPaneState();

    main.apply({ type: "status", state: "working", seq: 1 }, 1_000);
    sidebar.apply({ type: "status", state: "waiting", seq: 1 }, 5_000);
    main.setBackgroundAgents({
        running: 1,
        children: ["research"],
        has_parent: false,
    });
    sidebar.setBackgroundAgents({
        running: 0,
        children: [],
        has_parent: true,
    });

    expect(main.activity).toBe("thinking");
    expect(main.elapsedWorkingTime(62_000)).toBe("1m01s");
    expect(main.backgroundAgents).toEqual({
        running: 1,
        children: ["research"],
        has_parent: false,
    });
    expect(sidebar.activity).toBe("waiting");
    expect(sidebar.elapsedWorkingTime(6_000)).toBe("1s");
    expect(sidebar.backgroundAgents?.has_parent).toBe(true);
});

test("late reasoning settles before the answer when the turn completes", () => {
    const pane = new TuiAgentPaneState();

    pane.apply({
        type: "assistant_delta",
        text: "I created the game files.",
        seq: 1,
    }, 2_000);
    pane.apply({
        type: "assistant_thinking",
        text: "Identifying and fixing syntax errors",
        seq: 2,
    }, 3_000);
    pane.apply({ type: "turn_finished", seq: 3 }, 4_000);

    expect(pane.state.working).toBe(false);
    expect(pane.state.entries.map((entry) => entry.kind)).toEqual([
        "thought",
        "assistant",
    ]);
    expect(pane.state.entries[0]).toMatchObject({
        reasoning: "Identifying and fixing syntax errors",
    });
    expect(pane.state.pendingThinking).toBeUndefined();
});

test("a retry discards only the failed model round", () => {
    const pane = new TuiAgentPaneState();

    pane.apply({ type: "user_prompt", content: "inspect", seq: 1 }, 1_000);
    pane.apply({ type: "assistant_delta", text: "First round", seq: 2 }, 2_000);
    pane.apply({
        type: "tool_started",
        tool: "read",
        args: { path: "notes.txt" },
        seq: 3,
    }, 3_000);
    pane.apply({
        type: "tool_finished",
        tool: "read",
        output: "notes",
        seq: 4,
    }, 4_000);
    pane.apply({
        type: "assistant_thinking",
        text: "failed reasoning",
        seq: 5,
    }, 5_000);
    pane.apply({
        type: "assistant_delta",
        text: "Failed partial answer",
        seq: 6,
    }, 6_000);
    pane.apply({
        type: "model_activity",
        phase: "retrying",
        model: "test",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        retryAt: "2026-08-30T22:00:00.500Z",
        failure: { kind: "unknown" },
        replacesPartialAttempt: true,
        seq: 7,
    }, 7_000);

    expect(pane.state.entries.map((entry) => entry.text)).toEqual([
        "inspect",
        "First round",
        "+ Explored",
        "Read notes.txt",
        "notes",
    ]);
    expect(pane.state.pendingThinking).toBeUndefined();
    expect(pane.phaseSince).toBeUndefined();

    pane.apply({
        type: "assistant_delta",
        text: "Successful answer",
        seq: 8,
    }, 8_000);
    expect(pane.state.entries.at(-1)?.text).toBe("Successful answer");
});

function approval(requestId: string): AgentUpdate {
    return {
        type: "ui_request",
        requestId,
        request: {
            type: "tool_approval",
            toolCall: {
                id: `call-${requestId}`,
                name: "read",
                input: {},
            },
            reason: "approval needed",
            warning: "read approval",
        },
        seq: Number(requestId.endsWith("2")) + 1,
    };
}

test("a pane is waiting on the model until reasoning tokens arrive", () => {
    const pane = new TuiAgentPaneState();
    const seen: boolean[] = [];

    pane.apply({ type: "user_prompt", content: "inspect", seq: 1 }, 1_000);
    seen.push(pane.reasoning);
    pane.apply({ type: "assistant_thinking", text: "hm", seq: 2 }, 2_000);
    seen.push(pane.reasoning);
    pane.apply({ type: "tool_started", tool: "read", args: { path: "a" }, seq: 3 }, 3_000);
    pane.apply({ type: "tool_finished", tool: "read", output: "a", seq: 4 }, 4_000);
    seen.push(pane.reasoning);

    expect(seen).toEqual([false, true, false]);
    expect(pane.activity).toBe("thinking");
});

test("a delivery turn restarts the quiet clock so its strip begins dim", () => {
    const pane = new TuiAgentPaneState();

    pane.apply({ type: "user_prompt", content: "first", seq: 1 }, 1_000);
    pane.apply({ type: "assistant_delta", text: "done", seq: 2 }, 2_000);
    pane.apply({ type: "turn_finished", seq: 3 }, 3_000);
    // No user_prompt: a delivery turn opens with status working alone.
    pane.apply({ type: "status", state: "working", seq: 4 }, 60_000);

    expect(pane.quietSince).toBe(60_000);
    expect(tuiActivityKind(pane.activity, pane.reasoning, 60_500 - pane.quietSince!)).toBe("waiting");
    expect(tuiActivityKind(pane.activity, pane.reasoning, 62_500 - pane.quietSince!)).toBe("thinking");
});

test("every request that goes out restarts the quiet clock", () => {
    const pane = new TuiAgentPaneState();

    pane.apply({ type: "user_prompt", content: "go", seq: 1 }, 1_000);
    expect(pane.quietSince).toBe(1_000);
    pane.apply({ type: "tool_started", tool: "read", args: { path: "a" }, seq: 2 }, 2_000);
    pane.apply({ type: "tool_finished", tool: "read", output: "a", seq: 3 }, 9_000);
    expect(pane.quietSince).toBe(9_000);
    pane.apply({ type: "status", state: "idle", seq: 4 }, 10_000);
    expect(pane.quietSince).toBeUndefined();
});

test("a back-to-back delivery turn reports only its own thinking time", () => {
    const pane = new TuiAgentPaneState();

    pane.apply({ type: "user_prompt", content: "first", seq: 1 }, 1_000);
    pane.apply({ type: "assistant_delta", text: "done", seq: 2 }, 2_000);
    pane.apply({ type: "turn_finished", seq: 3 }, 3_000);
    pane.apply({ type: "status", state: "working", seq: 4 }, 60_000);
    pane.apply({ type: "assistant_thinking", text: "hm", seq: 5 }, 61_000);
    pane.apply({ type: "assistant_delta", text: "second", seq: 6 }, 64_000);

    expect(pane.state.entries.map((entry) => entry.text)).toContain("Reasoning: 4.0s");
});

test("thought timing still runs from the phase start, not the quiet clock", () => {
    const pane = new TuiAgentPaneState();

    pane.apply({ type: "user_prompt", content: "go", seq: 1 }, 1_000);
    pane.apply({
        type: "model_activity",
        phase: "retrying",
        model: "test",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 0,
        retryAt: "2026-08-30T22:00:00.000Z",
        failure: { kind: "unknown" },
        seq: 2,
    }, 2_500);
    pane.apply({ type: "assistant_thinking", text: "hm", seq: 3 }, 3_000);
    pane.apply({ type: "assistant_delta", text: "answer", seq: 4 }, 5_000);

    expect(pane.quietSince).toBe(2_500);
    expect(pane.state.entries.map((entry) => entry.text)).toEqual([
        "go",
        "Reasoning: 4.0s",
        "answer",
    ]);
});
