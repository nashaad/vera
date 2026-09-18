import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiAgentNoticeDependencies,
    type TuiAgentNoticeOptions,
} from "../../support/tui-agent-notice-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

/** The rows of the composer's frame, top border first. */
async function composerRows(
    options: TuiAgentNoticeOptions,
): Promise<{ pane: string; top: number; bottom: number }> {
    const home = mkdtempSync(join(tmpdir(), "vera-agent-notice-"));
    const session = await startTuiTestSession({
        home,
        width: 90,
        height: 24,
        dependencies: () => createTuiAgentNoticeDependencies(options),
    });

    try {
        await session.waitForVisiblePane("Message Vera");
        // The notice arrives with the attach, so it is on the settled frame
        // rather than one the first paint has yet to catch up with.
        await session.settle(300);
        const pane = session.captureVisiblePane();
        const lines = pane.split("\n");
        return {
            pane,
            top: lines.findIndex((line) => line.includes("╭")),
            bottom: lines.findIndex((line) => line.includes("╰")),
        };
    } finally {
        await session.close();
    }
}

test("the composer holds its height whatever the session has around it", async () => {
    const alone = await composerRows({});
    const child = await composerRows({ hasParent: true });
    const parent = await composerRows({ children: ["scout", "editor"] });

    expect(alone.top).toBeGreaterThan(0);
    expect(child.top).toBe(alone.top);
    expect(parent.top).toBe(alone.top);
    expect(child.bottom).toBe(alone.bottom);
    expect(parent.bottom).toBe(alone.bottom);

    // The rows the sessions around this one need are taken from the
    // transcript above the composer, not from the band under it.
    const childLines = child.pane.split("\n");
    expect(childLines[child.top - 1]).toContain("/parent to return");

    const parentLines = parent.pane.split("\n");
    expect(parentLines[parent.top - 3]).toContain(
        "2 subagents running · /subagents to attach",
    );
    expect(parentLines[parent.top - 2]).toContain("scout");
    expect(parentLines[parent.top - 1]).toContain("editor");

    // Ready is said once. The row under the composer reports the children,
    // the row under that carries `ready · Ctrl+P commands` on its right, and
    // a session waiting on its children is idle either way.
    const activityRow = parentLines[parent.bottom + 1] ?? "";
    expect(activityRow).toContain("waiting for 2 background agents");
    expect(activityRow).not.toContain("Ctrl+P commands");
    expect(parentLines[parent.bottom + 2]).toContain("ready · Ctrl+P commands");
}, 30_000);
