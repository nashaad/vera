import { expect, test } from "bun:test";

import { buildMenuTemplate } from "../../clients/desktop/src/app-menu.ts";
import { THEME_COMMANDS } from "../../clients/ui/src/commands/theme-commands.ts";
import { THEME_NAMES, type ThemeName } from "../../clients/ui/src/theme/tokens.ts";
import { LAYOUT_SHORTCUTS, shortcutCommand, type ShortcutInput } from "../../clients/desktop/src/shortcuts.ts";

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

test("the other platform's modifier, extra modifiers, repeats and key releases do not trigger a toggle", () => {
    expect(shortcutCommand(key("KeyB", { control: true }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true }), "linux")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true, control: true }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true, shift: true }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true, isAutoRepeat: true }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB", { meta: true, type: "keyUp" }), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyB"), "darwin")).toBeUndefined();
    expect(shortcutCommand(key("KeyK", { meta: true }), "darwin")).toBeUndefined();
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
