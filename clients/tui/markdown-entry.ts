import {
    MarkdownRenderable,
    type CliRenderer,
    type SyntaxStyle,
} from "@opentui/core";

import type { TuiTranscriptEntry } from "./state.ts";

export function tuiMarkdownEntryContent(
    entry: TuiTranscriptEntry,
    separated = false,
    _width = 80,
): string {
    return separated
        ? `---\n\n${entry.text}`
        : entry.text;
}

export function createTuiMarkdownEntry(
    renderer: CliRenderer,
    id: string,
    entry: TuiTranscriptEntry,
    syntaxStyle: SyntaxStyle,
    foreground: string,
    marginTop: number,
    separated = false,
    separatorWidth = renderer.terminalWidth,
): MarkdownRenderable | undefined {
    if (entry.kind !== "assistant" && entry.kind !== "notification") {
        return undefined;
    }

    return new MarkdownRenderable(renderer, {
        id,
        content: tuiMarkdownEntryContent(
            entry,
            separated,
            separatorWidth,
        ),
        syntaxStyle,
        fg: foreground,
        streaming: entry.kind === "assistant",
        width: "100%",
        marginTop,
    });
}
