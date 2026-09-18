import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelOperation } from "../../../src/model/model-operations.ts";
import {
    createTuiCatalogRefreshDependencies,
} from "../../support/tui-catalog-refresh-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("favorites verification stays inside a 100x40 terminal", async () => {
    let finish = (): void => {};
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const available = [{ provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] }];
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-picker-height-")),
        width: 100,
        height: 40,
        dependencies: () => ({
            ...createTuiCatalogRefreshDependencies({
                pooled: [{ ...available[0]!, available: true, verified: false }],
            }),
            operateModels: async (operation: ModelOperation, onResult) => {
                await gate;
                onResult({ ...operation.models[0]!, status: "passed" });
                return { model: "one/model", provider: "openrouter", availableModels: available,
                    pooled: [{ ...available[0]!, available: true, verified: true }] };
            },
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("favorites");
        await session.waitForVisiblePane("Favorites");
        session.sendKey("Enter");
        const favorites = await session.waitForVisiblePane("Favorites (1)");
        expect(favorites).toContain("Ctrl+R Rename · Ctrl+Y Verify · Esc Back");
        session.sendKey("C-y");
        const verifying = await session.waitForVisiblePane("Verifying models");
        expect(verifying).toContain("openrouter/one/model  waiting");
        expect(verifying).toContain("↑↓ results · esc back (checks continue)");
    } finally {
        finish();
        await session.close();
    }
}, 15_000);
