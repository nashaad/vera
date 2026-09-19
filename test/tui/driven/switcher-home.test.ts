import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHomeClient } from "../../../clients/tui/home-client.ts";
import type { ModelTurnSettings } from "../../../src/engine/model-settings.ts";
import type { ModelOperation } from "../../../src/model/model-operations.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const available = [
    { provider: "local", model: "tiny", label: "tiny", description: "", levels: [] },
    { provider: "local_t1", model: "tiny", label: "tiny", description: "", levels: [] },
];

function homeWithPool(operations: ModelOperation[], fail = false) {
    let pooled = available.map((model) => ({ ...model, available: true, verified: false }));
    const settings = (): ModelTurnSettings => ({
        provider: "local", model: "tiny", availableModels: available, pooled,
    });
    return {
        client: createHomeClient("/work/vera", { readModelSettings: async () => settings() }),
        homeHasSessions: false,
        operateModels: async (operation: ModelOperation) => {
            operations.push(operation);
            if (fail) throw new Error("pool.json did not parse cleanly");
            const gone = new Set(operation.models.map((entry) => `${entry.provider}/${entry.model}`));
            if (operation.operation === "unkeep") {
                pooled = pooled.filter((entry) => !gone.has(`${entry.provider}/${entry.model}`));
            }
            return settings();
        },
    };
}

async function openSwitcherOnHome(operations: ModelOperation[], fail = false) {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-switch-home-")), width: 130, height: 44,
        dependencies: () => homeWithPool(operations, fail),
    });
    await session.waitForVisiblePane("V  E  R  A");
    session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
    session.sendText("switch model"); await session.waitForVisiblePane("Switch model");
    session.sendKey("Enter"); await session.waitForVisiblePane("Your model, your favorites");
    session.sendKey("Down"); await session.waitForVisiblePane("Ctrl+F unfavorite");
    return session;
}

test("two providers serving one name are told apart", async () => {
    const session = await openSwitcherOnHome([]);
    try {
        const pane = session.captureVisiblePane();
        expect(pane).toMatch(/tiny\s+· local\s/);
        expect(pane).toMatch(/tiny\s+· local_t1/);
    } finally { await session.close(); }
}, 15_000);

test("unfavoriting from the switcher on home lands through the host", async () => {
    const operations: ModelOperation[] = [];
    const session = await openSwitcherOnHome(operations);
    try {
        session.sendKey("C-f");
        const pane = await session.waitForVisiblePaneWhere(
            (text) => operations.length === 1 && !text.includes("from favorites…"),
            "the unfavorite to settle",
        );
        expect(operations).toEqual([{ operation: "unkeep", models: [{ provider: "local_t1", model: "tiny" }] }]);
        expect(pane).not.toContain("There is no conversation open yet");
        expect(pane).toContain("Switch model");
    } finally { await session.close(); }
}, 15_000);

test("a refused unfavorite on home says so instead of waiting", async () => {
    const operations: ModelOperation[] = [];
    const session = await openSwitcherOnHome(operations, true);
    try {
        session.sendKey("C-f");
        const pane = await session.waitForVisiblePane("did not parse cleanly");
        expect(pane).not.toContain("from favorites…");
    } finally { await session.close(); }
}, 15_000);
