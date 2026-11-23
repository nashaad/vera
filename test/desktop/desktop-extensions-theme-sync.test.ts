import { afterEach, beforeEach, expect, test } from "bun:test";

import {
    CHANGE_FAILED,
    installExtension,
    LIST_FAILED,
    PACKAGE_UNREAD,
    previewExtension,
    readExtensions,
    removeExtension,
    toggleExtension,
} from "../../clients/ui/src/customize/desktop-extensions.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import type { DesktopExtensionEntry, ExtensionChangeResult } from "../../clients/ui/src/protocol/extensions.ts";
import { importedThemes, setImportedThemes } from "../../clients/ui/src/theme/imported-registry.ts";
import type { ImportedThemeSummary } from "../../clients/ui/src/theme/imported.ts";
import { storeTheme, readStoredTheme, readThemeCache } from "../../clients/ui/src/theme/storage.ts";
import { applyThemeList } from "../../clients/ui/src/theme/sync.ts";
import { importedThemeId } from "../../clients/ui/src/theme/tokens.ts";
import { mapColors } from "../../extensions/vscode-theme-import/color-map.ts";
import { PIRATE_CROW } from "./theme-fixtures.ts";

const DARK_THEME: ImportedThemeSummary = {
    slug: "crow.pack.crow-night",
    name: "Crow Night",
    type: "dark",
    source: "File crow-night.json",
    colors: mapColors(PIRATE_CROW.colors, "dark").colors,
    values: {},
};
const LIGHT_THEME: ImportedThemeSummary = { ...DARK_THEME, slug: "crow.pack.crow-day", name: "Crow Day", type: "light" };
const OTHER_THEME: ImportedThemeSummary = { ...DARK_THEME, slug: "other.pack.ash", name: "Ash" };

interface Page {
    attributes: Map<string, string>;
    storage: Map<string, string>;
}

let page: Page;

beforeEach(() => {
    page = { attributes: new Map(), storage: new Map() };
    const root = {
        setAttribute: (name: string, value: string) => void page.attributes.set(name, value),
        style: { setProperty: () => undefined },
    };
    const globals = globalThis as Record<string, unknown>;
    globals.document = { documentElement: root };
    globals.getComputedStyle = () => ({ getPropertyValue: () => "" });
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

function entry(id: string, overrides: Partial<DesktopExtensionEntry> = {}): DesktopExtensionEntry {
    return { id, version: "1.0.0", themes: ["Crow Night"], hasMain: false, hasCommands: false, commands: [], menus: { appearance: [], theme: [], browser: [] }, included: false, enabled: true, ...overrides, hasUnavailableContributions: overrides.hasUnavailableContributions ?? false };
}

function listed(extensions: DesktopExtensionEntry[], themes: ImportedThemeSummary[]): ExtensionChangeResult {
    return { ok: true, extensions, themes };
}

function bridgeAnswering(answer: Partial<Record<"list" | "install" | "enable" | "remove", ExtensionChangeResult | Error>>): DesktopBridge {
    const reply = (value: ExtensionChangeResult | Error | undefined): Promise<ExtensionChangeResult> =>
        value instanceof Error || value === undefined ? Promise.reject(value ?? new Error("no answer")) : Promise.resolve(value);
    return {
        setWindowBackground: () => undefined,
        setTheme: () => undefined,
        listDesktopExtensions: () => reply(answer.list),
        installDesktopExtension: () => reply(answer.install),
        setDesktopExtensionEnabled: () => reply(answer.enable),
        removeDesktopExtension: () => reply(answer.remove),
    } as unknown as DesktopBridge;
}

test("@core a stored theme whose extension is removed falls back to the built-in theme of its type", () => {
    setImportedThemes([DARK_THEME, LIGHT_THEME]);
    storeTheme(importedThemeId(LIGHT_THEME.slug));
    applyThemeList([DARK_THEME]);
    expect(readStoredTheme()).toBe("light");
    expect(page.attributes.get("data-theme")).toBe("light");
    expect(readThemeCache()).toBeUndefined();

    storeTheme(importedThemeId(DARK_THEME.slug));
    applyThemeList([]);
    expect(readStoredTheme()).toBe("dark");
    expect(importedThemes()).toEqual([]);
});

test("a stored theme that is still offered is applied again with the colors it has now", () => {
    setImportedThemes([DARK_THEME]);
    storeTheme(importedThemeId(DARK_THEME.slug));
    applyThemeList([{ ...DARK_THEME, colors: { ...DARK_THEME.colors, surface: "#102030" } }, OTHER_THEME]);
    expect(readStoredTheme()).toBe("imported:crow.pack.crow-night");
    expect(page.attributes.get("data-theme")).toBe("imported:crow.pack.crow-night");
    expect(importedThemes().map((theme) => theme.slug)).toEqual(["crow.pack.crow-night", "other.pack.ash"]);
});

test("@core at launch the type of a missing theme comes from the page-head cache", () => {
    page.storage.set("vera.theme", "imported:crow.pack.crow-day");
    page.storage.set("vera.theme.imported", JSON.stringify(LIGHT_THEME));
    expect(importedThemes()).toEqual([]);
    applyThemeList([DARK_THEME]);
    expect(readStoredTheme()).toBe("light");
});

test("a missing theme with no cache falls back to the default, and a built-in choice is left alone", () => {
    page.storage.set("vera.theme", "imported:crow.pack.crow-day");
    applyThemeList([]);
    expect(readStoredTheme()).toBe("dark");

    page.attributes.clear();
    page.storage.set("vera.theme", "high-contrast");
    applyThemeList([DARK_THEME]);
    expect(readStoredTheme()).toBe("high-contrast");
    expect(page.attributes.size).toBe(0);
});

test("a cache for another theme does not decide the fallback", () => {
    page.storage.set("vera.theme", "imported:crow.pack.crow-day");
    page.storage.set("vera.theme.imported", JSON.stringify({ ...LIGHT_THEME, slug: "other.pack.ash" }));
    applyThemeList([]);
    expect(readStoredTheme()).toBe("dark");
});

test("@core turning an extension off or removing it applies the themes the shell answers with", async () => {
    setImportedThemes([DARK_THEME, LIGHT_THEME]);
    storeTheme(importedThemeId(LIGHT_THEME.slug));
    const off = await toggleExtension(bridgeAnswering({ enable: listed([entry("crow.pack", { enabled: false })], []) }), "crow.pack", false);
    expect(off.ok).toBe(true);
    expect(readStoredTheme()).toBe("light");
    expect(importedThemes()).toEqual([]);

    setImportedThemes([OTHER_THEME]);
    storeTheme(importedThemeId(OTHER_THEME.slug));
    const removed = await removeExtension(bridgeAnswering({ remove: listed([], []) }), "other.pack");
    expect(removed.ok).toBe(true);
    expect(readStoredTheme()).toBe("dark");
});

test("an install offers its themes without changing the stored choice", async () => {
    storeTheme("light");
    const result = await installExtension(bridgeAnswering({ install: listed([entry("crow.pack")], [DARK_THEME]) }), "token");
    expect(result.ok && result.extensions.map((item) => item.id)).toEqual(["crow.pack"]);
    expect(importedThemes().map((theme) => theme.slug)).toEqual(["crow.pack.crow-night"]);
    expect(readStoredTheme()).toBe("light");
});

test("a refusal leaves the themes as they were, and a failed request reads as one", async () => {
    setImportedThemes([DARK_THEME]);
    storeTheme(importedThemeId(DARK_THEME.slug));
    const refused = await removeExtension(bridgeAnswering({ remove: { ok: false, reason: "Vera could not remove \"crow.pack\"." } }), "crow.pack");
    expect(refused).toEqual({ ok: false, reason: "Vera could not remove \"crow.pack\"." });
    expect(readStoredTheme()).toBe("imported:crow.pack.crow-night");
    expect(await removeExtension(bridgeAnswering({ remove: new Error("ipc closed") }), "crow.pack")).toEqual({ ok: false, reason: CHANGE_FAILED });
    expect(await installExtension(bridgeAnswering({ install: new Error("ipc closed") }), "token")).toEqual({ ok: false, reason: CHANGE_FAILED });
    expect(await readExtensions(bridgeAnswering({ list: new Error("ipc closed") }))).toEqual({ ok: false, reason: LIST_FAILED });
    const closed = { previewDesktopExtension: () => Promise.reject(new Error("ipc closed")) } as unknown as DesktopBridge;
    expect(await previewExtension(closed)).toEqual({ ok: false, reason: PACKAGE_UNREAD });
});

test("reading the list does not touch the theme", async () => {
    storeTheme("light");
    const result = await readExtensions(bridgeAnswering({ list: listed([entry("crow.pack")], [DARK_THEME]) }));
    expect(result.ok).toBe(true);
    expect(importedThemes()).toEqual([]);
    expect(page.attributes.size).toBe(0);
});


