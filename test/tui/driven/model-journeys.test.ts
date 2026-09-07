import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import type { ModelOperation } from "../../../src/model/model-operations.ts";

test("live shortlist keeps through the host operation and verification can be left running", async () => {
    const operations: ModelOperation[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const available = [{ provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] }];
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-journeys-")), width: 120, height: 36,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({ pooled: [] }),
            operateModels: async (operation, onResult) => {
                operations.push(operation);
                if (operation.operation === "verify") await gate;
                onResult({ ...operation.models[0]!, status: "passed" });
                return { model: "one/model", provider: "openrouter", availableModels: available,
                    pooled: [{ ...available[0]!, available: true, verified: operation.operation === "verify" }] };
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("manage short");
        await session.waitForVisiblePane("Manage shortlist");
        session.sendKey("Enter");
        await session.waitForVisiblePane("not kept ✗");
        session.sendKey("Enter");
        await session.waitForVisiblePane("1 kept of 1 discovered");
        expect(operations[0]?.operation).toBe("keep");
        session.sendKey("C-y");
        await session.waitForVisiblePane("Verifying models");
        session.sendKey("Escape");
        await session.settle();
        expect(session.captureVisiblePane()).not.toContain("Verifying models");
        finish();
        await session.settle(50);
        expect(operations.map((operation) => operation.operation)).toEqual(["keep", "verify"]);
    } finally { finish(); await session.close(); }
}, 15_000);
