import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    animateTuiThinkingWindow,
    createTuiThinkingWindow,
    updateTuiThinkingWindow,
} from "../../clients/tui/thinking-window.ts";
import type { TuiLiveReasoningRows } from "../../clients/tui/theme-preference.ts";

const REASONING = [
    "The crow checks the chart first.",
    "Then it counts the cannons on deck.",
    "Then it picks the lock on the rum store.",
    "Finally it flies off with the key.",
].join("\n");

async function drawWindow(rows: TuiLiveReasoningRows, text: string, width = 40): Promise<string[]> {
    const setup = await createTestRenderer({ width, height: 12 });
    const node = createTuiThinkingWindow(
        setup.renderer,
        "entry-thinking",
        { kind: "thinking", text },
        0,
        rows,
    );
    setup.renderer.root.add(node);
    try {
        await setup.flush();
        return setup.captureCharFrame().split("\n").slice(0, 10);
    } finally {
        setup.renderer.destroy();
    }
}

test("one line shows only the newest line", async () => {
    const frame = await drawWindow(1, REASONING, 60);
    expect(frame[0]).toContain("···");
    expect(frame[0]).toContain("Finally it flies off");
    expect(frame[1]?.trim()).toBe("");
    expect(frame.join("\n")).not.toContain("picks the lock");
});

test("unbounded shows every line and grows with the text", async () => {
    const frame = await drawWindow("all", REASONING, 60);
    expect(frame[0]).toContain("checks the chart");
    expect(frame[3]).toContain("Finally it flies off");
    expect(frame[4]?.trim()).toBe("");
});

test("the spinner replaces the dots without moving the text", async () => {
    const setup = await createTestRenderer({ width: 60, height: 4 });
    const node = createTuiThinkingWindow(
        setup.renderer,
        "entry-thinking",
        { kind: "thinking", text: "The crow checks the chart first." },
        0,
        1,
    );
    setup.renderer.root.add(node);
    try {
        await setup.flush();
        const before = setup.captureCharFrame().split("\n")[0] ?? "";
        animateTuiThinkingWindow(node, 1);
        await setup.flush();
        const after = setup.captureCharFrame().split("\n")[0] ?? "";
        expect(after.startsWith("⠙")).toBe(true);
        expect(after.indexOf("The crow")).toBe(before.indexOf("The crow"));
    } finally {
        setup.renderer.destroy();
    }
});

test("the rows are reserved before the text fills them", async () => {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const node = createTuiThinkingWindow(
        setup.renderer,
        "entry-thinking",
        { kind: "thinking", text: "The crow checks the chart first." },
        0,
        8,
    );
    setup.renderer.root.add(node);
    try {
        await setup.flush();
        expect(node.height).toBe(8);
        updateTuiThinkingWindow(node, { kind: "thinking", text: REASONING }, 8);
        await setup.flush();
        expect(node.height).toBe(8);
    } finally {
        setup.renderer.destroy();
    }
});

test("long lines wrap and the block still ends on the newest words", async () => {
    const frame = await drawWindow(1, "word ".repeat(40) + "ahoy", 24);
    expect(frame[0]).toContain("ahoy");
    expect(frame[1]?.trim()).toBe("");
});

test("zero rows shows only the ellipsis", async () => {
    const frame = await drawWindow(0, REASONING);
    expect(frame[0]?.trim()).toBe("···");
    expect(frame[1]?.trim()).toBe("");
});

test("earlier rows carry the rail and the newest row carries the mark", async () => {
    const frame = await drawWindow("all", REASONING, 60);
    expect(frame.slice(0, 3).map((row) => row.slice(0, 4))).toEqual(["│   ", "│   ", "│   "]);
    expect(frame[3]?.startsWith("··· Finally it flies off")).toBe(true);
});

test("wrapped rows carry the rail too", async () => {
    const frame = await drawWindow("all", "The crow counts every cannon on the deck twice\nThen it naps", 24);
    expect(frame[0]?.startsWith("│")).toBe(true);
    expect(frame[1]?.startsWith("│")).toBe(true);
    expect(frame.findIndex((row) => row.includes("Then it naps"))).toBe(frame.findIndex((row) => row.startsWith("···")));
});

test("reserved rows below the text stay blank", async () => {
    const frame = await drawWindow(8, "The crow checks the chart first.\nThen it counts the cannons on deck.", 60);
    expect(frame[0]?.startsWith("│   The crow")).toBe(true);
    expect(frame[1]?.startsWith("··· Then it counts")).toBe(true);
    expect(frame.slice(2, 8).every((row) => row.trim() === "")).toBe(true);
});

test("the spinner sits on the newest row", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const node = createTuiThinkingWindow(setup.renderer, "entry-thinking", { kind: "thinking", text: REASONING }, 0, "all");
    setup.renderer.root.add(node);
    try {
        animateTuiThinkingWindow(node, 1);
        await setup.flush();
        const frame = setup.captureCharFrame().split("\n");
        expect(frame[0]?.startsWith("│")).toBe(true);
        expect(frame[3]?.startsWith("⠙   Finally")).toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});
