import { StyledText, type TextChunk, type TextRenderable } from "@opentui/core";

const EMPTY_TEXT = new StyledText([]);

export function setTextContent(node: TextRenderable, content: string | StyledText): void {
    const chunks: TextChunk[] = typeof content === "string"
        ? [{ __isChunk: true, text: content }]
        : content.chunks;
    // OpenTUI 0.2.16 retains native allocations for chunks containing only "".
    const next = chunks.every((chunk) => chunk.text.length === 0)
        ? EMPTY_TEXT
        : typeof content === "string" ? new StyledText(chunks) : content;
    if (sameChunks(node.chunks, next.chunks)) return;
    node.content = next;
}

function sameChunks(left: readonly TextChunk[], right: readonly TextChunk[]): boolean {
    return left.length === right.length && left.every((chunk, index) => {
        const other = right[index]!;
        return chunk.text === other.text
            && chunk.attributes === other.attributes
            && chunk.link?.url === other.link?.url
            && (chunk.fg?.equals(other.fg) ?? other.fg === undefined)
            && (chunk.bg?.equals(other.bg) ?? other.bg === undefined);
    });
}
