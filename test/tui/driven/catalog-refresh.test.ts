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
        let pane = await session.waitForVisiblePane("One");
        expect(pane).toContain("Select model");
        expect(pane).not.toContain("Two");

        session.sendKey("Down");
        session.sendKey("C-f");
        await session.waitForVisiblePane("asking openrouter");
        pane = await session.waitForVisiblePane("Two");
        expect(pane).toContain("openrouter: 2 models");
    } finally {
        await session.close();
    }
});
