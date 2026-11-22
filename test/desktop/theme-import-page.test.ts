import { afterEach, beforeEach, expect, test } from "bun:test";

import { THEME_LABELS, THEME_NAMES } from "../../clients/ui/src/theme/registry.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import {
    importedThemeCommand,
    registerThemeCommands,
    THEME_COMMANDS,
    themeCommandId,
} from "../../clients/ui/src/commands/theme-commands.ts";
import { themeFromAttribute, themeLabel, themeSwatch } from "../../clients/ui/src/pages/settings/appearance.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import type { CommandThemesDone, ExtensionCommandResult } from "../../clients/ui/src/protocol/extension-commands.ts";
import { runExtensionCommand } from "../../clients/ui/src/extensions/run-command.ts";
import { desktopExtensions } from "../../clients/ui/src/extensions/state.ts";
import { closeOverlay, openedOverlay, openedPicker } from "../../clients/ui/src/overlays/store.ts";
import { applyTheme, resolveThemeChoice, themeFile } from "../../clients/ui/src/theme/apply.ts";
import { reportImport, type ImportReport } from "../../clients/ui/src/theme/import-flow.ts";
import { importedThemeFile, parseImportedSummaries, parseImportedSummary, type ImportedThemeSummary } from "../../clients/ui/src/theme/imported.ts";
import { importedThemes, setImportedThemes } from "../../clients/ui/src/theme/imported-registry.ts";
import { readStoredTheme, readThemeCache, storeTheme } from "../../clients/ui/src/theme/storage.ts";
import { syncImportedThemes } from "../../clients/ui/src/theme/sync.ts";
import {
    importedThemeId,
    importedThemeSlug,
    isImportedThemeId,
    isThemeChoice,
    isThemeKey,
    isThemeSlug,
    COLOR_TOKENS,
    type ColorToken,
} from "../../clients/ui/src/theme/tokens.ts";
import { mapColors } from "../../extensions/vscode-theme-import/color-map.ts";
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

type CommandAnswer = (command: string, pick: string | undefined) => ExtensionCommandResult | Promise<ExtensionCommandResult>;

function bridgeAnswering(answers: { load?: unknown; run?: CommandAnswer }): DesktopBridge {
    return {
        setWindowBackground: (color: string) => void page.windowBackgrounds.push(color),
        setTheme: (choice: string) => void page.menuChoices.push(choice),
        loadImportedThemes: async () => (answers.load ?? []) as ImportedThemeSummary[],
        runExtensionCommand: async (command: string, pick?: string) =>
            answers.run?.(command, pick) ?? { ok: true, kind: "themes", imported: [], themes: [], skipped: [] },
    } as unknown as DesktopBridge;
}

function done(imported: ImportedThemeSummary[], all: ImportedThemeSummary[] = imported, skipped: string[] = []): CommandThemesDone {
    return { ok: true, kind: "themes", imported, themes: all, skipped };
}

async function reported(command: string, bridge: DesktopBridge | undefined, pick?: string): Promise<ImportReport[]> {
    const reports: ImportReport[] = [];
    await runExtensionCommand(command, (outcome) => reports.push(outcome), bridge, pick);
    return reports;
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

test("@core an extension's theme is keyed by its extension id and slug, and the key cannot name a path", () => {
    expect(importedThemeSlug("imported:crow.pack.crow-night")).toBe("crow.pack.crow-night");
    expect(isImportedThemeId("imported:crow.pack.crow-night")).toBe(true);
    for (const key of ["crow.pack.night", "pirate-crow", "a".repeat(160)]) expect(isThemeKey(key)).toBe(true);
    for (const key of ["", ".hidden", "-lead", "Upper", "a/b", "a\\b", "a b", "a".repeat(161), "../x"]) expect(isThemeKey(key)).toBe(false);
    expect(importedThemeSlug("imported:a/b")).toBeUndefined();
    expect(parseImportedSummary({ ...PIRATE, slug: "crow.pack.crow-night" })?.slug).toBe("crow.pack.crow-night");
    expect(parseImportedSummary({ ...PIRATE, slug: "../x" })).toBeUndefined();
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

test("a theme import refreshes the extension list only when it installed a theme", async () => {
    let reads = 0;
    let imported = false;
    const bridge = {
        ...bridgeAnswering({ run: () => done(imported ? [PIRATE] : []) }),
        listDesktopExtensions: async () => {
            reads += 1;
            return { ok: true as const, extensions: [], themes: [PIRATE] };
        },
    } as DesktopBridge;
    await reported("vera.crow.import", bridge);
    expect(reads).toBe(0);
    imported = true;
    await reported("vera.crow.import", bridge);
    expect(reads).toBe(1);
    expect(desktopExtensions()).toEqual([]);
});

test("a closed file picker changes nothing and reports nothing", async () => {
    setImportedThemes([PIRATE]);
    applyTheme("light");
    expect(await reported("vera.crow.import", bridgeAnswering({ run: () => done([], [PIRATE]) }))).toEqual([]);
    expect(page.attributes.get("data-theme")).toBe("light");
});

test("@core a command run without a desktop bridge, or when the bridge throws, leaves the theme alone", async () => {
    expect(await reported("vera.crow.import", undefined)).toEqual([{ ok: false, message: "Importing a theme needs the desktop app. Your theme is unchanged." }]);
    const throwing = { runExtensionCommand: async () => { throw new Error("ipc closed"); } } as unknown as DesktopBridge;
    expect(await reported("vera.crow.import", throwing)).toEqual([{ ok: false, message: "Vera could not import that theme. Your theme is unchanged." }]);
    expect(page.attributes.size).toBe(0);
});

test("@core a themes answer switches to the imported theme and reports it, and a refusal gives its reason", async () => {
    const bridge = bridgeAnswering({ run: (command) => command === "vera.crow.refuse" ? { ok: false, reason: "The file is not valid JSON." } : done([NEST]) });
    const imported = await reported("vera.crow.import", bridge);
    expect(imported).toEqual([{ ok: true, message: "Imported \"Crow Nest\" and switched to it." }]);
    expect(page.attributes.get("data-theme")).toBe("imported:crow-nest");
    expect(await reported("vera.crow.refuse", bridge)).toEqual([{ ok: false, message: "The file is not valid JSON. Your theme is unchanged." }]);
    expect(page.attributes.get("data-theme")).toBe("imported:crow-nest");
});

test("@core a list answer opens the picker with the keys and labels only, and choosing runs the command again with that key", async () => {
    const asked: [string, string | undefined][] = [];
    const bridge = bridgeAnswering({
        run: (command, pick) => {
            asked.push([command, pick]);
            if (pick !== undefined) return done([NEST]);
            return { ok: true, kind: "pick", title: "Themes installed in VS Code", items: [{ key: "pick-0", label: "Crow Nest", detail: "Crow Pack" }, { key: "pick-1", label: "Pirate Crow" }], cut: true };
        },
    });
    const reports: ImportReport[] = [];
    await runExtensionCommand("vera.crow.installed", (outcome) => reports.push(outcome), bridge);
    const picker = openedPicker();
    expect(picker?.title).toBe("Themes installed in VS Code");
    expect(picker?.cut).toBe(true);
    expect(picker?.items).toEqual([{ key: "pick-0", label: "Crow Nest", detail: "Crow Pack" }, { key: "pick-1", label: "Pirate Crow" }]);
    expect(reports).toEqual([]);
    expect(page.attributes.size).toBe(0);

    picker?.choose("pick-0");
    await Bun.sleep(0);
    expect(asked).toEqual([["vera.crow.installed", undefined], ["vera.crow.installed", "pick-0"]]);
    expect(reports).toEqual([{ ok: true, message: "Imported \"Crow Nest\" and switched to it." }]);
    expect(page.attributes.get("data-theme")).toBe("imported:crow-nest");
});

test("the picker is closed by closing the overlay, and one overlay at a time stays open", async () => {
    const bridge = bridgeAnswering({ run: () => ({ ok: true, kind: "pick", title: "Crow themes", items: [], cut: false }) });
    await runExtensionCommand("vera.crow.installed", () => {}, bridge);
    expect(openedPicker()?.title).toBe("Crow themes");
    expect(openedOverlay()).toBeUndefined();
    closeOverlay();
    expect(openedPicker()).toBeUndefined();
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

test("@core each imported theme has a palette command, and the theme commands hold nothing of an extension", () => {
    const registry = new CommandRegistry();
    const applied: string[] = [];
    const dispose = registerThemeCommands(registry, (choice) => applied.push(choice), [PIRATE, NEST]);
    expect(registry.list().map((command) => [command.id, command.title]).sort()).toEqual([
        ...THEME_NAMES.map((name) => [THEME_COMMANDS[name], `Theme: ${name === "high-contrast" ? "High Contrast" : THEME_LABELS[name]}`]),
        ["theme.imported.crow-nest", "Theme: Crow Nest"],
        ["theme.imported.pirate-crow", "Theme: Pirate Crow"],
    ].sort());
    registry.execute(importedThemeCommand("crow-nest"));
    expect(applied).toEqual(["imported:crow-nest"]);
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
