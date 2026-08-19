import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiModelFailureDependencies,
} from "../../support/tui-model-failure-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function occurrences(text: string, value: string): number {
    return text.split(value).length - 1;
}

/**
 * The second time a model fails the same way, the transcript says so once and
 * names where to look. Driven through the real TUI over a real engine loop
 * writing a real ledger, because the point of the line is that someone reading
 * the screen sees it after the failures actually happened.
 */
test("a repeated model failure is named once with somewhere to go", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-model-failure-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiModelFailureDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("hello");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane(
            "Model error: Model returned no visible response",
        );
        expect(pane).not.toContain("has failed this way");

        session.sendText("again");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("has failed this way");
        expect(pane).toContain("openrouter/moonshotai/kimi-k3");
        expect(pane).toContain("/diagnostics");

        // Said once: a model failing all afternoon must not bury the
        // transcript in the same advice.
        session.sendText("once more");
        session.sendKey("Enter");
        await session.settle(300);
        pane = session.captureVisiblePane();
        expect(occurrences(pane, "has failed this way")).toBe(1);
    } finally {
        await session.close();
    }
}, 20_000);
