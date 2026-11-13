import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadTheme } from "../../clients/desktop/src/theme-import/chain.ts";
import { slugOf } from "../../clients/desktop/src/theme-import/convert.ts";
import { importThemeFile } from "../../clients/desktop/src/theme-import/import-theme.ts";
import { diskSource, MAX_FILE_BYTES } from "../../clients/desktop/src/theme-import/source.ts";
import { MAX_SAVED_THEMES, ThemeStore, themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { baseColor, parseImportedTheme } from "../../clients/ui/src/theme/imported.ts";
import { PIRATE_CROW, pirateCrowText, removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

function trial(): { home: string; store: ThemeStore; files: string } {
    const home = scratchDirectory();
    return { home, store: new ThemeStore(themesDirectory(home)), files: scratchDirectory() };
}

function reason(outcome: ReturnType<typeof importThemeFile>): string {
    if (outcome.ok) throw new Error("Expected a refusal.");
    return outcome.reason;
}

test("@core a theme file lands beside layout.json under the home and keeps its token rules", () => {
    const { home, store, files } = trial();
    const outcome = importThemeFile(store, writeText(join(files, "pirate-crow.json"), pirateCrowText()));
    expect(outcome.ok && outcome.imported.map((theme) => theme.name)).toEqual(["Pirate Crow"]);
    expect(themesDirectory(home)).toBe(join(home, "machine", "desktop", "themes"));
    expect(readdirSync(themesDirectory(home))).toEqual(["pirate-crow.json"]);
    const saved = parseImportedTheme(JSON.parse(readFileSync(join(themesDirectory(home), "pirate-crow.json"), "utf8")));
    expect(saved?.colors.surface).toBe("#10131a");
    expect(saved?.type).toBe("dark");
    expect(saved?.source).toBe("File pirate-crow.json");
    expect(saved?.tokenColors).toEqual(PIRATE_CROW.tokenColors);
    expect(saved?.semanticTokenColors).toEqual(PIRATE_CROW.semanticTokenColors);
});

test("@core importing the same theme again replaces its file", () => {
    const { home, store, files } = trial();
    const path = join(files, "crow.json");
    writeText(path, pirateCrowText());
    importThemeFile(store, path);
    writeFileSync(path, pirateCrowText({ colors: { "editor.background": "#202830" } }));
    const outcome = importThemeFile(store, path);
    expect(outcome.ok).toBe(true);
    expect(readdirSync(themesDirectory(home))).toEqual(["pirate-crow.json"]);
    expect(store.list().map((theme) => theme.colors.surface)).toEqual(["#202830"]);
});

test("a file without a name takes its file name", () => {
    const { store, files } = trial();
    const outcome = importThemeFile(store, writeText(join(files, "Black Flag.jsonc"), JSON.stringify({ colors: { "editor.background": "#050505" } })));
    expect(outcome.ok && outcome.imported[0]?.name).toBe("Black Flag");
    expect(store.slugs()).toEqual(["black-flag"]);
});

test("@core an include chain merges as VS Code does", () => {
    const { files } = trial();
    writeText(join(files, "base.json"), JSON.stringify({
        type: "light",
        colors: { "editor.background": "#ffffff", foreground: "#111111", focusBorder: "#0000ff" },
        tokenColors: [{ scope: "comment", settings: { foreground: "#999999" } }],
        semanticTokenColors: { parameter: "#aaaaaa", variable: "#bbbbbb" },
    }));
    writeText(join(files, "themes", "mid.json"), JSON.stringify({
        include: "../base.json",
        colors: { foreground: "#222222" },
        tokenColors: [{ scope: "string", settings: { foreground: "#00aa00" } }],
        semanticTokenColors: { parameter: "#cccccc" },
    }));
    const top = writeText(join(files, "themes", "top.json"), JSON.stringify({
        name: "Crow Nest",
        include: "./mid.json",
        colors: { focusBorder: "#ff0000" },
    }));
    const loaded = loadTheme(diskSource, top);
    expect(loaded.name).toBe("Crow Nest");
    expect(loaded.type).toBe("light");
    expect(loaded.colors).toEqual({ "editor.background": "#ffffff", foreground: "#222222", focusBorder: "#ff0000" });
    expect(loaded.tokenColors).toEqual([
        { scope: "comment", settings: { foreground: "#999999" } },
        { scope: "string", settings: { foreground: "#00aa00" } },
    ]);
    expect(loaded.semanticTokenColors).toEqual({ parameter: "#cccccc", variable: "#bbbbbb" });
});

test("an included theme supplies the type, and the leaf's tokens it leaves out derive against Light", () => {
    const { store, files } = trial();
    writeText(join(files, "base.json"), JSON.stringify({ type: "light", colors: { "editor.background": "#ffffff" } }));
    const outcome = importThemeFile(store, writeText(join(files, "leaf.json"), JSON.stringify({ name: "Crow Leaf", include: "base.json", colors: { foreground: "#222222" } })));
    expect(outcome.ok).toBe(true);
    const saved = store.list()[0];
    expect(saved?.type).toBe("light");
    expect(saved?.colors.surface).toBe("#ffffff");
    expect(saved?.colors["surface-hover"]).toBe("#f1f1f1");
    expect(saved?.colors.focus).toBe(baseColor("light", "focus"));
});

test("@core a file that does not parse is refused with the reason and nothing is saved", () => {
    const { home, store, files } = trial();
    const outcome = importThemeFile(store, writeText(join(files, "broken.json"), "{ \"colors\": { "));
    expect(reason(outcome)).toMatch(/^The file is not valid JSON/);
    expect(existsSync(themesDirectory(home))).toBe(false);
});

test("@core a file that sets none of the mapped colors is refused", () => {
    const { store, files } = trial();
    const outcome = importThemeFile(store, writeText(join(files, "plain.json"), JSON.stringify({ name: "Plain Crow", colors: { "editor.findMatchBackground": "#ff0000" } })));
    expect(reason(outcome)).toContain("\"Plain Crow\" sets none of the colors Vera reads");
    expect(store.slugs()).toEqual([]);
});

test("a JSON file that is not an object, or has no colors at all, is refused", () => {
    const { store, files } = trial();
    expect(reason(importThemeFile(store, writeText(join(files, "list.json"), "[1, 2]")))).toContain("does not hold a JSON object");
    expect(reason(importThemeFile(store, writeText(join(files, "empty.json"), "{}")))).toContain("sets none of the colors Vera reads");
});

test("@core an include cycle, a missing include and a bad include are refused", () => {
    const { store, files } = trial();
    writeText(join(files, "a.json"), JSON.stringify({ include: "b.json", colors: { "editor.background": "#000000" } }));
    writeText(join(files, "b.json"), JSON.stringify({ include: "a.json" }));
    expect(reason(importThemeFile(store, join(files, "a.json")))).toContain("which includes it back");
    writeText(join(files, "c.json"), JSON.stringify({ include: "gone.json", colors: { "editor.background": "#000000" } }));
    expect(reason(importThemeFile(store, join(files, "c.json")))).toContain("Included file \"gone.json\"");
    writeText(join(files, "d.json"), JSON.stringify({ include: 7, colors: { "editor.background": "#000000" } }));
    expect(reason(importThemeFile(store, join(files, "d.json")))).toContain("include that is not a file path");
    writeText(join(files, "e.json"), JSON.stringify({ include: "broken.json", colors: { "editor.background": "#000000" } }));
    writeText(join(files, "broken.json"), "{");
    expect(reason(importThemeFile(store, join(files, "e.json")))).toMatch(/^Included file "broken.json": The file is not valid JSON/);
});

test("an include chain nested too deep is refused", () => {
    const { store, files } = trial();
    for (let index = 0; index < 12; index += 1) {
        writeText(join(files, `link-${index}.json`), JSON.stringify({ include: `link-${index + 1}.json`, colors: { "editor.background": "#000000" } }));
    }
    writeText(join(files, "link-12.json"), JSON.stringify({ colors: { "editor.background": "#000000" } }));
    expect(reason(importThemeFile(store, join(files, "link-0.json")))).toContain("nested more than 8 deep");
});

test("@core files that are missing, too large or of another kind are refused", () => {
    const { store, files } = trial();
    expect(reason(importThemeFile(store, join(files, "missing.json")))).toContain("could not open");
    writeText(join(files, "huge.json"), `{ "name": "${"x".repeat(MAX_FILE_BYTES)}" }`);
    expect(reason(importThemeFile(store, join(files, "huge.json")))).toContain("larger than 2 MiB");
    writeText(join(files, "crow.tmTheme"), "<plist></plist>");
    expect(reason(importThemeFile(store, join(files, "crow.tmTheme")))).toBe("Choose a .json theme file or a .vsix extension package.");
    expect(reason(importThemeFile(store, files))).toBe("Choose a .json theme file or a .vsix extension package.");
});

test("the store refuses a theme past the saved limit but still replaces an existing one", () => {
    const { store, files } = trial();
    for (let index = 0; index < MAX_SAVED_THEMES; index += 1) {
        const outcome = importThemeFile(store, writeText(join(files, `t${index}.json`), pirateCrowText({ name: `Crow ${index}` })));
        expect(outcome.ok).toBe(true);
    }
    expect(store.slugs()).toHaveLength(MAX_SAVED_THEMES);
    expect(reason(importThemeFile(store, writeText(join(files, "extra.json"), pirateCrowText({ name: "One Crow Too Many" }))))).toContain(`at most ${MAX_SAVED_THEMES}`);
    expect(importThemeFile(store, join(files, "t5.json")).ok).toBe(true);
});

test("the store lists summaries by name, skips unreadable files and ignores other names", () => {
    const { home, store, files } = trial();
    importThemeFile(store, writeText(join(files, "b.json"), pirateCrowText({ name: "Raven Deck" })));
    importThemeFile(store, writeText(join(files, "a.json"), pirateCrowText({ name: "Albatross" })));
    writeText(join(themesDirectory(home), "broken.json"), "not json");
    writeText(join(themesDirectory(home), "Mismatch.json"), pirateCrowText());
    writeText(join(themesDirectory(home), "wrong-slug.json"), JSON.stringify({ ...PIRATE_CROW, version: 1, slug: "another", name: "Wrong Slug", type: "dark", source: "", colors: {}, values: {} }));
    writeText(join(themesDirectory(home), "notes.txt"), "x");
    expect(store.list().map((theme) => theme.name)).toEqual(["Albatross", "Raven Deck"]);
    expect(store.has("albatross")).toBe(true);
    expect(store.has("../albatross")).toBe(false);
    expect(store.has("mismatch")).toBe(false);
});

test("names become safe file names", () => {
    expect(slugOf("Pirate Crow")).toBe("pirate-crow");
    expect(slugOf("  Crème Brûlée / Dark!  ")).toBe("creme-brulee-dark");
    expect(slugOf("../../etc/passwd")).toBe("etc-passwd");
    expect(slugOf("日本語")).toBe("theme");
    expect(slugOf("x".repeat(200)).length).toBeLessThanOrEqual(64);
});
