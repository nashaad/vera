import { expect, test } from "bun:test";
import { parseColor } from "@opentui/core";

import {
    renderTuiChecklist,
    tuiChecklistLines,
    tuiChecklistText,
} from "../../clients/tui/checklist.ts";
import { TUI_MUTED, TUI_SUCCESS, TUI_TEXT } from "../../clients/tui/palette.ts";
import type { ChecklistItem } from "../../src/model/types.ts";

function items(doneCount: number, total: number, justDone?: number): ChecklistItem[] {
    return Array.from({ length: total }, (_, index) => ({
        text: `Task ${index + 1}`,
        done: index < doneCount,
        ...(index === justDone ? { justDone: true as const } : {}),
    }));
}

test("short checklists show every item, the newly done one and the next one marked", () => {
    expect(tuiChecklistText({
        kind: "checklist",
        path: "/scratch/todo.md",
        title: "OpenRouter token benchmark",
        items: [
            { text: "Create a worktree.", done: true },
            { text: "Verify `--effort low`; CLI test passes.", done: true, justDone: true },
            { text: "Define a runner.", done: false },
            { text: "~~Capture usage.~~", done: false },
        ],
    })).toBe([
        "OpenRouter token benchmark  2/4",
        "✓ Create a worktree.",
        "✓ Verify --effort low; CLI test passes.",
        "○ Define a runner.",
        "○ Capture usage.",
    ].join("\n"));
    expect(tuiChecklistLines({
        kind: "checklist",
        path: "/scratch/todo.md",
        items: items(1, 3, 0),
    }).map((line) => line.kind === "item" ? line.state : line.kind)).toEqual([
        "title",
        "just_done",
        "next",
        "open",
    ]);
});

test("an eight-item list still shows in full", () => {
    const lines = tuiChecklistLines({
        kind: "checklist",
        path: "/scratch/todo.md",
        items: items(4, 8),
    });
    expect(lines).toHaveLength(9);
    expect(lines[0]).toEqual({ kind: "title", title: "Todo", done: 4, total: 8 });
});

test("long checklists fold older done items and later open items", () => {
    expect(tuiChecklistText({
        kind: "checklist",
        path: "/scratch/todo.md",
        title: "Raid",
        items: items(7, 12),
    })).toBe([
        "Raid  7/12",
        "✓ 5 done",
        "✓ Task 6",
        "✓ Task 7",
        "○ Task 8",
        "○ Task 9",
        "○ Task 10",
        "○ 2 more",
    ].join("\n"));
});

test("a long checklist keeps an item ticked out of order visible", () => {
    expect(tuiChecklistText({
        kind: "checklist",
        path: "/scratch/todo.md",
        title: "Raid",
        items: items(7, 12, 1),
    })).toBe([
        "Raid  7/12",
        "✓ 4 done",
        "✓ Task 2",
        "✓ Task 6",
        "✓ Task 7",
        "○ Task 8",
        "○ Task 9",
        "○ Task 10",
        "○ 2 more",
    ].join("\n"));
});

test("checklist rows color the newly done item, dim done ones, and keep the next one plain", () => {
    const chunks = renderTuiChecklist({
        kind: "checklist",
        path: "/scratch/todo.md",
        title: "Raid",
        items: [
            { text: "Chart the reef", done: true },
            { text: "Steal the lantern", done: true, justDone: true },
            { text: "Bribe the gulls", done: false },
            { text: "Sail at dawn", done: false },
        ],
    });
    const colorOf = (text: string) =>
        chunks.find((chunk) => chunk.text.includes(text))?.fg;

    expect(colorOf("Raid")).toEqual(parseColor(TUI_TEXT));
    expect(colorOf("2/4")).toEqual(parseColor(TUI_MUTED));
    expect(colorOf("Chart the reef")).toEqual(parseColor(TUI_MUTED));
    expect(colorOf("Steal the lantern")).toEqual(parseColor(TUI_SUCCESS));
    expect(colorOf("Bribe the gulls")).toEqual(parseColor(TUI_TEXT));
    expect(colorOf("Sail at dawn")).toEqual(parseColor(TUI_MUTED));
});

test("the title row shows the checklist's path", () => {
    expect(tuiChecklistText({
        kind: "checklist",
        path: "/scratch/crow-raid.md",
        title: "Raid",
        items: items(1, 2),
    }, "/scratch/crow-raid.md").split("\n")[0]).toBe("Raid  1/2 · /scratch/crow-raid.md");
});
