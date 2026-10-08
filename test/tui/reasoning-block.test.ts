import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiReasoningBlock, updateTuiReasoningBlock } from "../../clients/tui/reasoning-block.ts";
import { TUI_MUTED, type TuiTranscriptEntry } from "../../clients/tui/state.ts";

function thought(reasoning: string, expanded: boolean): TuiTranscriptEntry {
    return { kind: "thought", text: "Reasoning summary: 2.1s", seconds: 2.1, reasoning, expanded };
}

async function drawBlock(entry: TuiTranscriptEntry, width = 60): Promise<string[]> {
    const setup = await createTestRenderer({ width, height: 12 });
    const node = createTuiReasoningBlock(setup.renderer, "entry-thought", entry, 0);
    setup.renderer.root.add(node);
    try {
        await setup.flush();
        return setup.captureCharFrame().split("\n").slice(0, 10);
    } finally {
        setup.renderer.destroy();
    }
}

test("a closed thought is only its header", async () => {
    const frame = await drawBlock(thought("**Plotting the course**", false));
    expect(frame[0]?.trim()).toBe("Reasoning summary: 2.1s  Ctrl+O reasoning");
    expect(frame.slice(1).every((row) => row.trim() === "")).toBe(true);
});

test("an opened thought puts its text behind a rail, one blank row under the header", async () => {
    const frame = await drawBlock(thought("**Plotting the course**\n\n**Counting the doubloons**", true));
    expect(frame.slice(0, 5).map((row) => row.trimEnd())).toEqual([
        "Reasoning summary: 2.1s  Ctrl+O hide reasoning",
        "",
        "│ Plotting the course",
        "│ Counting the doubloons",
        "",
    ]);
});

test("a wrapped row keeps the rail", async () => {
    const frame = await drawBlock(thought("The crow counts every cannon on the deck twice\n\nThen it naps", true), 24);
    const first = frame.findIndex((row) => row.startsWith("│"));
    expect(frame.slice(first, first + 5).map((row) => row.trimEnd())).toEqual([
        "│ The crow counts every",
        "│ cannon on the deck",
        "│ twice",
        "│",
        "│ Then it naps",
    ]);
});

test("the rail and the text draw in the muted color", async () => {
    const setup = await createTestRenderer({ width: 60, height: 6 });
    const node = createTuiReasoningBlock(setup.renderer, "entry-thought", thought("**Plotting the course**", true), 0);
    setup.renderer.root.add(node);
    try {
        await setup.flush();
        const row = setup.captureSpans().lines[2]!;
        const muted = (span: { fg: { r: number; g: number; b: number } }): string => {
            const to = (value: number): string => Math.round(value * 255).toString(16).padStart(2, "0");
            return `#${to(span.fg.r)}${to(span.fg.g)}${to(span.fg.b)}`;
        };
        const drawn = row.spans.filter((span) => span.text.trim().length > 0);
        expect(drawn.map((span) => span.text).join("")).toContain("│");
        expect(drawn.map((span) => span.text).join("")).toContain("Plotting the course");
        for (const span of drawn) expect(muted(span).toLowerCase()).toBe(TUI_MUTED.toLowerCase());
    } finally {
        setup.renderer.destroy();
    }
});

test("closing a thought removes the rail rows", async () => {
    const setup = await createTestRenderer({ width: 60, height: 8 });
    const node = createTuiReasoningBlock(setup.renderer, "entry-thought", thought("**Plotting the course**", true), 0);
    setup.renderer.root.add(node);
    try {
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("│ Plotting the course");
        updateTuiReasoningBlock(node, thought("**Plotting the course**", false));
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).not.toContain("│");
        expect(frame).not.toContain("Plotting the course");
        expect(node.height).toBe(1);
    } finally {
        setup.renderer.destroy();
    }
});
