import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";

test("assignment recovery returns through Favorites to the same assignment", async () => {
    const model = { provider: "openrouter", model: "one/model", label: "One", levels: [], verified: false, available: true };
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-model-back-")), width: 120, height: 40,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [model] }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("favorites"); await session.waitForVisiblePane("Favorites");
        session.sendKey("Enter"); await session.waitForVisiblePane("★ kept");
        session.sendKey("Escape"); await session.settle();
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("assign model defaults"); await session.waitForVisiblePane("Assign model defaults");
        session.sendKey("Enter"); await session.waitForVisiblePane("unset, inherits its intent");
        session.sendKey("Enter"); await session.waitForVisiblePane("manage saved favorites");
        session.sendKey("Down"); session.sendKey("Down"); session.sendKey("Enter");
        await session.waitForVisiblePane("Favorites (");
        session.sendKey("Escape"); await session.waitForVisiblePane("manage saved favorites");
        session.sendKey("Escape"); await session.waitForVisiblePane("Assign model defaults");
    } finally { await session.close(); }
}, 15_000);
