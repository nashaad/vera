import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiSelectionDependencies,
} from "../../support/tui-selection-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("real TUI mouse drag copies transcript text and keeps it highlighted", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-selection-"));
    const copiedTextPath = join(home, "copied-text");
    const selectedText = "COPY THIS TEXT";
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => createTuiSelectionDependencies(copiedTextPath),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane(selectedText);
        const lines = pane.split("\n");
        const row = lines.findIndex((line) => line.includes(selectedText));
        const selectedLine = lines[row];
        if (selectedLine === undefined) {
            throw new Error("Selected transcript line was not visible");
        }
        const column = selectedLine.indexOf(selectedText);

        await session.sendMouseDrag(
            column,
            row,
            column + selectedText.length,
            row,
        );
        pane = await session.waitForVisiblePane(
            `copied ${selectedText.length} characters`,
        );
        expect(readFileSync(copiedTextPath, "utf8")).toBe(selectedText);
        // Nobody else is in this conversation, so the selection was a
        // copy and only a copy: the next message is not armed with it.
        expect(pane).not.toContain("quoting");

        // The tmux test read the highlight back out of the escape stream;
        // the virtual frame carries the selection background per span.
        const styled = session.captureSpans();
        const highlighted = styled.lines.flatMap((line) => line.spans)
            .find((span) => span.text.includes(selectedText));
        expect(highlighted).toBeDefined();
        const background = highlighted!.bg.toInts();
        const defaultGround = styled.lines.flatMap((line) => line.spans)
            .find((span) => span.text.includes("Please "))?.bg.toInts();
        expect(background).not.toEqual(defaultGround);
    } finally {
        await session.close();
    }
}, 15_000);

test("real TUI mouse drag copies text from the composer", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-composer-selection-"));
    const copiedTextPath = join(home, "copied-text");
    const selectedText = "COPY THIS COMPOSER TEXT";
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => createTuiSelectionDependencies(copiedTextPath),
    });

    try {
        await session.waitForVisiblePane("COPY THIS TEXT");
        session.sendText(selectedText);
        const pane = await session.waitForVisiblePane(selectedText);
        const lines = pane.split("\n");
        const row = lines.findIndex((line) => line.includes(selectedText));
        const selectedLine = lines[row];
        if (selectedLine === undefined) {
            throw new Error("Selected composer line was not visible");
        }
        const column = selectedLine.indexOf(selectedText);

        await session.sendMouseDrag(
            column,
            row,
            column + selectedText.length,
            row,
        );
        await session.waitForVisiblePane(
            `copied ${selectedText.length} characters`,
        );
        expect(readFileSync(copiedTextPath, "utf8")).toBe(selectedText);
    } finally {
        await session.close();
    }
}, 15_000);

for (const direction of ["downward", "upward"] as const) {
    test(`transcript selection ${direction} between the header and message copies text`, async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-tui-header-selection-"));
        const copiedTextPath = join(home, "copied-text");
        const session = await startTuiTestSession({
            home,
            width: 100,
            height: 30,
            dependencies: () => createTuiSelectionDependencies(copiedTextPath),
        });
        try {
            const pane = await session.waitForVisiblePane("COPY THIS TEXT");
            const lines = pane.split("\n");
            const headerRow = lines.findIndex((line) => line.includes("Vera") && line.includes("loading"));
            const textRow = lines.findIndex((line) => line.includes("Please COPY THIS TEXT"));
            expect(headerRow).toBeGreaterThanOrEqual(0);
            const start = { x: lines[headerRow]!.indexOf("Vera"), y: headerRow };
            const end = { x: lines[textRow]!.indexOf("transcript.") + "transcript.".length, y: textRow };
            const [from, to] = direction === "downward" ? [start, end] : [end, start];
            await session.sendMouseDrag(from.x, from.y, to.x, to.y);
            await session.settle();
            expect(readFileSync(copiedTextPath, "utf8")).toContain("Please COPY THIS TEXT from the transcript.");
            if (direction === "downward") {
                expect(readFileSync(copiedTextPath, "utf8")).toContain("Vera");
            }
            expect(session.captureVisiblePane()).toContain("Vera · loading");
        } finally {
            await session.close();
        }
    }, 15_000);
}
