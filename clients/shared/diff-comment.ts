export const MAX_DIFF_COMMENTS = 20;
export const MAX_DIFF_COMMENT_CHARS = 2000;
export const MAX_DIFF_COMMENT_LINES = 40;
export const MAX_DIFF_QUOTE_CHARS = 8000;

export interface DiffComment {
    readonly id: string;
    readonly path: string;
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
    readonly quote: readonly string[];
    readonly note: string;
}

export function formatDiffComment(comment: DiffComment): string {
    const startLine = Math.max(1, Math.floor(comment.startLine));
    const endLine = Math.max(startLine, Math.floor(comment.endLine));
    const location = startLine === endLine
        ? `${comment.path}:${startLine}`
        : `${comment.path}:${startLine}-${endLine}`;
    const header = `${location} (${comment.side})`;
    const note = comment.note.slice(0, MAX_DIFF_COMMENT_CHARS);
    const quoteLines: string[] = [];
    let quotedChars = 0;

    for (const selectedLine of comment.quote) {
        if (quoteLines.length >= MAX_DIFF_COMMENT_LINES) break;
        const line = selectedLine.slice(0, MAX_DIFF_QUOTE_CHARS - quotedChars);
        for (const part of line.split("\n")) {
            if (quoteLines.length >= MAX_DIFF_COMMENT_LINES) break;
            quoteLines.push(`> ${part}`);
        }
        quotedChars += line.length;
        if (line.length < selectedLine.length) break;
    }

    const sections = [header];
    if (quoteLines.length > 0) {
        sections.push(quoteLines.join("\n"));
    }
    sections.push(note);
    return sections.join("\n\n");
}

export function appendDiffComments(text: string, comments: readonly DiffComment[]): string {
    const blocks = comments.slice(0, MAX_DIFF_COMMENTS).map(formatDiffComment);
    if (blocks.length === 0) {
        return text;
    }

    const suffix = blocks.join('\n\n');
    return text.length === 0 ? suffix : `${text}\n\n${suffix}`;
}
