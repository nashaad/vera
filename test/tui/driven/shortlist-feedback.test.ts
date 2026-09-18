import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";

test("Manage shows Working until save completes, then success or failure below the list", async () => {
    let finish!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const model = { provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] };
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-library-feedback-")), width: 120, height: 36,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({ pooled: [] }),
            operateModels: async (operation, onResult) => {
                calls++;
                if (calls > 1) throw new Error("Could not save library: disk full");
                await gate;
                onResult({ ...operation.models[0]!, status: "passed" });
                return { provider: "openrouter", model: "one/model", availableModels: [model],
                    pooled: [{ ...model, available: true, verified: false }] };
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("favorites"); await session.waitForVisiblePane("Favorites");
        session.sendKey("Enter"); await session.waitForVisiblePane("★ kept");
        session.sendKey("C-k"); await session.settle();
        expect(calls).toBe(0);
        expect(session.captureVisiblePane()).not.toContain("keep matches");
        session.sendKey("Enter"); await session.waitForVisiblePane("Working");
        session.sendKey("Enter"); await session.settle();
        expect(calls).toBe(1);
        expect(session.captureVisiblePane()).not.toContain("✓ One added");
        finish();
        const success = await session.waitForVisiblePane("✓ One added to favorites");
        expect(success).toContain("Favorites: saved");
        expect(success).not.toContain("default slot");
        session.sendKey("Enter");
        const failed = await session.waitForVisiblePane("✗ Could not save library: disk full");
        expect(failed).toContain("Favorites: saved");
        expect(failed).not.toContain("✓ One added");
        expect(failed).not.toContain("removed from favorites");
    } finally { finish(); await session.close(); }
}, 15_000);
