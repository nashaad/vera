import { expect, test } from "bun:test";
import { join } from "node:path";

import { themeViolations } from "../../clients/ui/src/lint/theme-lint.ts";
import { themeFile } from "../../clients/ui/src/theme/apply.ts";
import {
    COLOR_TOKENS,
    THEME_NAMES,
    VALUE_TOKENS,
} from "../../clients/ui/src/theme/tokens.ts";

const root = join(import.meta.dir, "..", "..");

test("@core desktop components use theme tokens only", () => {
    const violations = themeViolations(root);
    expect(violations).toEqual([]);
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
