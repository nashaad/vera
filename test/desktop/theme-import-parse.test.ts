import { expect, test } from "bun:test";

import { classifyType, COLOR_ROWS, mapColors } from "../../clients/desktop/src/theme-import/color-map.ts";
import { parseJsonc } from "../../clients/desktop/src/theme-import/jsonc.ts";
import { NEUTRAL_TOKENS } from "../../clients/desktop/src/theme-import/neutral-colors.ts";
import { ThemeRefusal } from "../../clients/desktop/src/theme-import/refusal.ts";
import { brightness, parseColor } from "../../clients/desktop/src/theme-import/vscode-color.ts";
import { baseColor, shadowFor } from "../../clients/ui/src/theme/imported.ts";
import { COLOR_TOKENS, type ColorToken } from "../../clients/ui/src/theme/tokens.ts";
import { PIRATE_CROW } from "./theme-fixtures.ts";

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

function expectContrastLike(derived: string, onDerived: string, base: string, onBase: string, tolerance: number): void {
    expect(Math.abs(contrastRatio(derived, onDerived) - contrastRatio(base, onBase))).toBeLessThan(tolerance);
}

const CROW_HOLD_NIGHT = { "editor.background": "#1b2a1f", foreground: "#e6f0e8" };
const TOMORROW_NIGHT_BLUE = { "editor.background": "#002451", foreground: "#ffffff" };
const HUE_TOKENS: readonly ColorToken[] = [
    "focus", "link", "accent", "accent-text", "badge", "badge-text", "danger", "warning", "success",
    "diff-added", "diff-removed", "selection", "menu-check", "slider-value", "slider-fill", "slider-stop", "slider-knob",
];

function refusal(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        if (error instanceof ThemeRefusal) return error.message;
        throw error;
    }
    throw new Error("Expected a refusal.");
}

test("@core JSONC reads comments, trailing commas and a byte order mark", () => {
    const text = [
        "﻿// the crow's log",
        "{",
        "    /* block */ \"name\": \"Pirate // Crow\", // trailing note",
        "    \"list\": [1, 2, ],",
        "    \"nested\": { \"a\": \"/* not a comment */\", },",
        "}",
    ].join("\n");
    expect(parseJsonc(text)).toEqual({ name: "Pirate // Crow", list: [1, 2], nested: { a: "/* not a comment */" } });
});

test("JSONC keeps escaped quotes inside strings", () => {
    expect(parseJsonc("{ \"a\": \"say \\\"hi\\\" // still text\" }")).toEqual({ a: "say \"hi\" // still text" });
});

test("@core JSONC refuses text that is not JSON and a comment that never closes", () => {
    expect(refusal(() => parseJsonc("{ \"name\": "))).toMatch(/^The file is not valid JSON/);
    expect(refusal(() => parseJsonc("not json at all"))).toMatch(/^The file is not valid JSON/);
    expect(refusal(() => parseJsonc("{ /* never closed }"))).toBe("The file has a comment that is never closed.");
});

test("@core colors read as #rgb, #rgba, #rrggbb and #rrggbbaa and nothing else", () => {
    expect(parseColor("#abc")).toBe("#aabbcc");
    expect(parseColor("#ABCD")).toBe("#aabbccdd");
    expect(parseColor("#C9A227")).toBe("#c9a227");
    expect(parseColor(" #c9a22780 ")).toBe("#c9a22780");
    for (const bad of ["default", "red", "#12", "#12345", "#1234567", "#gggggg", "rgb(1, 2, 3)", "", 7, null, undefined]) {
        expect(parseColor(bad)).toBeUndefined();
    }
});

test("brightness ignores alpha and orders black below white", () => {
    expect(brightness("#000000")).toBe(0);
    expect(brightness("#ffffff")).toBeCloseTo(1, 5);
    expect(brightness("#ffffff00")).toBeCloseTo(1, 5);
    expect(brightness("#10131a")).toBeLessThan(0.5);
});

test("@core a theme with no type is classified by the lightness of editor.background", () => {
    expect(classifyType(undefined, undefined, { "editor.background": "#fdf6e3" })).toBe("light");
    expect(classifyType(undefined, undefined, { "editor.background": "#10131a" })).toBe("dark");
    expect(classifyType(undefined, undefined, {})).toBe("dark");
});

test("a declared type wins over the manifest's uiTheme, which wins over the background", () => {
    expect(classifyType("light", "vs-dark", { "editor.background": "#000000" })).toBe("light");
    expect(classifyType(undefined, "vs", { "editor.background": "#000000" })).toBe("light");
    expect(classifyType(undefined, "hc-black", {})).toBe("high-contrast");
    expect(classifyType("hc", undefined, {})).toBe("high-contrast");
    expect(classifyType("hcLight", undefined, {})).toBe("light");
    expect(classifyType("unheard-of", undefined, { "editor.background": "#ffffff" })).toBe("light");
});

test("@core each token takes the first color in its row that the theme sets", () => {
    const first = mapColors({ "panel.background": "#111111", "sideBar.background": "#222222" }, "dark");
    expect(first.colors["surface-panel"]).toBe("#111111");
    expect(first.colors["surface-sidebar"]).toBe("#222222");
    const second = mapColors({ "sideBar.background": "#222222" }, "dark");
    expect(second.colors["surface-panel"]).toBe("#222222");
    const skipsUnreadable = mapColors({ "panel.border": "transparent", "sideBar.border": "#333333", contrastBorder: "#444444" }, "dark");
    expect(skipsUnreadable.colors.border).toBe("#333333");
    const code = mapColors({ "editor.background": "#10131a" }, "dark");
    expect(code.colors["surface-code"]).toBe("#10131a");
    expect(mapColors({ "editor.background": "#10131a", "textCodeBlock.background": "#abcdef" }, "dark").colors["surface-code"]).toBe("#abcdef");
});

test("@core without a readable surface and text, tokens the theme does not set take Vera's base for its type", () => {
    const light = mapColors({ "editor.background": "#fdf6e3" }, "light");
    expect(light.colors["surface-hover"]).toBe(baseColor("light", "surface-hover"));
    expect(light.colors["surface-hover"]).not.toBe(baseColor("dark", "surface-hover"));
    for (const token of COLOR_TOKENS) expect(light.colors[token]).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/);
    expect(mapColors({ foreground: "#e6f0e8" }, "dark").colors.border).toBe(baseColor("dark", "border"));
    expect(mapColors({ "editor.background": "#1b2a1f", foreground: "transparent" }, "dark").colors.border).toBe(baseColor("dark", "border"));
    expect(mapColors({ "editor.background": "default", foreground: "#e6f0e8" }, "dark").colors.border).toBe(baseColor("dark", "border"));
});

test("@core neutrals the theme does not set keep Dark's contrast on its own surface", () => {
    for (const theme of [CROW_HOLD_NIGHT, TOMORROW_NIGHT_BLUE]) {
        const mapped = mapColors(theme, "dark");
        for (const token of ["border", "border-input", "surface-raised", "surface-hover", "surface-menu", "surface-selected", "scrollbar"] as const) {
            expect(mapped.colors[token]).not.toBe(baseColor("dark", token));
            expect(mapped.colors[token]).not.toBe(mapped.colors.surface);
            expectContrastLike(mapped.colors[token], mapped.colors.surface, baseColor("dark", token), baseColor("dark", "surface"), 0.1);
        }
        expect(mapped.colors.border).not.toBe("#262626");
        for (const token of ["text-muted", "text-dim"] as const) {
            expect(contrastRatio(mapped.colors[token], mapped.colors.surface)).toBeGreaterThan(4.5);
        }
    }
    expect(mapColors(CROW_HOLD_NIGHT, "dark").colors.border).toBe("#2d3c31");
    expect(mapColors(TOMORROW_NIGHT_BLUE, "dark").colors["surface-raised"]).toBe("#15365f");
});

test("a light theme derives against the Light base", () => {
    const mapped = mapColors({ "editor.background": "#fbf8f0", foreground: "#1c1c1c" }, "light");
    for (const token of ["border", "border-input", "surface-hover", "text-muted"] as const) {
        expect(mapped.colors[token]).not.toBe(baseColor("light", token));
        expectContrastLike(mapped.colors[token], mapped.colors.surface, baseColor("light", token), baseColor("light", "surface"), 0.1);
    }
    expect(luminance(mapped.colors.border)).toBeLessThan(luminance(mapped.colors.surface));
    expect(luminance(mapped.colors["surface-raised"])).toBeGreaterThanOrEqual(luminance(mapped.colors.surface));
});

test("@core a theme's own surface and text give back the built-in neutrals of each type", () => {
    for (const type of ["dark", "high-contrast"] as const) {
        const mapped = mapColors({ "editor.background": baseColor(type, "surface"), foreground: baseColor(type, "text") }, type);
        for (const token of NEUTRAL_TOKENS) expect(mapped.colors[token]).toBe(baseColor(type, token));
    }
    const light = mapColors({ "editor.background": baseColor("light", "surface"), foreground: baseColor("light", "text") }, "light");
    for (const token of NEUTRAL_TOKENS) {
        for (const start of [1, 3, 5]) {
            const derived = Number.parseInt(light.colors[token].slice(start, start + 2), 16);
            const built = Number.parseInt(baseColor("light", token).slice(start, start + 2), 16);
            expect(Math.abs(derived - built)).toBeLessThanOrEqual(6);
        }
    }
});

test("a theme that sets a neutral keeps it and derives only the ones it leaves out", () => {
    const mapped = mapColors({ ...CROW_HOLD_NIGHT, "panel.border": "#ff00ff", "editorWidget.background": "#334455" }, "dark");
    expect(mapped.colors.border).toBe("#ff00ff");
    expect(mapped.colors["surface-raised"]).toBe("#334455");
    expect(mapped.colors["border-input"]).toBe(mapColors(CROW_HOLD_NIGHT, "dark").colors["border-input"]);
    expect(mapColors({ ...CROW_HOLD_NIGHT, "input.border": "#abcdef80" }, "dark").colors["border-input"]).toBe("#abcdef80");
});

test("hue tokens and the tokens paired with them keep Vera's base when the neutrals are derived", () => {
    for (const type of ["dark", "light"] as const) {
        const mapped = mapColors(type === "dark" ? CROW_HOLD_NIGHT : { "editor.background": "#fdf6e3", foreground: "#657b83" }, type);
        for (const token of HUE_TOKENS) expect(mapped.colors[token]).toBe(baseColor(type, token));
        expect(NEUTRAL_TOKENS.some((token) => HUE_TOKENS.includes(token))).toBe(false);
    }
});

test("muted text stays readable when the theme's own text is a mid gray", () => {
    const mapped = mapColors({ "editor.background": "#ffffff", foreground: "#616161" }, "light");
    for (const token of ["text-muted", "text-dim"] as const) {
        expect(contrastRatio(mapped.colors[token], mapped.colors.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(mapped.colors[token], mapped.colors.surface)).toBeLessThanOrEqual(contrastRatio("#616161", "#ffffff"));
    }
    const same = mapColors({ "editor.background": "#ffffff", foreground: "#bbbbbb" }, "light");
    expect(same.colors["text-muted"]).toBe("#bbbbbb");
});

test("derived neutrals are opaque and are not counted as used", () => {
    const mapped = mapColors({ "editor.background": "#1b2a1fcc", foreground: "#e6f0e8f0" }, "dark");
    for (const token of NEUTRAL_TOKENS) expect(mapped.colors[token]).toMatch(/^#[0-9a-f]{6}$/);
    expect(mapColors(CROW_HOLD_NIGHT, "dark").used).toBe(3);
    expect(mapColors({ ...CROW_HOLD_NIGHT, "panel.border": "#2a3140" }, "dark").used).toBe(4);
});

test("the tokens Vera adds beyond the table come from the base, and the grays among them are derived", () => {
    const bare = mapColors({ "editor.background": "#10131a" }, "dark");
    const derived = mapColors(CROW_HOLD_NIGHT, "dark");
    for (const token of ["text-dim", "menu-check", "slider-value", "slider-rail", "slider-fill", "slider-stop", "slider-knob"] as const) {
        expect(token in COLOR_ROWS).toBe(false);
        expect(bare.colors[token]).toBe(baseColor("dark", token));
    }
    for (const token of ["menu-check", "slider-value", "slider-fill", "slider-stop", "slider-knob"] as const) {
        expect(derived.colors[token]).toBe(baseColor("dark", token));
    }
    for (const token of ["text-dim", "slider-rail"] as const) expect(derived.colors[token]).not.toBe(baseColor("dark", token));
});

test("diff colors lose their alpha and the shadow takes the theme's color", () => {
    const mapped = mapColors(PIRATE_CROW.colors, "dark");
    expect(mapped.colors["diff-added"]).toBe("#4ade80");
    expect(mapped.colors["diff-removed"]).toBe(baseColor("dark", "diff-removed"));
    expect(mapped.shadow).toBe(shadowFor("dark", "#00000099"));
    expect(mapped.shadow).toContain("#00000099");
    expect(mapColors({ "editor.background": "#10131a" }, "dark").shadow).toBeUndefined();
});

test("@core a theme that sets none of the mapped colors counts none as used", () => {
    expect(mapColors({ "editor.foreground": "nope", "unrelated.color": "#ffffff" }, "dark").used).toBe(0);
    expect(mapColors({}, "dark").used).toBe(0);
    expect(mapColors({ "widget.shadow": "#000000" }, "dark").used).toBe(1);
    expect(mapColors({ "editor.background": "#10131a" }, "dark").used).toBeGreaterThan(0);
});

test("the shadow color replaces only the first color function of the built-in shadow", () => {
    expect(shadowFor("dark", "#112233")).toBe("0 12px 34px #112233, 0 0 0 1px rgba(255, 255, 255, 0.05)");
    expect(shadowFor("high-contrast", "#112233")).toBe("none");
});
