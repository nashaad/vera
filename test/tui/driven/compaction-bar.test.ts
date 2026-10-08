import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiCompactionDependencies,
} from "../../support/tui-compaction-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the status line sweeps a bar while compaction runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-compaction-bar-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiCompactionDependencies(),
    });

    try {
        const pane = await session.waitForVisiblePane("compacting ");
        expect(pane).toMatch(/compacting ─*━━━─*/);
        // It starts on the left, in line with the path below it.
        const rows = pane.split("\n");
        const compactingRow = rows.findIndex((row) => row.includes("compacting"));
        expect(rows[compactingRow]!.search(/\S/))
            .toBe(rows[compactingRow + 1]!.search(/\S/));
    } finally {
        await session.close();
    }
}, 15_000);
