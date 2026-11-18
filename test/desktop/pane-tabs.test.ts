import { afterEach, expect, test } from "bun:test";

import { browserUrl, typedAddress, URL_LIMIT } from "../../clients/ui/src/browser/url.ts";
import { reconcile } from "../../clients/ui/src/browser/reconcile.ts";
import { browserSlots, CONTAINER_SLOT, EMPTY_SLOT } from "../../clients/ui/src/browser/slots.ts";
import { LAYOUT_COMMANDS, registerLayoutCommands } from "../../clients/ui/src/commands/layout-commands.ts";
import { acceleratorKeys, paneShortcuts, PANE_SHORTCUTS } from "../../clients/ui/src/commands/keys.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { defaultLayout } from "../../clients/ui/src/layout/model.ts";
import { reduceLayout, type LayoutAction } from "../../clients/ui/src/layout/reducer.ts";
import { canOpenTab, resolveLayout } from "../../clients/ui/src/layout/resolve.ts";
import { ContributionRegistry } from "../../clients/ui/src/registry/contributions.ts";
import { CORE_CONTAINERS, PANE_KINDS, paneKindCommand, registerCoreContributions, type PaneKind } from "../../clients/ui/src/registry/core.ts";
import { containerShortcutKeys } from "../../clients/ui/src/workbench/hints.ts";

afterEach(() => browserSlots.reset());

test("@core a typed web address becomes a page address, and anything else opens no page", () => {
    expect(browserUrl("example.com")).toBe("https://example.com/");
    expect(browserUrl("  http://localhost:3000/a b ")).toBe("http://localhost:3000/a%20b");
    expect(browserUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(browserUrl("localhost:8080")).toBe("https://localhost:8080/");
    expect(browserUrl("")).toBeUndefined();
    expect(browserUrl("   ")).toBeUndefined();
    expect(browserUrl("file:///etc/passwd")).toBeUndefined();
    expect(browserUrl("javascript:alert(1)")).toBeUndefined();
    expect(browserUrl("mailto:a@b.c")).toBeUndefined();
    expect(browserUrl("not a url")).toBeUndefined();
    expect(browserUrl(`https://example.com/${"a".repeat(URL_LIMIT)}`)).toBeUndefined();
});

test("@core the launcher takes text for an address only when it reads as one", () => {
    expect(typedAddress("example.com/a")).toBe("https://example.com/a");
    expect(typedAddress("http://intranet")).toBe("http://intranet/");
    expect(typedAddress("localhost")).toBe("https://localhost/");
    expect(typedAddress("127.0.0.1:8080/site")).toBe("https://127.0.0.1:8080/site");
    expect(typedAddress("[::1]:3000")).toBe("https://[::1]:3000/");
    expect(typedAddress("fi")).toBeUndefined();
    expect(typedAddress("browser")).toBeUndefined();
    expect(typedAddress("file:///etc/passwd")).toBeUndefined();
    expect(typedAddress("")).toBeUndefined();
});

test("@core pages and tabs reconcile one to one: a closed page closes its tab, an unshown page gets a tab", () => {
    const quiet = reconcile({ live: ["tab.page-a"], bound: { "tab.page-a": 1 }, pages: [1], active: 1, room: 5 });
    expect(quiet).toEqual({ closeSlots: [], adopt: [], closePages: [], dropSlots: [] });

    const gone = reconcile({ live: ["tab.page-a", "tab.page-b"], bound: { "tab.page-a": 1, "tab.page-b": 2 }, pages: [2], active: 2, room: 5 });
    expect(gone.closeSlots).toEqual(["tab.page-a"]);
    expect(gone.dropSlots).toEqual(["tab.page-a"]);
    expect(gone.adopt).toEqual([]);

    const unbound = reconcile({ live: ["tab.page-a"], bound: { "tab.page-a": undefined }, pages: [], active: null, room: 5 });
    expect(unbound).toEqual({ closeSlots: [], adopt: [], closePages: [], dropSlots: [] });
});

test("a page no tab shows is adopted, the shell's active page last, and the rest are closed past the room", () => {
    const adopted = reconcile({ live: [], bound: {}, pages: [1, 2, 3], active: 1, room: 5 });
    expect(adopted.adopt).toEqual([2, 3, 1]);
    expect(adopted.closePages).toEqual([]);
    const cut = reconcile({ live: [], bound: {}, pages: [1, 2, 3], active: 1, room: 2 });
    expect(cut.adopt).toEqual([3, 1]);
    expect(cut.closePages).toEqual([2]);
    const none = reconcile({ live: [], bound: {}, pages: [1, 2], active: 2, room: 0 });
    expect(none.adopt).toEqual([]);
    expect(none.closePages).toEqual([1, 2]);
});

test("a slot with no view is forgotten and its page closes", () => {
    const plan = reconcile({ live: ["tab.page-a"], bound: { "tab.page-a": 1, "tab.page-old": 7, "tab.page-none": undefined }, pages: [1, 7], active: 1, room: 5 });
    expect(plan.closePages).toEqual([7]);
    expect([...plan.dropSlots].sort()).toEqual(["tab.page-none", "tab.page-old"]);
    expect(plan.adopt).toEqual([]);
});

test("slots keep their own web pages, and an equal read changes nothing", () => {
    expect(browserSlots.slot("a")).toBe(EMPTY_SLOT);
    browserSlots.bind("a", 4);
    browserSlots.bind("b", 5);
    expect(browserSlots.slot("a").page).toBe(4);
    expect(browserSlots.slot("b").page).toBe(5);
    expect(browserSlots.slot(CONTAINER_SLOT).page).toBeUndefined();
    browserSlots.unbind("a");
    expect(browserSlots.slot("a").page).toBeUndefined();
    browserSlots.drop(["a", "missing"]);
    expect(browserSlots.slot("a")).toBe(EMPTY_SLOT);
    expect(browserSlots.slot("b").page).toBe(5);

    const native = { pages: [], active: null } as unknown as Parameters<typeof browserSlots.read>[0];
    let heard = 0;
    const stop = browserSlots.subscribe(() => heard++);
    browserSlots.read(native);
    browserSlots.read({ ...native });
    expect(heard).toBe(1);
    browserSlots.claim();
    browserSlots.release();
    browserSlots.release();
    expect(browserSlots.get().claims).toBe(0);
    stop();
});

test("@core a new kind is one entry: it registers, takes tabs, answers its shortcut and is saved like the others", () => {
    const terminal: PaneKind = { id: "core.terminal", title: "Terminal", icon: "terminal", maxTabs: 3, shortcut: { key: "T", alt: true } };
    const kinds = [...PANE_KINDS, terminal];
    const contributions = new ContributionRegistry();
    registerCoreContributions(contributions, kinds);
    const snapshot = contributions.snapshot();
    expect(snapshot.containers.filter((container) => container.location === "rightPane").map((container) => container.id)).toEqual(kinds.map((kind) => kind.id));
    expect(contributions.keepsTabsOut("core.terminal")).toBe(false);

    let layout = defaultLayout();
    for (let index = 0; index < 4; index++) layout = reduceLayout(layout, { type: "openTab", container: "core.terminal" }, snapshot);
    expect(layout.tabs.map((tab) => tab.container)).toEqual(["core.terminal", "core.terminal", "core.terminal"]);
    expect(canOpenTab(resolveLayout(layout, snapshot), "core.terminal")).toBe(false);

    const keys = paneShortcuts(kinds).map((entry) => entry.command);
    expect(keys).toEqual([paneKindCommand("core.terminal")]);
    expect(paneShortcuts(kinds)[0]).toMatchObject({ accelerator: "CmdOrCtrl+Alt+T", code: "KeyT", alt: true, shift: false, label: "Show Terminal" });
    expect(containerShortcutKeys("core.terminal", "darwin", kinds)).toEqual(acceleratorKeys("CmdOrCtrl+Alt+T", "darwin"));
    expect(containerShortcutKeys("core.terminal", "darwin")).toEqual([]);
    expect(containerShortcutKeys(CORE_CONTAINERS.plan, "darwin", kinds)).toEqual([]);

    const commands = new CommandRegistry();
    const actions: LayoutAction[] = [];
    registerLayoutCommands(commands, (action) => actions.push(action), kinds);
    expect(commands.has(paneKindCommand("core.terminal"))).toBe(true);
    expect(commands.has(paneKindCommand(CORE_CONTAINERS.plan))).toBe(false);
    commands.execute(paneKindCommand("core.terminal"));
    commands.execute(LAYOUT_COMMANDS.tabOpen, { container: "core.terminal" });
    expect(actions).toEqual([
        { type: "activateContainer", container: "core.terminal" },
        { type: "openTab", container: "core.terminal" },
    ]);
});

test("the core kinds declare no shortcut and Browser, Chat and Subagents alone are limited and unsaved", () => {
    expect(PANE_SHORTCUTS).toEqual([]);
    expect(PANE_KINDS.map((kind) => kind.id)).toEqual([CORE_CONTAINERS.review, CORE_CONTAINERS.plan, CORE_CONTAINERS.files, CORE_CONTAINERS.browser, CORE_CONTAINERS.chat, CORE_CONTAINERS.subagents]);
    const limited = PANE_KINDS.filter((kind) => kind.maxTabs !== undefined || kind.transientTabs === true);
    expect(limited.map((kind) => kind.id)).toEqual([CORE_CONTAINERS.browser, CORE_CONTAINERS.chat, CORE_CONTAINERS.subagents]);
});

test("@core Browser is disabled at its limit and every kind at the pane's, but the others stay open below it", () => {
    const contributions = new ContributionRegistry();
    registerCoreContributions(contributions);
    const snapshot = contributions.snapshot();
    let layout = defaultLayout();
    for (let index = 0; index < 12; index++) layout = reduceLayout(layout, { type: "openTab", container: CORE_CONTAINERS.browser }, snapshot);
    const resolved = resolveLayout(layout, snapshot);
    expect(canOpenTab(resolved, CORE_CONTAINERS.browser)).toBe(false);
    expect(canOpenTab(resolved, CORE_CONTAINERS.plan)).toBe(true);
    expect(reduceLayout(layout, { type: "openTab", container: CORE_CONTAINERS.browser }, snapshot)).toBe(layout);
    for (let index = 0; index < 4; index++) layout = reduceLayout(layout, { type: "openTab", container: CORE_CONTAINERS.plan }, snapshot);
    expect(layout.tabs).toHaveLength(16);
    expect(canOpenTab(resolveLayout(layout, snapshot), CORE_CONTAINERS.files)).toBe(false);
});
