import { marked, type Token } from "marked";

export const MARKDOWN_OPTIONS = { gfm: true, breaks: true };

export interface MarkdownLexState {
    readonly text: string;
    readonly tokens: readonly Token[];
}

export function lexMarkdown(text: string, previous?: MarkdownLexState): MarkdownLexState {
    if (previous?.text === text) return previous;
    // Definitions may be nested, and HTML can change inline state across blocks.
    // Carriage returns are normalized before tokenization, changing token offsets.
    if (previous === undefined || !text.startsWith(previous.text) || text.includes("]:") || text.includes("<") || text.includes("\r")) {
        return { text, tokens: marked.lexer(text, MARKDOWN_OPTIONS) };
    }

    let last = previous.tokens.length - 1;
    while (last >= 0 && previous.tokens[last]!.type === "space") last--;
    // An unfinished marker can change whether the preceding block continues.
    while (last > 0) {
        let before = last - 1;
        while (before >= 0 && previous.tokens[before]!.type === "space") before--;
        const token = previous.tokens[before];
        if (token === undefined) break;
        const separator = token.raw + previous.tokens.slice(before + 1, last).map((item) => item.raw).join("");
        const canJoinParagraph = token.type === "paragraph" && !/\n *\n *$/.test(separator);
        if (token.type !== "list" && token.type !== "blockquote" && token.type !== "table" && !canJoinParagraph) break;
        last = before;
    }
    let offset = 0;
    for (let i = 0; i < last; i++) {
        const raw = previous.tokens[i]!.raw;
        if (!previous.text.startsWith(raw, offset)) {
            return { text, tokens: marked.lexer(text, MARKDOWN_OPTIONS) };
        }
        offset += raw.length;
    }
    const changed = marked.lexer(text.slice(offset), MARKDOWN_OPTIONS);
    return { text, tokens: [...previous.tokens.slice(0, Math.max(0, last)), ...changed] };
}
