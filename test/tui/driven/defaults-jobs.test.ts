import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiCatalogRefreshDependencies,
} from "../../support/tui-catalog-refresh-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the defaults tab names the auto-approval job classifier", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-defaults-jobs-"));
    const configDirectory = join(home, ".vera", "profiles", "default");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "one/model",
    }));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 40,
        dependencies: () => createTuiCatalogRefreshDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/model");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Select model");
        session.sendKey("Tab");
        session.sendKey("Tab");
        const pane = await session.waitForVisiblePane("Dedicated jobs");
        expect(pane).toContain("classifier");
        expect(pane).not.toMatch(/^.*reviewer.*uses session/m);
        expect(pane).toContain("compaction");
        expect(pane).toContain("subagents");
    } finally {
        await session.close();
    }
}, 15_000);
