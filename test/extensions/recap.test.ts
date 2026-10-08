import { expect, test } from "bun:test";
import { buildRecap } from "../../extensions/recap/model.ts";
import { formatDuration, recapRows, recapSubtitle } from "../../extensions/recap/rows.ts";
import type { VeraClientThreadEntry } from "../../src/sdk/extensions.ts";

const NINE = Date.UTC(2026, 9, 8, 9, 0);
const MINUTE = 60_000;
const utcClock = (epochMs: number): string => new Date(epochMs).toISOString().slice(11, 16);

let counter = 0;
function at(minutes: number): { id: string; at: number } {
    counter += 1;
    return { id: `m${counter}#0`, at: NINE + minutes * MINUTE };
}

function user(minutes: number, text: string): VeraClientThreadEntry {
    return { kind: "user", text, ...at(minutes) };
}

function answer(minutes: number, text = "Done."): VeraClientThreadEntry {
    return { kind: "assistant", text, ...at(minutes) };
}

function bash(start: number, end: number, command: string, output = "", isError = false): VeraClientThreadEntry[] {
    return [
        { kind: "tool_call", tool: "bash", args: { command }, ...at(start) },
        { kind: "tool_result", tool: "bash", output, isError, ...at(end) },
    ];
}

function edit(minutes: number, path: string): VeraClientThreadEntry {
    return { kind: "edit", path, ...at(minutes) };
}

test("each request is a phase, short replies continue it unless after a long break, and idle time is not counted", () => {
    const entries = [
        user(0, "Teach the crow to count the doubloons in the hold"),
        edit(4, "src/hold.ts"),
        ...bash(5, 6, "bun test test/hold.test.ts", "3 pass"),
        answer(8),
        user(20, "ok continue"),
        edit(42, "src/hold.ts"),
        ...bash(43, 44, "git commit -m 'feat: count doubloons'", "[main 1a2b3c4] feat: count doubloons\n 1 file changed"),
        answer(45),
        user(50, "Now paint the jolly roger on the mainsail"),
        ...bash(51, 52, "bun test", "1 fail", true),
        answer(53),
        user(90, "go on"),
        answer(91),
    ];

    const phases = buildRecap(entries, NINE + 100 * MINUTE);

    expect(phases.map((phase) => phase.title)).toEqual([
        "Teach the crow to count the doubloons in the…",
        "Now paint the jolly roger on the mainsail",
        "go on",
    ]);
    expect(phases[0]).toMatchObject({
        startedAt: NINE,
        activeMs: 33 * MINUTE,
        toolCalls: 2,
        editedPaths: ["src/hold.ts"],
        tests: "passed",
        running: false,
        target: { entryId: entries[0]!.id! },
    });
    expect(phases[0]!.marks).toEqual([{
        kind: "commit",
        text: "feat: count doubloons",
        ref: "1a2b3c4",
        at: NINE + 44 * MINUTE,
        target: { entryId: entries[7]!.id! },
    }]);
    expect(phases[1]!.tests).toBe("failed");
});

test("a quick question during real work folds into it, and work picks up again", () => {
    const entries = [
        user(0, "Rig the cannons to fire confetti instead"),
        edit(10, "src/cannons.ts"),
        answer(12),
        user(13, "why do parrots outrank crows aboard?"),
        answer(14, "They do not."),
        user(15, "back to it"),
        edit(20, "src/cannons.ts"),
        answer(22),
    ];

    const phases = buildRecap(entries, NINE + 30 * MINUTE);

    expect(phases).toHaveLength(1);
    expect(phases[0]!.activeMs).toBe(19 * MINUTE);
    expect(phases[0]!.marks).toEqual([{
        kind: "aside",
        text: "why do parrots outrank crows aboard?",
        at: NINE + 13 * MINUTE,
        durationMs: MINUTE,
        target: { entryId: entries[3]!.id! },
    }]);
});

test("a short turn that asked you something stays its own phase", () => {
    const entries: VeraClientThreadEntry[] = [
        user(0, "Rig the cannons to fire confetti instead"),
        edit(10, "src/cannons.ts"),
        answer(12),
        user(13, "Plot a course past the kraken"),
        { kind: "tool_call", tool: "ask_user", args: { question: "Around or through?" }, ...at(13.2) },
        { kind: "tool_result", tool: "ask_user", output: "around", isError: false, ...at(13.5) },
        answer(14),
    ];

    const phases = buildRecap(entries, NINE + 20 * MINUTE);

    expect(phases.map((phase) => phase.title)).toEqual(["Rig the cannons to fire confetti instead", "Plot a course past the kraken"]);
    expect(phases[1]!.marks.map((mark) => mark.kind)).toEqual(["question"]);
});

test("a long run splits where the checklist ticks an item, titled by that item", () => {
    const checklist = (minutes: number, done: number): VeraClientThreadEntry => ({
        kind: "checklist",
        path: "plan.md",
        items: ["Chart the reef", "Bury the chest", "Draw the map"].map((text, index) => ({
            text,
            done: index < done,
            ...(index === done - 1 ? { justDone: true as const } : {}),
        })),
        ...at(minutes),
    });
    const entries = [
        user(0, "Go hide the treasure, all of it"),
        edit(5, "reef.md"),
        checklist(10, 1),
        edit(15, "chest.md"),
        checklist(30, 2),
        edit(35, "map.md"),
        answer(40),
    ];

    const phases = buildRecap(entries, NINE + 50 * MINUTE);

    expect(phases.map((phase) => [phase.title, phase.activeMs / MINUTE])).toEqual([
        ["Chart the reef", 10],
        ["Bury the chest", 20],
        ["Draw the map", 10],
    ]);
    expect(phases[1]!.target).toEqual({ entryId: entries[3]!.id! });
});

test("questions, long steps and interruptions get their own marks", () => {
    const entries: VeraClientThreadEntry[] = [
        user(0, "Plot a course for Tortuga by dawn"),
        { kind: "tool_call", tool: "ask_user", args: { question: "Sail around the kraken or through it?" }, ...at(2) },
        { kind: "tool_result", tool: "ask_user", output: "around", isError: false, ...at(16) },
        { kind: "tool_call", tool: "subagent", args: { description: "survey the reef" }, ...at(17) },
        { kind: "tool_result", tool: "subagent", output: "clear", isError: false, ...at(29) },
        ...bash(30, 30.5, "ls"),
        { kind: "failure", outcome: "aborted", ...at(31) },
    ];

    const marks = buildRecap(entries, NINE + 40 * MINUTE)[0]!.marks;

    expect(marks.map((mark) => [mark.kind, mark.text, mark.durationMs])).toEqual([
        ["question", "Sail around the kraken or through it?", 14 * MINUTE],
        ["long_step", "subagent: survey the reef", 12 * MINUTE],
        ["failure", "Interrupted", undefined],
    ]);
});

test("the turn still running has no ids and jumps to the end", () => {
    const entries: VeraClientThreadEntry[] = [
        user(0, "Count the cannonballs"),
        answer(1),
        { kind: "user", text: "Now swab the poop deck, twice", at: NINE + 10 * MINUTE },
        { kind: "tool_call", tool: "bash", args: { command: "swab --twice" }, at: NINE + 11 * MINUTE },
    ];

    const phases = buildRecap(entries, NINE + 25 * MINUTE);

    expect(phases[1]).toMatchObject({ running: true, activeMs: 15 * MINUTE, target: { end: true } });
    expect(phases[1]!.marks[0]).toMatchObject({ kind: "long_step", durationMs: 14 * MINUTE, target: { end: true } });
});

test("rows line marks up under phase titles and read without colour", () => {
    const entries = [
        user(0, "Teach the crow to whistle"),
        edit(3, "crow.ts"),
        ...bash(4, 5, "bun test", "ok"),
        ...bash(6, 7, "git commit -m 'feat: whistle'", "[main (root-commit) abc1234] feat: whistle"),
        answer(8),
    ];
    const phases = buildRecap(entries, NINE + 10 * MINUTE);

    const rows = recapRows(phases, utcClock);

    expect(rows.map((row) => [row.heading, row.group, row.label, row.meta])).toEqual([
        ["09:00", "phase-0", "Teach the crow to whistle", "8m ✓"],
        ["09:00", "phase-0", "  ● feat: whistle", "abc1234"],
    ]);
    expect(rows[0]!.details).toEqual([
        "Teach the crow to whistle",
        "",
        "Started 09:00 · 8m",
        "2 tool calls · 1 file edited",
        "Tests passed ✓",
        "",
        "crow.ts",
    ]);
    expect(recapSubtitle(phases)).toBe("1 phase · 8m working");
    expect([formatDuration(40_000), formatDuration(125 * MINUTE)]).toEqual(["40s", "2h 05m"]);
});

test("a long session builds quickly", () => {
    const entries: VeraClientThreadEntry[] = [];
    for (let turn = 0; turn < 400; turn++) {
        const base = turn * 3;
        entries.push(user(base, `Raid merchant ship number ${turn} for its biscuits`));
        for (let step = 0; step < 10; step++) entries.push(...bash(base + step * 0.1, base + step * 0.1 + 0.05, `loot ${step}`));
        entries.push(edit(base + 2, `ships/${turn % 40}.ts`), answer(base + 2.5));
    }

    const started = performance.now();
    const phases = buildRecap(entries, NINE + 1300 * MINUTE);
    recapRows(phases);

    expect(phases).toHaveLength(400);
    expect(performance.now() - started).toBeLessThan(250);
});
