import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";

test("feedback command collects the report in the terminal", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-feedback-tui-"));
    let payload: unknown;
    const session = await startTuiTestSession({ home, width: 120, height: 40, dependencies: () => ({
        ...createTuiCatalogRefreshDependencies({ pooled: [] }),
        requestExtension: async (_extension, _name, value) => { payload = value; return { path: "/tmp/crow-report" }; },
    }) });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/feedback"); session.sendKey("Enter");
        await session.waitForVisiblePane("Report a bug or request a feature");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Title");
        session.sendText("Crow cannot sail"); session.sendKey("Enter");
        await session.waitForVisiblePane("Description");
        session.sendText("Sail stuck"); session.sendKey("Enter");
        await session.waitForVisiblePane("Image path");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Report saved on this computer");
        expect(payload).toMatchObject({ kind: "bug", title: "Crow cannot sail", description: "Sail stuck", source: "terminal", image_paths: [] });
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 20000);
