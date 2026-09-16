import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyAgentUpdate, createTuiState } from "../../clients/tui/state.ts";
import { workedDividerText } from "../../clients/tui/worked-divider.ts";
import { projectTranscript, type TurnFinishedUpdate } from "../../src/engine/protocol.ts";
import { parseAgentUpdate } from "../../src/host/agent-update-wire.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const turnTiming = {
    durationMs: 125_900,
    finishedAt: new Date(2026, 8, 15, 20, 12).getTime(),
};

test("worked divider dates turns only after twenty-four hours", () => {
    const nextDay = turnTiming.finishedAt + 24 * 60 * 60 * 1_000;
    expect(workedDividerText(turnTiming, turnTiming.finishedAt)).toBe("Worked for 2m 05s");
    expect(workedDividerText(turnTiming, nextDay)).toBe("Worked for 2m 05s");
    expect(workedDividerText(turnTiming, nextDay + 1)).toBe(
        "Worked for 2m 05s · Sep 15, 8:12 PM",
    );
    expect(workedDividerText({ ...turnTiming, durationMs: 900 })).toContain("Worked for 0s");
});

test("terminal notices stay above the divider and replay keeps one copy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-worked-"));
    try {
        for (const outcome of [undefined, "error", "aborted"] as const) {
            const message: AssistantMessage = {
                role: "assistant",
                content: [{ type: "text", text: "Response" }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: outcome ?? "stop",
                ...(outcome === "error" ? { errorMessage: "Request failed" } : {}),
                turnTiming,
            };
            const path = join(directory, `${outcome ?? "completed"}.jsonl`);
            const store = await SessionStore.create(path, { sessionId: outcome ?? "completed", cwd: directory });
            await store.appendMessage({ role: "user", content: [{ type: "text", text: "Go" }] });
            await store.appendMessage(message);
            const reopened = await SessionStore.open(path);
            const entries = projectTranscript(reopened.messages());
            const history = parseAgentUpdate({ type: "history", entries, seq: 3 });
            expect(history).toBeDefined();
            const update: TurnFinishedUpdate = {
                type: "turn_finished", seq: 2, turnTiming,
                ...(outcome === undefined ? {} : { outcome }),
                ...(outcome === "error" ? { error: "Request failed" } : {}),
            };
            expect(parseAgentUpdate(update)).toEqual(update);
            let state = applyAgentUpdate(createTuiState(), {
                type: "assistant_delta", text: "Response", seq: 1,
            });
            state = applyAgentUpdate(state, update);
            expect(state.entries.at(-1)?.kind).toBe(outcome === undefined ? "assistant" : "worked");
            if (outcome !== undefined) expect(state.entries.at(-2)?.kind).toBe("notice");
            state = applyAgentUpdate(state, history!);
            expect(state.entries.filter((entry) => entry.kind === "worked")).toHaveLength(outcome === undefined ? 0 : 1);
            state = applyAgentUpdate(createTuiState(), history!);
            expect(state.entries.filter((entry) => entry.kind === "worked")).toHaveLength(1);
            expect(state.entries.at(-1)?.text).toBe(workedDividerText(turnTiming));
            if (outcome !== undefined) expect(state.entries.at(-2)?.kind).toBe("notice");
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("legacy turns do not acquire an invented date and malformed timing is rejected", () => {
    const state = applyAgentUpdate(createTuiState(), {
        type: "history", entries: [{ kind: "assistant", text: "Earlier" }], seq: 0,
    });
    expect(state.entries.some((entry) => entry.kind === "worked")).toBe(false);
    for (const invalid of [null, { durationMs: -1, finishedAt: 0 }, { durationMs: 0, finishedAt: Infinity }]) {
        expect(parseAgentUpdate({ type: "turn_finished", turnTiming: invalid, seq: 1 })).toBeUndefined();
        expect(parseAgentUpdate({
            type: "history", entries: [{ kind: "assistant", text: "", turnTiming: invalid }], seq: 1,
        })).toBeUndefined();
    }
});


test("five-minute threshold applies to live completion and subsequent history", () => {
    for (const durationMs of [299_999, 300_000]) {
        const timing = { ...turnTiming, durationMs };
        let state = applyAgentUpdate(createTuiState(), {
            type: "assistant_delta", text: "Done", seq: 1,
        });
        state = applyAgentUpdate(state, { type: "turn_finished", turnTiming: timing, seq: 2 });
        const expected = durationMs >= 300_000 ? 1 : 0;
        expect(state.entries.filter((entry) => entry.kind === "worked")).toHaveLength(expected);
        state = applyAgentUpdate(state, {
            type: "history", entries: [{ kind: "assistant", text: "Done", turnTiming: timing }], seq: 3,
        });
        expect(state.entries.filter((entry) => entry.kind === "worked")).toHaveLength(expected);
    }
});

test("reopening dates only the last short turn and retains that boundary on refresh", () => {
    const first = { ...turnTiming, finishedAt: turnTiming.finishedAt - 60_000 };
    const entries = [
        { kind: "assistant" as const, text: "First", turnTiming: first },
        { kind: "user" as const, text: "Again" },
        { kind: "assistant" as const, text: "Second", turnTiming },
    ];
    let state = applyAgentUpdate(createTuiState(), { type: "history", entries, seq: 0 });
    expect(state.entries.filter((entry) => entry.kind === "worked").map((entry) => entry.text))
        .toEqual([workedDividerText(turnTiming)]);
    state = applyAgentUpdate(state, { type: "history", entries, seq: 1 });
    expect(state.entries.filter((entry) => entry.kind === "worked")).toHaveLength(1);
    const active = applyAgentUpdate(createTuiState(), { type: "history", entries, status: "working", seq: 0 });
    expect(active.entries.some((entry) => entry.kind === "worked")).toBe(false);
});
