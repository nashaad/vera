import { expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";

import {
    applyAgentUpdate,
    beginNextQueuedTuiTurn,
    beginTuiTurn,
    createTuiState,
    queueTuiPrompt,
    renderTuiEntry,
    renderTuiQueuedPrompt,
    tuiEntryMarginTop,
} from "../../clients/tui/state.ts";

function plainText(styled: StyledText): string {
    return styled.chunks.map((chunk) => chunk.text).join("");
}

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

test("TUI does not duplicate its optimistic user prompt", () => {
    const state = applyAgentUpdate(
        beginTuiTurn(createTuiState(), "inspect"),
        { type: "user_prompt", content: "inspect", seq: 1 },
    );

    expect(state.entries).toEqual([{ kind: "user", text: "inspect" }]);
});

test("TUI entries render with kind-specific prefixes", () => {
    expect(plainText(renderTuiEntry({ kind: "user", text: "hi\nthere" })))
        .toBe("▌ hi\n▌ there");
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
