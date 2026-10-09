import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiSettingsDependencies } from "../../support/tui-settings-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("Footer layout hides and moves items live, and Escape saves them to tui.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-footer-"));
    const session = await startTuiTestSession({ home, width: 120, height: 40, dependencies: () => createTuiSettingsDependencies() });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/settings");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Footer layout");
        session.sendText("footer");
        await session.settle();
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane("Reset to default");
        expect(pane).toMatch(/ 5 folder, branch +6 · +7 pane controls +8 activity strip/);
        // The canvas draws the example; the real footer under the composer keeps the real folder.
        expect(pane).toContain("~/crow-nest");
        expect(pane).toContain("worktrees/footer");

        session.sendKey("Down");
        session.sendText(" ");
        pane = await session.waitForVisiblePaneWhere((text) => text.includes("Slot 5: folder, branch · hidden"), "folder hidden");
        expect(pane).not.toContain("~/crow-nest");
        expect(pane).not.toContain("worktrees/footer");

        session.sendKey("Right");
        session.sendKey("Right");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Footer layout › moving pane controls");
        session.sendKey("Down");
        await session.waitForVisiblePaneWhere((text) => text.includes("Slot 11: pane controls"), "panes in slot 11");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere((text) => !text.includes("moving pane controls") && text.includes("Slot 11: pane controls"), "panes placed");

        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((text) => text.includes("Footer layout") && !text.includes("Reset to default"), "back on Settings");
        session.sendKey("Escape");
        await session.settle();

        const saved = JSON.parse(readFileSync(join(home, ".vera", "tui.json"), "utf8"));
        expect(saved.footer_layout.hidden).toEqual(["place"]);
        expect(saved.footer_layout.rows[1]).toEqual(["place", null, null, "activity"]);
        expect(saved.footer_layout.rows[2]).toEqual([null, null, "panes", null]);
        expect(session.captureVisiblePane()).not.toContain("worktrees/footer");
    } finally { await session.close(); }
}, 20_000);
