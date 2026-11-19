import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { syntaxColors } from "../../extensions/vscode-theme-import/syntax-colors.ts";
import { importThemeFile } from "../../extensions/vscode-theme-import/import-theme.ts";
import { ThemeStore, themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { themeFile } from "../../clients/ui/src/theme/apply.ts";
import { baseColor } from "../../clients/ui/src/theme/imported.ts";
import { SYNTAX_TOKENS, THEME_NAMES } from "../../clients/ui/src/theme/tokens.ts";
import { PIRATE_CROW, removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

function luminance(color: string): number {
    const channel = (start: number): number => {
        const unit = Number.parseInt(color.slice(start, start + 2), 16) / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrastRatio(first: string, second: string): number {
    const [low, high] = [luminance(first), luminance(second)].sort((a, b) => a - b);
    return (high! + 0.05) / (low! + 0.05);
}

const RULES = [
    { scope: "comment", settings: { foreground: "#5c6370" } },
    { scope: ["keyword", "storage"], settings: { foreground: "#c678dd" } },
    { scope: "keyword.control.conditional", settings: { foreground: "#ff00ff" } },
    { scope: "string.quoted, string.template", settings: { foreground: "#98c379" } },
    { scope: "constant.numeric", settings: { foreground: "#d19a66" } },
    { scope: "entity.name.function", settings: { foreground: "#61afef" } },
    { scope: "entity.name.type", settings: { foreground: "#e5c07b" } },
    { scope: "entity.name.tag", settings: { foreground: "#e06c75" } },
    { scope: "meta.function-call entity.name.function", settings: { foreground: "#00ff00" } },
    { scope: "support.type.property-name", settings: { fontStyle: "italic" } },
];

test("@core token rules give each kind of code token its color", () => {
    expect(syntaxColors(RULES)).toEqual({
        "syntax-comment": "#5c6370",
        "syntax-keyword": "#ff00ff",
        "syntax-string": "#98c379",
        "syntax-number": "#d19a66",
        "syntax-function": "#61afef",
        "syntax-type": "#e5c07b",
        "syntax-tag": "#e06c75",
    });
});

test("a rule for a parent scope colors the kinds beneath it, and a later rule of equal depth wins", () => {
    const colors = syntaxColors([
        { scope: "keyword", settings: { foreground: "#111111" } },
        { scope: "keyword", settings: { foreground: "#222222" } },
        { scope: "comment.block", settings: { foreground: "#333333" } },
    ]);
    expect(colors["syntax-keyword"]).toBe("#222222");
    expect(colors["syntax-comment"]).toBe("#333333");
});

test("rules that set no color, no scope or a parent-scope selector are left out", () => {
    expect(syntaxColors([
        { settings: { foreground: "#111111" } },
        { scope: "comment", settings: { fontStyle: "bold" } },
        { scope: "string meta", settings: { foreground: "#222222" } },
        { scope: "keyword", settings: { foreground: "not a color" } },
        "not a rule",
        null,
    ])).toEqual({});
    expect(syntaxColors([])).toEqual({});
});

test("@core an imported theme carries its token colors as syntax colors and keeps them when listed again", () => {
    const home = scratchDirectory();
    const path = writeText(join(scratchDirectory(), "crow.json"), JSON.stringify({ ...PIRATE_CROW, tokenColors: RULES }));
    const outcome = importThemeFile(path);
    const theme = outcome.ok ? outcome.themes[0] : undefined;
    expect(theme?.colors["syntax-keyword"]).toBe("#ff00ff");
    writeText(join(themesDirectory(home), "pirate-crow.json"), JSON.stringify(theme));
    const listed = new ThemeStore(themesDirectory(home)).list()[0];
    expect(listed?.colors["syntax-string"]).toBe("#98c379");
    expect(listed?.colors["syntax-comment"]).toBe("#5c6370");
    // A kind the theme does not style falls back to the built-in color for the theme's type.
    expect(listed?.colors["syntax-property"]).toBe(baseColor("dark", "syntax-property"));
});

test("@core a theme saved before syntax colors existed lists with the built-in ones", () => {
    const home = scratchDirectory();
    const path = writeText(join(scratchDirectory(), "old.json"), JSON.stringify(PIRATE_CROW));
    const outcome = importThemeFile(path);
    const saved = JSON.parse(JSON.stringify(outcome.ok ? outcome.themes[0] : undefined)) as { colors: Record<string, string> };
    for (const token of SYNTAX_TOKENS) delete saved.colors[token];
    writeText(join(themesDirectory(home), "pirate-crow.json"), JSON.stringify(saved));
    const listed = new ThemeStore(themesDirectory(home)).list()[0];
    for (const token of SYNTAX_TOKENS) expect(listed?.colors[token]).toBe(baseColor("dark", token));
});

test("@core built-in syntax colors read clearly on the code surface in every theme", () => {
    for (const name of THEME_NAMES) {
        const theme = themeFile(name);
        const surface = theme.palette[theme.colors["surface-code"]] ?? "";
        for (const token of SYNTAX_TOKENS) {
            const color = theme.palette[theme.colors[token]] ?? "";
            expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(4.5);
        }
        const kinds = SYNTAX_TOKENS.map((token) => theme.palette[theme.colors[token]]);
        expect(new Set(kinds).size).toBe(SYNTAX_TOKENS.length);
    }
});
