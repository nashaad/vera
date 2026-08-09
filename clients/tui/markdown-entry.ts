import {
    MarkdownRenderable,
    type CliRenderer,
    type SyntaxStyle,
} from "@opentui/core";

import type { TuiTranscriptEntry } from "./state.ts";

export function tuiMarkdownEntryContent(
    entry: TuiTranscriptEntry,
    separated = false,
    width = 80,
): string {
    return separated
        ? `${"─".repeat(Math.max(1, width))}\n\n${entry.text}`
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
): MarkdownRenderable | undefined {
    if (entry.kind !== "assistant" && entry.kind !== "notification") {
        return undefined;
    }

    return new MarkdownRenderable(renderer, {
        id,
        content: tuiMarkdownEntryContent(
            entry,
            separated,
            renderer.terminalWidth,
        ),
        syntaxStyle,
        fg: foreground,
        streaming: entry.kind === "assistant",
        width: "100%",
        marginTop,
    });
}
