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
        session.sendText("/models");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane("More models");
        expect(pane).toContain("More models");
        expect(pane).not.toContain("Two");

        // The page opens on Favorites, and the catalog rows are under All.
        session.sendKey("C-g");
        await session.waitForVisiblePane("● Recommended");
        session.sendKey("C-g");
        await session.waitForVisiblePane("One");
        session.sendKey("C-r");
        pane = await session.waitForVisiblePane("Refreshed 1 catalogs");
        expect(pane).toContain("Two");
    } finally {
        await session.close();
    }
}, 20_000);
