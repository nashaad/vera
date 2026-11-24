import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isFixedFindHighlightColor, themeViolations } from "../../clients/ui/src/lint/theme-lint.ts";
import { themeFile } from "../../clients/ui/src/theme/apply.ts";
import { TREE_STYLE } from "../../clients/ui/src/session/tree-style.ts";
import {
    COLOR_TOKENS,
    SYNTAX_TOKENS,
    THEME_NAMES,
    VALUE_TOKENS,
} from "../../clients/ui/src/theme/tokens.ts";
import { THEME_PALETTE_KEYS } from "./theme-palette-keys.ts";

const root = join(import.meta.dir, "..", "..");

function treeStyleIsLayoutOnly(css: string): boolean {
    const allowed: Readonly<Record<string, readonly string[]>> = {
        display: ["block", "contents", "none"],
        "min-width": ["0"],
        overflow: ["hidden"],
        "text-overflow": ["ellipsis"],
        "white-space": ["nowrap"],
    };
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    const rules = [...css.matchAll(rulePattern)];
    if (rules.length === 0 || css.replace(rulePattern, "").trim() !== "") return false;
    for (const rule of rules) {
        if (rule[1]!.includes("@")) return false;
        const declarations = rule[2]!.split(";").map((declaration) => declaration.trim()).filter(Boolean);
        if (declarations.length === 0) return false;
        for (const declaration of declarations) {
            const match = /^([a-z-]+)\s*:\s*(.+)$/.exec(declaration);
            if (match === null || !allowed[match[1]!]?.includes(match[2]!.trim())) return false;
        }
    }
    return true;
}

test("@core desktop components use theme tokens only", () => {
    const violations = themeViolations(root);
    expect(violations).toEqual([]);
});

test("@core fixed find highlight colors are narrowly scoped", () => {
    const file = "clients/ui/src/styles/window-find.css";
    const css = "::highlight(vera-find-matches) { background-color: #ffff55; color: #000000; }";
    expect(isFixedFindHighlightColor(file, css, css.indexOf("#ffff55"))).toBe(true);
    expect(isFixedFindHighlightColor(file, css, css.indexOf("#000000"))).toBe(true);
    expect(isFixedFindHighlightColor("other.css", css, css.indexOf("#ffff55"))).toBe(false);
    const otherColor = css.replace("#ffff55", "#ffffff");
    expect(isFixedFindHighlightColor(file, otherColor, otherColor.indexOf("#ffffff"))).toBe(false);
    const otherSelector = css.replace("::highlight(vera-find-matches)", ".window-find");
    expect(isFixedFindHighlightColor(file, otherSelector, otherSelector.indexOf("#ffff55"))).toBe(false);
    const otherProperty = css.replace("background-color", "border-color");
    expect(isFixedFindHighlightColor(file, otherProperty, otherProperty.indexOf("#ffff55"))).toBe(false);
});

test("@core diff styles name only known theme tokens", () => {
    const css = readFileSync(join(root, "clients/ui/src/styles/diffs.css"), "utf8");
    const known = new Set([...COLOR_TOKENS, ...VALUE_TOKENS].map((token) => `--vera-${token}`));
    const tokens = [...css.matchAll(/var\((--vera-[a-z0-9-]+)\)/g)].map((match) => match[1]!);
    expect([...new Set(tokens)].filter((token) => !known.has(token))).toEqual([]);
});

test("@core diff hosts take the color scheme the theme sets on the root", () => {
    const css = readFileSync(join(root, "clients/ui/src/styles/diffs.css"), "utf8");
    expect(css).toMatch(/:root\[data-color-scheme="dark"\] \.diff-patch diffs-container/);
    expect(css).toMatch(/:root\[data-color-scheme="dark"\] \.review-diffs diffs-container/);
    expect(css).toMatch(/:root\[data-color-scheme="light"\] \.diff-patch diffs-container/);
    expect(css).toMatch(/:root\[data-color-scheme="light"\] \.review-diffs diffs-container/);
    const apply = readFileSync(join(root, "clients/ui/src/theme/apply.ts"), "utf8");
    expect(apply).toContain('root.setAttribute("data-color-scheme", colorScheme(applied));');
});

test("@core the Pierre theme uses every Vera syntax token and maps diff surfaces", () => {
    const known = new Set([...COLOR_TOKENS, ...VALUE_TOKENS].map((token) => `--vera-${token}`));
    const theme = readFileSync(join(root, "clients/ui/src/session/diff/pierreTheme.ts"), "utf8");
    const used = new Set([...theme.matchAll(/var\((--vera-[a-z0-9-]+)\)/g)].map((match) => match[1]!));
    for (const token of SYNTAX_TOKENS) expect(used.has(`--vera-${token}`)).toBe(true);
    expect([...used].filter((token) => !known.has(token))).toEqual([]);
    const css = readFileSync(join(root, "clients/ui/src/styles/diffs.css"), "utf8");
    expect(css).toMatch(/--diffs-light-bg:\s*var\(--vera-surface-code\)/);
    expect(css).toMatch(/--diffs-dark-bg:\s*var\(--vera-surface-code\)/);
    expect(css).toMatch(/--diffs-addition-color:\s*var\(--vera-diff-added\)/);
    expect(css).toMatch(/--diffs-deletion-color:\s*var\(--vera-diff-removed\)/);
    expect(css).toMatch(/--diffs-bg-addition-override:\s*var\(--vera-diff-added\)/);
    expect(css).toMatch(/--diffs-bg-deletion-override:\s*var\(--vera-diff-removed\)/);
    expect(css).toMatch(/--diffs-bg-selection-override:\s*var\(--vera-selection\)/);
    expect(css).toMatch(/--diffs-bg-selection-number-override:\s*var\(--vera-selection\)/);
    expect(css).toMatch(/--diffs-bg-hover-override:\s*var\(--vera-text-muted\)/);
});

test("@core shared tree colors use Vera tokens and the inline style is layout only", () => {
    const css = readFileSync(join(root, "clients/ui/src/styles/changes.css"), "utf8");
    const known = new Set([...COLOR_TOKENS, ...VALUE_TOKENS].map((token) => `--vera-${token}`));
    const declarations = [...css.matchAll(/(--trees-[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!] as const);
    expect(declarations.length).toBeGreaterThan(25);
    for (const [name, value] of declarations) {
        const tokens = [...value.matchAll(/var\((--vera-[a-z0-9-]+)\)/g)].map((match) => match[1]!);
        expect([name, tokens.length > 0]).toEqual([name, true]);
        expect([name, tokens.filter((token) => !known.has(token))]).toEqual([name, []]);
    }
    const names = new Set(declarations.map(([name]) => name));
    for (const required of [
        "--trees-bg-override", "--trees-fg-override", "--trees-selected-bg-override",
        "--trees-search-bg-override", "--trees-git-added-color-override", "--trees-status-untracked-override",
    ]) expect(names.has(required)).toBe(true);
    for (const file of ["ChangesTree.tsx", "FilesTree.tsx"]) {
        const tree = readFileSync(join(root, "clients/ui/src/session", file), "utf8");
        expect(tree).toMatch(/import\s*\{\s*TREE_STYLE\s*\}\s*from\s*["']\.\/tree-style\.ts["']/);
        expect(tree.match(/\bunsafeCSS\b/g)).toHaveLength(1);
        expect(tree).toMatch(/\bunsafeCSS\s*:\s*TREE_STYLE\s*,/);
    }
    expect(treeStyleIsLayoutOnly(TREE_STYLE)).toBe(true);
    for (const declaration of [
        "color: inherit", "background: none", "border-color: currentColor", "fill: none",
        "stroke: none", "outline-color: transparent", "box-shadow: none", "display: #fff",
        "display: rgb(0, 0, 0)", "display: hsl(0, 0%, 0%)", "display: rebeccapurple",
    ]) expect(treeStyleIsLayoutOnly(`${TREE_STYLE}\n.example { ${declaration}; }`)).toBe(false);
});

test("@core every theme fills the complete palette", () => {
    const palette = [...THEME_PALETTE_KEYS].sort();
    for (const name of THEME_NAMES) {
        expect([name, Object.keys(themeFile(name).palette).sort()]).toEqual([name, palette]);
    }
});

test("@core every theme defines every token and resolves every color", () => {
    for (const name of THEME_NAMES) {
        const theme = themeFile(name);
        expect(Object.keys(theme.colors).sort()).toEqual([...COLOR_TOKENS].sort());
        expect(Object.keys(theme.values).sort()).toEqual([...VALUE_TOKENS].sort());
        for (const token of COLOR_TOKENS) {
            const reference = theme.colors[token];
            expect(typeof theme.palette[reference]).toBe("string");
        }
        for (const token of VALUE_TOKENS) {
            expect(theme.values[token].length).toBeGreaterThan(0);
        }
    }
});
