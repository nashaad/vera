import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("ctrl+c clears an idle draft before it quits", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-draft-interrupt-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("keep me from quitting");
        await session.waitForVisiblePane("keep me from quitting");

        session.sendKey("C-c");
        const pane = await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Message Vera")
                && !visible.includes("keep me from quitting"),
            "ctrl+c to clear the draft without quitting",
        );
        expect(pane).toContain("ready");

        session.sendKey("C-c");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("ctrl+c on an empty composer asks for a second press before it quits", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-draft-interrupt-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-c");
        await session.waitForVisiblePane("Press Ctrl+C again to quit");

        // Typing shows the first press did not quit; clearing the draft starts over.
        session.sendText("still here");
        await session.waitForVisiblePane("still here");
        session.sendKey("C-c");
        const pane = await session.waitForVisiblePaneWhere(
            (visible) => !visible.includes("still here") && !visible.includes("again to quit"),
            "the draft cleared and the quit disarmed",
        );
        expect(pane).toContain("ready");

        session.sendKey("C-c");
        await session.waitForVisiblePane("Press Ctrl+C again to quit");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);
