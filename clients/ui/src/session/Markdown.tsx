import { memo, useRef } from "react";
import { marked, type Token } from "marked";

import { renderBlock } from "./MarkdownBlocks.tsx";
import { inlineTokens } from "./MarkdownInline.tsx";
import { lexMarkdown, MARKDOWN_OPTIONS, type MarkdownLexState } from "./MarkdownLexer.ts";

export { isClosedFence } from "./MarkdownBlocks.tsx";

export function Inline({ text }: { readonly text: string }) {
    return <>{inlineTokens(marked.Lexer.lexInline(text, MARKDOWN_OPTIONS), "i", { fade: false, links: true })}</>;
}

export interface MarkdownProps {
    readonly text: string;
    // Fades in the words of the last block as they arrive; for text that is still streaming.
    readonly fade?: boolean;
}

interface MarkdownBlockProps {
    readonly token: Token;
    readonly index: number;
    readonly fade: boolean;
}

const MarkdownBlock = memo(function MarkdownBlock({ token, index, fade }: MarkdownBlockProps) {
    return renderBlock(token, String(index), fade);
});

export const Markdown = memo(function Markdown({ text, fade = false }: MarkdownProps) {
    const state = useRef<MarkdownLexState | undefined>(undefined);
    state.current = lexMarkdown(text, state.current);
    const blocks = state.current.tokens.filter((token) => token.type !== "space" && token.type !== "def");
    return (
        <div className="assistant-text">
            {blocks.map((token, i) => <MarkdownBlock key={i} token={token} index={i} fade={fade && i === blocks.length - 1} />)}
        </div>
    );
});
