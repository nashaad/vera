import { expect, test } from "bun:test";

import {
    renderStartupCard,
    renderStartupChoiceEcho,
    shortenHome,
    startupCardStyle,
    wrapText,
    type StartupCard,
} from "../clients/cli/startup-card.ts";

const HOME = "/Users/nash";

const configCard: StartupCard = {
    kind: "error",
    title: "Vera can't start",
    rows: [
        { label: "file", value: `${HOME}/.vera/config.json` },
        { label: "field", value: "extensions[5]", bold: true },
        { label: "reason", value: "path is missing; it must be an absolute path" },
    ],
    body: ["Set aside extensions[5] and start Vera?", "A backup is saved first."],
    choices: [
        { key: "y", label: "set aside and start" },
        { key: "n", label: "quit", isDefault: true },
    ],
};

test("@core a config card lays out the file, field, reason and choices in a box", () => {
    const text = renderStartupCard(configCard, { columns: 48, color: "none", home: HOME });
    expect(text).toBe([
        "                   V  E  R  A",
        "╭──────────────────────────────────────────────╮",
        "│ ✗ Vera can't start                           │",
        "│                                              │",
        "│   file    ~/.vera/config.json                │",
        "│   field   extensions[5]                      │",
        "│   reason  path is missing; it must be an     │",
        "│           absolute path                      │",
        "│                                              │",
        "│   Set aside extensions[5] and start Vera?    │",
        "│   A backup is saved first.                   │",
        "│                                              │",
        "│   [y] set aside and start      [N] quit      │",
        "╰──────────────────────────────────────────────╯",
        "",
    ].join("\n"));
});

test("a card is at most 64 columns wide on a wide terminal", () => {
    const text = renderStartupCard(configCard, { columns: 200, color: "none", home: HOME });
    const widths = text.split("\n").filter((line) => line.startsWith("╭")).map((line) => line.length);
    expect(widths).toEqual([64]);
});

test("a long path wraps after a slash inside its column", () => {
    const text = renderStartupCard({
        kind: "error",
        title: "Vera can't start",
        rows: [{ label: "path", value: "/tmp/vera-dev/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/cc/sock" }],
    }, { columns: 40, color: "none" });
    expect(text).toBe([
        "               V  E  R  A",
        "╭──────────────────────────────────────╮",
        "│ ✗ Vera can't start                   │",
        "│                                      │",
        "│   path  /tmp/vera-dev/               │",
        "│         aaaaaaaaaaaaaaaaaaaaaaaa/    │",
        "│         bbbbbbbbbbbbbbbbbbbbbbbb/cc/ │",
        "│         sock                         │",
        "╰──────────────────────────────────────╯",
        "",
    ].join("\n"));
});

test("a word wider than the column breaks by character", () => {
    expect(wrapText("abcdefghij klm", 4)).toEqual(["abcd", "efgh", "ij", "klm"]);
});

test("choices stack when they do not fit side by side", () => {
    const text = renderStartupCard(configCard, { columns: 36, color: "none", home: HOME });
    expect(text).toContain("│   [y] set aside and start        │\n│   [N] quit                       │");
});

test("only paths under the home folder become ~", () => {
    expect(shortenHome("/Users/nash/.vera/x and /Users/nashville", HOME))
        .toBe("~/.vera/x and /Users/nashville");
    expect(shortenHome("/Users/nash", HOME)).toBe("~");
    expect(shortenHome("/tmp/vera-dev/x", HOME)).toBe("/tmp/vera-dev/x");
    expect(shortenHome("/etc/x", "/")).toBe("/etc/x");
});

test("a question card marks the title with a question mark", () => {
    const text = renderStartupCard({ kind: "question", title: "Reset the host?" }, {
        columns: 40,
        color: "none",
    });
    expect(text).toContain("│ ? Reset the host?                    │");
});

test("a done card is an unboxed line with labelled rows", () => {
    const text = renderStartupCard({
        kind: "done",
        title: "Set aside extensions[5]",
        rows: [
            { label: "backup", value: `${HOME}/.vera/config.json.bak` },
            { label: "next", value: "starting Vera" },
        ],
    }, { columns: 48, color: "none", home: HOME });
    expect(text).toBe([
        "✓ Set aside extensions[5]",
        "",
        "  backup  ~/.vera/config.json.bak",
        "  next    starting Vera",
        "",
    ].join("\n"));
});

test("colour mode paints the glyph, labels, field, keys and border", () => {
    const text = renderStartupCard(configCard, { columns: 48, color: "ansi", home: HOME });
    const reset = "\u001b[0m";
    expect(text).toContain(`\u001b[31m✗${reset} \u001b[1mVera can't start${reset}`);
    expect(text).toContain(`\u001b[2mfield${reset}   \u001b[1mextensions[5]${reset}`);
    expect(text).toContain(`\u001b[36m\u001b[1m[y]${reset}${reset} set aside and start`);
    expect(text).toContain(`\u001b[36m\u001b[1m[N]${reset}${reset} quit`);
    expect(text).toContain(`\u001b[2m╭${"─".repeat(46)}╮${reset}`);
    expect(text.split("\n")[0]).toBe(`${" ".repeat(19)}\u001b[36m\u001b[1mV  E  R  A${reset}${reset}`);
});

test("colour mode keeps the box lines the same width as plain mode", () => {
    const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
    const plain = renderStartupCard(configCard, { columns: 48, color: "none", home: HOME });
    expect(strip(renderStartupCard(configCard, { columns: 48, color: "ansi", home: HOME }))).toBe(plain);
    expect(strip(renderStartupCard(configCard, { columns: 48, color: "truecolor", home: HOME }))).toBe(plain);
});

test("truecolor mode paints the roles with the theme colours", () => {
    const text = renderStartupCard({ kind: "done", title: "Done" }, {
        columns: 48,
        color: "truecolor",
    });
    expect(text).toContain("\u001b[38;2;158;206;106m✓\u001b[0m");
    const error = renderStartupCard({ kind: "error", title: "Bad" }, { columns: 48, color: "truecolor" });
    expect(error).toContain("\u001b[38;2;255;95;86m✗\u001b[0m");
});

test("NO_COLOR and a dumb terminal turn colour off, COLORTERM selects truecolor", () => {
    expect(startupCardStyle({ NO_COLOR: "1" }, 80, undefined).color).toBe("none");
    expect(startupCardStyle({ NO_COLOR: "" }, 80, undefined).color).toBe("ansi");
    expect(startupCardStyle({ TERM: "dumb" }, 80, undefined).color).toBe("none");
    expect(startupCardStyle({ COLORTERM: "truecolor" }, 80, undefined).color).toBe("truecolor");
    expect(startupCardStyle({ COLORTERM: "24bit" }, 80, HOME)).toEqual({
        columns: 80,
        home: HOME,
        color: "truecolor",
    });
});

test("the echo line names the key and its label", () => {
    expect(renderStartupChoiceEcho({ key: "y", label: "set aside and start" }, { color: "none" }))
        .toBe("  [y] set aside and start\n");
    expect(renderStartupChoiceEcho({ key: "n", label: "quit", isDefault: true }, { color: "none" }))
        .toBe("  [N] quit\n");
});
