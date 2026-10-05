import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchSummaryDependencies } from "../../support/tui-search-summary-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("search summaries show every query and details still expand", async () => {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-search-summary-")),
        height: 50,
        dependencies: () => createSearchSummaryDependencies(),
    });
    try {
        await session.waitForVisiblePane("default · ask");
        session.sendText("check licenses");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane("Interrupted");
        expect(pane).toContain("Searched the web 3 times");
        expect(pane).toContain("where sample pack producers");
        expect(pane).toContain("site:loopmasters.com");
        expect(pane).not.toContain("LICENSE RESULT");
        expect(pane).toContain("Reasoning summary:");
        session.sendKey("C-t");
        pane = await session.waitForVisiblePane("LICENSE RESULT");
        expect(pane).toContain("Searched the web 3 times");
        session.sendKey("C-o");
        pane = await session.waitForVisiblePane("Checking source terms");
        expect(pane).toContain("Reasoning summary:");
    } finally {
        await session.close();
    }
}, 15_000);
