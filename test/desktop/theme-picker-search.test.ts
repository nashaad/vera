import { expect, test } from "bun:test";
import { filterThemes } from "../../clients/ui/src/theme/picker-search.ts";
import { BUILTIN_THEME_REGISTRY } from "../../clients/ui/src/theme/registry.ts";

const themes = [
    ...BUILTIN_THEME_REGISTRY.map((theme) => ({
        choice: theme.name,
        label: theme.label,
        description: theme.description,
    })),
    { choice: "imported:crow.night", label: "Crow Night", description: "Imported. Extension Pirate Crow." },
];

function choices(query: string): string[] {
    return filterThemes(themes, query).map((theme) => theme.choice);
}

test("@core theme search keeps the original order for empty and whitespace queries", () => {
    const expected = themes.map((theme) => theme.choice);
    expect(choices("")).toEqual(expected);
    expect(choices("  \t  ")).toEqual(expected);
});

test("@core theme search matches case-insensitive terms in labels and descriptions", () => {
    expect(choices("GRUVBOX")).toEqual(["gruvbox-dark-hard", "gruvbox-light-hard"]);
    expect(choices("  WARM\tGrUvBoX  ")).toEqual(["gruvbox-dark-hard", "gruvbox-light-hard"]);
    expect(choices("ink light")).toEqual(["gruvbox-light-hard"]);
    expect(choices("surface light")).toEqual(["dark", "light"]);
    expect(choices("gruvbox purple")).toEqual([]);
});

test("@core theme search includes imported names and descriptions", () => {
    expect(choices("night imported")).toEqual(["imported:crow.night"]);
    expect(choices("pirate extension")).toEqual(["imported:crow.night"]);
    expect(choices("zzz")).toEqual([]);
    expect(choices("1")).toEqual(["windows-31"]);
});

test("@core theme search ranks label matches before description matches", () => {
    const short = choices("l");
    expect(short[0]).toBe("light");
    expect(short.indexOf("light")).toBeLessThan(short.indexOf("dark"));
    expect(choices("light")).toEqual(["light", "github-light", "gruvbox-light-hard", "dark"]);
});

test("@core theme search ranks multiple terms in stable tiers", () => {
    const mixed = [
        { choice: "description-first", label: "Dark", description: "bright warm" },
        { choice: "name-first", label: "Warm Bright", description: "" },
        { choice: "prefix-first", label: "Bright Warm One", description: "" },
        { choice: "split", label: "Bright Blue", description: "warm" },
        { choice: "prefix-second", label: "Bright Warm Two", description: "" },
        { choice: "name-second", label: "Warm Bright Two", description: "" },
        { choice: "description-second", label: "Silent", description: "bright warm" },
    ];
    expect(filterThemes(mixed, " BRIGHT\t warm ").map((theme) => theme.choice)).toEqual([
        "prefix-first", "prefix-second", "name-first", "name-second",
        "description-first", "split", "description-second",
    ]);
    expect(choices("gruvbox light")).toEqual(["gruvbox-light-hard"]);
});

test("@core imported themes use the same stable ranking as built-ins", () => {
    const mixed = [
        ...themes.filter((theme) => ["dark", "light", "github-light"].includes(theme.choice)),
        { choice: "imported:light.crow", label: "Light Crow", description: "Imported. Crow." },
        { choice: "imported:crow.light", label: "Crow Light", description: "Imported. Crow." },
        { choice: "imported:dim.crow", label: "Dim Crow", description: "Imported. Light Crow." },
    ];
    expect(filterThemes(mixed, "light").map((theme) => theme.choice)).toEqual([
        "light", "imported:light.crow", "github-light", "imported:crow.light",
        "dark", "imported:dim.crow",
    ]);
});
