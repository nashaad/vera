import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiSettingsDependencies,
} from "../../support/tui-settings-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("a lever that contradicts another is refused in the pane", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-overrides-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiSettingsDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");

        session.sendText("/settings");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Overrides");
        session.sendText("Overrides");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Tool result budget");
        session.sendText("Tool result budget");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("results are stubbed early");

        // 16k for every result is under the 64k one result may carry, which
        // is a config that does not load, so the pane says no before writing.
        session.sendText("16k");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "A 16k total budget is under the 64k one-result ceiling.",
        );
        // The pane it was turned down in is the pane it is still on.
        expect(pane).toContain("Tool result budget");
        expect(pane).toContain("Not set");
        expect(existsSync(join(home, ".vera", "config.json"))).toBe(false);
    } finally {
        await session.close();
    }
}, 15_000);
