import { XIcon } from "../components/Icons.tsx";
import { removeDiffComment, type StoredDiffComment } from "./diff-comments.ts";

interface DiffCommentChipsProps {
    readonly sessionId: string;
    readonly comments: readonly StoredDiffComment[];
}

export function DiffCommentChips({ sessionId, comments }: DiffCommentChipsProps) {
    if (comments.length === 0) return null;
    return (
        <div className="context-chips attached">
            {comments.map((comment) => {
                const line = comment.startLine === comment.endLine
                    ? `${comment.startLine}`
                    : `${comment.startLine}-${comment.endLine}`;
                const location = comment.file === true
                    ? comment.path
                    : `${comment.path}:${line}${comment.side === "old" ? " (old)" : ""}`;
                const label = comment.note.trim().replace(/\s+/g, " ");
                return (
                    <span className="chip chip-file diff-comment-chip" key={comment.id} title={`${location}: ${comment.note}`}>
                        <span className="chip-label diff-comment-chip-note">{label}</span>
                        <span aria-hidden="true">·</span>
                        <span className="diff-comment-chip-location">{location}</span>
                        <button
                            type="button"
                            className="chip-x"
                            title={`Remove comment on ${location}`}
                            aria-label={`Remove comment on ${location}`}
                            onClick={() => removeDiffComment(sessionId, comment.id)}
                        ><XIcon className="chip-x-icon" /></button>
                    </span>
                );
            })}
        </div>
    );
}
