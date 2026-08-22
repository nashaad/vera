import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiToolDetailsDependencies,
} from "../../support/tui-tool-details-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("long tool output folds and Ctrl-T reveals it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-tool-details-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiToolDetailsDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("show the details");
        session.sendKey("Enter");

        pane = await session.waitForVisiblePane("TOOL DETAILS COMPLETED");
        expect(pane).toMatch(/· ask +│$/m);
        expect(pane).toContain("Ran  printf");
        expect(pane).not.toContain("TOOL_DETAIL_09");
        // An instant reasoning phase earns no verb row at all.
        expect(pane).not.toContain("Reasoning:");
        expect(pane).toMatch(/^ {2}─{20}/m);
        expect(pane).toMatch(/^• TOOL DETAILS COMPLETED$/m);
        expect(pane).toMatch(/^ {3}Tip /m);
        expect(pane).toMatch(/^ {2}╭─{20}/m);

        session.sendKey("C-t");
        pane = await session.waitForVisiblePane("TOOL_DETAIL_09");
        expect(pane).toMatch(/▾ Ran\s+ctrl\+t details/);
        expect(pane).toContain("TOOL DETAILS COMPLETED");

        session.sendKey("C-t");
        pane = await session.waitForVisiblePane("Ran  printf");

        session.sendText("run one short action");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("SHORT TOOL COMPLETED");
        expect(pane).toMatch(/Ran {2}printf 'SHORT_DETAIL/);
        expect(pane.match(/SHORT_DETAIL/g)).toHaveLength(2);

        session.sendKey("C-t");
        pane = await session.waitForVisiblePane("└ SHORT_DETAIL");
        // Expanded details deliberately show both what ran and its short
        // result; this command prints the same sentinel in each.
        expect(pane.match(/SHORT_DETAIL/g)).toHaveLength(2);
        expect(pane).toContain("SHORT TOOL COMPLETED");
    } finally {
        await session.close();
    }
}, 15_000);
