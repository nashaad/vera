import { expect, test } from "bun:test";
import { applyAgentUpdate, beginTuiTurn, createTuiState } from "../../clients/tui/state.ts";

for (const durationMs of [268_000, 299_999, 300_000, 360_000]) {
    test(`interruption at ${durationMs}ms uses the long-turn threshold live and after refresh`, () => {
        const turnTiming = { durationMs, finishedAt: Date.now() };
        let state = beginTuiTurn(createTuiState(), "Tell me about a pirate crow");
        state = applyAgentUpdate(state, {
            type: "turn_finished", outcome: "aborted", error: "Stopped", turnTiming, seq: 1,
        });
        expect(state.working).toBe(false);
        expect(state.entries.some((entry) => entry.kind === "worked")).toBe(durationMs >= 300_000);
        expect(state.entries.some((entry) => entry.kind === "notice")).toBe(true);
        state = applyAgentUpdate(state, {
            type: "history",
            entries: [{ kind: "error", outcome: "aborted", turnTiming }],
            seq: 2,
        });
        expect(state.entries.some((entry) => entry.kind === "worked")).toBe(durationMs >= 300_000);
        expect(beginTuiTurn(state, "Continue the pirate crow story").working).toBe(true);
    });
}

for (const durationMs of [0, 299_999, 300_000]) {
    test(`error at ${durationMs}ms uses the long-turn threshold live and after refresh`, () => {
        const turnTiming = { durationMs, finishedAt: Date.now() };
        let state = beginTuiTurn(createTuiState(), "Tell me about a pirate crow");
        state = applyAgentUpdate(state, {
            type: "turn_finished", outcome: "error", error: "Model unavailable", turnTiming, seq: 1,
        });
        expect(state.entries.some((entry) => entry.kind === "worked")).toBe(durationMs >= 300_000);
        state = applyAgentUpdate(state, {
            type: "history", entries: [{ kind: "error", outcome: "error", turnTiming }], seq: 2,
        });
        expect(state.entries.some((entry) => entry.kind === "worked")).toBe(durationMs >= 300_000);
    });
}

test("reopening a short interrupted turn retains the saved final divider", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "history", status: "idle",
        entries: [{ kind: "error", outcome: "aborted", turnTiming: { durationMs: 268_000, finishedAt: Date.now() } }],
        seq: 1,
    });
    expect(state.entries.at(-1)?.kind).toBe("worked");
});
