import { expect, test } from "bun:test";
import { fg, StyledText, type TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createLiveReasoningCache,
    createTuiThinkingWindow,
    liveReasoningRowCount,
    liveReasoningText,
    updateTuiThinkingWindow,
} from "../../clients/tui/thinking-window.ts";
import { transcriptEstimatedRows } from "../../clients/tui/main/transcript-nodes.ts";
import { TUI_MUTED } from "../../clients/tui/state.ts";
import { setTextContent } from "../../clients/tui/text-content.ts";

const PIECES = [
    "The crow checks the chart.",
    "## A heading",
    "**Bold title**",
    "---",
    "",
    "A line with trailing spaces   ",
    "Text with 🐦‍⬛ and café.",
    "   ",
];

// Deterministic generator so a failure names the same text every run.
function randomLines(count: number, seed: number): string {
    let state = seed;
    const next = (): number => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
    };
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
        lines.push(PIECES[Math.floor(next() * PIECES.length)]!);
    }
    return lines.join("\n");
}

test("incremental summaries and row counts match the whole-text pass", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
        const full = randomLines(1 + seed % 30, seed);
        const cache = createLiveReasoningCache();
        let text = "";
        for (let end = 1; end <= full.length; end += 7) {
            text = full.slice(0, end);
            const expected = liveReasoningText(text, true);
            expect(liveReasoningText(text, true, cache)).toBe(expected);
            for (const width of [8, 21, 60]) {
                expect(liveReasoningRowCount(cache, text, width)).toBe(
                    transcriptEstimatedRows(null as never, expected, width),
                );
            }
        }
    }
});

test("replaced text resets the incremental cache", () => {
    const cache = createLiveReasoningCache();
    liveReasoningText("first block\nwith lines", true, cache);
    const replacement = "## Second\n**block**\n---\ntext";
    expect(liveReasoningText(replacement, true, cache)).toBe(
        liveReasoningText(replacement, true),
    );
});

test("carriage returns fall back to the whole-text pass", () => {
    const cache = createLiveReasoningCache();
    const text = "line one\r\nline two\r\n---\r\nline three\r\n";
    for (let end = 1; end <= text.length; end += 3) {
        expect(liveReasoningText(text.slice(0, end), true, cache)).toBe(
            liveReasoningText(text.slice(0, end), true),
        );
    }
});

test("streamed frames match frames drawn from the whole-text rendering", async () => {
    const text = randomLines(120, 7);
    const expected = liveReasoningText(text, true);

    const streamed = await createTestRenderer({ width: 60, height: 30 });
    const streamedNode = createTuiThinkingWindow(
        streamed.renderer,
        "entry-thinking",
        { kind: "thinking", text: "" },
        0,
        "all",
    );
    streamed.renderer.root.add(streamedNode);
    for (let end = 37; end <= text.length; end += 37) {
        updateTuiThinkingWindow(streamedNode, { kind: "thinking", text: text.slice(0, end) }, "all");
    }
    updateTuiThinkingWindow(streamedNode, { kind: "thinking", text }, "all");
    await streamed.flush();
    const streamedFrame = streamed.captureCharFrame();
    streamed.renderer.destroy();

    const reference = await createTestRenderer({ width: 60, height: 30 });
    const referenceNode = createTuiThinkingWindow(
        reference.renderer,
        "entry-thinking",
        { kind: "thinking", text: "" },
        0,
        "all",
    );
    reference.renderer.root.add(referenceNode);
    setTextContent(
        referenceNode.getChildren()[1] as TextRenderable,
        new StyledText([fg(TUI_MUTED)(expected)]),
    );
    await reference.flush();
    const referenceFrame = reference.captureCharFrame();
    reference.renderer.destroy();

    expect(streamedFrame).toBe(referenceFrame);
});
