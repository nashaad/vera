import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";

test("/models and Assign model defaults keep the last good config and say so when config.json stops loading", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-models-unreadable-"));
    const model = { provider: "openrouter", model: "one/model", label: "One", levels: [], verified: false, available: true };
    const session = await startTuiTestSession({
        home, width: 120, height: 40,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [model] }),
    });
    const waitForComposer = () => session.waitForVisiblePaneWhere(
        (pane) => pane.includes("Message Vera") && !pane.includes("Assign model defaults"),
        "the composer with no picker open",
    );
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("assign model defaults"); await session.waitForVisiblePane("Assign model defaults");
        session.sendKey("Enter"); await session.waitForVisiblePane("unset, inherits its intent");
        for (let step = 0; step < 5; step++) session.sendKey("Down");
        session.sendKey("Enter"); await session.waitForVisiblePane("Subagent models");
        session.sendText("one"); session.sendKey("Enter");
        await session.waitForVisiblePane("1. One");
        session.sendKey("Escape");
        expect(await session.waitForVisiblePane("Assign model defaults")).toMatch(/subagents\s+openrouter\/one\/model/);
        session.sendKey("Escape"); await waitForComposer();

        const configPath = join(home, ".vera", "config.json");
        const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
        writeFileSync(configPath, JSON.stringify({
            ...written,
            providers: { deepseek: { protocol: "openai-chat", base_url: "https://api.deepseek.com", credential: "api_key" } },
        }, null, 2));

        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("assign model defaults"); await session.waitForVisiblePane("Assign model defaults");
        session.sendKey("Enter");
        const defaults = await session.waitForVisiblePane("unset, inherits its intent");
        expect(defaults).toMatch(/subagents\s+openrouter\/one\/model/);
        expect(defaults).toContain('config.json could not be read: provider "deepseek" is built into Vera');
        expect(defaults).toContain("Showing the last settings that loaded.");
        session.sendKey("Escape"); await waitForComposer();

        session.sendText("/models"); session.sendKey("Enter");
        const models = await session.waitForVisiblePane("● Favorites");
        expect(models).toContain("config.json could not be read");
        expect(models).not.toContain("Vera config at");
    } finally { await session.close(); }
}, 20_000);

test("Assign model defaults keeps the config the TUI started with when it breaks before the page opens", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-models-broken-early-"));
    const configPath = join(home, ".vera", "config.json");
    const config = {
        schema_version: 1,
        provider: "openrouter",
        model: "one/model",
        model_assignments: { subagents: { models: [{ name: "crow", provider: "openrouter", model: "one/model" }] } },
    };
    mkdirSync(join(home, ".vera"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const model = { provider: "openrouter", model: "one/model", label: "One", levels: [], verified: false, available: true };
    const session = await startTuiTestSession({
        home, width: 120, height: 40,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [model] }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        writeFileSync(configPath, "{ not json");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("assign model defaults"); await session.waitForVisiblePane("Assign model defaults");
        session.sendKey("Enter");
        const defaults = await session.waitForVisiblePane("unset, inherits its intent");
        expect(defaults).toMatch(/subagents\s+openrouter\/one\/model/);
        expect(defaults).toContain("config.json could not be read: it is not valid JSON");
        expect(defaults).toContain("Showing the last settings that loaded.");
    } finally { await session.close(); }
}, 20_000);

test("assigning a model while config.json is broken keeps the picker open with the reason", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-models-broken-save-"));
    const configPath = join(home, ".vera", "config.json");
    mkdirSync(join(home, ".vera"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ schema_version: 1, provider: "openrouter", model: "one/model" }, null, 2));
    const model = { provider: "openrouter", model: "one/model", label: "One", levels: [], verified: false, available: true };
    const session = await startTuiTestSession({
        home, width: 120, height: 40,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [model] }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        writeFileSync(configPath, "{ not json");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("assign model defaults"); await session.waitForVisiblePane("Assign model defaults");
        session.sendKey("Enter"); await session.waitForVisiblePane("unset, inherits its intent");
        for (let step = 0; step < 5; step++) session.sendKey("Down");
        session.sendKey("Enter");
        expect(await session.waitForVisiblePane("Subagent models")).toContain("config.json could not be read");
        session.sendText("one"); session.sendKey("Enter");
        const refused = await session.waitForVisiblePane("Vera config at");
        expect(refused).toContain("Subagent models");
        expect(refused).not.toContain("Key failed");
        expect(readFileSync(configPath, "utf8")).toBe("{ not json");

        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("Assign model defaults") && !pane.includes("Subagent models"),
            "Assign model defaults after leaving Subagent models",
        );
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("Message Vera") && !pane.includes("Assign model defaults"),
            "the composer with no picker open",
        );
        session.sendText("ahoy crow");
        await session.waitForVisiblePaneWhere(
            (pane) => /│ ahoy crow/.test(pane),
            "typing in the composer",
        );
    } finally { await session.close(); }
}, 20_000);
