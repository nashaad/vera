import { describe, expect, test } from 'bun:test';
import {
    appendDiffComments,
    type DiffComment,
    formatDiffComment,
    MAX_DIFF_COMMENTS,
    MAX_DIFF_COMMENT_CHARS,
    MAX_DIFF_COMMENT_LINES,
    MAX_DIFF_QUOTE_CHARS,
} from '../../clients/shared/diff-comment';

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
    return {
        id: 'crow-comment',
        path: 'src/treasure.ts',
        side: 'new',
        startLine: 7,
        endLine: 7,
        quote: ['chart the route to the island'],
        note: 'Keep the crow’s map dry.',
        ...overrides,
    };
}

describe('diff comment formatter', () => {
    test('@core formats a single selected line', () => {
        expect(formatDiffComment(makeComment())).toBe(
            'src/treasure.ts:7 (new)\n\n> chart the route to the island\n\nKeep the crow’s map dry.',
        );
    });

    test('@core formats a selected range and old side', () => {
        expect(formatDiffComment(makeComment({
            side: 'old',
            startLine: 11,
            endLine: 13,
            quote: ['the crow counts', 'three shiny coins'],
        }))).toBe(
            'src/treasure.ts:11-13 (old)\n\n> the crow counts\n> three shiny coins\n\nKeep the crow’s map dry.',
        );
    });

    test('@core caps comments, notes, quoted lines, and quoted characters', () => {
        const manyComments = Array.from({ length: MAX_DIFF_COMMENTS + 1 }, (_, index) =>
            makeComment({ id: `crow-${index}`, path: `src/crow-${index}.ts` }));
        const cappedComments = appendDiffComments('', manyComments);
        expect(cappedComments).toContain(`src/crow-${MAX_DIFF_COMMENTS - 1}.ts:7`);
        expect(cappedComments).not.toContain(`src/crow-${MAX_DIFF_COMMENTS}.ts:7`);

        const capped = formatDiffComment(makeComment({
            quote: Array.from({ length: MAX_DIFF_COMMENT_LINES + 1 }, () => 'x'.repeat(300)),
            note: 'y'.repeat(MAX_DIFF_COMMENT_CHARS + 1),
        }));
        const quotedLines = capped.split('\n\n')[1]!.split('\n');
        const note = capped.split('\n\n')[2];
        expect(quotedLines.length).toBeLessThanOrEqual(MAX_DIFF_COMMENT_LINES);
        expect(quotedLines.reduce((count, line) => count + line.slice(2).length, 0))
            .toBe(MAX_DIFF_QUOTE_CHARS);
        expect(note).toHaveLength(MAX_DIFF_COMMENT_CHARS);
    });

    test('@core preserves a blank quoted row at the character limit', () => {
        const formatted = formatDiffComment(makeComment({ quote: ['x'.repeat(MAX_DIFF_QUOTE_CHARS), ''] }));
        expect(formatted).toContain(`> ${'x'.repeat(MAX_DIFF_QUOTE_CHARS)}\n> \n\n`);
    });

    test('@core bounds physical lines even if a quote contains line breaks', () => {
        const formatted = formatDiffComment(makeComment({ quote: [Array(MAX_DIFF_COMMENT_LINES + 20).fill('crow').join('\n')] }));
        expect(formatted.split('\n\n')[1]!.split('\n')).toHaveLength(MAX_DIFF_COMMENT_LINES);
    });

    test('@core appends comments without a leading blank line for empty text', () => {
        expect(appendDiffComments('', [makeComment()])).toBe(formatDiffComment(makeComment()));
        expect(appendDiffComments('Mark the crow’s nest.', [makeComment()])).toBe(
            `Mark the crow’s nest.\n\n${formatDiffComment(makeComment())}`,
        );
    });

    test('@core separates multiple comments with a blank line', () => {
        const comments = [
            makeComment(),
            makeComment({ id: 'second-crow-comment', startLine: 9, endLine: 10 }),
        ];
        expect(appendDiffComments('Inspect the route.', comments)).toBe(
            `Inspect the route.\n\n${formatDiffComment(comments[0]!)}\n\n${formatDiffComment(comments[1]!)}`,
        );
    });
});
