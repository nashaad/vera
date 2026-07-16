import { expect, test } from "bun:test";

import {
    applyPageFrame,
    beginNextQueuedPageTurn,
    beginPageTurn,
    createPageState,
    queuePagePrompt,
    renderQueuedPrompts,
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
        queuedPrompts: [],
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

test("desktop promotes queued prompts in FIFO order after turns finish", () => {
    let state = beginPageTurn(createPageState(), "first");
    state = applyPageFrame(state, {
        type: "assistant_delta",
        text: "working ",
        seq: 1,
    });
    state = queuePagePrompt(state, "second");
    state = queuePagePrompt(state, "third");
    state = applyPageFrame(state, {
        type: "assistant_delta",
        text: "on it",
        seq: 2,
    });

    expect(state.entries).toEqual([
        { kind: "user", text: "first" },
        { kind: "assistant", text: "working on it" },
    ]);
    expect(state.queuedPrompts).toEqual(["second", "third"]);

    state = applyPageFrame(state, { type: "turn_finished", seq: 3 });
    state = beginNextQueuedPageTurn(state);

    expect(state.working).toBe(true);
    expect(state.queuedPrompts).toEqual(["third"]);
    expect(state.entries.at(-1)).toEqual({ kind: "user", text: "second" });

    state = applyPageFrame(state, { type: "turn_finished", seq: 4 });
    state = beginNextQueuedPageTurn(state);

    expect(state.working).toBe(true);
    expect(state.queuedPrompts).toEqual([]);
    expect(state.entries.at(-1)).toEqual({ kind: "user", text: "third" });
});

test("desktop queue renders a compact summary with remainder count", () => {
    let state = queuePagePrompt(
        createPageState(),
        "explain   " + "x".repeat(60),
    );
    state = queuePagePrompt(state, "then test it");

    expect(renderQueuedPrompts(state.queuedPrompts))
        .toBe(`queued · explain ${"x".repeat(39)}… · +1`);
});

test("desktop queue renders nothing when empty", () => {
    expect(renderQueuedPrompts([])).toBe("");
});
