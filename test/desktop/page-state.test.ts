import { expect, test } from "bun:test";

import {
    applyPageFrame,
    beginPageTurn,
    createPageState,
} from "../../clients/desktop/src/state.ts";

test("desktop page state accumulates streamed text and finishes the turn", () => {
    let state = beginPageTurn(createPageState(), "inspect the repo");
    state = applyPageFrame(state, {
        type: "assistant_delta",
        text: "Working ",
        seq: 1,
    });
    state = applyPageFrame(state, {
        type: "assistant_delta",
        text: "on it.",
        seq: 2,
    });
    state = applyPageFrame(state, {
        type: "tool_started",
        tool: "read",
        args: { path: "package.json" },
        seq: 3,
    });
    state = applyPageFrame(state, { type: "turn_finished", seq: 4 });

    expect(state).toEqual({
        working: false,
        entries: [
            { kind: "user", text: "inspect the repo" },
            { kind: "assistant", text: "Working on it." },
            { kind: "tool", text: "∗ read package.json" },
        ],
    });
});

test("desktop page state compacts long tool arguments", () => {
    const state = applyPageFrame(beginPageTurn(createPageState(), "go"), {
        type: "tool_started",
        tool: "bash",
        args: { command: "x".repeat(100) },
        seq: 1,
    });

    expect(state.entries.at(-1)?.text).toBe(`∗ bash ${"x".repeat(63)}…`);
});
