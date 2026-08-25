import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiReviewerDependencies,
} from "../../support/tui-reviewer-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the reviewer pane sets and clears both slots", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-reviewer-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiReviewerDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/settings");
        session.sendKey("Enter");
        await session.waitForVisiblePane("All settings");
        session.sendText("reviewer models");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Reviewer");
        await session.waitForVisiblePane("the agent's own model");

        // Primary, then the failsafe behind it.
        session.sendKey("Enter");
        await session.waitForVisiblePane("Claude Haiku 4.5");
        session.sendKey("Down");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("anthropic/claude-haiku-4.5");
        expect(pane).toContain("Failsafe");

        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("no failsafe reviewer");
        session.sendKey("Down");
        session.sendKey("Down");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("gemma4:26b");
        expect(pane).toContain("anthropic/claude-haiku-4.5");

        // Clearing the primary drops the whole reviewer, failsafe included.
        session.sendKey("Up");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Use the agent's model");
        session.sendKey("Up");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("the agent's own model");
        expect(pane).toContain("not set");
    } finally {
        await session.close();
    }
}, 15_000);
