import { CodeView, type CodeViewAnnotationArgs, type CodeViewHandle } from "@pierre/diffs/react";
import type { CodeViewItem, LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import type { FileLineChange } from "../protocol/bridge.ts";
import { addDiffComment, getDiffComments, subscribeDiffComments, type StoredDiffComment } from "../composer/diff-comments.ts";
import { CommentEditor, CommentNote, locationText, quoteNotice } from "../session/DiffComments.tsx";
import { diffOptions } from "../session/diff/pierreOptions.ts";
import { pathUnder } from "./files.ts";
import { fileChangeGutterCss } from "./file-change-css.ts";
import "../styles/files-code.css";

export interface FilesCodeProps {
    readonly sessionId: string;
    readonly folder: string;
    readonly path: string;
    readonly contents: string;
    readonly wordWrap: boolean;
    readonly scrollPastEnd: boolean;
    readonly tabSize: 2 | 4 | 8;
    readonly targetLine?: { readonly line: number; readonly request: number };
    readonly changes: readonly FileLineChange[];
}

type FilesCodeAnnotation =
    | { readonly kind: "comment"; readonly comment: StoredDiffComment }
    | { readonly kind: "editor"; readonly line: number };

function validLine(line: number, count: number): boolean {
    return Number.isSafeInteger(line) && line >= 1 && line <= count;
}

export function FilesCode({ sessionId, folder, path, contents, wordWrap, scrollPastEnd, tabSize, targetLine, changes }: FilesCodeProps) {
    const view = useRef<CodeViewHandle<FilesCodeAnnotation, undefined> | null>(null);
    const targetTimer = useRef<number | undefined>(undefined);
    const [editorLine, setEditorLine] = useState<number>();
    const [selection, setSelection] = useState<SelectedLineRange | null>(null);
    const [note, setNote] = useState("");
    const [notice, setNotice] = useState<string>();
    const lines = useMemo(() => contents.split("\n"), [contents]);
    const comments = useSyncExternalStore(
        (listener) => subscribeDiffComments(sessionId, listener),
        () => getDiffComments(sessionId),
        () => getDiffComments(sessionId),
    );
    const relativePath = useMemo(() => pathUnder(folder, path), [folder, path]);
    const commentsForFile = useMemo(() => comments.filter((comment) => comment.path === relativePath
        && comment.file !== true && comment.side === "new"
        && comment.endLine <= lines.length
        && lines.slice(comment.startLine - 1, comment.endLine).length === comment.quote.length
        && lines.slice(comment.startLine - 1, comment.endLine).every((line, index) => (line.endsWith("\r") ? line.slice(0, -1) : line) === comment.quote[index])),  [comments, relativePath, lines]);

    useEffect(() => () => window.clearTimeout(targetTimer.current), []);
    useEffect(() => {
        if (targetLine === undefined || !validLine(targetLine.line, lines.length)) return;
        view.current?.scrollTo({ type: "line", id: path, lineNumber: targetLine.line, align: "center", behavior: "smooth" });
        view.current?.setSelectedLines({ id: path, range: { start: targetLine.line, end: targetLine.line } });
        window.clearTimeout(targetTimer.current);
        targetTimer.current = window.setTimeout(() => view.current?.clearSelectedLines(), 1400);
    }, [targetLine?.request, targetLine?.line, path, lines.length]);

    const annotations = useMemo<LineAnnotation<FilesCodeAnnotation>[]>(() => {
        const rows: LineAnnotation<FilesCodeAnnotation>[] = [];
        for (const comment of commentsForFile) {
            if (validLine(comment.endLine, lines.length)) rows.push({ lineNumber: comment.endLine, metadata: { kind: "comment", comment } });
        }
        if (editorLine !== undefined && validLine(editorLine, lines.length)) {
            rows.push({ lineNumber: editorLine, metadata: { kind: "editor", line: editorLine } });
        }
        return rows;
    }, [commentsForFile, editorLine, lines.length]);

    const revision = useRef({ contents, annotations, version: 0 });
    if (revision.current.contents !== contents || revision.current.annotations !== annotations) {
        revision.current = { contents, annotations, version: revision.current.version + 1 };
    }
    const item = useMemo<CodeViewItem<FilesCodeAnnotation>>(() => ({
        id: path,
        type: "file",
        file: { name: path, contents },
        annotations,
        version: revision.current.version,
    }), [path, contents, annotations]);
    const gutterCss = useMemo(() => fileChangeGutterCss(changes, lines.length), [changes, lines.length]);
    const baseOptions = diffOptions("unified", wordWrap ? "wrap" : "scroll");

    const openEditor = (range: SelectedLineRange): void => {
        if (!validLine(range.start, lines.length) || !validLine(range.end, lines.length)) return;
        const first = Math.min(range.start, range.end);
        setSelection({ start: first, end: Math.max(range.start, range.end) });
        setEditorLine(Math.max(range.start, range.end));
        setNote("");
        setNotice(undefined);
    };
    const closeEditor = (): void => {
        setEditorLine(undefined);
        setSelection(null);
        setNote("");
        setNotice(undefined);
    };
    const addComment = (): boolean => {
        if (editorLine === undefined || selection === null || !note.trim()) return false;
        const quote = lines.slice(selection.start - 1, selection.end).map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
        const range = { side: "new" as const, startLine: selection.start, endLine: selection.end, quote };
        const warning = quoteNotice(range);
        if (warning !== undefined) {
            setNotice(warning);
            return false;
        }
        const added = addDiffComment(sessionId, {
            path: relativePath,
            side: "new",
            startLine: selection.start,
            endLine: selection.end,
            quote,
            note,
            patchKey: "file",
            startRow: selection.start - 1,
            endRow: selection.end - 1,
        });
        if (added === undefined) {
            setNotice("Could not add this comment. The session may have reached its comment limit.");
            return false;
        }
        closeEditor();
        return true;
    };

    const renderAnnotation = (...[annotation]: CodeViewAnnotationArgs<FilesCodeAnnotation>): ReactNode => {
        const metadata = annotation.metadata;
        if (metadata === undefined) return null;
        if (metadata.kind === "comment") return <div className="diff-comment-cell"><CommentNote comment={metadata.comment} /></div>;
        return <div className="diff-comment-cell">
            <CommentEditor
                title={locationText(selection?.start ?? metadata.line, selection?.end ?? metadata.line, false)}
                note={note}
                notice={notice}
                onNoteChange={setNote}
                onClose={closeEditor}
                onAdd={addComment}
            />
        </div>;
    };

    return <div className="files-code" style={{ "--files-code-tab-size": tabSize } as CSSProperties}>
        <CodeView<FilesCodeAnnotation, undefined>
            ref={view}
            items={[item]}
            renderAnnotation={renderAnnotation}
            renderCodeViewFooter={scrollPastEnd ? () => <div className="files-code-scroll-space" /> : undefined}
            selectedLines={selection === null ? null : { id: path, range: selection }}
            onSelectedLinesChange={(selected) => setSelection(selected?.range ?? null)}
            options={{
                ...baseOptions,
                unsafeCSS: `${baseOptions.unsafeCSS}\n${gutterCss}`,
                onLineNumberClick: ({ lineNumber, event }) => {
                    if (event.shiftKey && selection !== null) openEditor({ start: selection.start, end: lineNumber });
                    else openEditor({ start: lineNumber, end: lineNumber });
                },
                onGutterUtilityClick: openEditor,
                onLineSelectionEnd: (range) => {
                    if (range !== null) openEditor(range);
                },
            }}
        />
    </div>;
}
