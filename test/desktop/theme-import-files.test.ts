import { afterEach, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadTheme } from "../../clients/desktop/src/theme-import/chain.ts";
import { slugOf } from "../../clients/desktop/src/theme-import/convert.ts";
import { importThemeFile } from "../../clients/desktop/src/theme-import/import-theme.ts";
import { diskSource, MAX_FILE_BYTES } from "../../clients/desktop/src/theme-import/source.ts";
import { ReplyBudget } from "../../clients/desktop/src/theme-import/import-theme.ts";
import { MAX_THEME_BYTES, ThemeStore, themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { baseColor, type ImportedTheme } from "../../clients/ui/src/theme/imported.ts";
import { PIRATE_CROW, pirateCrowText, removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

function trial(): { files: string } {
    return { files: scratchDirectory() };
}

function reason(outcome: ReturnType<typeof importThemeFile>): string {
    if (outcome.ok) throw new Error("Expected a refusal.");
    return outcome.reason;
}

test("@core a theme file converts to a theme that keeps its token rules, and nothing is written", () => {
    const { files } = trial();
    const outcome = importThemeFile(writeText(join(files, "pirate-crow.json"), pirateCrowText()));
    expect(outcome.ok && outcome.themes.map((theme) => theme.name)).toEqual(["Pirate Crow"]);
    expect(readdirSync(files)).toEqual(["pirate-crow.json"]);
    const saved = outcome.ok ? outcome.themes[0] : undefined;
    expect(saved?.colors.surface).toBe("#10131a");
    expect(saved?.type).toBe("dark");
    expect(saved?.source).toBe("File pirate-crow.json");
    expect(saved?.tokenColors).toEqual(PIRATE_CROW.tokenColors);
    expect(saved?.semanticTokenColors).toEqual(PIRATE_CROW.semanticTokenColors);
});

test("@core importing the same file again converts it again, under the same slug", () => {
    const { files } = trial();
    const path = join(files, "crow.json");
    writeText(path, pirateCrowText());
    const first = importThemeFile(path);
    writeFileSync(path, pirateCrowText({ colors: { "editor.background": "#202830" } }));
    const second = importThemeFile(path);
    expect(first.ok && first.themes.map((theme) => [theme.slug, theme.colors.surface])).toEqual([["pirate-crow", "#10131a"]]);
    expect(second.ok && second.themes.map((theme) => [theme.slug, theme.colors.surface])).toEqual([["pirate-crow", "#202830"]]);
});

test("a file without a name takes its file name", () => {
    const { files } = trial();
    const outcome = importThemeFile(writeText(join(files, "Black Flag.jsonc"), JSON.stringify({ colors: { "editor.background": "#050505" } })));
    expect(outcome.ok && outcome.themes.map((theme) => [theme.name, theme.slug])).toEqual([["Black Flag", "black-flag"]]);
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
    const { files } = trial();
    writeText(join(files, "base.json"), JSON.stringify({ type: "light", colors: { "editor.background": "#ffffff" } }));
    const outcome = importThemeFile(writeText(join(files, "leaf.json"), JSON.stringify({ name: "Crow Leaf", include: "base.json", colors: { foreground: "#222222" } })));
    expect(outcome.ok).toBe(true);
    const saved = outcome.ok ? outcome.themes[0] : undefined;
    expect(saved?.type).toBe("light");
    expect(saved?.colors.surface).toBe("#ffffff");
    expect(saved?.colors["surface-hover"]).toBe("#f1f1f1");
    expect(saved?.colors.focus).toBe(baseColor("light", "focus"));
});

test("@core a file that does not parse is refused with the reason", () => {
    const { files } = trial();
    const outcome = importThemeFile(writeText(join(files, "broken.json"), "{ \"colors\": { "));
    expect(reason(outcome)).toMatch(/^The file is not valid JSON/);
});

test("@core a file that sets none of the mapped colors is refused", () => {
    const { files } = trial();
    const outcome = importThemeFile(writeText(join(files, "plain.json"), JSON.stringify({ name: "Plain Crow", colors: { "editor.findMatchBackground": "#ff0000" } })));
    expect(reason(outcome)).toContain("\"Plain Crow\" sets none of the colors Vera reads");
});

test("a JSON file that is not an object, or has no colors at all, is refused", () => {
    const { files } = trial();
    expect(reason(importThemeFile(writeText(join(files, "list.json"), "[1, 2]")))).toContain("does not hold a JSON object");
    expect(reason(importThemeFile(writeText(join(files, "empty.json"), "{}")))).toContain("sets none of the colors Vera reads");
});

test("@core an include cycle, a missing include and a bad include are refused", () => {
    const { files } = trial();
    writeText(join(files, "a.json"), JSON.stringify({ include: "b.json", colors: { "editor.background": "#000000" } }));
    writeText(join(files, "b.json"), JSON.stringify({ include: "a.json" }));
    expect(reason(importThemeFile(join(files, "a.json")))).toContain("which includes it back");
    writeText(join(files, "c.json"), JSON.stringify({ include: "gone.json", colors: { "editor.background": "#000000" } }));
    expect(reason(importThemeFile(join(files, "c.json")))).toContain("Included file \"gone.json\"");
    writeText(join(files, "d.json"), JSON.stringify({ include: 7, colors: { "editor.background": "#000000" } }));
    expect(reason(importThemeFile(join(files, "d.json")))).toContain("include that is not a file path");
    writeText(join(files, "e.json"), JSON.stringify({ include: "broken.json", colors: { "editor.background": "#000000" } }));
    writeText(join(files, "broken.json"), "{");
    expect(reason(importThemeFile(join(files, "e.json")))).toMatch(/^Included file "broken.json": The file is not valid JSON/);
});

test("an include chain nested too deep is refused", () => {
    const { files } = trial();
    for (let index = 0; index < 12; index += 1) {
        writeText(join(files, `link-${index}.json`), JSON.stringify({ include: `link-${index + 1}.json`, colors: { "editor.background": "#000000" } }));
    }
    writeText(join(files, "link-12.json"), JSON.stringify({ colors: { "editor.background": "#000000" } }));
    expect(reason(importThemeFile(join(files, "link-0.json")))).toContain("nested more than 8 deep");
});

test("@core files that are missing, too large or of another kind are refused", () => {
    const { files } = trial();
    expect(reason(importThemeFile(join(files, "missing.json")))).toContain("could not open");
    writeText(join(files, "huge.json"), `{ "name": "${"x".repeat(MAX_FILE_BYTES)}" }`);
    expect(reason(importThemeFile(join(files, "huge.json")))).toContain("larger than 2 MiB");
    writeText(join(files, "crow.tmTheme"), "<plist></plist>");
    expect(reason(importThemeFile(join(files, "crow.tmTheme")))).toBe("Choose a .json theme file or a .vsix extension package.");
    expect(reason(importThemeFile(files))).toBe("Choose a .json theme file or a .vsix extension package.");
});

test("a reply budget refuses a theme over the saved size and a reply over 16 MiB", () => {
    const outcome = importThemeFile(writeText(join(scratchDirectory(), "crow.json"), pirateCrowText()));
    const base = outcome.ok ? outcome.themes[0] : undefined;
    if (base === undefined) throw new Error("The fixture theme did not import.");
    const theme = (name: string, bytes: number): ImportedTheme => ({ ...base, name, source: "x".repeat(bytes) });
    const budget = new ReplyBudget();
    expect(() => budget.take(theme("Big Crow", MAX_THEME_BYTES))).toThrow(`"Big Crow" is larger than 2 MiB once saved.`);
    const each = MAX_THEME_BYTES - 4096;
    for (let count = 0; count < 8; count += 1) budget.take(theme(`Crow ${count}`, each));
    expect(() => budget.take(theme("Last Crow", each))).toThrow("This import already holds 16 MiB of themes.");
});

test("the legacy store lists summaries by name, skips unreadable files and ignores other names", () => {
    const home = scratchDirectory();
    const files = scratchDirectory();
    const store = new ThemeStore(themesDirectory(home));
    for (const [file, name] of [["b.json", "Raven Deck"], ["a.json", "Albatross"]] as const) {
        const outcome = importThemeFile(writeText(join(files, file), pirateCrowText({ name })));
        const theme = outcome.ok ? outcome.themes[0] : undefined;
        if (theme === undefined) throw new Error("The fixture theme did not import.");
        writeText(join(themesDirectory(home), `${theme.slug}.json`), JSON.stringify(theme));
    }
    writeText(join(themesDirectory(home), "broken.json"), "not json");
    writeText(join(themesDirectory(home), "Mismatch.json"), pirateCrowText());
    writeText(join(themesDirectory(home), "notes.txt"), "x");
    expect(store.slugs()).toEqual(["albatross", "broken", "raven-deck"]);
    expect(store.list().map((theme) => theme.name)).toEqual(["Albatross", "Raven Deck"]);
});

test("names become safe file names", () => {
    expect(slugOf("Pirate Crow")).toBe("pirate-crow");
    expect(slugOf("  Crème Brûlée / Dark!  ")).toBe("creme-brulee-dark");
    expect(slugOf("../../etc/passwd")).toBe("etc-passwd");
    expect(slugOf("日本語")).toBe("theme");
    expect(slugOf("x".repeat(200)).length).toBeLessThanOrEqual(64);
});
