import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import tuiThemes from "../../config/tui-themes.json";
import { buildMenuTemplate } from "../../clients/desktop/src/app-menu.ts";
import { THEME_COMMANDS, registerThemeCommands } from "../../clients/ui/src/commands/theme-commands.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { BUILTIN_THEME_REGISTRY, THEME_LABELS } from "../../clients/ui/src/theme/registry.ts";
import { BUILTIN_THEMES } from "../../clients/ui/src/theme/builtin.ts";
import { buildCommandItems } from "../../clients/ui/src/overlays/palette.ts";
import { DEFAULT_THEME, THEME_NAMES, isThemeName } from "../../clients/ui/src/theme/tokens.ts";

const root = join(import.meta.dir, "..", "..");

test("@core the built-in registry includes every TUI theme with the same text", () => {
    expect(THEME_NAMES).toHaveLength(17);
    expect(new Set(THEME_NAMES).size).toBe(THEME_NAMES.length);
    expect(THEME_NAMES.slice(0, 3)).toEqual(["dark", "light", "high-contrast"]);
    expect(DEFAULT_THEME).toBe("dark");
    expect(isThemeName("missing-crow")).toBe(false);
    for (const [name, theme] of Object.entries(tuiThemes.themes)) {
        expect(BUILTIN_THEME_REGISTRY.find((entry) => entry.name === name)).toMatchObject({
            label: theme.label,
            description: theme.description,
        });
    }
    expect(readdirSync(join(root, "clients/ui/src/theme/themes")).sort()).toEqual(THEME_NAMES.map((name) => `${name}.json`).sort());
    for (const entry of BUILTIN_THEME_REGISTRY) {
        expect(BUILTIN_THEMES[entry.name].name).toBe(entry.name);
        expect(Object.keys(entry).sort()).toEqual(["colorScheme", "description", "label", "name"]);
        if (!["dark", "light", "high-contrast"].includes(entry.name)) {
            expect(BUILTIN_THEMES[entry.name].values).toEqual(BUILTIN_THEMES.dark.values);
        }
        const file = BUILTIN_THEMES[entry.name];
        const surface = file.palette[file.colors.surface]!;
        const linear = [1, 3, 5].map((start) => {
            const value = Number.parseInt(surface.slice(start, start + 2), 16) / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
        expect(entry.colorScheme).toBe(luminance > 0.179 ? "light" : "dark");
    }
});

test("@core the main theme menu bundles metadata without palette JSON", async () => {
    const bundle = await Bun.build({
        entrypoints: [join(root, "clients/desktop/src/app-menu.ts")],
        target: "node",
        format: "esm",
        external: ["electron"],
    });
    expect(bundle.success).toBe(true);
    const code = await bundle.outputs[0]!.text();
    expect(code).toContain("near-black, warm white and orange");
    expect(code).not.toContain("/theme/themes/");
    expect(code).not.toContain("#0b0c10");
    expect(code).not.toContain("#0B0C10");
    expect(code).not.toContain("colors:");
});

test("@core the imported-theme decoder bundles only its three existing fallback palettes", async () => {
    const bundle = await Bun.build({
        entrypoints: [join(root, "clients/desktop/src/theme-store.ts")],
        target: "node",
        format: "esm",
    });
    expect(bundle.success).toBe(true);
    const code = await bundle.outputs[0]!.text();
    const palettes = [...code.matchAll(/\/\/ clients\/ui\/src\/theme\/themes\/([^\n]+)\.json/g)].map((match) => match[1]);
    expect(palettes.sort()).toEqual(["dark", "high-contrast", "light"]);
});

test("@core the menu and commands list all built-ins before extension themes", () => {
    const applied: string[] = [];
    const registry = new CommandRegistry();
    const dispose = registerThemeCommands(registry, (theme) => applied.push(theme), []);
    for (const name of THEME_NAMES) {
        expect(registry.list().find((command) => command.id === THEME_COMMANDS[name])?.title).toBe(`Theme: ${name === "high-contrast" ? "High Contrast" : THEME_LABELS[name]}`);
    }
    registry.register({ id: "theme.imported.aardvark", title: "Theme: Aardvark", run: () => {} });
    const commandIds = buildCommandItems(registry.list(), "darwin").map((item) => item.id);
    expect(new Set(commandIds.slice(0, THEME_NAMES.length))).toEqual(new Set(Object.values(THEME_COMMANDS)));
    expect(commandIds.at(-1)).toBe("theme.imported.aardvark");
    const menu = buildMenuTemplate("darwin", (command) => applied.push(command), "vera-orange", [{ slug: "crow.pack.onyx", name: "Onyx" }]);
    const view = menu.find((item) => item.label === "View");
    const themeMenu = Array.isArray(view?.submenu) ? view.submenu.find((item) => item.label === "Theme") : undefined;
    const items = Array.isArray(themeMenu?.submenu) ? themeMenu.submenu : [];
    expect(items.slice(0, THEME_NAMES.length).map((item) => item.label)).toEqual(THEME_NAMES.map((name) => THEME_LABELS[name]));
    expect(items[THEME_NAMES.length + 1]?.label).toBe("Onyx");
    expect(items.find((item) => item.id === THEME_COMMANDS["vera-orange"])?.checked).toBe(true);
    dispose();
});

test("@core a built-in choice round-trips through real disk-backed web storage and unknown names fall back", async () => {
    const folder = mkdtempSync(join(tmpdir(), "vera-theme-storage-"));
    try {
        const bundle = await Bun.build({
            entrypoints: [join(root, "clients/ui/src/theme/storage.ts")],
            target: "node",
            format: "esm",
        });
        expect(bundle.success).toBe(true);
        const module = join(folder, "storage.mjs");
        writeFileSync(module, await bundle.outputs[0]!.text());
        const script = `import { storeTheme, readStoredTheme } from ${JSON.stringify(pathToFileURL(module).href)};
            const storage = globalThis.localStorage;
            if (process.argv[1] === "save") storeTheme("vera-orange", storage);
            if (process.argv[1] === "unknown") storage.setItem("vera.theme", "missing-crow");
            console.log(readStoredTheme(storage));`;
        const run = (mode: string): string => execFileSync("node", [
            "--experimental-webstorage", `--localstorage-file=${join(folder, "localstorage")}`,
            "--input-type=module", "-e", script, mode,
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        expect(run("save")).toBe("vera-orange");
        expect(run("read")).toBe("vera-orange");
        expect(run("unknown")).toBe("dark");
        expect(run("read")).toBe("dark");
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
