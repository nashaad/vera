import { expect, test } from "bun:test";

import {
    registerTuiParsers,
    TUI_PARSER_SOURCES,
} from "../../clients/tui/parsers.ts";

test("TUI registers a broad lazy parser catalog beyond OpenTUI built-ins", () => {
    const filetypes = new Set(TUI_PARSER_SOURCES.map((source) => source.filetype));

    expect(filetypes.size).toBeGreaterThan(30);
    for (const language of [
        "python",
        "bash",
        "c",
        "cpp",
        "css",
        "go",
        "html",
        "java",
        "json",
        "kotlin",
        "lua",
        "make",
        "ruby",
        "rust",
        "yaml",
    ]) {
        expect(filetypes.has(language)).toBe(true);
    }
});

test("TUI parser registration carries each source into OpenTUI", () => {
    let registered: Array<{
        filetype: string;
        wasm: string;
        queries: { highlights: string[] };
    }> = [];
    registerTuiParsers((parsers) => {
        registered = parsers;
    });

    expect(registered).toHaveLength(TUI_PARSER_SOURCES.length);
    expect(registered.find((parser) => parser.filetype === "python"))
        .toMatchObject({
            filetype: "python",
            wasm: expect.stringContaining("tree-sitter-python.wasm"),
            queries: {
                highlights: [expect.stringContaining("python")],
            },
        });
});
