import { expect, test } from "bun:test";
import {
    applyThreadUpdate,
    EMPTY_THREAD_FACTS,
    threadFactEntries,
    type ThreadFacts,
} from "../../clients/shared/thread-facts.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

function apply(facts: ThreadFacts, updates: readonly AgentUpdate[], now: number): ThreadFacts {
    return updates.reduce((next, update) => applyThreadUpdate(next, update, now), facts);
}

test("a checkpoint becomes stored facts with ids, write times and turn length", () => {
    const facts = applyThreadUpdate(EMPTY_THREAD_FACTS, {
        type: "history",
        seq: 1,
        entries: [
            { kind: "user", text: "find the buried gold", id: "m1#0", recordedAt: 1_000 },
            { kind: "tool", tool: "bash", args: { command: "dig --deep" }, id: "m2#0", recordedAt: 2_000 },
            { kind: "tool_result", tool: "bash", output: "a chest", isError: false, id: "m3#0", recordedAt: 3_000 },
            {
                kind: "presentation",
                presentation: { kind: "unified_diff", path: "map.md", patch: "+X" },
                id: "m3#1",
                recordedAt: 3_000,
            },
            {
                kind: "presentation",
                presentation: { kind: "unified_diff", path: "scratch.md", patch: "+?", scratch: true },
                id: "m3#2",
                recordedAt: 3_000,
            },
            { kind: "assistant", text: "", id: "m4#0", recordedAt: 4_000 },
            {
                kind: "harness",
                text: "noted",
                tone: "soft",
                id: "m4#1",
                recordedAt: 4_000,
                turnTiming: { durationMs: 3_500, finishedAt: 4_500 },
            },
        ],
    }, 9_999);

    expect(threadFactEntries(facts)).toEqual([
        { kind: "user", text: "find the buried gold", id: "m1#0", at: 1_000 },
        { kind: "tool_call", tool: "bash", args: { command: "dig --deep" }, id: "m2#0", at: 2_000 },
        { kind: "tool_result", tool: "bash", output: "a chest", isError: false, id: "m3#0", at: 3_000 },
        { kind: "edit", path: "map.md", id: "m3#1", at: 3_000, turnDurationMs: 3_500 },
    ]);
});

test("the running turn streams in with client times and no ids", () => {
    const stored = applyThreadUpdate(EMPTY_THREAD_FACTS, {
        type: "history",
        seq: 1,
        entries: [{ kind: "user", text: "ahoy", id: "m1#0", recordedAt: 1_000 }],
    }, 1_000);
    const live = apply(stored, [
        { type: "user_prompt", content: "raise the black flag", seq: 2 },
        { type: "assistant_delta", text: "Raising", seq: 3 },
        { type: "assistant_delta", text: " it now", seq: 4 },
        { type: "tool_started", tool: "bash", args: { command: "hoist" }, seq: 5 },
        { type: "tool_finished", tool: "bash", output: "flag up", seq: 6 },
        {
            type: "tool_presentation",
            tool: "checklist",
            presentation: {
                kind: "checklist",
                path: "plan.md",
                items: [{ text: "hoist", done: true, justDone: true }, { text: "sail", done: false }],
            },
            seq: 7,
        },
        { type: "turn_finished", outcome: "aborted", turnTiming: { durationMs: 900, finishedAt: 5_900 }, seq: 8 },
    ], 5_000);

    expect(threadFactEntries(live).slice(1)).toEqual([
        { kind: "user", text: "raise the black flag", at: 5_000 },
        { kind: "assistant", text: "Raising it now", at: 5_000 },
        { kind: "tool_call", tool: "bash", args: { command: "hoist" }, at: 5_000 },
        { kind: "tool_result", tool: "bash", output: "flag up", isError: false, at: 5_000 },
        {
            kind: "checklist",
            path: "plan.md",
            items: [{ text: "hoist", done: true, justDone: true }, { text: "sail", done: false }],
            at: 5_000,
            turnDurationMs: 900,
        },
        { kind: "failure", outcome: "aborted", at: 5_000 },
    ]);

    const replaced = applyThreadUpdate(live, { type: "history", seq: 9, entries: [] }, 6_000);
    expect(threadFactEntries(replaced)).toEqual([]);
});

test("a retried model attempt drops its partial answer", () => {
    const facts = apply(EMPTY_THREAD_FACTS, [
        { type: "assistant_delta", text: "Half a sea sha", seq: 1 },
        {
            type: "model_activity",
            phase: "retrying",
            model: "claude-opus-5",
            nextAttempt: 2,
            maxAttempts: 3,
            delayMs: 0,
            retryAt: "2026-10-08T00:00:00.000Z",
            failure: { kind: "server" },
            replacesPartialAttempt: true,
            seq: 2,
        },
        { type: "assistant_delta", text: "A whole sea shanty", seq: 3 },
    ], 1_000);

    expect(threadFactEntries(facts)).toEqual([
        { kind: "assistant", text: "A whole sea shanty", at: 1_000 },
    ]);
});

test("an update that is not about the thread leaves the facts untouched", () => {
    const facts = applyThreadUpdate(EMPTY_THREAD_FACTS, { type: "user_prompt", content: "caw", seq: 1 }, 1);
    expect(applyThreadUpdate(facts, { type: "status", state: "idle", seq: 2 }, 2)).toBe(facts);
});
