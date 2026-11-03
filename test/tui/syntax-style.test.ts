import { expect, test } from "bun:test";
import { parseColor, type RGBA, type StyleDefinition } from "@opentui/core";

import { createMarkdownStyle } from "../../clients/tui/main/chrome.ts";
import { TUI_PARSER_SOURCES } from "../../clients/tui/parsers.ts";
import {
    FALLBACK_TUI_THEME,
    TUI_THEME_REQUIRED_ROLES,
    type TuiTheme,
} from "../../clients/tui/theme.ts";
import captures from "./fixtures/syntax-captures.json" with { type: "json" };

// Fixed copy of the capture names in every registered query, so the test never fetches.
// A new parser in TUI_PARSER_SOURCES needs its names added to the fixture.

interface ExpectedStyle {
    fg: string | undefined;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
}

interface CaptureFixture {
    sources: Record<string, string[]>;
    resolvedBefore: Record<string, ExpectedStyle>;
}

const fixture: CaptureFixture = captures;

type ColorRole = Exclude<typeof TUI_THEME_REQUIRED_ROLES[number], "chrome">;

// Every color role gets its own color, so a resolved style names the role it came from.
function sentinelTheme(): { theme: TuiTheme; roleOf: Map<string, ColorRole> } {
    const colors: Partial<Record<ColorRole, string>> = {};
    const roleOf = new Map<string, ColorRole>();
    let next = 1;
    for (const role of TUI_THEME_REQUIRED_ROLES) {
        if (role === "chrome") continue;
        const color = `#0000${next.toString(16).padStart(2, "0")}`;
        next += 1;
        colors[role] = color;
        roleOf.set(colorKey(parseColor(color)), role);
    }
    return { theme: { ...FALLBACK_TUI_THEME, ...colors }, roleOf };
}

function colorKey(color: RGBA): string {
    return color.toInts().join(",");
}

const { theme, roleOf } = sentinelTheme();
const style = createMarkdownStyle(theme);

function describeStyle(definition: StyleDefinition): ExpectedStyle {
    const described: ExpectedStyle = {
        fg: definition.fg === undefined ? undefined : roleOf.get(colorKey(parseColor(definition.fg))),
    };
    if (definition.bold === true) described.bold = true;
    if (definition.italic === true) described.italic = true;
    if (definition.underline === true) described.underline = true;
    return described;
}

const vocabulary: string[] = [...new Set(Object.values(fixture.sources).flat())].sort();

// Names a grammar emits that stay in the base text color. Each one is checked below
// to resolve to nothing, so a name cannot sit here and also be colored.
const PLAIN_ON_PURPOSE: readonly string[] = [
    "embedded",
    "parameter",
    "variable",
    "variable.builtin",
    "variable.member",
    "variable.parameter",
    "variable.parameter.builtin",
    "punctuation.bracket",
    "punctuation.delimiter",
    "punctuation.special",
    // Mapping these would recolor prose, which is drawn from the same style.
    "markup.heading.1",
    "markup.heading.2",
    "markup.heading.3",
    "markup.heading.4",
    "markup.heading.5",
    "markup.heading.6",
    "markup.link.bracket.close",
    "markup.list.checked",
    "markup.list.unchecked",
    "markup.math",
    "markup.strikethrough",
    "markup.underline",
];

// Pairs rather than an object: a key named constructor collides with Object.prototype.
const NEWLY_COLORED: ReadonlyArray<readonly [string, ColorRole]> = [
    ["diff.plus", "diffAdded"],
    ["diff.minus", "diffRemoved"],
    ["diff.delta", "notice"],
    ["attribute", "secondary"],
    ["attribute.builtin", "secondary"],
    ["tag", "accent"],
    ["tag.builtin", "accent"],
    ["tag.attribute", "secondary"],
    ["tag.delimiter", "muted"],
    ["tag.error", "danger"],
    ["property", "secondary"],
    ["field", "secondary"],
    ["constructor", "notice"],
    ["module", "notice"],
    ["module.builtin", "notice"],
    ["namespace", "notice"],
    ["label", "secondary"],
    ["escape", "notice"],
    ["character", "success"],
    ["character.special", "success"],
    ["include", "accent"],
    ["conditional", "accent"],
    ["repeat", "accent"],
    ["exception", "accent"],
    ["preproc", "accent"],
    ["method", "accent"],
    ["method.call", "accent"],
    ["float", "notice"],
];

function sourcesOf(name: string): string[] {
    return Object.entries(fixture.sources)
        .filter(([, names]) => names.includes(name))
        .map(([source]) => source);
}

test("the vocabulary covers every registered parser and leaves out meta captures", () => {
    const grammars = Object.keys(fixture.sources)
        .filter((source) => !source.includes(":"))
        .sort();
    expect(grammars).toEqual(TUI_PARSER_SOURCES.map((source) => source.filetype).sort());
    expect(Object.keys(fixture.sources)).toEqual(expect.arrayContaining([
        "opentui:javascript",
        "opentui:typescript",
        "opentui:markdown",
        "opentui:markdown_inline",
        "nvim-treesitter:standard",
    ]));
    expect(vocabulary.length).toBeGreaterThan(100);
    for (const name of vocabulary) {
        expect(["spell", "nospell", "none", "conceal"]).not.toContain(name);
        expect(name).not.toMatch(/^(_|local\.|injection\.)/);
    }
});

test("every capture name a grammar emits is colored unless it is plain on purpose", () => {
    const uncolored = vocabulary
        .filter((name) => style.getStyle(name) === undefined)
        .filter((name) => !PLAIN_ON_PURPOSE.includes(name))
        .map((name) => `${name} (${sourcesOf(name).slice(0, 4).join(", ")})`);
    expect(uncolored).toEqual([]);
});

test("names that are plain on purpose resolve to nothing and appear in the vocabulary", () => {
    for (const name of PLAIN_ON_PURPOSE) {
        expect(vocabulary).toContain(name);
        expect(style.getStyle(name)).toBeUndefined();
    }
});

test("established capture styles keep their theme roles", () => {
    const before = Object.entries(fixture.resolvedBefore);
    expect(before.length).toBeGreaterThan(50);
    for (const [name, expected] of before) {
        const resolved = style.getStyle(name);
        expect(resolved).toBeDefined();
        expect({ name, ...describeStyle(resolved!) }).toEqual({ name, ...expected });
    }
});

test("names without an established style use their assigned theme roles", () => {
    for (const [name, role] of NEWLY_COLORED) {
        expect(vocabulary).toContain(name);
        expect(Object.hasOwn(fixture.resolvedBefore, name)).toBe(false);
        const resolved = style.getStyle(name);
        expect(resolved).toBeDefined();
        expect({ name, ...describeStyle(resolved!) }).toEqual({ name, fg: role });
    }
});
