import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadTuiThemeCatalog,
    mergeUserTuiThemes,
    reloadTuiThemeCatalog,
    resolveTuiTheme,
    tuiThemeOptions,
} from "../../clients/tui/theme-catalog.ts";
import {
    BUILT_IN_TUI_THEMES,
    FALLBACK_TUI_THEME,
    loadBuiltInTuiThemes,
    parseBuiltInTuiThemes,
} from "../../clients/tui/theme.ts";

const renderer = { async getPalette(): Promise<never> { throw new Error("no terminal"); } };

function writeThemes(value: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), "vera-themes-")), "tui-themes.json");
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
}

test("a missing home file leaves the built-ins with no problems", () => {
    const catalog = loadTuiThemeCatalog(join(tmpdir(), "vera-no-such-dir", "tui-themes.json"));
    expect(catalog.entries).toBe(BUILT_IN_TUI_THEMES);
    expect(catalog.problems).toEqual([]);
});

test("extends copies a theme and the user's fields win", async () => {
    const catalog = loadTuiThemeCatalog(writeThemes({
        themes: {
            "my-dusk": {
                label: "My Dusk",
                description: "purple, softer text",
                extends: "vera-purple",
                text: "#CFCBE0",
            },
        },
    }));
    expect(catalog.problems).toEqual([]);
    const dusk = await resolveTuiTheme(renderer, "my-dusk", catalog);
    const purple = await resolveTuiTheme(renderer, "vera-purple", catalog);
    expect(dusk).toEqual({ ...purple, text: "#CFCBE0" });
    expect(tuiThemeOptions(catalog).at(-1)).toEqual({
        name: "my-dusk",
        label: "My Dusk",
        description: "purple, softer text",
    });
});

test("a user theme named like a built-in replaces it in place", async () => {
    const catalog = mergeUserTuiThemes({
        themes: { onyx: { extends: "onyx", accent: "#FF00AA" } },
    }, "tui-themes.json");
    const names = tuiThemeOptions(catalog).map((option) => option.name);
    expect(names).toEqual(tuiThemeOptions({ entries: BUILT_IN_TUI_THEMES, problems: [] })
        .map((option) => option.name));
    expect((await resolveTuiTheme(renderer, "onyx", catalog)).accent).toBe("#FF00AA");
});

test("hud overrides merge over the inherited hud", async () => {
    const catalog = mergeUserTuiThemes({
        themes: { retro: { extends: "windows-31", hud: { accent: "#123456" } } },
    }, "tui-themes.json");
    const base = await resolveTuiTheme(renderer, "windows-31", catalog);
    const retro = await resolveTuiTheme(renderer, "retro", catalog);
    expect(retro.hud).toEqual({ ...base.hud, accent: "#123456" });
});

test("a bad theme is skipped with a problem naming the file, theme, and field", () => {
    const catalog = mergeUserTuiThemes({
        themes: {
            partial: { accent: "#FF00AA" },
            typo: { extends: "onyx", accnet: "#FF00AA" },
            "bad-color": { extends: "onyx", text: "white" },
            orphan: { extends: "nope" },
            system: { extends: "onyx" },
            orng: { extends: "onyx" },
            fine: { extends: "onyx" },
        },
    }, "home/tui-themes.json");
    expect(catalog.problems).toEqual([
        `home/tui-themes.json: theme "partial" skipped: text is missing`,
        `home/tui-themes.json: theme "typo" skipped: unknown field "accnet"`,
        `home/tui-themes.json: theme "bad-color" skipped: text must be a color like #A1B2C3`,
        `home/tui-themes.json: theme "orphan" skipped: extends unknown theme "nope"`,
        `home/tui-themes.json: theme "system" skipped: "system" is reserved for terminal colors`,
        `home/tui-themes.json: theme "orng" skipped: "orng" is the fallback theme and cannot be replaced`,
    ]);
    expect(catalog.entries.at(-1)?.name).toBe("fine");
});

test("invalid JSON reports the file and keeps the built-ins", () => {
    const path = writeThemes("{ not json");
    const catalog = loadTuiThemeCatalog(path);
    expect(catalog.entries).toBe(BUILT_IN_TUI_THEMES);
    expect(catalog.problems[0]).toStartWith(`${path} is not valid JSON:`);
});

test("a missing or broken saved theme falls back to Orng", async () => {
    reloadTuiThemeCatalog(writeThemes({ themes: { broken: { accent: "#FF00AA" } } }));
    expect(await resolveTuiTheme(renderer, "deleted-theme")).toBe(FALLBACK_TUI_THEME);
    expect(await resolveTuiTheme(renderer, "broken")).toBe(FALLBACK_TUI_THEME);
});

test("a broken built-in is skipped and Orng still follows the default", () => {
    const builtIns = parseBuiltInTuiThemes({
        default: { extends: "orng", accent: "#4E7BF2" },
        dusk: { extends: "default", text: "#CFCBE0" },
        broken: { extends: "default", text: "white" },
    }, "built-in");
    expect(builtIns.entries.map((entry) => entry.name)).toEqual(["default", "orng", "dusk"]);
    expect(builtIns.problems).toEqual([
        `built-in: theme "broken" skipped: text must be a color like #A1B2C3`,
    ]);
});

test("Orng is offered even when every built-in is broken", () => {
    const builtIns = parseBuiltInTuiThemes({ default: { accent: "#4E7BF2" } }, "built-in");
    expect(builtIns.entries.map((entry) => entry.name)).toEqual(["orng"]);
    expect(tuiThemeOptions({ entries: builtIns.entries, problems: [] }).map((option) => option.name))
        .toEqual(["system", "orng"]);
});

test("a shipped themes file with a JSON syntax error leaves Orng and a problem", () => {
    const path = writeThemes('{ "themes": { "default": { } ');
    const builtIns = loadBuiltInTuiThemes(path);
    expect(builtIns.entries.map((entry) => entry.name)).toEqual(["orng"]);
    expect(builtIns.problems[0]).toStartWith(`${path} could not be loaded:`);
});

test("a missing shipped themes file leaves Orng and a problem", () => {
    const builtIns = loadBuiltInTuiThemes(join(tmpdir(), "vera-no-such-dir", "tui-themes.json"));
    expect(builtIns.entries.map((entry) => entry.name)).toEqual(["orng"]);
    expect(builtIns.problems).toHaveLength(1);
});
