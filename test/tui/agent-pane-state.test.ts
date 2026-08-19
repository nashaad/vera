import { expect, test } from "bun:test";

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
