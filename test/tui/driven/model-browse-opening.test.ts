import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import type { PooledModel } from "../../../src/model/catalog-view.ts";
import { startTuiTestSession, type TuiTestSession } from "../../support/tui-harness.ts";
import { createTuiSettingsDependencies } from "../../support/tui-settings-child.ts";

const favorite: PooledModel = {
    provider: "faux",
    model: "test",
    label: "Test model",
    available: true,
    verified: false,
    levels: [],
};

function homeWithScope(scope: "pool" | "all"): string {
    const home = mkdtempSync(join(tmpdir(), "vera-browse-opening-"));
    mkdirSync(join(home, ".vera"), { recursive: true });
    writeFileSync(join(home, ".vera", "tui.json"), JSON.stringify({
        model_picker: { scope, view: "standard", sort: "library" },
    }));
    return home;
}

function savedPreferences(home: string): { scope: string; view: string; sort: string } {
    return JSON.parse(readFileSync(join(home, ".vera", "tui.json"), "utf8")).model_picker;
}

async function openModels(session: TuiTestSession): Promise<void> {
    session.sendText("/models");
    session.sendKey("Enter");
    await session.waitForVisiblePane("More models");
}

test("@core opening and closing the empty-favorites fallback keeps the real saved scope", async () => {
    const home = homeWithScope("pool");
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 36,
        dependencies: () => createTuiSettingsDependencies({ pooled: [] }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        await openModels(session);
        await session.waitForVisiblePane("● All connected");
        expect(session.captureVisiblePane()).toContain("Test model");
        expect(savedPreferences(home).scope).toBe("pool");

        session.sendKey("C-k");
        await session.waitForVisiblePane("Verify this model");
        session.sendKey("Escape");
        await session.waitForVisiblePane("● All connected");
        expect(savedPreferences(home).scope).toBe("pool");

        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("More models"), "browse to close");
        expect(savedPreferences(home).scope).toBe("pool");

        await openModels(session);
        await session.waitForVisiblePane("● All connected");
        session.sendKey("C-g");
        await session.waitForVisiblePane("● Favorites");
        expect(session.captureVisiblePane()).toContain("No favorites yet");
        expect(savedPreferences(home).scope).toBe("pool");
        session.sendKey("C-g");
        await session.waitForVisiblePane("● Recommended");
        session.sendKey("C-g");
        await session.waitForVisiblePane("● All connected");
        expect(savedPreferences(home).scope).toBe("all");
    } finally {
        await session.close();
    }
}, 30_000);

test("view and sort changes keep the saved scope until Show changes it", async () => {
    const home = homeWithScope("pool");
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 36,
        dependencies: () => createTuiSettingsDependencies({ pooled: [] }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        await openModels(session);
        await session.waitForVisiblePane("● All connected");
        session.sendKey("Tab");
        session.sendKey("Tab");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Filter and sort");
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("View: Detailed");
        expect(savedPreferences(home)).toEqual({ scope: "pool", view: "detailed", sort: "library" });

        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Sort models");
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Sort: Cheapest first");
        expect(savedPreferences(home)).toEqual({ scope: "pool", view: "detailed", sort: "price" });

        session.sendKey("Up");
        session.sendKey("Up");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Show models");
        session.sendKey("Up");
        session.sendKey("Up");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Show: Favorites");
        expect(savedPreferences(home).scope).toBe("pool");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Show models");
        session.sendKey("Down");
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Show: All connected");
        expect(savedPreferences(home)).toEqual({ scope: "all", view: "detailed", sort: "price" });
    } finally {
        await session.close();
    }
}, 30_000);

test("More models and the Favorites command keep their separate opening behavior", async () => {
    const home = homeWithScope("pool");
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 36,
        dependencies: () => createTuiSettingsDependencies({ pooled: [] }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/model");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Switch model");
        session.sendKey("C-k");
        await session.waitForVisiblePane("More models");
        await session.waitForVisiblePane("● All connected");
        session.sendKey("Escape");
        await session.waitForVisiblePane("Switch model");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("Switch model"), "switcher to close");
        expect(savedPreferences(home).scope).toBe("pool");

        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("Favorites");
        await session.waitForVisiblePane("add or remove models from your favorites");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Favorites (0)");
        expect(session.captureVisiblePane()).toContain("Add to favorites");
        expect(savedPreferences(home).scope).toBe("pool");
    } finally {
        await session.close();
    }
}, 30_000);

test("favorites restore the saved collection, including All connected", async () => {
    const home = homeWithScope("pool");
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 36,
        dependencies: () => createTuiSettingsDependencies({ pooled: [favorite] }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        await openModels(session);
        await session.waitForVisiblePane("● Favorites");
        expect(session.captureVisiblePane()).toContain("Test model");
        expect(savedPreferences(home).scope).toBe("pool");
        session.sendKey("C-g");
        await session.waitForVisiblePane("● Recommended");
        session.sendKey("C-g");
        await session.waitForVisiblePane("● All connected");
        expect(savedPreferences(home).scope).toBe("all");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("More models"), "browse to close");
        await openModels(session);
        await session.waitForVisiblePane("● All connected");
        expect(savedPreferences(home).scope).toBe("all");
    } finally {
        await session.close();
    }
}, 30_000);
