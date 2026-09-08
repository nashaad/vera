import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";

test("assignment recovery returns through verification scope and Manage to the same assignment", async () => {
    const model = { provider: "openrouter", model: "one/model", label: "One", levels: [], verified: false, available: true };
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-model-back-")), width: 120, height: 40,
        dependencies: () => ({
            ...createTuiCatalogRefreshDependencies({ pooled: [model] }),
            operateModels: async (operation, onResult) => {
                await gate;
                onResult({ ...operation.models[0]!, status: "failed", reason: "Fixture rejection" });
                return undefined;
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("manage shortlist"); await session.waitForVisiblePane("Manage shortlist");
        session.sendKey("Enter"); await session.waitForVisiblePane("kept ✓");
        session.sendKey("Escape"); await session.settle();
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("assign model defaults"); await session.waitForVisiblePane("Assign model defaults");
        session.sendKey("Enter"); await session.waitForVisiblePane("unset, inherits its intent");
        session.sendKey("Enter"); await session.waitForVisiblePane("make models eligible for a default");
        session.sendKey("Down"); session.sendKey("Enter");
        await session.waitForVisiblePane("Entire shortlist");
        session.sendKey("Enter"); await session.waitForVisiblePane("Verifying models");
        finish(); await session.waitForVisiblePane("Fixture rejection");
        session.sendKey("Escape"); await session.waitForVisiblePane("Entire shortlist");
        session.sendKey("Escape");
        const assignment = await session.waitForVisiblePane("make models eligible for a default");
        expect(assignment).not.toContain("Entire shortlist");
        session.sendKey("Down"); session.sendKey("Enter");
        await session.waitForVisiblePane("Manage shortlist");
        session.sendKey("Escape"); await session.waitForVisiblePane("make models eligible for a default");
        session.sendKey("Escape"); await session.waitForVisiblePane("Assign model defaults");
    } finally { finish(); await session.close(); }
}, 15_000);
