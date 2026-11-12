import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiDependencies } from "../../../clients/tui/main.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const levels = [
    { id: "low", label: "Low", description: "A little reasoning." },
    { id: "high", label: "High", description: "Deep reasoning." },
] as const;

function homeDependencies(withLevels: boolean): TuiDependencies {
    const available = [
        { provider: "dpsk", model: "flash-1017", label: "DeepSeek V4.1 Flash 1017", description: "", levels: withLevels ? levels : [] },
        { provider: "dpsk", model: "pro", label: "DeepSeek Pro", description: "", levels: withLevels ? levels : [] },
    ];
    const settings = () => ({
        provider: "dpsk",
        model: "pro",
        availableModels: available,
        pooled: available.map((entry) => ({ ...entry, available: true, verified: false })),
    });
    return {
        client: createHomeClient("/work/vera", { readModelSettings: async () => settings() }),
        homeHasSessions: false,
        createSession: async () => {
            await Bun.sleep(200);
            return createSettingsAnsweringClient({
                agentId: "new-session-id",
                model: "flash-1017",
                mode: "review",
                modelSettings: { provider: "dpsk", availableModels: available },
            });
        },
    };
}

async function searchForFlash(session: Awaited<ReturnType<typeof startTuiTestSession>>): Promise<void> {
    await session.waitForVisiblePane("V  E  R  A");
    session.sendText("/model");
    session.sendKey("Enter");
    await session.waitForVisiblePane("Switch model");
    session.sendText("flash");
    await session.settle(300);
    session.sendKey("Enter");
}

test("a model with no reasoning levels leaves the next typing to the composer", async () => {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-home-pick-")),
        dependencies: () => homeDependencies(false),
    });

    try {
        await searchForFlash(session);
        await session.settle(500);
        session.sendText("write hello");
        const pane = await session.waitForVisiblePane("write hello");
        expect(pane).not.toContain("No matches found");
    } finally {
        await session.close();
    }
}, 20_000);

test("choosing a reasoning level after a model search leaves the next typing to the composer", async () => {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-home-pick-levels-")),
        dependencies: () => homeDependencies(true),
    });

    try {
        await searchForFlash(session);
        const picker = await session.waitForVisiblePane("Reasoning");
        expect(picker).toContain("1. Low");
        session.sendKey("Enter");
        await session.settle(600);
        session.sendText("write hello");
        const pane = await session.waitForVisiblePane("write hello");
        expect(pane).not.toContain("No matches found");
        expect(pane).not.toContain("Reasoning");
    } finally {
        await session.close();
    }
}, 20_000);
