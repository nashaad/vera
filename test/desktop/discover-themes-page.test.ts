import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { mapColors } from "../../extensions/vscode-theme-import/color-map.ts";
import { DiscoverThemesView } from "../../clients/ui/src/customize/DiscoverThemes.tsx";
import {
    CATALOG_UNREACHABLE,
    DOWNLOAD_FAILED,
    previewCatalogTheme,
    readCatalog,
    restoreSnapshot,
    showPreview,
    snapshotTheme,
} from "../../clients/ui/src/customize/discover-themes.ts";
import type { DiscoverThemesState } from "../../clients/ui/src/customize/useDiscoverThemes.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import type { CatalogPreview, CatalogTheme } from "../../clients/ui/src/protocol/extension-catalog.ts";
import { importedThemes, setImportedThemes } from "../../clients/ui/src/theme/imported-registry.ts";
import type { ImportedThemeSummary } from "../../clients/ui/src/theme/imported.ts";
import { readStoredTheme, storeTheme } from "../../clients/ui/src/theme/storage.ts";
import { importedThemeId } from "../../clients/ui/src/theme/tokens.ts";
import { PIRATE_CROW } from "./theme-fixtures.ts";

const CROW: ImportedThemeSummary = {
    slug: "crow.pack.crow-night",
    name: "Crow Night",
    type: "dark",
    source: "File crow-night.json",
    colors: mapColors(PIRATE_CROW.colors, "dark").colors,
    values: {},
};
const ASH: ImportedThemeSummary = { ...CROW, slug: "other.pack.ash", name: "Ash" };
const PALETTE = ["#07080a", "#deddd7", "#e8582a", "#6fe3d4", "#ff5f56"];

const attributes = new Map<string, string>();
const storage = new Map<string, string>();

beforeEach(() => {
    attributes.clear();
    storage.clear();
    const root = { setAttribute: (name: string, value: string) => void attributes.set(name, value), style: { setProperty: () => undefined } };
    const globals = globalThis as Record<string, unknown>;
    globals.document = { documentElement: root };
    globals.getComputedStyle = () => ({ getPropertyValue: () => "" });
    globals.window = {
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => void storage.set(key, value),
            removeItem: (key: string) => void storage.delete(key),
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

test("@core a preview applies the theme without storing it, and restoring puts the previous theme back", () => {
    setImportedThemes([ASH]);
    storeTheme(importedThemeId(ASH.slug));
    const before = snapshotTheme();

    showPreview(CROW, before);
    expect(attributes.get("data-theme")).toBe("imported:crow.pack.crow-night");
    expect(importedThemes().map((theme) => theme.slug)).toEqual(["other.pack.ash", "crow.pack.crow-night"]);
    expect(readStoredTheme()).toBe("imported:other.pack.ash");

    restoreSnapshot(before);
    expect(attributes.get("data-theme")).toBe("imported:other.pack.ash");
    expect(importedThemes().map((theme) => theme.slug)).toEqual(["other.pack.ash"]);
    expect(readStoredTheme()).toBe("imported:other.pack.ash");
});

test("@core previewing a theme that replaces an installed one swaps it in and restores the old one", () => {
    setImportedThemes([CROW]);
    storeTheme("light");
    const before = snapshotTheme();
    showPreview({ ...CROW, colors: { ...CROW.colors, surface: "#102030" } }, before);
    expect(importedThemes()).toHaveLength(1);
    expect(importedThemes()[0]?.colors.surface).toBe("#102030");
    restoreSnapshot(before);
    expect(importedThemes()).toEqual([CROW]);
    expect(attributes.get("data-theme")).toBe("light");
    expect(readStoredTheme()).toBe("light");
});

test("a bridge that fails reads as a failed request with the catalog's wording", async () => {
    const closed = {
        openExtensionCatalog: () => Promise.reject(new Error("ipc closed")),
        previewCatalogTheme: () => Promise.reject(new Error("ipc closed")),
    } as unknown as DesktopBridge;
    expect(await readCatalog(closed)).toEqual({ ok: false, reason: CATALOG_UNREACHABLE });
    expect(await previewCatalogTheme(closed, "crow.pack")).toEqual({ ok: false, reason: DOWNLOAD_FAILED });
});

function theme(id: string, overrides: Partial<CatalogTheme> = {}): CatalogTheme {
    return { id, name: "Crow Night", version: "1.0.0", palette: PALETTE, installed: false, ...overrides };
}

function state(overrides: Partial<DiscoverThemesState>): DiscoverThemesState {
    const none = (): void => undefined;
    return {
        list: { phase: "ready", themes: [] },
        fetching: undefined,
        preview: undefined,
        keeping: false,
        failure: undefined,
        start: none,
        keep: none,
        cancel: none,
        retry: none,
        ...overrides,
    };
}

function render(overrides: Partial<DiscoverThemesState>): string {
    return renderToStaticMarkup(createElement(DiscoverThemesView, { state: state(overrides) }));
}

test("@core each theme shows its name, version, swatches and Install, and an installed one says Installed", () => {
    const html = render({ list: { phase: "ready", themes: [theme("crow.pack"), theme("crow.two", { name: "Two", version: "2.0.0", installed: true })] } });
    expect(html).toContain('data-catalog-theme="crow.pack"');
    expect(html).toContain('data-catalog-install="crow.pack"');
    expect(html).toContain("Crow Night");
    expect(html).toContain("1.0.0");
    for (const color of PALETTE) expect(html).toContain(`background:${color}`);
    expect(html).toContain("data-catalog-installed");
    expect(html).toContain("Installed");
    expect(html).not.toContain('data-catalog-install="crow.two"');
});

test("loading, unavailable, failed and empty each say so", () => {
    expect(render({ list: { phase: "loading" } })).toContain("Reading the catalog…");
    expect(render({ list: { phase: "unavailable" } })).toContain("The catalog is not available in this build.");
    const failed = render({ list: { phase: "failed", reason: CATALOG_UNREACHABLE } });
    expect(failed).toContain(CATALOG_UNREACHABLE);
    expect(failed).toContain("data-catalog-retry");
    expect(render({})).toContain("The catalog has no themes for this version of Vera.");
});

test("a download in progress and a refused download show on the card and above it", () => {
    const list = { phase: "ready", themes: [theme("crow.pack"), theme("crow.two", { name: "Two" })] } as const;
    const fetching = render({ list, fetching: "crow.pack" });
    expect(fetching).toContain("Downloading…");
    expect(fetching.match(/disabled=""/g)).toHaveLength(2);
    const failure = render({ list, failure: "The package does not match its expected checksum." });
    expect(failure).toContain("The package does not match its expected checksum.");
    expect(failure).toContain('data-tone="danger"');
});

test("a preview offers Install and Cancel, and says what it replaces", () => {
    const list = { phase: "ready", themes: [theme("crow.pack")] } as const;
    const preview: CatalogPreview = { token: "t", id: "crow.pack", name: "Crow Night", version: "2.0.0", replaces: "1.0.0", themes: [CROW] };
    const html = render({ list, preview });
    expect(html).toContain('data-catalog-bar="crow.pack"');
    expect(html).toContain("Previewing Crow Night 2.0.0.");
    expect(html).toContain("Replaces version 1.0.0.");
    expect(html).toContain("data-catalog-keep");
    expect(html).toContain("data-catalog-cancel");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-catalog-install/);
    expect(render({ list, preview: { ...preview, replaces: undefined } })).not.toContain("Replaces");
    const keeping = render({ list, preview, keeping: true });
    expect(keeping).toMatch(/<button[^>]*disabled=""[^>]*data-catalog-keep/);
    expect(keeping).toMatch(/<button[^>]*disabled=""[^>]*data-catalog-cancel/);
});
