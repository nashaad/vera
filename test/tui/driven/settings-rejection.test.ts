import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiSettingsRejectionDependencies,
} from "../../support/tui-settings-rejection-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("a refused settings change is reported in the transcript", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-settings-reject-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiSettingsRejectionDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/model openrouter/other");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Changing the model to openrouter/other is unavailable",
        );
        // The status line kept reporting the model that is still in force.
        expect(pane).toContain("current-model · DEFAULT");

        session.sendText("/permissions auto");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Could not change permissions to auto",
        );
        expect(pane).toContain("review");
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);
