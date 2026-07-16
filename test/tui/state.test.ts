import { expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";

import {
    applyAgentFrame,
    beginTuiTurn,
    createTuiState,
    renderTuiEntry,
    tuiEntryMarginTop,
} from "../../clients/tui/state.ts";

function plainText(styled: StyledText): string {
    return styled.chunks.map((chunk) => chunk.text).join("");
}

test("TUI state tracks a streamed turn and tool activity", () => {
    let state = beginTuiTurn(createTuiState(), "inspect the project");
    state = applyAgentFrame(state, {
        type: "assistant_delta",
        text: "I will ",
        seq: 1,
    });
    state = applyAgentFrame(state, {
        type: "assistant_delta",
        text: "check.",
        seq: 2,
    });
    state = applyAgentFrame(state, {
        type: "tool_started",
        tool: "bash",
        args: { command: "pwd" },
        seq: 3,
    });
    state = applyAgentFrame(state, {
        type: "tool_finished",
        tool: "bash",
        seq: 4,
    });
    state = applyAgentFrame(state, {
        type: "assistant_delta",
        text: "Done.",
        seq: 5,
    });
    state = applyAgentFrame(state, { type: "turn_finished", seq: 6 });

    expect(state.working).toBe(false);
    expect(state.entries).toEqual([
        { kind: "user", text: "inspect the project" },
        { kind: "assistant", text: "I will check." },
        { kind: "tool", text: "∗ bash pwd" },
        { kind: "assistant", text: "Done." },
    ]);
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
    const state = applyAgentFrame(beginTuiTurn(createTuiState(), "go"), {
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
