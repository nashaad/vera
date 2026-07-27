import {
    MarkdownRenderable,
    type CliRenderer,
    type SyntaxStyle,
} from "@opentui/core";

import type { TuiTranscriptEntry } from "./state.ts";

export function createTuiMarkdownEntry(
    renderer: CliRenderer,
    id: string,
    entry: TuiTranscriptEntry,
    syntaxStyle: SyntaxStyle,
    foreground: string,
    marginTop: number,
): MarkdownRenderable | undefined {
    if (entry.kind !== "assistant" && entry.kind !== "notification") {
        return undefined;
    }

    return new MarkdownRenderable(renderer, {
        id,
        content: entry.text,
        syntaxStyle,
        fg: foreground,
        streaming: entry.kind === "assistant",
        width: "100%",
        marginTop,
    });
}
