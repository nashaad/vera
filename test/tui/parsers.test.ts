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

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const RELEASE_WASM = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/[^/]+\.wasm$/;
const COMMIT_WASM = /^https:\/\/github\.com\/[^/]+\/[^/]+\/raw\/[0-9a-f]{40}\//;
const RAW_FILE = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\//;

// A query from the grammar's own repository uses the grammar's release tag; any other query needs a commit.
test("every grammar and highlight query is pinned to a release or a commit", () => {
    const unpinned: string[] = [];
    for (const source of TUI_PARSER_SOURCES) {
        const release = RELEASE_WASM.exec(source.wasm);
        if (release === null && !COMMIT_WASM.test(source.wasm)) {
            unpinned.push(source.wasm);
        }
        for (const url of source.highlights) {
            const file = RAW_FILE.exec(url);
            const sameRelease = file !== null && release !== null
                && file[1] === release[1] && file[2] === release[2];
            const commit = file !== null && COMMIT_SHA.test(file[2]!);
            if (!sameRelease && !commit) {
                unpinned.push(url);
            }
        }
    }

    expect(unpinned).toEqual([]);
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
