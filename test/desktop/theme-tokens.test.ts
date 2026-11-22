import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { themeViolations } from "../../clients/ui/src/lint/theme-lint.ts";
import { themeFile } from "../../clients/ui/src/theme/apply.ts";
import {
    COLOR_TOKENS,
    SYNTAX_TOKENS,
    THEME_NAMES,
    VALUE_TOKENS,
} from "../../clients/ui/src/theme/tokens.ts";
import { THEME_PALETTE_KEYS } from "./theme-palette-keys.ts";

const root = join(import.meta.dir, "..", "..");

test("@core desktop components use theme tokens only", () => {
    const violations = themeViolations(root);
    expect(violations).toEqual([]);
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
