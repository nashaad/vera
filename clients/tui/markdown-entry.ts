import {
    MarkdownRenderable,
    type CliRenderer,
    type SyntaxStyle,
} from "@opentui/core";

import type { TuiTranscriptEntry } from "./state.ts";
import {
    installTuiMarkdownLinkHandlers,
    openTuiLink,
    type TuiLinkOpener,
} from "./markdown-links.ts";

export function tuiMarkdownEntryContent(entry: TuiTranscriptEntry): string {
    return entry.text;
}

export function createTuiMarkdownEntry(
    renderer: CliRenderer,
    id: string,
    entry: TuiTranscriptEntry,
    syntaxStyle: SyntaxStyle,
    foreground: string,
    marginTop: number,
    streaming = false,
    openLink: TuiLinkOpener = openTuiLink,
): MarkdownRenderable | undefined {
    if (entry.kind !== "assistant" && entry.kind !== "notification") {
        return undefined;
    }

    return new MarkdownRenderable(renderer, {
        id,
        content: tuiMarkdownEntryContent(entry),
        syntaxStyle,
        fg: foreground,
        streaming,
        width: "100%",
        marginTop,
        renderBefore() {
            if (openLink === undefined) return;
            installTuiMarkdownLinkHandlers(this, openLink);
        },
    });
}
