import {
    MAX_DIFF_COMMENT_CHARS,
    MAX_DIFF_COMMENT_LINES,
    MAX_DIFF_COMMENTS,
    MAX_DIFF_QUOTE_CHARS,
    type DiffComment,
} from "../../../shared/diff-comment.ts";

export const MAX_WINDOW_DIFF_COMMENTS = 100;
const MAX_PATH_CHARS = 4096;
const MAX_PATCH_KEY_CHARS = 1024;

export interface StoredDiffComment extends DiffComment {
    readonly patchKey: string;
    readonly startRow: number;
    readonly endRow: number;
}

const empty: readonly StoredDiffComment[] = [];
const comments = new Map<string, readonly StoredDiffComment[]>();
const listeners = new Map<string, Set<() => void>>();
let count = 0;
let nextId = 0;

function notify(sessionId: string): void {
    for (const listener of listeners.get(sessionId) ?? []) listener();
}

function valid(comment: Omit<StoredDiffComment, "id">): boolean {
    return comment.path.length > 0 && comment.path.length <= MAX_PATH_CHARS
        && comment.patchKey.length > 0 && comment.patchKey.length <= MAX_PATCH_KEY_CHARS
        && (comment.side === "old" || comment.side === "new")
        && Number.isSafeInteger(comment.startLine) && comment.startLine > 0
        && Number.isSafeInteger(comment.endLine) && comment.endLine >= comment.startLine
        && Number.isSafeInteger(comment.startRow) && comment.startRow >= 0
        && Number.isSafeInteger(comment.endRow) && comment.endRow >= comment.startRow
        && comment.note.trim().length > 0 && comment.note.length <= MAX_DIFF_COMMENT_CHARS
        && comment.quote.length > 0 && comment.quote.length <= MAX_DIFF_COMMENT_LINES
        && comment.quote.reduce((total, line) => total + line.length, 0) <= MAX_DIFF_QUOTE_CHARS;
}

export function getDiffComments(sessionId: string): readonly StoredDiffComment[] {
    return comments.get(sessionId) ?? empty;
}

export function subscribeDiffComments(sessionId: string, listener: () => void): () => void {
    if (sessionId.length === 0) return () => {};
    const group = listeners.get(sessionId) ?? new Set<() => void>();
    group.add(listener);
    listeners.set(sessionId, group);
    return () => {
        group.delete(listener);
        if (group.size === 0) listeners.delete(sessionId);
    };
}

export function addDiffComment(sessionId: string, comment: Omit<StoredDiffComment, "id">): StoredDiffComment | undefined {
    if (sessionId.length === 0 || !valid(comment)) return undefined;
    const current = getDiffComments(sessionId);
    if (current.length >= MAX_DIFF_COMMENTS || count >= MAX_WINDOW_DIFF_COMMENTS) return undefined;
    const item: StoredDiffComment = { ...comment, quote: [...comment.quote], id: `diff-comment-${++nextId}` };
    comments.set(sessionId, [...current, item]);
    count++;
    notify(sessionId);
    return item;
}

export function removeDiffComments(sessionId: string, ids: readonly string[]): void {
    const current = getDiffComments(sessionId);
    if (current.length === 0 || ids.length === 0) return;
    const removed = new Set(ids);
    const next = current.filter((comment) => !removed.has(comment.id));
    if (next.length === current.length) return;
    count -= current.length - next.length;
    if (next.length === 0) comments.delete(sessionId);
    else comments.set(sessionId, next);
    notify(sessionId);
}

export function removeDiffComment(sessionId: string, id: string): void {
    removeDiffComments(sessionId, [id]);
}

export function clearDiffCommentsForTest(): void {
    comments.clear();
    listeners.clear();
    count = 0;
    nextId = 0;
}
