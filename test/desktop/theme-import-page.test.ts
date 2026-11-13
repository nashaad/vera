import { afterEach, beforeEach, expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import {
    importedThemeCommand,
    registerThemeCommands,
    THEME_COMMANDS,
    THEME_IMPORT_COMMAND,
    themeCommandId,
} from "../../clients/ui/src/commands/theme-commands.ts";
import { themeFromAttribute, themeLabel, themeSwatch } from "../../clients/ui/src/pages/settings/appearance.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import type { ThemeImportResult } from "../../clients/ui/src/protocol/themes.ts";
import { applyTheme, resolveThemeChoice, themeFile } from "../../clients/ui/src/theme/apply.ts";
import { importInstalledTheme, importThemeFromPicker, reportImport } from "../../clients/ui/src/theme/import-flow.ts";
import { importedThemeFile, parseImportedSummaries, parseImportedSummary, type ImportedThemeSummary } from "../../clients/ui/src/theme/imported.ts";
import { importedThemes, setImportedThemes } from "../../clients/ui/src/theme/imported-registry.ts";
import { readStoredTheme, readThemeCache, storeTheme } from "../../clients/ui/src/theme/storage.ts";
import { syncImportedThemes } from "../../clients/ui/src/theme/sync.ts";
import {
    importedThemeId,
    importedThemeSlug,
    isImportedThemeId,
    isThemeChoice,
    isThemeSlug,
    COLOR_TOKENS,
    type ColorToken,
} from "../../clients/ui/src/theme/tokens.ts";
import { mapColors } from "../../clients/desktop/src/theme-import/color-map.ts";
import { PIRATE_CROW } from "./theme-fixtures.ts";

const PIRATE: ImportedThemeSummary = {
    slug: "pirate-crow",
    name: "Pirate Crow",
    type: "dark",
    source: "File pirate-crow.json",
    colors: mapColors(PIRATE_CROW.colors, "dark").colors,
    values: {},
};
const NEST: ImportedThemeSummary = { ...PIRATE, slug: "crow-nest", name: "Crow Nest", colors: { ...PIRATE.colors, surface: "#202830" } };

interface Page {
    properties: Map<string, string>;
    attributes: Map<string, string>;
    storage: Map<string, string>;
    windowBackgrounds: string[];
    menuChoices: string[];
}

let page: Page;

// The shared theme code reads document, getComputedStyle and window; these stand in for them.
beforeEach(() => {
    page = { properties: new Map(), attributes: new Map(), storage: new Map(), windowBackgrounds: [], menuChoices: [] };
    const root = {
        setAttribute: (name: string, value: string) => void page.attributes.set(name, value),
        style: { setProperty: (name: string, value: string) => void page.properties.set(name, value) },
    };
    const globals = globalThis as Record<string, unknown>;
    globals.document = { documentElement: root };
    globals.getComputedStyle = () => ({ getPropertyValue: (name: string) => page.properties.get(name) ?? "" });
    globals.window = {
        localStorage: {
            getItem: (key: string) => page.storage.get(key) ?? null,
            setItem: (key: string, value: string) => void page.storage.set(key, value),
            removeItem: (key: string) => void page.storage.delete(key),
        },
    };
    setImportedThemes([]);
});

afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    delete globals.document;
    delete globals.getComputedStyle;
    delete globals.window;
    setImportedThemes([]);
});

function bridgeAnswering(answers: { load?: unknown; import?: ThemeImportResult; installed?: ThemeImportResult }): DesktopBridge {
    return {
        setWindowBackground: (color: string) => void page.windowBackgrounds.push(color),
        setTheme: (choice: string) => void page.menuChoices.push(choice),
        loadImportedThemes: async () => (answers.load ?? []) as ImportedThemeSummary[],
        importTheme: async () => answers.import ?? { ok: true, imported: [], themes: [], skipped: [] },
        importInstalledTheme: async () => answers.installed ?? { ok: true, imported: [], themes: [], skipped: [] },
    } as unknown as DesktopBridge;
}

function done(imported: ImportedThemeSummary[], all: ImportedThemeSummary[] = imported, skipped: string[] = []): ThemeImportResult {
    return { ok: true, imported, themes: all, skipped };
}

test("@core imported theme ids are a prefix and a safe slug, and cannot collide with a built-in name", () => {
    expect(importedThemeId("pirate-crow")).toBe("imported:pirate-crow");
    expect(importedThemeSlug("imported:pirate-crow")).toBe("pirate-crow");
    expect(importedThemeSlug("dark")).toBeUndefined();
    expect(isImportedThemeId("imported:pirate-crow")).toBe(true);
    expect(isImportedThemeId("imported:../etc")).toBe(false);
    expect(isImportedThemeId("imported:")).toBe(false);
    expect(isThemeChoice("dark")).toBe(true);
    expect(isThemeChoice("imported:dark")).toBe(true);
    expect(isThemeChoice("pirate-crow")).toBe(false);
    expect(isThemeSlug("Pirate")).toBe(false);
    expect(isThemeSlug("a".repeat(65))).toBe(false);
});

test("@core applying an imported theme sets its colors live and keeps Vera's fonts, sizes, radius and motion", () => {
    setImportedThemes([PIRATE]);
    const applied = applyTheme("imported:pirate-crow");
    expect(applied).toBe("imported:pirate-crow");
    expect(page.attributes.get("data-theme")).toBe("imported:pirate-crow");
    expect(page.properties.get("--vera-surface")).toBe("#10131a");
    expect(page.properties.get("--vera-accent")).toBe("#c9a227");
    expect(page.properties.get("color-scheme")).toBe("dark");
    const dark = themeFile("dark").values;
    for (const token of ["font-ui", "font-code", "font-size", "radius", "space", "row-height", "motion"] as const) {
        expect(page.properties.get(`--vera-${token}`)).toBe(dark[token]);
    }
});

test("an imported light theme asks for the light color scheme", () => {
    setImportedThemes([{ ...PIRATE, type: "light" }]);
    applyTheme("imported:pirate-crow");
    expect(page.properties.get("color-scheme")).toBe("light");
});

test("an imported theme whose file is gone resolves to the default theme", () => {
    expect(resolveThemeChoice("imported:pirate-crow")).toBe("dark");
    expect(applyTheme("imported:pirate-crow")).toBe("dark");
    expect(page.attributes.get("data-theme")).toBe("dark");
    expect(themeFromAttribute("imported:pirate-crow")).toBe("dark");
    setImportedThemes([PIRATE]);
    expect(themeFromAttribute("imported:pirate-crow")).toBe("imported:pirate-crow");
});

test("an imported theme draws the same file shape the built-in themes have", () => {
    const file = importedThemeFile({ ...PIRATE, values: { shadow: "0 1px 2px #000000" } });
    expect(file.name).toBe("Pirate Crow");
    for (const token of COLOR_TOKENS) expect(file.palette[file.colors[token]]).toBe(PIRATE.colors[token]);
    expect(file.values.shadow).toBe("0 1px 2px #000000");
    expect(importedThemeFile(PIRATE).values.shadow).toBe(themeFile("dark").values.shadow);
});

test("@core a saved theme read back with a bad or missing color takes the built-in value for that token", () => {
    const damaged = { ...PIRATE, colors: { ...PIRATE.colors, surface: "javascript:alert(1)", accent: 7 } as unknown as Record<ColorToken, string> };
    const read = parseImportedSummary(damaged);
    expect(read?.colors.surface).toBe(themeFile("dark").palette[themeFile("dark").colors.surface] ?? "");
    expect(read?.colors.accent).toBe(themeFile("dark").palette[themeFile("dark").colors.accent] ?? "");
    expect(read?.colors.text).toBe(PIRATE.colors.text);
    expect(parseImportedSummary({ ...PIRATE, slug: "../x" })).toBeUndefined();
    expect(parseImportedSummary({ ...PIRATE, type: "sepia" })).toBeUndefined();
    expect(parseImportedSummary({ ...PIRATE, name: "" })).toBeUndefined();
    expect(parseImportedSummary("crow")).toBeUndefined();
    expect(parseImportedSummaries([PIRATE, "junk", null, NEST]).map((theme) => theme.slug)).toEqual(["pirate-crow", "crow-nest"]);
    expect(parseImportedSummaries("not a list")).toEqual([]);
});

test("@core the choice and the last imported theme's colors are kept for the next launch", () => {
    setImportedThemes([PIRATE]);
    storeTheme("imported:pirate-crow");
    expect(readStoredTheme()).toBe("imported:pirate-crow");
    expect(readThemeCache()?.colors.surface).toBe("#10131a");
    storeTheme("light");
    expect(readStoredTheme()).toBe("light");
    expect(readThemeCache()).toBeUndefined();
    page.storage.set("vera.theme", "imported:../etc");
    expect(readStoredTheme()).toBe("dark");
    page.storage.set("vera.theme.imported", "{ not json");
    expect(readThemeCache()).toBeUndefined();
});

test("@core a successful import switches to the first imported theme at once and says so", () => {
    const report = reportImport(done([PIRATE, NEST]));
    expect(report).toEqual({ ok: true, message: "Imported 2 themes and switched to \"Pirate Crow\"." });
    expect(importedThemes().map((theme) => theme.slug)).toEqual(["pirate-crow", "crow-nest"]);
    expect(page.attributes.get("data-theme")).toBe("imported:pirate-crow");
    expect(readStoredTheme()).toBe("imported:pirate-crow");
    expect(reportImport(done([NEST]))?.message).toBe("Imported \"Crow Nest\" and switched to it.");
});

test("an import that skipped some themes lists them", () => {
    const report = reportImport(done([PIRATE], [PIRATE], ["Bare Crow: it sets no colors."]));
    expect(report?.ok).toBe(true);
    expect(report?.message).toBe("Imported \"Pirate Crow\" and switched to it. Not imported: Bare Crow: it sets no colors.");
});

test("@core a refused import keeps the current theme and gives the reason", () => {
    setImportedThemes([PIRATE]);
    applyTheme("light");
    const report = reportImport({ ok: false, reason: "The file is not valid JSON (Unexpected end)." });
    expect(report).toEqual({ ok: false, message: "The file is not valid JSON (Unexpected end). Your theme is unchanged." });
    expect(page.attributes.get("data-theme")).toBe("light");
    expect(importedThemes()).toHaveLength(1);
});

test("a closed picker changes nothing and reports nothing", async () => {
    setImportedThemes([PIRATE]);
    applyTheme("light");
    expect(await importThemeFromPicker(bridgeAnswering({ import: done([], [PIRATE]) }))).toBeUndefined();
    expect(page.attributes.get("data-theme")).toBe("light");
});

test("importing without a desktop bridge or when the bridge throws leaves the theme alone", async () => {
    expect(await importThemeFromPicker(undefined)).toEqual({ ok: false, message: "Importing a theme needs the desktop app. Your theme is unchanged." });
    const throwing = { importTheme: async () => { throw new Error("ipc closed"); } } as unknown as DesktopBridge;
    expect(await importThemeFromPicker(throwing)).toEqual({ ok: false, message: "Vera could not import that theme. Your theme is unchanged." });
    expect(page.attributes.size).toBe(0);
});

test("an installed theme imports through the same flow", async () => {
    const report = await importInstalledTheme("installed-1", bridgeAnswering({ installed: done([NEST]) }));
    expect(report?.ok).toBe(true);
    expect(page.attributes.get("data-theme")).toBe("imported:crow-nest");
});

test("@core on launch the stored imported theme is applied again from the saved files, and falls back when its file is gone", async () => {
    page.storage.set("vera.theme", "imported:crow-nest");
    await syncImportedThemes(bridgeAnswering({ load: [NEST, PIRATE] }));
    expect(importedThemes().map((theme) => theme.slug)).toEqual(["crow-nest", "pirate-crow"]);
    expect(page.attributes.get("data-theme")).toBe("imported:crow-nest");
    expect(page.properties.get("--vera-surface")).toBe("#202830");

    await syncImportedThemes(bridgeAnswering({ load: [PIRATE] }));
    expect(page.attributes.get("data-theme")).toBe("dark");
    expect(readStoredTheme()).toBe("dark");
});

test("syncing leaves a built-in choice alone, and does nothing without a bridge", async () => {
    page.storage.set("vera.theme", "light");
    await syncImportedThemes(bridgeAnswering({ load: [PIRATE] }));
    expect(page.attributes.size).toBe(0);
    await syncImportedThemes(undefined);
    await syncImportedThemes({ loadImportedThemes: async () => { throw new Error("ipc closed"); } } as unknown as DesktopBridge);
    expect(importedThemes().map((theme) => theme.slug)).toEqual(["pirate-crow"]);
});

test("@core each imported theme has a palette command, and the import command exists only when asked for", () => {
    const registry = new CommandRegistry();
    const applied: string[] = [];
    let imports = 0;
    const dispose = registerThemeCommands(registry, (choice) => applied.push(choice), [PIRATE, NEST], () => { imports += 1; });
    expect(registry.list().map((command) => [command.id, command.title]).sort()).toEqual([
        ["theme.dark", "Theme: Dark"],
        ["theme.highContrast", "Theme: High Contrast"],
        ["theme.imported.crow-nest", "Theme: Crow Nest"],
        ["theme.imported.pirate-crow", "Theme: Pirate Crow"],
        ["theme.import", "Theme: Import VS Code Theme…"],
        ["theme.light", "Theme: Light"],
    ].sort());
    registry.execute(importedThemeCommand("crow-nest"));
    registry.execute(THEME_IMPORT_COMMAND);
    expect(applied).toEqual(["imported:crow-nest"]);
    expect(imports).toBe(1);
    dispose();
    expect(registry.list()).toEqual([]);
    const plain = new CommandRegistry();
    registerThemeCommands(plain, () => {});
    expect(plain.list().map((command) => command.id).sort()).toEqual(Object.values(THEME_COMMANDS).sort());
});

test("the command id of a choice is the one a menu item or a select can run", () => {
    expect(themeCommandId("dark")).toBe("theme.dark");
    expect(themeCommandId("high-contrast")).toBe("theme.highContrast");
    expect(themeCommandId("imported:pirate-crow")).toBe("theme.imported.pirate-crow");
});

test("settings cards and the Themes sheet draw an imported theme from its own colors", () => {
    setImportedThemes([PIRATE]);
    expect(themeSwatch("imported:pirate-crow")).toEqual({
        surface: "#10131a",
        text: PIRATE.colors.text,
        accent: "#c9a227",
        border: PIRATE.colors.border,
    });
    expect(themeLabel("imported:pirate-crow")).toBe("Pirate Crow");
    expect(themeLabel("light")).toBe("Light");
});
