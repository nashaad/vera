import { expect, test } from "bun:test";

import { LAYOUT_COMMANDS, registerLayoutCommands } from "../../clients/ui/src/commands/layout-commands.ts";
import { containerMenu, switcherMenu, viewMenu, type MenuEntry } from "../../clients/ui/src/commands/menus.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { registerThemeCommands, THEME_COMMANDS } from "../../clients/ui/src/commands/theme-commands.ts";
import { defaultLayout, type RegistrySnapshot } from "../../clients/ui/src/layout/model.ts";
import type { LayoutAction } from "../../clients/ui/src/layout/reducer.ts";
import { reduceLayout } from "../../clients/ui/src/layout/reducer.ts";
import { resolveLayout } from "../../clients/ui/src/layout/resolve.ts";
import { THEME_NAMES, type ThemeChoice } from "../../clients/ui/src/theme/tokens.ts";

const REGISTRY: RegistrySnapshot = {
    containers: [
        { id: "c.sessions", title: "Sessions", icon: "sessions", location: "sidebar" },
        { id: "c.vera", title: "Vera", icon: "vera", location: "rightPane" },
        { id: "c.output", title: "Output", icon: "output", location: "panel" },
    ],
    views: [
        { id: "v.sessions", title: "Sessions", container: "c.sessions" },
        { id: "v.host", title: "Host", container: "c.vera" },
        { id: "v.notes", title: "Notes", container: "c.vera" },
        { id: "v.output", title: "Output", container: "c.output" },
    ],
};

function wired(): { registry: CommandRegistry; actions: LayoutAction[] } {
    const registry = new CommandRegistry();
    const actions: LayoutAction[] = [];
    registerLayoutCommands(registry, (action) => actions.push(action));
    return { registry, actions };
}

function labels(entries: readonly MenuEntry[]): string[] {
    return entries.flatMap((entry) => (entry.kind === "item" ? [entry.label] : []));
}

test("@core the command registry runs a command and says when none exists", () => {
    const registry = new CommandRegistry();
    const ran: unknown[] = [];
    const dispose = registry.register({ id: "a.b", title: "A", run: (args) => ran.push(args) });
    expect(registry.execute("a.b", { x: 1 })).toBe(true);
    expect(ran).toEqual([{ x: 1 }]);
    expect(registry.execute("missing")).toBe(false);
    expect(() => registry.register({ id: "a.b", title: "Again", run: () => {} })).toThrow("already registered");
    dispose();
    expect(registry.has("a.b")).toBe(false);
});

test("@core every layout action has a command that dispatches the matching action", () => {
    const { registry, actions } = wired();
    registry.execute(LAYOUT_COMMANDS.toggleSidebar);
    registry.execute(LAYOUT_COMMANDS.togglePanel);
    registry.execute(LAYOUT_COMMANDS.toggleRightPane);
    registry.execute(LAYOUT_COMMANDS.reset);
    registry.execute(LAYOUT_COMMANDS.viewMoveTo, { view: "v.host", location: "panel" });
    registry.execute(LAYOUT_COMMANDS.viewMoveTo, { view: "v.host", container: "c.output", index: 1 });
    registry.execute(LAYOUT_COMMANDS.viewHide, { view: "v.host" });
    registry.execute(LAYOUT_COMMANDS.viewShow, { view: "v.host" });
    registry.execute(LAYOUT_COMMANDS.viewCollapse, { view: "v.host" });
    registry.execute(LAYOUT_COMMANDS.viewExpand, { view: "v.host" });
    registry.execute(LAYOUT_COMMANDS.viewReset, { view: "v.host" });
    registry.execute(LAYOUT_COMMANDS.containerMoveTo, { container: "c.vera", location: "sidebar", index: 0 });
    registry.execute(LAYOUT_COMMANDS.containerHide, { container: "c.vera" });
    registry.execute(LAYOUT_COMMANDS.containerShow, { container: "c.vera" });
    registry.execute(LAYOUT_COMMANDS.containerActivate, { container: "c.vera" });
    registry.execute(LAYOUT_COMMANDS.containerReset, { container: "c.vera" });
    expect(actions).toEqual([
        { type: "toggleLocation", location: "sidebar" },
        { type: "toggleLocation", location: "panel" },
        { type: "toggleLocation", location: "rightPane" },
        { type: "resetLayout" },
        { type: "moveView", view: "v.host", to: { location: "panel" } },
        { type: "moveView", view: "v.host", to: { container: "c.output", index: 1 } },
        { type: "setViewHidden", view: "v.host", hidden: true },
        { type: "setViewHidden", view: "v.host", hidden: false },
        { type: "setViewCollapsed", view: "v.host", collapsed: true },
        { type: "setViewCollapsed", view: "v.host", collapsed: false },
        { type: "resetView", view: "v.host" },
        { type: "moveContainer", container: "c.vera", location: "sidebar", index: 0 },
        { type: "setContainerHidden", container: "c.vera", hidden: true },
        { type: "setContainerHidden", container: "c.vera", hidden: false },
        { type: "activateContainer", container: "c.vera" },
        { type: "resetContainer", container: "c.vera" },
    ]);
});

test("layout commands reject missing or malformed arguments without dispatching", () => {
    const { registry, actions } = wired();
    expect(() => registry.execute(LAYOUT_COMMANDS.viewHide)).toThrow("Missing argument view");
    expect(() => registry.execute(LAYOUT_COMMANDS.viewMoveTo, { view: "v.host" })).toThrow("Missing argument location");
    expect(() => registry.execute(LAYOUT_COMMANDS.containerMoveTo, { container: "c.vera", location: "nowhere" }))
        .toThrow("Missing argument location");
    expect(() => registry.execute(LAYOUT_COMMANDS.containerHide, { container: 4 })).toThrow("Missing argument container");
    expect(actions).toEqual([]);
});

test("a bad index is dropped rather than passed on", () => {
    const { registry, actions } = wired();
    registry.execute(LAYOUT_COMMANDS.viewMoveTo, { view: "v.host", location: "panel", index: -1 });
    registry.execute(LAYOUT_COMMANDS.viewMoveTo, { view: "v.host", location: "panel", index: 1.5 });
    expect(actions).toEqual([
        { type: "moveView", view: "v.host", to: { location: "panel" } },
        { type: "moveView", view: "v.host", to: { location: "panel" } },
    ]);
});

test("disposing the layout commands removes them all", () => {
    const registry = new CommandRegistry();
    const dispose = registerLayoutCommands(registry, () => {});
    expect(registry.list().length).toBe(Object.keys(LAYOUT_COMMANDS).length);
    dispose();
    expect(registry.list()).toEqual([]);
});

test("the view menu offers every location, hide and reset, and runs real commands", () => {
    const layout = resolveLayout(defaultLayout(), REGISTRY);
    const entries = viewMenu(layout, "v.sessions");
    expect(labels(entries)).toEqual([
        "Hide Sessions",
        "Move to Sidebar",
        "Move to Right Pane",
        "Move to Panel",
        "Move to Vera (Right Pane)",
        "Move to Output (Panel)",
        "Reset Location",
    ]);
    const registry = new CommandRegistry();
    registerLayoutCommands(registry, () => {});
    for (const entry of entries) {
        if (entry.kind === "item") expect(registry.has(entry.command)).toBe(true);
    }
});

test("a view that is alone in its own generated container cannot be moved to where it already is", () => {
    const moved = reduceLayout(defaultLayout(), { type: "moveView", view: "v.sessions", to: { location: "panel" } }, REGISTRY);
    const entries = viewMenu(resolveLayout(moved, REGISTRY), "v.sessions");
    const toPanel = entries.find((entry) => entry.kind === "item" && entry.label === "Move to Panel");
    expect(toPanel).toMatchObject({ disabled: true });
    expect(labels(entries)).not.toContain("Move to New Container");
});

test("a view in a shared container lists its siblings with their visibility and can leave as a new container", () => {
    const hidden = reduceLayout(defaultLayout(), { type: "setViewHidden", view: "v.notes", hidden: true }, REGISTRY);
    const entries = viewMenu(resolveLayout(hidden, REGISTRY), "v.host");
    const sibling = entries.find((entry) => entry.kind === "item" && entry.label === "Notes");
    expect(sibling).toMatchObject({ command: LAYOUT_COMMANDS.viewShow, checked: false });
    expect(labels(entries)).toContain("Move to New Container");
});

test("the container menu disables the current location and the switcher menu lists every container there", () => {
    const layout = resolveLayout(defaultLayout(), REGISTRY);
    const entries = containerMenu(layout, "c.vera");
    expect(entries.find((entry) => entry.kind === "item" && entry.label === "Move to Right Pane")).toMatchObject({ disabled: true });
    expect(labels(entries)).toContain("Reset Location");
    const hidden = reduceLayout(defaultLayout(), { type: "setContainerHidden", container: "c.output", hidden: true }, REGISTRY);
    expect(switcherMenu(resolveLayout(hidden, REGISTRY), "panel")).toEqual([
        { kind: "item", label: "Output", command: LAYOUT_COMMANDS.containerShow, args: { container: "c.output" }, checked: false },
    ]);
});

test("menus for ids that are not registered are empty", () => {
    const layout = resolveLayout(defaultLayout(), REGISTRY);
    expect(viewMenu(layout, "nope")).toEqual([]);
    expect(containerMenu(layout, "nope")).toEqual([]);
});

test("@core each theme has a command that applies that theme, and disposing removes them", () => {
    const registry = new CommandRegistry();
    const applied: ThemeChoice[] = [];
    const dispose = registerThemeCommands(registry, (name) => applied.push(name));
    expect(Object.keys(THEME_COMMANDS).sort()).toEqual([...THEME_NAMES].sort());
    for (const name of THEME_NAMES) expect(registry.execute(THEME_COMMANDS[name])).toBe(true);
    expect(applied).toEqual([...THEME_NAMES]);
    expect(registry.list().map((command) => command.id).sort()).toEqual(Object.values(THEME_COMMANDS).sort());
    dispose();
    expect(registry.list()).toEqual([]);
});
