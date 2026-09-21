import { afterEach, expect, test, setSystemTime } from "bun:test";

import { tuiActivityKind } from "../../clients/tui/activity-bar.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { observeActivity } from "../../clients/tui/main/watchers.ts";
import { applyAgentUpdate, createTuiState } from "../../clients/tui/state.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

afterEach(() => {
    setSystemTime();
});

function runtime(): TuiRuntime {
    return {
        state: createTuiState(),
        activity: "ready",
        reasoning: false,
        workingSince: undefined,
        phaseSince: undefined,
        quietSince: undefined,
        experimentalTuiHost: { agentEvent: () => {} },
    } as unknown as TuiRuntime;
}

function at(rt: TuiRuntime, nowMs: number, update: AgentUpdate): void {
    setSystemTime(new Date(nowMs));
    observeActivity(rt, update);
    rt.state = applyAgentUpdate(rt.state, update);
}

test("a main-pane delivery turn begins dim however long the session has run", () => {
    const rt = runtime();

    at(rt, 1_000, { type: "user_prompt", content: "first", seq: 1 });
    at(rt, 2_000, { type: "assistant_delta", text: "done", seq: 2 });
    at(rt, 3_000, { type: "turn_finished", seq: 3 });
    at(rt, 60_000, { type: "status", state: "working", seq: 4 });

    expect(rt.quietSince).toBe(60_000);
    expect(tuiActivityKind(rt.activity, rt.reasoning, 60_500 - rt.quietSince!)).toBe("waiting");
    expect(tuiActivityKind(rt.activity, rt.reasoning, 62_500 - rt.quietSince!)).toBe("thinking");
});

test("a main-pane back-to-back delivery turn reports only its own thinking and working time", () => {
    const rt = runtime();

    at(rt, 1_000, { type: "user_prompt", content: "first", seq: 1 });
    at(rt, 2_000, { type: "assistant_delta", text: "done", seq: 2 });
    at(rt, 3_000, { type: "turn_finished", seq: 3 });
    at(rt, 60_000, { type: "status", state: "working", seq: 4 });
    expect(rt.workingSince).toBe(60_000);
    at(rt, 61_000, { type: "assistant_thinking", text: "hm", seq: 5 });
    at(rt, 64_000, { type: "assistant_delta", text: "second", seq: 6 });

    expect(rt.state.entries.map((entry) => entry.text)).toContain("Reasoning: 4.0s");
});

test("main-pane thought timing is unaffected by the quiet clock", () => {
    const rt = runtime();

    at(rt, 1_000, { type: "user_prompt", content: "go", seq: 1 });
    at(rt, 2_500, {
        type: "model_activity",
        phase: "retrying",
        model: "test",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 0,
        retryAt: "2026-08-30T22:00:00.000Z",
        failure: { kind: "unknown" },
        seq: 2,
    });
    at(rt, 3_000, { type: "assistant_thinking", text: "hm", seq: 3 });
    at(rt, 5_000, { type: "assistant_delta", text: "answer", seq: 4 });

    expect(rt.quietSince).toBe(2_500);
    expect(rt.phaseSince).toBeUndefined();
    expect(rt.state.entries.map((entry) => entry.text)).toContain("Reasoning: 4.0s");
});
