import { expect, test } from "bun:test";
import type { TerminalColors } from "@opentui/core";

import {
    VERA_TUI_THEME,
    resolveTuiTheme,
    resolveSystemTuiTheme,
    themeFromTerminal,
} from "../../clients/tui/theme.ts";

function terminalColors(): TerminalColors {
    return {
        palette: [
            "#101010", "#aa0000", "#00aa00", "#aa5500",
            "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
        ],
        defaultBackground: "#111111",
        defaultForeground: "#eeeeee",
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightBackground: null,
        highlightForeground: null,
    };
}

test("TUI system theme uses terminal foreground and ANSI colors", () => {
    const theme = themeFromTerminal(terminalColors());

    expect(theme.text).toBe("#eeeeee");
    expect(theme.background).toBe("#111111");
    expect(theme.accent).toBe("#00aaaa");
    expect(theme.notice).toBe("#aa5500");
    expect(theme.success).toBe("#00aa00");
    expect(theme.code).toBe("#00aa00");
    expect(theme.panel).not.toBe(VERA_TUI_THEME.panel);
});

test("TUI uses Vera colors by default", async () => {
    const theme = await resolveTuiTheme({
        async getPalette() {
            return terminalColors();
        },
    });

    expect(theme).toBe(VERA_TUI_THEME);
    expect(theme.success).toBe("#B8B6D9");
    expect(theme.code).toBe("#B8B6D9");
});

test("TUI system theme falls back to Vera colors when detection fails", async () => {
    const theme = await resolveSystemTuiTheme({
        async getPalette() {
            throw new Error("palette unavailable");
        },
    });

    expect(theme).toBe(VERA_TUI_THEME);
});

test("named themes resolve their configured dark palettes", async () => {
    const renderer = { async getPalette() { return terminalColors(); } };

    expect(await resolveTuiTheme(renderer, "orng")).toMatchObject({
        accent: "#EC5B2B",
        background: "#111111",
        panel: "#181818",
        element: "#222222",
    });
    expect((await resolveTuiTheme(renderer, "palenight")).background).toBe("#292d3e");
    expect((await resolveTuiTheme(renderer, "synthwave")).success).toBe("#72f1b8");
    expect((await resolveTuiTheme(renderer, "nightowl")).panel).toBe("#0b253a");
    expect((await resolveTuiTheme(renderer, "github")).text).toBe("#c9d1d9");
    expect((await resolveTuiTheme(renderer, "system")).background).toBe("#111111");
});

test("midnight blue maps its editor and syntax palette to TUI roles", async () => {
    const renderer = { async getPalette() { return terminalColors(); } };

    expect(await resolveTuiTheme(renderer, "midnight-blue")).toEqual({
        accent: "#82AAFF",
        text: "#EEFFFF",
        muted: "#546E7A",
        notice: "#F9D768",
        success: "#C3E88D",
        code: "#9b92ea",
        background: "#14171C",
        panel: "#252933",
        element: "#2C4069",
    });
});

test("Midnight Blue II remixes the source palette around its gold accent", async () => {
    const renderer = { async getPalette() { return terminalColors(); } };

    expect(await resolveTuiTheme(renderer, "midnight-blue-ii")).toEqual({
        accent: "#F9D768",
        text: "#B2CCD6",
        muted: "#65737E",
        notice: "#F37D3B",
        success: "#C3E88D",
        code: "#82AAFF",
        background: "#14171C",
        panel: "#283246",
        element: "#222F47",
    });
});

test("muted blue uses Codex transcript, inline code, and detail colors", async () => {
    const renderer = { async getPalette() { return terminalColors(); } };
    const theme = await resolveTuiTheme(renderer, "muted-blue");

    expect(theme).toEqual({
        accent: "#02A2FF",
        text: "#02A2FF",
        muted: "#175B8B",
        notice: "#FEFC59",
        success: "#A7E3A1",
        code: "#74C0FF",
        background: "#0F1117",
        panel: "#171B23",
        element: "#2C2D31",
    });
});
