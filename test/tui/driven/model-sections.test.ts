import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";

test("picker focus preserves search editing, nested Back, and model selection", async () => {
    const commands: string[] = [];
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-focus-picker-")), width: 120, height: 42,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [], onCommand: (command) => commands.push(command.type) }) });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/model"); session.sendKey("Enter");
        const initial = await session.waitForVisiblePane("Your library is empty");
        const lines = initial.split("\n");
        const scopeY = lines.findIndex((line) => line.includes("Show  Library models"));
        await session.sendMouseClick(lines[scopeY]!.indexOf("Library models"), scopeY);
        await session.waitForVisiblePane("Show models");
        session.sendKey("Escape");
        await session.waitForVisiblePane("⏎ choose which models to show");
        session.sendKey("Enter"); await session.waitForVisiblePane("Show models");
        session.sendKey("Down"); session.sendKey("Enter");
        await session.waitForVisiblePane("Models from your connected providers");
        session.sendKey("Tab"); await session.waitForVisiblePane("Type to search");
        session.sendText("oe"); session.sendKey("Left"); session.sendText("n");
        await session.settle();
        expect(session.captureVisiblePane()).toContain("one");
        expect(session.captureVisiblePane()).not.toContain("No models match");
        session.sendKey("Down"); await session.settle();
        expect(session.captureVisiblePane()).toContain("Type to search");
        session.sendKey("C-k"); await session.waitForVisiblePane("Show extra variants");
        session.sendKey("Escape"); await session.waitForVisiblePane("Type to search");
        session.sendKey("BSpace"); await session.waitForVisiblePane("No models match");
        session.sendText("n"); await session.settle();
        expect(session.captureVisiblePane()).not.toContain("No models match");
        session.sendKey("Tab"); await session.waitForVisiblePane("←→ change cutoff");
        session.sendKey("Down"); await session.settle();
        expect(session.captureVisiblePane()).toContain("←→ change cutoff");
        session.sendKey("Right"); await session.waitForVisiblePane("No models match");
        session.sendKey("Left"); await session.settle();
        session.sendKey("Tab"); await session.waitForVisiblePane("↑↓ choose · ⏎ switch model");
        session.sendKey("Left"); await session.settle();
        expect(session.captureVisiblePane()).toContain("↑↓ choose · ⏎ switch model");
        session.sendKey("BTab"); await session.waitForVisiblePane("←→ change cutoff");
        session.sendKey("BTab"); await session.waitForVisiblePane("Type to search");
        session.sendKey("Enter"); await session.settle();
        expect(session.captureVisiblePane()).toContain("Switch model");
        expect(commands).not.toContain("update_session_model_settings");
        expect(commands).not.toContain("pool_add");
        expect(commands).not.toContain("prompt");
    } finally { await session.close(); }
}, 20_000);

test("HUD Tab and mouse choose controls, vertical arrows stage models, and Escape cancels", async () => {
    const commands: string[] = [];
    const pooled = ["one/model", "two/model", "three/model"].map((model, index) => ({ provider: "openrouter", model,
        label: ["One", "Two", "Three"][index]!, levels: [], available: true, verified: false }));
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-focus-hud-")), width: 120, height: 42,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "hud-focus", model: "one/model", mode: "ask",
                modelSettings: { provider: "openrouter", pooled, availableModels: pooled },
                onCommand: (command) => commands.push(command.type),
            }),
        }) });
    try {
        await session.waitForVisiblePane("Start a conversation");
        await session.waitForVisiblePane("openrouter/one/model");
        session.sendKey("BTab"); await session.waitForVisiblePane("› EFFORT");
        session.sendKey("Down"); await session.settle();
        expect(session.captureVisiblePane()).toContain("› EFFORT");
        session.sendKey("Tab"); await session.waitForVisiblePane("› ACCESS");
        session.sendKey("Tab"); await session.waitForVisiblePane("› MODEL");
        session.sendKey("Down"); await session.settle();
        expect(session.captureVisiblePane()).toMatch(/‹ Two\s+›/);
        expect(session.captureVisiblePane()).toContain("› MODEL");
        session.sendKey("Right"); await session.settle();
        expect(session.captureVisiblePane()).toMatch(/‹ Two\s+›/);
        session.sendKey("Tab"); await session.waitForVisiblePane("› AGENT");
        session.sendKey("BTab"); await session.waitForVisiblePane("› MODEL");
        session.sendKey("Up"); await session.settle();
        expect(session.captureVisiblePane()).toMatch(/‹ One\s+›/);
        const lines = session.captureVisiblePane().split("\n");
        const accessY = lines.findIndex((line) => line.includes("ACCESS"));
        await session.sendMouseClick(lines[accessY]!.indexOf("ACCESS"), accessY);
        await session.waitForVisiblePane("› ACCESS");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("EFFORT"), "HUD to close");
        expect(commands).not.toContain("update_session_model_settings");
        expect(commands).not.toContain("update_session_permission_mode");
        expect(commands).not.toContain("prompt");
    } finally { await session.close(); }
}, 15_000);
