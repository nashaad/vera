import { expect, test } from "bun:test";

import { applyAgentUpdate, createTuiState } from "../../clients/tui/state.ts";

test("a replayed prompt leaves the client reading as working", () => {
    const replayed = applyAgentUpdate(
        applyAgentUpdate(createTuiState(), {
            type: "history",
            entries: [],
            seq: 0,
        }),
        { type: "user_prompt", content: "run the sweep", seq: 1 },
    );

    expect(replayed.working).toBe(true);
});

test("a prompt from another client is working before any status arrives", () => {
    const observed = applyAgentUpdate(createTuiState(), {
        type: "user_prompt",
        content: "run the sweep",
        seq: 1,
    });

    expect(observed.working).toBe(true);
    expect(observed.entries.at(-1)?.kind).toBe("user");
});

test("a prompt the client already shows still marks it working", () => {
    const live = applyAgentUpdate(
        applyAgentUpdate(createTuiState(), {
            type: "user_prompt",
            content: "run the sweep",
            seq: 1,
        }),
        { type: "user_prompt", content: "run the sweep", seq: 2 },
    );

    expect(live.working).toBe(true);
    expect(live.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
});

test("a finished turn still clears working after a replayed prompt", () => {
    const settled = applyAgentUpdate(
        applyAgentUpdate(createTuiState(), {
            type: "user_prompt",
            content: "run the sweep",
            seq: 1,
        }),
        { type: "turn_finished", seq: 2 },
    );

    expect(settled.working).toBe(false);
});
