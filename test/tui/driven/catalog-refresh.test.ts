import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiCatalogRefreshDependencies,
} from "../../support/tui-catalog-refresh-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the model picker's refresh key asks the provider and shows the new list", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-catalog-refresh-"));
    const session = await startTuiTestSession({
        home,
        width: 200,
        height: 50,
        dependencies: () => createTuiCatalogRefreshDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/model");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane("Switch model");
        expect(pane).toContain("Switch model");
        expect(pane).not.toContain("Two");

        session.sendKey("Tab");
        await session.waitForVisiblePane("One");
        session.sendKey("C-r");
        pane = await session.waitForVisiblePane("Two");
        expect(pane).toContain("Refreshed 1 catalogs");
    } finally {
        await session.close();
    }
});
