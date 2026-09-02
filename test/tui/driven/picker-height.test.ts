import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiCatalogRefreshDependencies,
} from "../../support/tui-catalog-refresh-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the model inspector stays inside a 100x40 terminal", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-picker-height-"));
    const configDirectory = join(home, ".vera");
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
        dependencies: () => createTuiCatalogRefreshDependencies({
            pooled: [{
                provider: "openrouter",
                model: "one/model",
                label: "One",
                poolName: "Primary",
                available: true,
                verified: false,
                levels: [],
            }],
            poolAdmissionDelayMs: 750,
            poolAdmissionSteps: [
                { step: "reasoning", label: "Reasoning", status: "passed" },
                { step: "tools", label: "Tool calling", status: "passed" },
                { step: "images", label: "Image input", status: "running" },
            ],
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("shortlist");
        await session.waitForVisiblePane("Open your shortlist");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Shortlist (1)");
        session.sendKey("Right");
        await session.waitForVisiblePane("Verify this model");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePaneWhere(
            (frame) => frame.includes("Reasoning")
                && frame.includes("Tool calling")
                && frame.includes("Image input"),
            "the three-step verification console",
        );

        expect(pane).toContain(
            "moves between sections  tab · moves inside one  arrows · reaches the tabs  shift+tab",
        );
        expect(pane).toContain("↑↓ move · ⏎ run · ← list · ⇥ section · esc tabs");
        expect(pane).toContain("Verify this model");
        expect(pane).toContain("Unpin");
        expect(pane).toContain("Name this model");
    } finally {
        await session.close();
    }
}, 15_000);
