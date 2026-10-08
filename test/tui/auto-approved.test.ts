import { expect, test } from "bun:test";
import {
    applyAgentUpdate,
    beginTuiTurn,
    createTuiState,
    toggleTuiToolDetails,
    toggleTuiWorkedRow,
    tuiWorkedRowText,
    type TuiState,
} from "../../clients/tui/state.ts";

const LONG = 360_000;
const SHORT = 42_000;

function lowAllow(state: TuiState, seq: number): TuiState {
    return applyAgentUpdate(state, {
        type: "tool_review",
        tool: "bash",
        decision: "allow",
        reason: "The crow only counts the doubloons.",
        riskLevel: "low",
        userAuthorization: "unknown",
        seq,
    });
}

function turnWithAllows(count: number): TuiState {
    let state = beginTuiTurn(createTuiState(), "Count the doubloons");
    for (let seq = 1; seq <= count; seq += 1) state = lowAllow(state, seq);
    return applyAgentUpdate(state, { type: "assistant_delta", text: "Forty doubloons.", seq: 50 });
}

function workedRows(state: TuiState): string[] {
    return state.entries.filter((entry) => entry.kind === "worked").map(tuiWorkedRowText);
}

test("low-risk allows add no rows and count up", () => {
    const state = turnWithAllows(3);
    expect(state.entries.some((entry) => entry.kind === "review")).toBe(false);
    expect(state.autoApprovals).toHaveLength(3);
});

test("a medium-risk allow stays a row and is not counted", () => {
    const state = applyAgentUpdate(beginTuiTurn(createTuiState(), "Fire the cannon"), {
        type: "tool_review",
        tool: "bash",
        decision: "allow",
        reason: "The cannon is aimed at the sea.",
        riskLevel: "medium",
        userAuthorization: "high",
        seq: 1,
    });
    expect(state.entries.filter((entry) => entry.kind === "review")).toHaveLength(1);
    expect(state.autoApprovals).toBeUndefined();
});

test("a long turn puts the count on its worked row and clears it", () => {
    const state = applyAgentUpdate(turnWithAllows(3), {
        type: "turn_finished", turnTiming: { durationMs: LONG, finishedAt: Date.now() }, seq: 60,
    });
    expect(workedRows(state)).toEqual(["Worked for 6m 00s · 3 auto-approved"]);
    expect(state.autoApprovals).toBeUndefined();
});

test("a short turn with approvals gets a row with only the count", () => {
    const state = applyAgentUpdate(turnWithAllows(2), {
        type: "turn_finished", turnTiming: { durationMs: SHORT, finishedAt: Date.now() }, seq: 60,
    });
    expect(workedRows(state)).toEqual(["2 auto-approved"]);
    const last = state.entries.at(-1);
    expect(last?.kind === "worked" && last.liveOnly).toBe(true);
});

test("a short turn without approvals gets no row", () => {
    const state = applyAgentUpdate(turnWithAllows(0), {
        type: "turn_finished", turnTiming: { durationMs: SHORT, finishedAt: Date.now() }, seq: 60,
    });
    expect(workedRows(state)).toEqual([]);
});

test("each turn counts only its own approvals", () => {
    let state = applyAgentUpdate(turnWithAllows(2), {
        type: "turn_finished", turnTiming: { durationMs: SHORT, finishedAt: Date.now() }, seq: 60,
    });
    state = lowAllow(beginTuiTurn(state, "Count them again"), 61);
    state = applyAgentUpdate(state, {
        type: "turn_finished", turnTiming: { durationMs: SHORT, finishedAt: Date.now() }, seq: 62,
    });
    expect(workedRows(state)).toEqual(["2 auto-approved", "1 auto-approved"]);
});

test("a failed agent clears the count", () => {
    const state = applyAgentUpdate(turnWithAllows(2), {
        type: "agent_failed", failureId: "parrot-1", detail: "The parrot ate the map", seq: 60,
    });
    expect(state.autoApprovals).toBeUndefined();
    expect(workedRows(state)).toEqual([]);
});

for (const durationMs of [SHORT, LONG]) {
    test(`a matching history checkpoint keeps the count after a ${durationMs}ms turn`, () => {
        const turnTiming = { durationMs, finishedAt: Date.now() };
        let state = applyAgentUpdate(turnWithAllows(3), { type: "turn_finished", turnTiming, seq: 60 });
        const before = workedRows(state);
        state = applyAgentUpdate(state, {
            type: "history",
            entries: [
                { kind: "user", text: "Count the doubloons" },
                { kind: "assistant", text: "Forty doubloons.", turnTiming },
            ],
            seq: 61,
        });
        expect(workedRows(state)).toEqual(before);
        expect(state.entries.at(-1)?.kind).toBe("worked");
    });
}

function cannonTurn(): TuiState {
    let state = beginTuiTurn(createTuiState(), "Fire the cannon");
    let seq = 1;
    const run = (command: string): void => {
        state = applyAgentUpdate(state, { type: "tool_started", tool: "bash", args: { command }, seq: seq++ });
        state = applyAgentUpdate(state, { type: "tool_finished", tool: "bash", seq: seq++ });
    };
    state = lowAllow(state, seq++);
    run("env -i DOUBLOON=one");
    state = applyAgentUpdate(state, {
        type: "tool_review",
        tool: "bash",
        decision: "allow",
        reason: "The cannon points at open sea.",
        riskLevel: "medium",
        userAuthorization: "high",
        seq: seq++,
    });
    run("env -i CANNON=fired");
    return applyAgentUpdate(state, { type: "assistant_delta", text: "Fired once.", seq: seq++ });
}

function shape(state: TuiState): string[] {
    return state.entries.filter((entry) => entry.kind !== "worked").map((entry) =>
        entry.kind === "tool" ? `tool ${entry.text}` : entry.kind
    );
}

test("a review row sits directly above the call it approved", () => {
    expect(shape(cannonTurn())).toEqual([
        "user",
        "tool_header",
        "tool env -i DOUBLOON=one",
        "review",
        "tool_header",
        "tool env -i CANNON=fired",
        "assistant",
    ]);
});

test("a matching history checkpoint keeps the review above its call", () => {
    const live = cannonTurn();
    const state = applyAgentUpdate(live, {
        type: "history",
        entries: [
            { kind: "user", text: "Fire the cannon" },
            { kind: "tool", tool: "bash", args: { command: "env -i DOUBLOON=one" } },
            { kind: "tool", tool: "bash", args: { command: "env -i CANNON=fired" } },
            { kind: "assistant", text: "Fired once." },
        ],
        seq: 99,
    });
    expect(shape(state)).toEqual(shape(live));
});

function workedEntry(state: TuiState) {
    const index = state.entries.findIndex((entry) => entry.kind === "worked");
    const entry = state.entries[index];
    if (entry === undefined || entry.kind !== "worked") throw new Error("no worked row");
    return { index, entry };
}

function finishedCannonTurn(): TuiState {
    return applyAgentUpdate(cannonTurn(), {
        type: "turn_finished", turnTiming: { durationMs: SHORT, finishedAt: Date.now() }, seq: 99,
    });
}

test("each auto-approval keeps the call that followed it", () => {
    const { entry } = workedEntry(finishedCannonTurn());
    expect(entry.autoApprovals).toEqual([
        { tool: "bash", reason: "The crow only counts the doubloons.", call: "env -i DOUBLOON=one" },
    ]);
    expect(entry.expanded).toBeUndefined();
});

test("an approval waits for the next start of its own tool", () => {
    let state = lowAllow(beginTuiTurn(createTuiState(), "Count"), 1);
    state = applyAgentUpdate(state, { type: "tool_started", tool: "read", args: { path: "map.md" }, seq: 2 });
    expect(state.autoApprovals?.[0]?.call).toBeUndefined();
    state = applyAgentUpdate(state, { type: "tool_started", tool: "bash", args: { command: "env -i CHEST=open" }, seq: 3 });
    expect(state.autoApprovals?.[0]?.call).toBe("env -i CHEST=open");
});

test("toggling a worked row opens and closes its list", () => {
    const state = finishedCannonTurn();
    const { index } = workedEntry(state);
    const opened = toggleTuiWorkedRow(state, index);
    expect(workedEntry(opened).entry.expanded).toBe(true);
    expect(workedEntry(toggleTuiWorkedRow(opened, index)).entry.expanded).toBe(false);
    expect(toggleTuiWorkedRow(state, 0)).toBe(state);
});

test("Ctrl+T opens every list and a later turn starts open", () => {
    // Rows without output stay visible, so the first press hides them and the second opens everything.
    let state = toggleTuiToolDetails(toggleTuiToolDetails(finishedCannonTurn()));
    expect(state.toolDetailsExpanded).toBe(true);
    expect(workedEntry(state).entry.expanded).toBe(true);
    state = lowAllow(beginTuiTurn(state, "Again"), 100);
    state = applyAgentUpdate(state, {
        type: "turn_finished", turnTiming: { durationMs: SHORT, finishedAt: Date.now() }, seq: 101,
    });
    const worked = state.entries.filter((entry) => entry.kind === "worked");
    expect(worked.map((entry) => entry.kind === "worked" && entry.expanded)).toEqual([true, true]);
    state = toggleTuiToolDetails(state);
    expect(state.entries.filter((entry) => entry.kind === "worked").map((entry) =>
        entry.kind === "worked" && entry.expanded
    )).toEqual([false, false]);
});

test("a matching history checkpoint keeps an open list", () => {
    const live = finishedCannonTurn();
    const opened = toggleTuiWorkedRow(live, workedEntry(live).index);
    const state = applyAgentUpdate(opened, {
        type: "history",
        entries: [
            { kind: "user", text: "Fire the cannon" },
            { kind: "tool", tool: "bash", args: { command: "env -i DOUBLOON=one" } },
            { kind: "tool", tool: "bash", args: { command: "env -i CANNON=fired" } },
            { kind: "assistant", text: "Fired once." },
        ],
        seq: 120,
    });
    expect(workedEntry(state).entry).toEqual(workedEntry(opened).entry);
});
