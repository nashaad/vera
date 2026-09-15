import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import type { SessionSearchResults } from "../../../src/store/session-search.ts";

/** Enough sessions that the list runs past a page of hits. */
function manyResults(): SessionSearchResults {
    return {
        truncated: false,
        results: Array.from({ length: 8 }, (_, index) => ({
            session_id: `session-${index}`,
            session_path: `/sessions/session-${index}.jsonl`,
            title: `session-${index}`,
            workspace: "/work/one",
            updated_at: "2026-08-28T10:00:00.000Z",
            hits: [{
                kind: "user_message" as const,
                snippet: `define the ${index}th thing`,
                entry_id: `entry-${index}`,
            }],
        })),
    };
}

test("the search pane types into a box and pages through its results", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-search-browse-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...createTuiResumeScenario({ home }).dependencies,
            searchSessions: async () => manyResults(),
        }),
    });

    try {
        await session.waitForVisiblePane("ready · ctrl+p commands");
        session.sendKey("C-f");
        await session.waitForVisiblePane("Search ·");

        session.sendText("define");
        const pane = await session.waitForVisiblePane("define the 0th thing");

        // The query sits in a field of its own, with tint above and below it,
        // rather than as the first row of the result list.
        const rows = pane.split("\n");
        const typed = rows.findIndex((row) => row.includes("define"));
        expect(rows[typed - 1]?.trim()).toBe("");
        expect(rows[typed + 1]?.trim()).toBe("");

        // And the field costs the list rows rather than pushing them off the
        // bottom: the first result is still drawn under it.
        expect(pane).toContain("session-0");

        // Ctrl+D browses without touching the query, the filter or the scope.
        session.sendKey("C-d");
        const paged = await session.waitForVisiblePaneWhere(
            (frame) => frame.includes("define"),
            "the query still in its box",
        );
        expect(paged).toContain("Filter: all ▾");

        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (frame) => !frame.includes("Search ·"),
            "the search pane gone",
        );
    } finally {
        await session.close();
    }
}, 20_000);
