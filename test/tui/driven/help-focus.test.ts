import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiHelpActiveDependencies,
} from "../../support/tui-help-active-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("turn completion keeps focus in the open Help surface", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-help-focus-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiHelpActiveDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("start");
        session.sendKey("Enter");
        await session.waitForVisiblePane("STREAM");
        session.sendText("/help");
        session.sendKey("Enter");
        await session.waitForVisiblePane(
            "Vera keeps agent sessions resident",
        );
        // Two rows since the status split across footer lines: the model
        // shortcut above, then the persistent ready and command controls.
        pane = await session.waitForVisiblePane(
            "shift+tab HUD · ctrl+shift+m model",
        );
        expect(pane).toContain("ready · ctrl+p commands");
        const footerLines = pane.split("\n");
        const modelHintLine = footerLines.findIndex((line) =>
            line.includes("shift+tab HUD · ctrl+shift+m model")
        );
        const readyLine = footerLines.findIndex((line) =>
            line.includes("ready · ctrl+p commands")
        );
        expect(modelHintLine).toBe(readyLine - 1);
        expect(Bun.stringWidth(footerLines[modelHintLine]!))
            .toBeLessThanOrEqual(100);
        // One key at a time, each waiting for the card it opened. Sending
        // both and typing straight after raced the redraw, and a key that
        // lands mid-redraw is a key the surface never sees.
        session.sendKey("Right");
        await session.waitForVisiblePane("Search");
        session.sendKey("Right");
        await session.waitForVisiblePane("/rename");
        session.sendText("themes");
        pane = await session.waitForVisiblePaneWhere(
            (visible) =>
                visible.includes("/themes") && !visible.includes("/rename"),
            "the command list narrowed to the search",
        );
    } finally {
        await session.close();
    }
}, 15_000);
