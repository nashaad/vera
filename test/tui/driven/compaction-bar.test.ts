import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiCompactionDependencies,
} from "../../support/tui-compaction-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the status line fills a bar while compaction runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-compaction-bar-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiCompactionDependencies(),
    });

    try {
        const pane = await session.waitForVisiblePane("compacting [");
        expect(pane).toContain("compacting [");
        expect(pane).toContain("░");
    } finally {
        await session.close();
    }
}, 15_000);
