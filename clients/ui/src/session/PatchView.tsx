import { FileDiff, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs/react";
import { useMemo, useState, useSyncExternalStore } from "react";

import { addDiffComment, getDiffComments, subscribeDiffComments, type StoredDiffComment } from "../composer/diff-comments.ts";
import { CommentEditor, CommentNote, annotationForComment, annotationForEditor, commentControlsEnabled, locationText, matchesComment, quoteNotice, type DiffCommentAnnotation, type PendingComment } from "./DiffComments.tsx";
import { MAX_PATCH_LINES, capDiff } from "./diff/cap.ts";
import { lineOrdinal, resolveKeyedRange } from "./diff/commentRange.ts";
import { diffOptions } from "./diff/pierreOptions.ts";
import { parseKeyedPatches, rawPatchText, splitKeyedPatches, type KeyedPatch, type KeyedPatchRun } from "./diff/patches.ts";

export interface PatchViewProps {
    readonly path: string;
    readonly patches: readonly string[];
    readonly sessionId?: string;
    readonly patchKeys?: readonly string[];
}

interface PatchRun {
    readonly key: string;
    readonly patches: readonly KeyedPatch[];
    readonly diff: FileDiffMetadata;
    readonly cut: boolean;
}

interface PatchSelection {
    readonly runKey: string;
    readonly range: SelectedLineRange;
}

const EMPTY_COMMENTS: readonly StoredDiffComment[] = [];

function commentsSnapshot(sessionId: string | undefined): readonly StoredDiffComment[] {
    return sessionId === undefined ? EMPTY_COMMENTS : getDiffComments(sessionId);
}

function cappedRuns(runs: readonly KeyedPatchRun[]): PatchRun[] {
    return runs.flatMap((run) => {
        const capped = capDiff(run.diff);
        return capped.diff.hunks.length === 0
            ? []
            : [{ key: run.key, patches: run.patches, diff: capped.diff, cut: capped.cut }];
    });
}

export function PatchView({ path, patches, sessionId, patchKeys }: PatchViewProps) {
    const keyed = useMemo(() => parseKeyedPatches(patches, patchKeys ?? []), [patches, patchKeys]);
    const runs = useMemo(() => cappedRuns(splitKeyedPatches(keyed, path)), [keyed, path]);
    const [selection, setSelection] = useState<PatchSelection | null>(null);
    const [pending, setPending] = useState<PendingComment>();
    const [note, setNote] = useState("");
    const [notice, setNotice] = useState<string>();
    const comments = useSyncExternalStore(
        (listener) => sessionId === undefined ? () => {} : subscribeDiffComments(sessionId, listener),
        () => commentsSnapshot(sessionId),
        () => commentsSnapshot(sessionId),
    );
    const enabled = commentControlsEnabled(sessionId, patchKeys, runs.length > 0);
    const matched = useMemo(() => {
        if (!enabled) return [];
        return comments.filter((comment) => {
            if (comment.path !== path) return false;
            const source = keyed.find((entry) => entry.key === comment.patchKey)?.diff;
            return source !== undefined && matchesComment(source, comment);
        });
    }, [comments, enabled, keyed, path]);
    const annotations = useMemo(() => {
        const byRun = new Map<string, DiffLineAnnotation<DiffCommentAnnotation>[]>();
        for (const run of runs) {
            const rows: DiffLineAnnotation<DiffCommentAnnotation>[] = matched
                .filter((comment) => run.patches.some((entry) => entry.key === comment.patchKey))
                .map(annotationForComment);
            if (pending !== undefined && run.patches.some((entry) => entry.key === pending.patchKey)) {
                rows.push(annotationForEditor(pending));
            }
            byRun.set(run.key, rows);
        }
        return byRun;
    }, [runs, matched, pending]);
    const closeEditor = (): void => {
        setPending(undefined);
        setSelection(null);
        setNote("");
        setNotice(undefined);
    };
    const openEditor = (run: PatchRun, range: SelectedLineRange): void => {
        if (!enabled) return;
        const resolved = resolveKeyedRange(run.patches, range);
        if (resolved === undefined) return;
        setSelection({ runKey: run.key, range });
        setPending({ patchKey: resolved.patchKey, range: resolved.range });
        setNote("");
        setNotice(quoteNotice(resolved.range));
    };
    const select = (run: PatchRun, range: SelectedLineRange | null): void => {
        if (!enabled) return;
        if (range === null) {
            setSelection(null);
            return;
        }
        setSelection({ runKey: run.key, range });
        if (pending !== undefined) {
            const resolved = resolveKeyedRange(run.patches, range);
            if (resolved !== undefined) setPending({ patchKey: resolved.patchKey, range: resolved.range });
        }
    };
    const add = (): boolean => {
        if (sessionId === undefined || pending === undefined || !note.trim()) return false;
        const notice = quoteNotice(pending.range);
        if (notice !== undefined) {
            setNotice(notice);
            return false;
        }
        const source = keyed.find((entry) => entry.key === pending.patchKey)?.diff;
        if (source === undefined) return false;
        const added = addDiffComment(sessionId, {
            path,
            side: pending.range.side,
            startLine: pending.range.startLine,
            endLine: pending.range.endLine,
            quote: [...pending.range.quote],
            note,
            patchKey: pending.patchKey,
            startRow: lineOrdinal(source, pending.range.side, pending.range.startLine),
            endRow: lineOrdinal(source, pending.range.side, pending.range.endLine),
        });
        if (!added) {
            setNotice("Could not add this comment. The session may have reached its comment limit.");
            return false;
        }
        closeEditor();
        return true;
    };
    const renderAnnotation = (annotation: { readonly metadata?: DiffCommentAnnotation }) => {
        const metadata = annotation.metadata;
        if (metadata === undefined) return null;
        if (metadata.kind === "comment") {
            return <div className="diff-comment-cell"><CommentNote comment={metadata.comment} /></div>;
        }
        const range = metadata.pending.range;
        return <div className="diff-comment-cell">
            <CommentEditor
                title={locationText(range.startLine, range.endLine, range.side === "old")}
                note={note}
                notice={notice}
                onNoteChange={setNote}
                onClose={closeEditor}
                onAdd={add}
            />
        </div>;
    };
    if (runs.length === 0) {
        const raw = rawPatchText(patches);
        return <div className="diff-patch" data-path={path}>
            <div className="diff-error">Could not read this patch.</div>
            {raw.trim() === "" ? null : <pre className="diff-raw">{raw}</pre>}
        </div>;
    }
    return <div className="diff-patch" data-path={path}>
        {runs.some((run) => run.cut) ? <p className="diff-note">Showing the first {MAX_PATCH_LINES} lines of this patch.</p> : null}
        {runs.map((run) => (
            <FileDiff<DiffCommentAnnotation, undefined>
                key={run.key}
                fileDiff={run.diff}
                lineAnnotations={annotations.get(run.key) ?? []}
                selectedLines={selection?.runKey === run.key ? selection.range : null}
                renderAnnotation={renderAnnotation}
                options={{
                    ...diffOptions("unified", "wrap"),
                    enableLineSelection: enabled,
                    enableGutterUtility: enabled,
                    onLineSelected: (range) => select(run, range),
                    onGutterUtilityClick: (range) => openEditor(run, range),
                }}
            />
        ))}
    </div>;
}
