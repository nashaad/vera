import {
    BoxRenderable,
    DiffRenderable,
    pathToFiletype,
    SyntaxStyle,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_BACKGROUND,
    TUI_DIFF_ADDED,
    TUI_DIFF_REMOVED,
    TUI_MUTED,
    TUI_TEXT,
} from "./state.ts";
import { tuiDiffBackgroundColors } from "./theme.ts";

export function createTuiDiff(
    renderer: RenderContext,
    id: string,
    path: string,
    patch: string,
    syntaxStyle: SyntaxStyle,
    marginTop = 0,
): BoxRenderable {
    const backgrounds = tuiDiffBackgroundColors(
        TUI_BACKGROUND,
        TUI_DIFF_ADDED,
        TUI_DIFF_REMOVED,
    );
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
        lineNumberBg: TUI_BACKGROUND,
        contextBg: TUI_BACKGROUND,
        addedBg: backgrounds.added,
        removedBg: backgrounds.removed,
        // OpenTUI renders the number/sign gutter as a separate cell. Use the
        // row ground there too so additions and removals read as one surface.
        addedLineNumberBg: backgrounds.added,
        removedLineNumberBg: backgrounds.removed,
        addedSignColor: TUI_DIFF_ADDED,
        removedSignColor: TUI_DIFF_REMOVED,
    }));
    return container;
}

export function tuiDiffFiletype(path: string): string | undefined {
    return pathToFiletype(path);
}
