import { expect, test } from "bun:test";
import { addDefaultParsers, parseColor, type RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { createMarkdownStyle } from "../../clients/tui/main/chrome.ts";
import { createTuiMarkdownEntry } from "../../clients/tui/markdown-entry.ts";
import { FALLBACK_TUI_THEME } from "../../clients/tui/theme.ts";
import { waitForRender } from "./render-wait.ts";

// The diff grammar normally downloads on first use. This copy of the release asset and
// of the highlight query Vera registers lets the test run offline.
const DIFF_GRAMMAR = new URL("./fixtures/tree-sitter-diff/", import.meta.url).pathname;
addDefaultParsers([{
    filetype: "diff",
    wasm: `${DIFF_GRAMMAR}tree-sitter-diff.wasm`,
    queries: { highlights: [`${DIFF_GRAMMAR}highlights.scm`] },
}]);

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

const theme = FALLBACK_TUI_THEME;

const REPLY = [
    "Here is the change.",
    "",
    "```diff",
    "@@ -1,3 +1,3 @@",
    " context line",
    "-old line",
    "+new line",
    "```",
    "",
    "Done.",
].join("\n");

// One foreground color per terminal column of the row that holds `text`.
function rowColors(setup: Setup, text: string): { row: string; colors: RGBA[] } {
    for (const line of setup.captureSpans().lines) {
        const row = line.spans.map((span) => span.text).join("");
        if (!row.includes(text)) continue;
        const colors = line.spans.flatMap((span) =>
            Array.from({ length: span.text.length }, () => span.fg));
        return { row, colors };
    }
    throw new Error(`no row contains ${text}`);
}

function colorsOf(setup: Setup, text: string): RGBA[] {
    const { row, colors } = rowColors(setup, text);
    const start = row.indexOf(text);
    return colors.slice(start, start + text.length);
}

async function renderReply(text: string): Promise<Setup> {
    const setup = await createTestRenderer({ width: 50, height: 16 });
    const style = createMarkdownStyle(theme);
    const node = createTuiMarkdownEntry(
        setup.renderer,
        "diff-reply",
        { kind: "assistant", text },
        style,
        theme.text,
        0,
        false,
    );
    setup.renderer.root.add(node!);
    try {
        await waitForRender(setup, () => {
            const frame = setup.captureCharFrame();
            return ["@@ -1,3 +1,3 @@", "context line", "-old line", "+new line", "Here is the change.", "Done."]
                .every((text) => frame.includes(text))
                && !colorsOf(setup, "@@ -1,3 +1,3 @@").every((color) => color.equals(parseColor(theme.text)));
        });
    } catch (error) {
        setup.renderer.destroy();
        throw error;
    }
    return setup;
}

test("a diff block in a reply colors added and removed lines, signs included", async () => {
    const setup = await renderReply(REPLY);
    try {
        const added = colorsOf(setup, "+new line");
        const removed = colorsOf(setup, "-old line");
        expect(added.every((color) => color.equals(parseColor(theme.diffAdded)))).toBe(true);
        expect(removed.every((color) => color.equals(parseColor(theme.diffRemoved)))).toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});

test("a diff hunk header is secondary and context and prose keep the text color", async () => {
    const setup = await renderReply(REPLY);
    try {
        const header = colorsOf(setup, "@@ -1,3 +1,3 @@");
        expect(header.every((color) => color.equals(parseColor(theme.secondary)))).toBe(true);
        for (const text of ["context line", "Here is the change.", "Done."]) {
            expect(colorsOf(setup, text).every((color) => color.equals(parseColor(theme.text))))
                .toBe(true);
        }
    } finally {
        setup.renderer.destroy();
    }
});
