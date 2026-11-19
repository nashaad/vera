import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LayoutStore, layoutPath } from "../../clients/desktop/src/layout-store.ts";
import { defaultLayout, LOCATION_SIZES, MAX_TABS, type LayoutState } from "../../clients/ui/src/layout/model.ts";
import { reduceLayout } from "../../clients/ui/src/layout/reducer.ts";
import { resolveLayout } from "../../clients/ui/src/layout/resolve.ts";
import { forSave, parseLayout } from "../../clients/ui/src/layout/saved.ts";

const homes: string[] = [];

function trialHome(): string {
    const home = mkdtempSync(join(tmpdir(), "vera-layout-store-"));
    homes.push(home);
    return home;
}

afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const REGISTRY = {
    containers: [{ id: "c.a", title: "A", icon: "view", location: "sidebar" as const }],
    views: [{ id: "v.a", title: "A", container: "c.a" }],
};

function moved(): LayoutState {
    return reduceLayout(
        reduceLayout(defaultLayout(), { type: "moveView", view: "v.a", to: { location: "panel" } }, REGISTRY),
        { type: "resizeLocation", location: "sidebar", size: 300 },
        REGISTRY,
    );
}

test("@core the layout lives in the desktop directory of the home", () => {
    const home = trialHome();
    expect(layoutPath(home)).toBe(join(home, "machine", "desktop", "layout.json"));
    expect(layoutPath(home)).not.toBe(layoutPath(trialHome()));
});

test("@core a saved layout reads back unchanged from a real file", () => {
    const home = trialHome();
    const store = new LayoutStore(layoutPath(home));
    expect(store.load()).toBeUndefined();
    const layout = moved();
    expect(store.save(layout)).toBe(true);
    expect(JSON.parse(readFileSync(layoutPath(home), "utf8")).version).toBe(1);
    expect(new LayoutStore(layoutPath(home)).load()).toEqual(layout);
});

test("a missing file is defaults and leaves nothing behind", () => {
    const home = trialHome();
    expect(new LayoutStore(layoutPath(home)).load()).toBeUndefined();
    expect(existsSync(join(home, "machine", "desktop"))).toBe(false);
});

test("@core a corrupt file is kept aside as layout.json.bad and defaults are used", () => {
    const home = trialHome();
    const path = layoutPath(home);
    mkdirSync(join(home, "machine", "desktop"), { recursive: true });
    writeFileSync(path, "{ not json");
    const store = new LayoutStore(path);
    expect(store.load()).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.bad`, "utf8")).toBe("{ not json");
    expect(store.save(moved())).toBe(true);
    expect(store.load()).toEqual(moved());
});

test("a layout of another version or shape is kept aside", () => {
    for (const text of ["[]", "null", JSON.stringify({ version: 2 }), JSON.stringify({ locations: {} })]) {
        const home = trialHome();
        const path = layoutPath(home);
        mkdirSync(join(home, "machine", "desktop"), { recursive: true });
        writeFileSync(path, text);
        expect(new LayoutStore(path).load()).toBeUndefined();
        expect(readFileSync(`${path}.bad`, "utf8")).toBe(text);
    }
});

test("a file over the size cap is kept aside", () => {
    const home = trialHome();
    const path = layoutPath(home);
    mkdirSync(join(home, "machine", "desktop"), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, pad: "x".repeat(300_000) }));
    expect(new LayoutStore(path).load()).toBeUndefined();
    expect(existsSync(`${path}.bad`)).toBe(true);
});

test("@core ids nothing registers any more stay in the file", () => {
    const home = trialHome();
    const layout: LayoutState = {
        ...defaultLayout(),
        viewContainer: { "ext.view": "ext.box" },
        containerLocation: { "ext.box": "panel" },
        hiddenViews: ["ext.view"],
        viewOrder: { "ext.box": ["ext.view"] },
    };
    const store = new LayoutStore(layoutPath(home));
    expect(store.save(layout)).toBe(true);
    expect(store.load()).toEqual(layout);
});

test("@core a save replaces the file whole and leaves no temp file", () => {
    const home = trialHome();
    const store = new LayoutStore(layoutPath(home));
    expect(store.save(defaultLayout())).toBe(true);
    expect(store.save(moved())).toBe(true);
    expect(readdirSync(join(home, "machine", "desktop"))).toEqual(["layout.json"]);
    expect(store.load()).toEqual(moved());
});

test("a save that cannot be written keeps the previous file and leaves no temp file", () => {
    const home = trialHome();
    const path = layoutPath(home);
    const store = new LayoutStore(path);
    expect(store.save(moved())).toBe(true);
    expect(store.save({ version: 9 })).toBe(false);
    expect(store.load()).toEqual(moved());

    const blocked = trialHome();
    mkdirSync(join(blocked, "machine", "desktop", "layout.json"), { recursive: true });
    expect(new LayoutStore(layoutPath(blocked)).save(moved())).toBe(false);
    expect(readdirSync(join(blocked, "machine", "desktop"))).toEqual(["layout.json"]);
});

test("wrong fields inside a readable layout fall back one by one", () => {
    const layout = parseLayout({
        version: 1,
        locations: {
            sidebar: { visible: "yes", size: 99999 },
            rightPane: { visible: true, size: "wide" },
            panel: 7,
        },
        containerLocation: { a: "nowhere", b: "panel", "": "panel" },
        containerOrder: { sidebar: ["x", 3, "x", "y"] },
        viewContainer: { v: 4, w: "c" },
        hiddenViews: "no",
        collapsedViews: ["v"],
        generated: { g: { title: "T", icon: "i" }, h: { title: 1 } },
    })!;
    expect(layout.locations.sidebar).toEqual({ visible: true, size: LOCATION_SIZES.sidebar.max });
    expect(layout.locations.rightPane).toEqual({ visible: true, size: LOCATION_SIZES.rightPane.initial });
    expect(layout.locations.panel).toEqual(defaultLayout().locations.panel);
    expect(layout.containerLocation).toEqual({ b: "panel" });
    expect(layout.containerOrder.sidebar).toEqual(["x", "y"]);
    expect(layout.viewContainer).toEqual({ w: "c" });
    expect(layout.hiddenViews).toEqual([]);
    expect(layout.collapsedViews).toEqual(["v"]);
    expect(layout.generated).toEqual({ g: { title: "T", icon: "i" } });
});

test("a layout naming thousands of ids is cut to a bounded size", () => {
    const ids = Array.from({ length: 5000 }, (_, index) => `v.${index}`);
    expect(parseLayout({ version: 1, hiddenViews: ids })!.hiddenViews.length).toBeLessThanOrEqual(512);
});

function writeSaved(home: string, saved: unknown): string {
    const path = layoutPath(home);
    mkdirSync(join(home, "machine", "desktop"), { recursive: true });
    writeFileSync(path, JSON.stringify(saved));
    return path;
}

const SAVED_BEFORE_TABS = {
    version: 1,
    locations: {
        sidebar: { visible: true, size: 256 },
        rightPane: { visible: true, size: 440, active: "core.plan" },
        panel: { visible: false, size: 240 },
    },
    containerLocation: {},
    containerOrder: { sidebar: [], rightPane: ["core.files", "core.plan"], panel: [] },
    viewContainer: {},
    viewOrder: {},
    hiddenContainers: [],
    hiddenViews: [],
    collapsedViews: [],
    generated: {},
};

const PANE_REGISTRY = {
    containers: [
        { id: "core.files", title: "Files", icon: "files", location: "rightPane" as const },
        { id: "core.plan", title: "Plan", icon: "plan", location: "rightPane" as const },
        { id: "core.browser", title: "Browser", icon: "browser", location: "rightPane" as const, transientTabs: true },
    ],
    views: [
        { id: "v.files", title: "Files", container: "core.files" },
        { id: "v.plan", title: "Plan", container: "core.plan" },
        { id: "v.browser", title: "Browser", container: "core.browser" },
    ],
};

function withTabs(...containers: string[]): LayoutState {
    return containers.reduce(
        (state, container) => reduceLayout(state, { type: "openTab", container }, PANE_REGISTRY),
        defaultLayout(),
    );
}

const keepsOut = (container: string): boolean => container === "core.browser";

test("@core the pane's tabs are saved and read back from a real file, duplicates and order included", () => {
    const home = trialHome();
    const store = new LayoutStore(layoutPath(home));
    const layout = reduceLayout(withTabs("core.plan", "core.files", "core.plan"), { type: "activateTab", tab: "tab.2" }, PANE_REGISTRY);
    expect(layout.tabs.map((tab) => tab.container)).toEqual(["core.plan", "core.files", "core.plan"]);
    expect(store.save(layout)).toBe(true);
    expect(JSON.parse(readFileSync(layoutPath(home), "utf8")).tabs).toEqual(layout.tabs);
    const loaded = new LayoutStore(layoutPath(home)).load()!;
    expect(loaded).toEqual(layout);
    expect(resolveLayout(loaded, PANE_REGISTRY).locations.rightPane.activeTab?.id).toBe("tab.2");
    expect(store.save(defaultLayout())).toBe(true);
    expect(new LayoutStore(layoutPath(home)).load()?.tabs).toEqual([]);
});

test("@core Browser tabs are not written, and the saved active tab moves to a neighbour", () => {
    const home = trialHome();
    const store = new LayoutStore(layoutPath(home));
    const layout = withTabs("core.files", "core.browser", "core.browser", "core.plan");
    const active = reduceLayout(layout, { type: "activateTab", tab: "tab.3" }, PANE_REGISTRY);
    expect(store.save(forSave(active, keepsOut))).toBe(true);
    const text = readFileSync(layoutPath(home), "utf8");
    expect(text).not.toContain("core.browser");
    const loaded = new LayoutStore(layoutPath(home)).load()!;
    expect(loaded.tabs.map((tab) => tab.container)).toEqual(["core.files", "core.plan"]);
    const right = resolveLayout(loaded, PANE_REGISTRY).locations.rightPane;
    expect(right.activeTab?.container.id).toBe("core.plan");
    expect(forSave(layout, () => false)).toBe(layout);
});

test("@core a layout saved before tabs loads with one tab for its active right-pane container", () => {
    const home = trialHome();
    const loaded = new LayoutStore(writeSaved(home, SAVED_BEFORE_TABS)).load()!;
    expect(loaded.tabs).toEqual([{ id: "tab.1", container: "core.plan" }]);
    expect(loaded.locations.rightPane).toEqual({ visible: true, size: 440, active: "tab.1" });
    expect(loaded.containerOrder.rightPane).toEqual(["core.files", "core.plan"]);
    const right = resolveLayout(loaded, PANE_REGISTRY).locations.rightPane;
    expect(right.containers.map((container) => container.id)).toEqual(["core.files", "core.plan", "core.browser"]);
    expect(right.tabs.map((tab) => tab.container.id)).toEqual(["core.plan"]);
    expect(right.activeTab?.container.id).toBe("core.plan");
    expect(right.active?.id).toBe("core.plan");
    const next = reduceLayout(loaded, { type: "openTab", container: "core.plan" }, PANE_REGISTRY);
    expect(next.tabs.map((tab) => tab.id)).toEqual(["tab.1", "tab.2"]);
});

test("a layout saved before tabs, with no active right-pane container, loads with no tab", () => {
    const home = trialHome();
    const withoutActive = { ...SAVED_BEFORE_TABS, locations: { ...SAVED_BEFORE_TABS.locations, rightPane: { visible: true, size: 440 } } };
    const loaded = new LayoutStore(writeSaved(home, withoutActive)).load()!;
    expect(loaded.tabs).toEqual([]);
    expect(loaded.locations.rightPane.active).toBeUndefined();
});

test("a saved empty tab list stays empty even when an active id is recorded", () => {
    const home = trialHome();
    const loaded = new LayoutStore(writeSaved(home, { ...SAVED_BEFORE_TABS, tabs: [] })).load()!;
    expect(loaded.tabs).toEqual([]);
    expect(loaded.locations.rightPane.active).toBeUndefined();
});

test("a damaged tab list falls back to no tabs, bad entries are skipped and a long list is cut", () => {
    expect(parseLayout({ version: 1, tabs: "tab.1" })!.tabs).toEqual([]);
    const parsed = parseLayout({
        version: 1,
        tabs: [{ id: "tab.4", container: "a" }, 3, { id: "tab.4", container: "b" }, { id: "", container: "c" }, { id: "tab.9", container: "d" }],
        tabSeq: 2,
    })!;
    expect(parsed.tabs).toEqual([{ id: "tab.4", container: "a" }, { id: "tab.9", container: "d" }]);
    expect(parsed.tabSeq).toBe(9);
    const many = Array.from({ length: 5000 }, (_, index) => ({ id: `tab.${index + 1}`, container: "c" }));
    expect(parseLayout({ version: 1, tabs: many })!.tabs.length).toBeLessThanOrEqual(MAX_TABS);
});
