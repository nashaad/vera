import { expect, test } from "bun:test";

import { buildMenuTemplate } from "../../clients/desktop/src/app-menu.ts";
import { THEME_COMMANDS } from "../../clients/ui/src/commands/theme-commands.ts";
import { THEME_NAMES, type ThemeName } from "../../clients/ui/src/theme/tokens.ts";
import { GO_SHORTCUTS, LAYOUT_SHORTCUTS, shortcutCommand, type ShortcutInput } from "../../clients/desktop/src/shortcuts.ts";
import { acceleratorKeys, shortcutGroups } from "../../clients/ui/src/commands/keys.ts";

function key(code: string, overrides: Partial<ShortcutInput> = {}): ShortcutInput {
    return {
        type: "keyDown",
        code,
        alt: false,
        shift: false,
        control: false,
        meta: false,
        isAutoRepeat: false,
        ...overrides,
    };
}

test("@core the three toggles are bound directly on the platform modifier", () => {
    expect(shortcutCommand(key("KeyB", { meta: true }), "darwin")).toBe("layout.toggleSidebar");
    expect(shortcutCommand(key("KeyJ", { meta: true }), "darwin")).toBe("layout.togglePanel");
    expect(shortcutCommand(key("KeyB", { meta: true, alt: true }), "darwin")).toBe("layout.toggleRightPane");
    expect(shortcutCommand(key("KeyB", { control: true }), "linux")).toBe("layout.toggleSidebar");
    expect(shortcutCommand(key("KeyB", { control: true, alt: true }), "win32")).toBe("layout.toggleRightPane");
});

test("@core page shortcuts open New Chat and Settings and walk back and forward", () => {
    expect(shortcutCommand(key("KeyN", { meta: true }), "darwin")).toBe("go.newChat");
    expect(shortcutCommand(key("BracketLeft", { meta: true }), "darwin")).toBe("go.back");
    expect(shortcutCommand(key("BracketRight", { control: true }), "linux")).toBe("go.forward");
    expect(shortcutCommand(key("Comma", { meta: true }), "darwin")).toBe("go.settings");
    expect(shortcutCommand(key("KeyN", { meta: true, alt: true }), "darwin")).toBeUndefined();
});

test("the Go menu carries each page shortcut with its accelerator, and every page", () => {
    const run: string[] = [];
    const go = buildMenuTemplate("darwin", (id) => run.push(id)).find((entry) => entry.label === "Go");
    if (!Array.isArray(go?.submenu)) throw new Error("There is no Go menu.");
    const keyed = go.submenu.filter((entry) => entry.accelerator !== undefined);
    expect(keyed.map((entry) => [entry.id, entry.label, entry.accelerator])).toEqual(
        GO_SHORTCUTS.map((shortcut) => [shortcut.command, shortcut.label, shortcut.accelerator]),
    );
    for (const entry of go.submenu) if (entry.type !== "separator") (entry.click as () => void)();
    expect(run).toEqual(["go.newChat", "go.back", "go.forward", "go.search", "go.work", "go.customize", "go.devices", "go.settings", "go.tour", "go.coverage"]);
});

test("the other platform's modifier, extra modifiers, repeats and key releases do not trigger a toggle", () => {
    expect(shortcutCommand(key("KeyB", { control: true }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true }), "linux")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true, control: true }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true, shift: true }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true, isAutoRepeat: true }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true, type: "keyUp" }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB"), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyY", { meta: true }), "darwin")).toBeUndefined();
});

test("@core the palette opens on Cmd+K and Shift+Cmd+P, sessions on Cmd+P, and the key sheet on Cmd+/", () => {
    expect(shortcutCommand(key("KeyK", { meta: true }), "darwin")).toBe("palette.commands");
    expect(shortcutCommand(key("KeyP", { meta: true, shift: true }), "darwin")).toBe("palette.commands");
    expect(shortcutCommand(key("KeyP", { meta: true }), "darwin")).toBe("palette.sessions");
    expect(shortcutCommand(key("Slash", { control: true }), "linux")).toBe("help.shortcuts");
    expect(shortcutCommand(key("KeyK", { meta: true, shift: true }), "darwin")).toBeUndefined();
});

test("accelerators read as macOS symbols in menu order, and as words elsewhere", () => {
    expect(acceleratorKeys("CmdOrCtrl+Shift+P", "darwin")).toEqual(["⇧", "⌘", "P"]);
    expect(acceleratorKeys("CmdOrCtrl+Alt+B", "darwin")).toEqual(["⌥", "⌘", "B"]);
    expect(acceleratorKeys("CmdOrCtrl+Shift+P", "linux")).toEqual(["Ctrl", "Shift", "P"]);
});

test("the View menu opens the palette and the Help menu lists the keys", () => {
    const template = buildMenuTemplate("darwin", () => {});
    const view = template.find((entry) => entry.label === "View");
    const ids = Array.isArray(view?.submenu) ? view.submenu.map((entry) => entry.id) : [];
    expect(ids.slice(0, 2)).toEqual(["palette.commands", "palette.sessions"]);
    const help = template.find((entry) => entry.role === "help");
    const helpItems = Array.isArray(help?.submenu) ? help.submenu.filter((entry) => entry.type !== "separator") : [];
    expect(helpItems[0]?.accelerator).toBe("CmdOrCtrl+/");
    expect(helpItems.map((entry) => entry.id)).toEqual([
        "help.shortcuts",
        "help.diagnostics",
        "help.doctor",
        "help.extensions",
        "help.configure",
        "help.failures",
        "help.nudges",
    ]);
});

test("the View menu carries each toggle with its accelerator, plus Reset Layout", () => {
    const run: string[] = [];
    const template = buildMenuTemplate("darwin", (id) => run.push(id));
    const view = template.find((entry) => entry.label === "View");
    const submenu = view?.submenu;
    if (!Array.isArray(submenu)) throw new Error("The View menu has no items.");
    for (const shortcut of LAYOUT_SHORTCUTS) {
        const found = submenu.find((entry) => entry.id === shortcut.command);
        expect(found?.label).toBe(shortcut.label);
        expect(found?.accelerator).toBe(shortcut.accelerator);
        (found?.click as () => void)();
    }
    const reset = submenu.find((entry) => entry.id === "layout.reset");
    expect(reset?.label).toBe("Reset Layout");
    (reset?.click as () => void)();
    expect(run).toEqual([...LAYOUT_SHORTCUTS.map((shortcut) => shortcut.command), "layout.reset"]);
});

test("@core the View menu has a Theme submenu of radio items that run the theme commands", () => {
    const run: string[] = [];
    const themeEntries = (current?: ThemeName) => {
        const template = buildMenuTemplate("darwin", (id) => run.push(id), current);
        const view = template.find((entry) => entry.label === "View");
        const submenu = Array.isArray(view?.submenu) ? view.submenu : [];
        const themeMenu = submenu.find((entry) => entry.label === "Theme");
        if (!Array.isArray(themeMenu?.submenu)) throw new Error("The View menu has no Theme submenu.");
        return themeMenu.submenu;
    };
    const items = themeEntries();
    expect(items.map((entry) => entry.label)).toEqual(["Dark", "Light", "High contrast"]);
    expect(items.map((entry) => entry.id)).toEqual(THEME_NAMES.map((name) => THEME_COMMANDS[name]));
    expect(items.every((entry) => entry.type === "radio")).toBe(true);
    expect(items.map((entry) => entry.checked)).toEqual([true, false, false]);
    expect(themeEntries("light").map((entry) => entry.checked)).toEqual([false, true, false]);
    expect(themeEntries("high-contrast").map((entry) => entry.checked)).toEqual([false, false, true]);
    for (const item of items) (item.click as () => void)();
    expect(run).toEqual(THEME_NAMES.map((name) => THEME_COMMANDS[name]));
});

test("the menu has a File menu with Quit off macOS and the app menu on it", () => {
    expect(buildMenuTemplate("darwin", () => {})[0]).toEqual({ role: "appMenu" });
    expect(buildMenuTemplate("linux", () => {})[0]?.label).toBe("File");
});

test("shortcut groups merge a command's accelerators and list page keys by where they work", () => {
    const groups = shortcutGroups("darwin");
    const help = groups.find((group) => group.title === "Help");
    const palette = help?.rows.find((row) => row.label === "Command Palette");
    expect(palette?.chords).toEqual([["⌘", "K"], ["⇧", "⌘", "P"]]);
    const composer = groups.find((group) => group.title === "Composer");
    expect(composer?.rows.map((row) => row.chords[0]?.[0])).toContain("↑");
    expect(groups.map((group) => group.title).slice(0, 4)).toEqual(["Window", "Go", "Session", "Help"]);
});
