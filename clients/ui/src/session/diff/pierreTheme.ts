import { registerCustomTheme } from "@pierre/diffs";

export const VERA_DIFF_THEME = "vera-diff";

const tokenRules = [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--vera-syntax-comment)" } },
    { scope: ["string", "string.template", "string.regexp", "punctuation.definition.string"], settings: { foreground: "var(--vera-syntax-string)" } },
    { scope: ["constant.numeric", "constant.language", "constant.character"], settings: { foreground: "var(--vera-syntax-number)" } },
    { scope: ["keyword", "keyword.control", "keyword.operator", "storage", "storage.modifier"], settings: { foreground: "var(--vera-syntax-keyword)" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "var(--vera-syntax-function)" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "storage.type"], settings: { foreground: "var(--vera-syntax-type)" } },
    { scope: ["variable.other.property", "variable.other.member", "meta.object-literal.key", "support.variable.property"], settings: { foreground: "var(--vera-syntax-property)" } },
    { scope: ["entity.name.tag", "punctuation.definition.tag", "meta.tag"], settings: { foreground: "var(--vera-syntax-tag)" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "var(--vera-text-muted)" } },
];

const theme = {
    name: VERA_DIFF_THEME,
    type: "dark" as const,
    colors: {
        "editor.foreground": "var(--vera-text)",
        "editor.background": "var(--vera-surface-code)",
    },
    tokenColors: tokenRules,
};

registerCustomTheme(VERA_DIFF_THEME, () => Promise.resolve(theme));

export function activeThemeType(): "light" | "dark" {
    if (typeof document === "undefined") return "dark";
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    return scheme.split(/\s+/).includes("light") ? "light" : "dark";
}
