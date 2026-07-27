import {
    BoxRenderable,
    DiffRenderable,
    SyntaxStyle,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_MUTED,
    TUI_NOTICE,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";

export function createTuiDiff(
    renderer: RenderContext,
    id: string,
    path: string,
    patch: string,
    syntaxStyle: SyntaxStyle,
    marginTop = 0,
): BoxRenderable {
    const container = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "column",
        marginTop,
    });
    container.add(new TextRenderable(renderer, {
        id: `${id}-path`,
        content: path,
        fg: TUI_MUTED,
        width: "100%",
        selectable: true,
    }));
    container.add(new DiffRenderable(renderer, {
        id: `${id}-body`,
        diff: patch,
        view: "unified",
        showLineNumbers: true,
        width: "100%",
        wrapMode: "word",
        filetype: tuiDiffFiletype(path),
        syntaxStyle,
        fg: TUI_TEXT,
        lineNumberFg: TUI_MUTED,
        addedSignColor: TUI_SUCCESS,
        removedSignColor: TUI_NOTICE,
    }));
    return container;
}

export function tuiDiffFiletype(path: string): string | undefined {
    const name = path.toLowerCase().split("/").at(-1) ?? path.toLowerCase();
    if (name === "dockerfile") return "dockerfile";
    if (name === "makefile") return "make";
    const extension = name.includes(".") ? name.split(".").at(-1) : undefined;
    return extension === undefined ? undefined : FILETYPES[extension];
}

const FILETYPES: Readonly<Record<string, string>> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    java: "java",
    js: "typescript",
    json: "json",
    jsx: "typescript",
    lua: "lua",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "typescript",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
};
