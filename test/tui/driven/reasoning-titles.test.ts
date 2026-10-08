import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReasoningTitlesDependencies } from "../../support/tui-reasoning-titles-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("opened reasoning stacks its titles and keeps a gap above the tool row", async () => {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-reasoning-titles-")),
        height: 40,
        dependencies: () => createReasoningTitlesDependencies(),
    });
    try {
        await session.waitForVisiblePane("default · ask");
        session.sendText("where is the map");
        session.sendKey("Enter");
        await session.waitForVisiblePane("The map is in the hold.");
        session.sendKey("C-o");
        const pane = await session.waitForVisiblePane("Raising the black flag");
        const lines = pane.split("\n").map((line) => line.trim());
        const first = lines.indexOf("Plotting the course");
        expect(lines.slice(first, first + 4)).toEqual([
            "Plotting the course",
            "Counting the doubloons",
            "Raising the black flag",
            "",
        ]);
    } finally {
        await session.close();
    }
}, 15_000);
