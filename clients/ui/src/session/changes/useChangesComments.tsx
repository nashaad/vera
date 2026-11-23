import { useMemo, useSyncExternalStore, useState, type ReactNode } from "react";
import type { CodeViewAnnotationArgs } from "@pierre/diffs/react";
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";

import type { GitChangedFile, GitFileList, GitScope } from "../../../../shared/git-wire.ts";
import { addDiffComment, getDiffComments, subscribeDiffComments, type StoredDiffComment } from "../../composer/diff-comments.ts";
import { annotationForComment, annotationForEditor, annotationForFileComment, CommentEditor, CommentNote, locationText, matchesComment, quoteNotice } from "../DiffComments.tsx";
import { lineOrdinal, resolveKeyedRange } from "../diff/commentRange.ts";
import { gitPatchKey } from "../gitChanges.ts";
import type { ActiveSession } from "../activeSession.ts";
import type { ChangesAnnotation, ChangesPending, PatchCache } from "./types.ts";

function commentsSnapshot(sessionId: string | undefined): readonly StoredDiffComment[] {
    return sessionId === undefined ? [] : getDiffComments(sessionId);
}

// Line zero is Pierre's file-level slot, shown under the header.
function annotationForChangesEditor(path: string): DiffLineAnnotation<ChangesAnnotation> {
    return { side: "additions", lineNumber: 0, metadata: { kind: "file-editor", path } };
}

interface ChangesCommentsInput {
    readonly session: ActiveSession;
    readonly list: GitFileList | undefined;
    readonly scope: GitScope;
    readonly filesByPath: ReadonlyMap<string, GitChangedFile>;
    readonly cache: PatchCache;
    readonly patchVersion: number;
}

// Line and file comments: the editor that opens from the gutter or the file menu,
// the stored comments as CodeView annotations, and adding them.
export function useChangesComments({ session, list, scope, filesByPath, cache, patchVersion }: ChangesCommentsInput) {
    const [pending, setPending] = useState<ChangesPending>();
    const [direction, setDirection] = useState<{ readonly id: string; readonly range: SelectedLineRange } | null>(null);
    const [lineNote, setLineNote] = useState("");
    const [filePath, setFilePath] = useState<string | undefined>();
    const [fileNote, setFileNote] = useState("");
    const [notice, setNotice] = useState<string | undefined>();

    const comments = useSyncExternalStore(
        (listener) => subscribeDiffComments(session.agentId, listener),
        () => commentsSnapshot(session.agentId),
        () => commentsSnapshot(session.agentId),
    );

    const closeEditor = (): void => {
        setPending(undefined);
        setDirection(null);
        setFilePath(undefined);
        setLineNote("");
        setFileNote("");
        setNotice(undefined);
    };

    const openLineEditor = (itemId: string, range: SelectedLineRange): void => {
        const file = filesByPath.get(itemId);
        const patch = file === undefined ? undefined : cache.current.get(file.path);
        if (file === undefined || patch?.source.diff === undefined) return;
        const resolved = resolveKeyedRange([patch.source], range);
        if (resolved === undefined) return;
        setFilePath(undefined);
        setDirection({ id: itemId, range });
        setPending({ patchKey: resolved.patchKey, range: resolved.range, path: file.path, source: resolved.diff });
        setFileNote("");
        setLineNote("");
        setNotice(quoteNotice(resolved.range));
    };

    const openFileEditor = (path: string): void => {
        setPending(undefined);
        setDirection(null);
        setLineNote("");
        setFilePath((current) => current === path ? undefined : path);
        setFileNote("");
        setNotice(undefined);
    };

    const addLineComment = (): boolean => {
        if (pending === undefined || !lineNote.trim()) return false;
        const warning = quoteNotice(pending.range);
        if (warning !== undefined) {
            setNotice(warning);
            return false;
        }
        const added = addDiffComment(session.agentId, {
            path: pending.path,
            side: pending.range.side,
            startLine: pending.range.startLine,
            endLine: pending.range.endLine,
            quote: [...pending.range.quote],
            note: lineNote,
            patchKey: pending.patchKey,
            startRow: lineOrdinal(pending.source, pending.range.side, pending.range.startLine),
            endRow: lineOrdinal(pending.source, pending.range.side, pending.range.endLine),
        });
        if (!added) {
            setNotice("Could not add this comment. The session may have reached its comment limit.");
            return false;
        }
        closeEditor();
        return true;
    };

    const addFileComment = (): boolean => {
        if (filePath === undefined || !fileNote.trim()) return false;
        const base = list?.base ?? "";
        const added = addDiffComment(session.agentId, {
            path: filePath,
            side: "new",
            startLine: 0,
            endLine: 0,
            quote: [],
            note: fileNote,
            file: true,
            patchKey: gitPatchKey(scope, base, filePath),
            startRow: 0,
            endRow: 0,
        });
        if (!added) {
            setNotice("Could not add this comment. The session may have reached its comment limit.");
            return false;
        }
        closeEditor();
        return true;
    };

    const annotations = useMemo(() => {
        const byPath = new Map<string, DiffLineAnnotation<ChangesAnnotation>[]>();
        for (const file of list?.files ?? []) {
            const patch = cache.current.get(file.path);
            const rows: DiffLineAnnotation<ChangesAnnotation>[] = [];
            for (const comment of comments) {
                if (comment.path !== file.path) continue;
                if (comment.file === true) rows.push(annotationForFileComment(comment));
                else if (patch?.source.diff !== undefined && matchesComment(patch.source.diff, comment)) rows.push(annotationForComment(comment));
            }
            if (filePath === file.path && patch !== undefined) rows.push(annotationForChangesEditor(file.path));
            if (pending !== undefined && pending.path === file.path && patch?.source.diff !== undefined) rows.push(annotationForEditor(pending));
            if (rows.length > 0) byPath.set(file.path, rows);
        }
        return byPath;
    }, [list, comments, pending, filePath, patchVersion]);

    const renderAnnotation = (...[annotation]: CodeViewAnnotationArgs<ChangesAnnotation>): ReactNode => {
        const metadata = annotation.metadata;
        if (metadata === undefined) return null;
        if (metadata.kind === "comment") return <div className="diff-comment-cell"><CommentNote comment={metadata.comment} /></div>;
        if (metadata.kind === "file-editor") {
            return <div className="diff-comment-cell">
                <CommentEditor
                    title={metadata.path}
                    note={fileNote}
                    notice={notice}
                    onNoteChange={setFileNote}
                    onClose={closeEditor}
                    onAdd={addFileComment}
                />
            </div>;
        }
        const range = metadata.pending.range;
        return <div className="diff-comment-cell">
            <CommentEditor
                title={locationText(range.startLine, range.endLine, range.side === "old")}
                note={lineNote}
                notice={notice}
                onNoteChange={setLineNote}
                onClose={closeEditor}
                onAdd={addLineComment}
            />
        </div>;
    };

    return {
        pending,
        setPending,
        direction,
        setDirection,
        filePath,
        annotations,
        renderAnnotation,
        openLineEditor,
        openFileEditor,
    };
}
