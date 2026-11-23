import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { migrateSavedThemes } from "../../clients/desktop/src/extensions/migrate.ts";
import { extensionsDirectory, extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";
import { ThemeService } from "../../clients/desktop/src/theme-service.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { savedTheme } from "./extension-fixtures.ts";
import { removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

function storeFor(home: string): ExtensionStore {
    return new ExtensionStore(home, new ExtensionStateStore(extensionStatePath(home)));
}

function saveOld(home: string, name: string): string {
    const saved = savedTheme(name);
    writeText(join(themesDirectory(home), `${saved.slug}.json`), saved.text);
    return saved.slug;
}

test("@core each saved theme moves into an extension of its own and the old file is removed", () => {
    const home = scratchDirectory();
    const night = saveOld(home, "Crow Night");
    const day = saveOld(home, "Crow Day");
    const store = storeFor(home);
    expect(migrateSavedThemes(store, themesDirectory(home))).toEqual({ moved: 2, kept: 0 });
    expect(store.entries().map((entry) => [entry.id, entry.version, entry.themes])).toEqual([
        [`imported.${day}`, "1.0.0", ["Crow Day"]],
        [`imported.${night}`, "1.0.0", ["Crow Night"]],
    ]);
    expect(store.themes().map((theme) => theme.slug)).toEqual([day, night]);
    expect(existsSync(themesDirectory(home))).toBe(false);
    expect(readdirSync(extensionsDirectory(home)).filter((name) => name.startsWith("."))).toEqual([]);
});

test("@core the theme keeps the key a stored choice already points at, and the file bytes", () => {
    const home = scratchDirectory();
    const slug = saveOld(home, "Crow Night");
    const before = readFileSync(join(themesDirectory(home), `${slug}.json`), "utf8");
    const store = storeFor(home);
    migrateSavedThemes(store, themesDirectory(home));
    expect(store.themes().map((theme) => theme.slug)).toEqual([slug]);
    expect(readFileSync(join(extensionsDirectory(home), `imported.${slug}`, "themes", `${slug}.json`), "utf8")).toBe(before);
});

test("@core running it again changes nothing, and finishes a move that stopped before the old file was removed", () => {
    const home = scratchDirectory();
    const slug = saveOld(home, "Crow Night");
    const store = storeFor(home);
    migrateSavedThemes(store, themesDirectory(home));
    expect(migrateSavedThemes(store, themesDirectory(home))).toEqual({ moved: 0, kept: 0 });
    const text = readFileSync(join(extensionsDirectory(home), `imported.${slug}`, "themes", `${slug}.json`), "utf8");
    writeText(join(themesDirectory(home), `${slug}.json`), text);
    expect(migrateSavedThemes(store, themesDirectory(home))).toEqual({ moved: 1, kept: 0 });
    expect(existsSync(join(themesDirectory(home), `${slug}.json`))).toBe(false);
    expect(store.entries()).toHaveLength(1);
});

test("@core a file that does not read stays where it is, and the others still move", () => {
    const home = scratchDirectory();
    const good = saveOld(home, "Crow Night");
    writeText(join(themesDirectory(home), "broken.json"), "not json");
    writeText(join(themesDirectory(home), "mismatch.json"), readFileSync(join(themesDirectory(home), `${good}.json`), "utf8"));
    const store = storeFor(home);
    expect(migrateSavedThemes(store, themesDirectory(home))).toEqual({ moved: 1, kept: 2 });
    expect(store.entries().map((entry) => entry.id)).toEqual([`imported.${good}`]);
    expect(readdirSync(themesDirectory(home)).sort()).toEqual(["broken.json", "mismatch.json"]);
});

test("@core when the extension cannot be installed the old file stays and the theme is still listed", () => {
    const home = scratchDirectory();
    const slug = saveOld(home, "Crow Night");
    const store = storeFor(home);
    const root = extensionsDirectory(home);
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o500);
    try {
        const result = migrateSavedThemes(store, themesDirectory(home));
        expect(result.moved).toBe(0);
        expect(result.kept).toBe(1);
    } finally {
        chmodSync(root, 0o700);
    }
    expect(existsSync(join(themesDirectory(home), `${slug}.json`))).toBe(true);
    const service = new ThemeService(store, themesDirectory(home));
    expect(service.load().map((theme) => theme.slug)).toEqual([slug]);
});

test("a theme saved under the old folder is listed by the service until it moves, then once", () => {
    const home = scratchDirectory();
    const slug = saveOld(home, "Crow Night");
    const store = storeFor(home);
    const service = new ThemeService(store, themesDirectory(home));
    expect(service.load().map((theme) => theme.slug)).toEqual([slug]);
    migrateSavedThemes(store, themesDirectory(home));
    expect(service.load().map((theme) => theme.slug)).toEqual([slug]);
});

test("a home with nothing saved migrates nothing and creates nothing", () => {
    const home = scratchDirectory();
    expect(migrateSavedThemes(storeFor(home), themesDirectory(home))).toEqual({ moved: 0, kept: 0 });
    expect(existsSync(extensionsDirectory(home))).toBe(false);
});

test("a stray file in the old folder is left alone with its folder", () => {
    const home = scratchDirectory();
    saveOld(home, "Crow Night");
    writeFileSync(join(themesDirectory(home), "notes.txt"), "x");
    migrateSavedThemes(storeFor(home), themesDirectory(home));
    expect(readdirSync(themesDirectory(home))).toEqual(["notes.txt"]);
});

test("a legacy theme with sparse colors migrates into an extension", () => {
    const home = scratchDirectory();
    const file = join(themesDirectory(home), "legacy-crow.json");
    writeText(file, JSON.stringify({
        version: 1,
        slug: "legacy-crow",
        name: "Legacy Crow",
        type: "dark",
        source: "Extension crow.pack",
        colors: { surface: "#202830" },
        values: {},
        tokenColors: [],
        semanticTokenColors: {},
    }));
    const store = storeFor(home);
    expect(migrateSavedThemes(store, themesDirectory(home))).toEqual({ moved: 1, kept: 0 });
    expect(store.entries().map((entry) => entry.id)).toEqual(["imported.legacy-crow"]);
    expect(existsSync(file)).toBe(false);
});
