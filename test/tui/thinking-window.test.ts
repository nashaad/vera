import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiThinkingWindow,
    updateTuiThinkingWindow,
} from "../../clients/tui/thinking-window.ts";

const REASONING = [
    "The crow checks the chart first.",
    "Then it counts the cannons on deck.",
    "Then it picks the lock on the rum store.",
    "Finally it flies off with the key.",
].join("\n");

async function drawWindow(rows: number, text: string, width = 40): Promise<string[]> {
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

test("the block shows the latest rows and keeps its height fixed", async () => {
    const frame = await drawWindow(2, REASONING, 60);
    expect(frame[0]).toContain("···");
    expect(frame[0]).toContain("Then it picks the lock");
    expect(frame[1]).toContain("Finally it flies off");
    expect(frame[2]?.trim()).toBe("");
    expect(frame.join("\n")).not.toContain("checks the chart");
});

test("the rows are reserved before the text fills them", async () => {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const node = createTuiThinkingWindow(
        setup.renderer,
        "entry-thinking",
        { kind: "thinking", text: "The crow checks the chart first." },
        0,
        4,
    );
    setup.renderer.root.add(node);
    try {
        await setup.flush();
        expect(node.height).toBe(4);
        updateTuiThinkingWindow(node, { kind: "thinking", text: REASONING }, 4);
        await setup.flush();
        expect(node.height).toBe(4);
    } finally {
        setup.renderer.destroy();
    }
});

test("long lines wrap and the block still ends on the newest words", async () => {
    const frame = await drawWindow(2, "word ".repeat(40) + "ahoy", 24);
    expect(frame[1]).toContain("ahoy");
    expect(frame[2]?.trim()).toBe("");
});

test("zero rows shows only the ellipsis", async () => {
    const frame = await drawWindow(0, REASONING);
    expect(frame[0]?.trim()).toBe("···");
    expect(frame[1]?.trim()).toBe("");
});
