import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";

function available(model: string, label: string): { provider: string; model: string; label: string; description: string; levels: [] } {
    return { provider: "openrouter", model, label, description: "", levels: [] };
}

function pooled(model: string, label: string, isAvailable: boolean): {
    provider: string; model: string; label: string; available: boolean; verified: boolean; levels: [];
} {
    return { provider: "openrouter", model, label, available: isAvailable, verified: true, levels: [] };
}

test("Favorites leaves out dropped favorites and says none are offered", async () => {
    const one = available("one/model", "One");
    const settings = {
        provider: "openrouter",
        model: "one/model",
        availableModels: [one],
        pooled: [pooled("gone/one", "Gone One", false), pooled("gone/two", "Gone Two", false)],
    };
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-favorites-dropped-")), width: 130, height: 44,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "favorites-dropped", workspace: "/work/vera", model: "one/model",
                mode: "ask", modelSettings: settings }) }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/models"); session.sendKey("Enter");
        const favorites = await session.waitForVisiblePane("None of your favorites is offered now");
        expect(favorites).toContain("● Favorites");
        expect(favorites).not.toContain("Gone One");
        expect(favorites).not.toContain("You have no favorites");
        session.sendKey("C-g"); await session.waitForVisiblePane("● Recommended");
        session.sendKey("C-g");
        const all = await session.waitForVisiblePane("● All connected");
        // The full browser keeps both, so that is where one is removed for good.
        expect(all).toContain("Gone One");
        expect(all).toContain("Gone Two");
        expect(all).toContain("unavailable");
        session.sendKey("C-g");
        await session.waitForVisiblePane("None of your favorites is offered now");
    } finally { await session.close(); }
}, 20_000);

test("the running favorite stays in Favorites when its provider dropped it", async () => {
    const one = available("one/model", "One");
    const settings = { provider: "openrouter", model: "gone/current", availableModels: [one],
        pooled: [pooled("gone/current", "Gone Current", false)] };
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-favorites-running-")), width: 130, height: 44,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "favorites-running", workspace: "/work/vera", model: "gone/current",
                mode: "ask", modelSettings: settings }) }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/models"); session.sendKey("Enter");
        const favorites = await session.waitForVisiblePane("current · unavailable");
        // The running model keeps its row, so the list is not empty and says why it is unusable.
        expect(favorites.split("\n").some((line) => line.includes("gone/current") && line.includes("current · unavailable"))).toBe(true);
        expect(favorites).not.toContain("None of your favorites is offered now");
    } finally { await session.close(); }
}, 20_000);

test("the Switch model favorites scope keeps the running model its provider dropped", async () => {
    const one = available("one/model", "One");
    const settings = { provider: "openrouter", model: "gone/current", availableModels: [one],
        pooled: [pooled("gone/current", "Gone Current", false)] };
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-switch-dropped-")), width: 130, height: 44,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "switch-dropped", workspace: "/work/vera", model: "gone/current",
                mode: "ask", modelSettings: settings }) }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("switch model"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Gone Current");
        expect(pane).not.toContain("Your favorite models land here");
        expect(pane.split("\n").some((line) => line.includes("Gone Current") && line.includes("unavailable"))).toBe(true);
    } finally { await session.close(); }
}, 20_000);
