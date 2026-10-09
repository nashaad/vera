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
            "Every key, grouped by where it works",
        );
        pane = await session.waitForVisiblePane("Ctrl+P commands");
        expect(pane).toContain("Ctrl+P commands");
        expect(pane).not.toContain("Shift+Tab HUD");
        expect(pane).not.toContain("Ctrl+X m Models");
        // One key at a time, each waiting for the card it opened. Sending
        // both and typing straight after raced the redraw, and a key that
        // lands mid-redraw is a key the surface never sees.
        session.sendKey("Down");
        session.sendKey("Down");
        session.sendKey("Enter");
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
