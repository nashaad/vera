import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { litDialValue } from "../../support/tui-dial-lit.ts";

test("browse keeps the search text while Tab walks its sections, and Enter favorites", async () => {
    const commands: string[] = [];
    const operations: string[] = [];
    const model = { provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] };
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-focus-picker-")), width: 120, height: 42,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({ pooled: [], onCommand: (command) => commands.push(command.type) }),
            operateModels: async (operation, onResult) => {
                operations.push(operation.operation);
                onResult({ ...operation.models[0]!, status: "passed" });
                return { provider: "openrouter", model: "one/model", availableModels: [model],
                    pooled: [{ ...model, available: true, verified: false }] };
            },
        }) });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/models"); session.sendKey("Enter");
        await session.waitForVisiblePane("● Favorites");
        await session.waitForVisiblePane("No favorites yet");
        session.sendKey("C-g"); await session.waitForVisiblePane("● Recommended");
        session.sendKey("C-g"); await session.waitForVisiblePane("● All connected");
        session.sendText("oe"); await session.settle(); session.sendKey("Left"); session.sendText("n");
        await session.waitForVisiblePane("Search all connected models");
        expect(session.captureVisiblePane()).toContain("One");
        session.sendKey("Tab"); await session.waitForVisiblePane("⏎ favorite");
        session.sendKey("Tab"); await session.waitForVisiblePane("⏎ filter and sort");
        session.sendKey("Tab"); await session.waitForVisiblePane("⏎ connect provider");
        session.sendKey("Tab"); await session.waitForVisiblePane("⏎ manage models");
        session.sendKey("Tab"); await session.waitForVisiblePane("Type to search · ←→ cursor");
        // The query survives a full walk of the sections.
        expect(session.captureVisiblePane()).toContain("one");
        const lines = session.captureVisiblePane().split("\n");
        const filtersY = lines.findIndex((line) => line.includes("Filter and sort"));
        await session.sendMouseClick(lines[filtersY]!.indexOf("Filter and sort"), filtersY);
        await session.waitForVisiblePane("Known price only");
        session.sendKey("Escape"); await session.waitForVisiblePane("More models · Search all connected models");
        // The query survives the trip into filters and back.
        expect(session.captureVisiblePane()).toContain("one");
        session.sendKey("BTab"); await session.waitForVisiblePane("⏎ favorite");
        session.sendKey("Enter"); await session.settle();
        // Favoriting marks the row in place; the page does not switch the model.
        const favorited = await session.waitForVisiblePane("⏎ unfavorite");
        expect(favorited).toContain("* One");
        expect(operations).toEqual(["keep"]);
        expect(commands).not.toContain("update_model_settings");
        expect(commands).not.toContain("prompt");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("More models"), "the browse page to close");
    } finally { await session.close(); }
}, 20_000);

test("the HUD stages agent and access, and Escape cancels both", async () => {
    const commands: string[] = [];
    const pooled = ["one/model", "two/model"].map((model, index) => ({ provider: "openrouter", model,
        label: ["One", "Two"][index]!, levels: [], available: true, verified: false }));
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-focus-hud-")), width: 120, height: 42,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "hud-focus", model: "one/model", mode: "ask",
                modelSettings: { provider: "openrouter", pooled, availableModels: pooled },
                onCommand: (command) => commands.push(command.type),
            }),
        }) });
    try {
        await session.waitForVisiblePane("Start a conversation");
        await session.waitForVisiblePane("opnrtr/One");
        session.sendKey("BTab"); await session.waitForVisiblePane("› AGENT");
        // The rebuilt HUD carries agent and access only.
        const opened = session.captureVisiblePane();
        expect(opened).not.toContain("MODEL");
        expect(opened).not.toContain("EFFORT");
        session.sendKey("Tab"); await session.waitForVisiblePane("› ACCESS");
        session.sendKey("Right"); await session.waitForVisiblePane("live: ask");
        const lines = session.captureVisiblePane().split("\n");
        const agentY = lines.findIndex((line) => line.includes("AGENT"));
        await session.sendMouseClick(lines[agentY]!.indexOf("AGENT"), agentY);
        await session.waitForVisiblePane("› AGENT");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("ACCESS"), "the HUD to close");
        expect(commands).not.toContain("update_model_settings");
        expect(commands).not.toContain("update_session_permission_mode");
        expect(commands).not.toContain("prompt");
    } finally { await session.close(); }
}, 15_000);

test("a HUD opened before the mode arrives lights the mode once it is reported", async () => {
    const changes: string[] = [];
    let reportMode: (() => void) | undefined;
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-focus-hud-late-")), width: 120, height: 42,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "hud-late", model: "one/model",
                onCommand: (command, push) => {
                    if (command.type === "get_permissions") {
                        reportMode = () => push({ type: "permissions", requestId: command.requestId, mode: "auto", pending: false, seq: 99 });
                    }
                    if (command.type === "update_session_permission_mode") changes.push(command.mode);
                },
            }),
        }) });
    try {
        await session.waitForVisiblePane("permissions loading");
        session.sendKey("BTab"); await session.waitForVisiblePane("› AGENT");
        session.sendKey("Tab"); await session.waitForVisiblePane("› ACCESS");
        await session.settle();
        expect(litDialValue(session, "ACCESS")).toBeUndefined();
        expect(reportMode).toBeDefined();
        reportMode!();
        await session.waitForVisiblePane("default · auto");
        await session.settle();
        expect(litDialValue(session, "ACCESS")).toBe("auto");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("ACCESS"), "the HUD to close");
        await session.settle();
        expect(changes).toEqual([]);
    } finally { await session.close(); }
}, 15_000);

test("the HUD lights no access mode until the session reports one", async () => {
    const changes: string[] = [];
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-focus-hud-unknown-")), width: 120, height: 42,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "hud-unknown", model: "one/model",
                onCommand: (command) => {
                    if (command.type === "update_session_permission_mode") changes.push(command.mode);
                },
            }),
        }) });
    try {
        await session.waitForVisiblePane("permissions loading");
        session.sendKey("BTab"); await session.waitForVisiblePane("› AGENT");
        session.sendKey("Tab"); await session.waitForVisiblePane("› ACCESS");
        await session.settle();
        expect(litDialValue(session, "ACCESS")).toBeUndefined();
        session.sendKey("Right"); await session.settle();
        expect(litDialValue(session, "ACCESS")).toBe("readonly");
        session.sendKey("Right"); await session.settle();
        expect(litDialValue(session, "ACCESS")).toBe("ask");
        // A guessed live mode would show a "live:" note and swallow a pick that matches the guess.
        expect(session.captureVisiblePane()).not.toContain("live:");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("ACCESS"), "the HUD to close");
        await session.settle();
        expect(changes).toEqual(["ask"]);
    } finally { await session.close(); }
}, 15_000);
