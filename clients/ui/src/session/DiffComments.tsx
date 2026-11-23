import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { MAX_DIFF_COMMENT_CHARS, MAX_DIFF_COMMENT_LINES, MAX_DIFF_QUOTE_CHARS } from "../../../shared/diff-comment.ts";
import type { StoredDiffComment } from "../composer/diff-comments.ts";
import { annotationSide, rangeInPatch, type PatchRange } from "./diff/commentRange.ts";

export interface PendingComment {
    readonly patchKey: string;
    readonly range: PatchRange;
}

export type DiffCommentAnnotation =
    | { readonly kind: "comment"; readonly comment: StoredDiffComment }
    | { readonly kind: "editor"; readonly pending: PendingComment };

interface CommentEditorProps {
    readonly title: string;
    readonly note: string;
    readonly notice: string | undefined;
    readonly onNoteChange: (note: string) => void;
    readonly onClose: () => void;
    readonly onAdd: () => boolean;
}

export function locationText(start: number, end: number, old: boolean): string {
    const range = start === end ? `Comment on line ${start}` : `Comment on lines ${start} to ${end}`;
    return old ? `${range} (old)` : range;
}

export function quoteNotice(range: PatchRange): string | undefined {
    if (range.quote.length > MAX_DIFF_COMMENT_LINES) return `Select no more than ${MAX_DIFF_COMMENT_LINES} code lines.`;
    if (range.quote.reduce((total, line) => total + line.length, 0) > MAX_DIFF_QUOTE_CHARS) {
        return `The selected code exceeds ${MAX_DIFF_QUOTE_CHARS} characters. Select a shorter range.`;
    }
    return undefined;
}

export function commentControlsEnabled(sessionId: string | undefined, patchKeys: readonly string[] | undefined, readable: boolean): boolean {
    return sessionId !== undefined && patchKeys !== undefined && patchKeys.length > 0 && readable;
}

// Pierre draws the box's slot a frame or more after React mounts the textarea,
// so retry until focus holds; a pointer or key event means the person moved on.
function useSlotFocus(revision: string) {
    const area = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        let attempts = 0;
        let handle = 0;
        let cancelled = false;
        let moved = false;
        const interrupt = (): void => { moved = true; };
        document.addEventListener("pointerdown", interrupt, true);
        document.addEventListener("keydown", interrupt, true);
        const attempt = (): void => {
            if (cancelled || moved) return;
            const node = area.current;
            if (node !== null && document.activeElement !== node) {
                node.focus({ preventScroll: true });
            }
            attempts += 1;
            if (attempts < 20) handle = requestAnimationFrame(attempt);
        };
        attempt();
        return () => {
            cancelled = true;
            cancelAnimationFrame(handle);
            document.removeEventListener("pointerdown", interrupt, true);
            document.removeEventListener("keydown", interrupt, true);
        };
    }, [revision]);
    return area;
}

export function commentEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, note: string, onClose: () => void, onAdd: () => boolean): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
        event.preventDefault();
        onClose();
    } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (note.trim()) onAdd();
        else onClose();
    }
}

export function CommentEditor({ title, note, notice, onNoteChange, onClose, onAdd }: CommentEditorProps) {
    const area = useSlotFocus(title);
    const canAdd = note.trim().length > 0;
    return <div className="diff-comment-box">
        <div className="diff-comment-head">
            <span className="diff-comment-who">You</span>
            <span className="diff-comment-where">{title}</span>
        </div>
        <textarea
            ref={area}
            autoFocus
            rows={2}
            maxLength={MAX_DIFF_COMMENT_CHARS}
            placeholder="Add a comment..."
            value={note}
            onChange={(event) => onNoteChange(event.currentTarget.value)}
            onKeyDown={(event) => commentEditorKeyDown(event, note, onClose, onAdd)}
        />
        {notice ? <div className="diff-comment-notice" role="status">{notice}</div> : null}
        <div className="diff-comment-actions">
            <button type="button" className="diff-comment-cancel" onClick={onClose}>Cancel</button>
            <button type="button" className="diff-comment-add" disabled={!canAdd} onClick={() => { if (canAdd) onAdd(); }}>Comment</button>
        </div>
    </div>;
}

export function CommentNote({ comment }: { readonly comment: StoredDiffComment }) {
    const title = comment.file === true
        ? comment.path
        : locationText(comment.startLine, comment.endLine, comment.side === "old");
    return <div className="diff-comment-box diff-comment-readonly">
        <div className="diff-comment-head">
            <span className="diff-comment-who">You</span>
            <span className="diff-comment-where">{title} · Added to prompt</span>
        </div>
        <div className="diff-comment-note">{comment.note}</div>
    </div>;
}

export function matchesComment(diff: FileDiffMetadata, comment: StoredDiffComment): boolean {
    if (comment.quote.length > MAX_DIFF_COMMENT_LINES) return false;
    if (comment.quote.reduce((total, line) => total + line.length, 0) > MAX_DIFF_QUOTE_CHARS) return false;
    const range = rangeInPatch(diff, comment.side, comment.startLine, comment.endLine);
    return range !== undefined && range.quote.every((line, index) => line === comment.quote[index]);
}

export function annotationForComment(comment: StoredDiffComment): DiffLineAnnotation<DiffCommentAnnotation> {
    return {
        side: annotationSide(comment.side),
        lineNumber: comment.endLine,
        metadata: { kind: "comment", comment },
    };
}

export function annotationForEditor(pending: PendingComment): DiffLineAnnotation<DiffCommentAnnotation> {
    return {
        side: annotationSide(pending.range.side),
        lineNumber: pending.range.endLine,
        metadata: { kind: "editor", pending },
    };
}

// Line zero is Pierre's file-level slot, shown under the header.
export function annotationForFileComment(comment: StoredDiffComment): DiffLineAnnotation<DiffCommentAnnotation> {
    return {
        side: "additions",
        lineNumber: 0,
        metadata: { kind: "comment", comment },
    };
}
