import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("ctrl+f inside a conversation searches that conversation first", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-search-scope-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...createTuiResumeScenario({ home }).dependencies,
            searchSessions: async () => ({ truncated: false, results: [] }),
        }),
    });

    try {
        await session.waitForVisiblePane("ready · ctrl+p commands");
        session.sendKey("C-f");

        // The conversation on screen is the narrowest thing to ask about, so
        // that is what the pane asks about first.
        let pane = await session.waitForVisiblePane("Search ·");
        expect(pane).toContain("this conversation");

        session.sendKey("C-w");
        pane = await session.waitForVisiblePane("this workspace");
        expect(pane).not.toContain("this conversation");

        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (frame) => !frame.includes("Search ·"),
            "the search pane gone",
        );
    } finally {
        await session.close();
    }
}, 20_000);
