import {
    CodeView,
    type CodeViewAnnotationArgs,
    type CodeViewItem,
    type DiffLineAnnotation,
    type FileDiffMetadata,
    type SelectedLineRange,
} from "@pierre/diffs/react";
import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { CORE_VIEWS } from "../registry/core.ts";
import { addDiffComment, getDiffComments, subscribeDiffComments, type StoredDiffComment } from "../composer/diff-comments.ts";
import { useActiveSession, type ActiveSession } from "../session/activeSession.ts";
import { MAX_PATCH_LINES, capDiff } from "../session/diff/cap.ts";
import { lineOrdinal, resolveKeyedRange } from "../session/diff/commentRange.ts";
import { diffOptions, type DiffStyle, type OverflowMode } from "../session/diff/pierreOptions.ts";
import { parseKeyedPatches, reviewItemId, splitKeyedPatches, type KeyedPatch } from "../session/diff/patches.ts";
import { DiffFileMenu } from "../session/DiffFileMenu.tsx";
import { DiffViewControls } from "../session/DiffViewControls.tsx";
import { CommentEditor, CommentNote, annotationForComment, annotationForEditor, locationText, matchesComment, quoteNotice, type DiffCommentAnnotation, type PendingComment } from "../session/DiffComments.tsx";
import { collectChanges, lastTurn, MAX_CHANGED_FILES, type FileChange } from "../session/changes.ts";
import { gateView } from "../session/liveSession.ts";
import type { Block } from "../session/model.ts";
import { StartOffer } from "../session/StartSession.tsx";
import type { ViewProps } from "./env.tsx";

type Scope = "turn" | "session";

interface ReviewRun {
    readonly key: string;
    readonly itemId: string;
    readonly patches: readonly KeyedPatch[];
    readonly diff: FileDiffMetadata;
    readonly cut: boolean;
}

interface ReviewFile {
    readonly change: FileChange;
    readonly runs: readonly ReviewRun[];
}

interface ReviewSelection {
    readonly id: string;
    readonly range: SelectedLineRange;
}

interface ReviewPending extends PendingComment {
    readonly fileId: string;
    readonly source: FileDiffMetadata;
}

function commentsSnapshot(sessionId: string | undefined): readonly StoredDiffComment[] {
    return sessionId === undefined ? [] : getDiffComments(sessionId);
}

function runAnnotationsKey(path: string, runKey: string): string {
    return `${path}\u0000${runKey}`;
}

export function ReviewView({ visible }: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its changes.</p>;
    return <ReviewBody session={session} visible={visible} />;
}

function ReviewBody({ session, visible }: { readonly session: ActiveSession; readonly visible: boolean }) {
    const [scope, setScope] = useState<Scope>("turn");
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
    const [overflow, setOverflow] = useState<OverflowMode>("wrap");
    const [direction, setDirection] = useState<ReviewSelection | null>(null);
    const [pending, setPending] = useState<ReviewPending>();
    const [note, setNote] = useState("");
    const [notice, setNotice] = useState<string>();
    const itemVersions = useRef(new Map<string, { signature: string; collapsed: boolean; diff: FileDiffMetadata; version: number }>());
    const { history, live, hasOlder } = session.watch;

    // Hidden views skip the walk over the transcript; the memo reruns when they show again.
    const changes = useMemo(() => {
        if (!visible) return [];
        const blocks: readonly Block[] = [...history, ...live];
        return collectChanges(scope === "turn" ? lastTurn(blocks) : blocks);
    }, [visible, scope, history, live]);

    const files = useMemo<ReviewFile[]>(() => changes.map((change) => {
        const keyed = parseKeyedPatches(change.patches, change.patchKeys);
        const runs = splitKeyedPatches(keyed, change.path).flatMap((run) => {
            const capped = capDiff(run.diff);
            return capped.diff.hunks.length === 0
                ? []
                : [{ key: run.key, patches: run.patches, diff: capped.diff, cut: capped.cut }];
        });
        return {
            change,
            runs: runs.map((run, index) => ({ ...run, itemId: reviewItemId(change.path, run.patches, index) })),
        };
    }), [changes]);

    const runByItem = useMemo(() => {
        const byItem = new Map<string, { file: ReviewFile; run: ReviewRun }>();
        for (const file of files) {
            for (const run of file.runs) byItem.set(run.itemId, { file, run });
        }
        return byItem;
    }, [files]);

    const comments = useSyncExternalStore(
        (listener) => subscribeDiffComments(session.agentId, listener),
        () => commentsSnapshot(session.agentId),
        () => commentsSnapshot(session.agentId),
    );

    const annotations = useMemo(() => {
        const byRun = new Map<string, DiffLineAnnotation<DiffCommentAnnotation>[]>();
        for (const file of files) {
            for (const run of file.runs) {
                const rows: DiffLineAnnotation<DiffCommentAnnotation>[] = [];
                for (const comment of comments) {
                    if (comment.path !== file.change.path) continue;
                    const source = run.patches.find((entry) => entry.key === comment.patchKey)?.diff;
                    if (source === undefined || !matchesComment(source, comment)) continue;
                    rows.push(annotationForComment(comment));
                }
                if (pending?.fileId === file.change.path && run.patches.some((entry) => entry.key === pending.patchKey)) {
                    rows.push(annotationForEditor(pending));
                }
                if (rows.length > 0) byRun.set(runAnnotationsKey(file.change.path, run.key), rows);
            }
        }
        return byRun;
    }, [files, comments, pending]);

    const items = useMemo<CodeViewItem<DiffCommentAnnotation>[]>(() => files.flatMap((file) => file.runs.map((run) => {
        const rows = annotations.get(runAnnotationsKey(file.change.path, run.key)) ?? [];
        const collapsedFlag = collapsed.has(file.change.path);
        const signature = JSON.stringify(rows);
        const previous = itemVersions.current.get(run.itemId);
        let version = previous?.version ?? 0;
        if (previous !== undefined && (previous.signature !== signature || previous.collapsed !== collapsedFlag || previous.diff !== run.diff)) {
            version += 1;
        }
        itemVersions.current.set(run.itemId, { signature, collapsed: collapsedFlag, diff: run.diff, version });
        return {
            id: run.itemId,
            type: "diff" as const,
            fileDiff: run.diff,
            annotations: rows,
            collapsed: collapsedFlag,
            version,
        };
    })), [files, annotations, collapsed]);

    const toggle = (path: string): void => {
        setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const resolveForItem = (itemId: string, range: SelectedLineRange): { pending: PendingComment; source: FileDiffMetadata; fileId: string } | undefined => {
        const entry = runByItem.get(itemId);
        if (entry === undefined) return undefined;
        const resolved = resolveKeyedRange(entry.run.patches, range);
        return resolved === undefined ? undefined : {
            pending: { patchKey: resolved.patchKey, range: resolved.range },
            source: resolved.diff,
            fileId: entry.file.change.path,
        };
    };

    const closeEditor = (): void => {
        setPending(undefined);
        setDirection(null);
        setNote("");
        setNotice(undefined);
    };

    const openEditor = (itemId: string, range: SelectedLineRange): void => {
        const resolved = resolveForItem(itemId, range);
        if (resolved === undefined) return;
        setDirection({ id: itemId, range });
        setPending({ ...resolved.pending, fileId: resolved.fileId, source: resolved.source });
        setNote("");
        setNotice(quoteNotice(resolved.pending.range));
    };

    const add = (): boolean => {
        if (pending === undefined || !note.trim()) return false;
        const notice = quoteNotice(pending.range);
        if (notice !== undefined) {
            setNotice(notice);
            return false;
        }
        const added = addDiffComment(session.agentId, {
            path: pending.fileId,
            side: pending.range.side,
            startLine: pending.range.startLine,
            endLine: pending.range.endLine,
            quote: [...pending.range.quote],
            note,
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

    const renderAnnotation = (...[annotation]: CodeViewAnnotationArgs<DiffCommentAnnotation>) => {
        const metadata = annotation.metadata;
        if (metadata === undefined) return null;
        if (metadata.kind === "comment") return <div className="diff-comment-cell"><CommentNote comment={metadata.comment} /></div>;
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

    const headerMetadata = (item: CodeViewItem<DiffCommentAnnotation>): ReactNode => {
        const entry = runByItem.get(item.id);
        if (entry === undefined) return null;
        const path = entry.file.change.path;
        return <div className="review-file-actions">
            {entry.run.cut ? <span className="review-file-note">First {MAX_PATCH_LINES} lines</span> : null}
            <DiffFileMenu
                path={path}
                open={!collapsed.has(path)}
                onToggle={() => toggle(path)}
                reveal={session.bridge.revealFolder}
            />
        </div>;
    };

    const added = changes.reduce((total, change) => total + change.added, 0);
    const removed = changes.reduce((total, change) => total + change.removed, 0);
    const noun = changes.length === 1 ? "file" : "files";
    const gate = gateView(CORE_VIEWS.review, session.watch);
    if (gate.kind === "start") return <StartOffer text="This session is not running. Start it to see its changes." onStart={session.start} />;
    if (gate.kind === "unavailable") return <p className="view-empty">{gate.reason}</p>;

    return (
        <div className="review">
            <div className="review-toolbar">
                <div className="right-seg" role="group" aria-label="Changes scope">
                    <button type="button" className="right-seg-option" aria-pressed={scope === "turn"} data-on={scope === "turn"} onClick={() => setScope("turn")}>Last turn</button>
                    <button type="button" className="right-seg-option" aria-pressed={scope === "session"} data-on={scope === "session"} onClick={() => setScope("session")}>Whole session</button>
                </div>
                <DiffViewControls
                    diffStyle={diffStyle}
                    overflow={overflow}
                    onDiffStyle={setDiffStyle}
                    onOverflow={setOverflow}
                />
                <p className="right-summary">
                    {changes.length} {noun} changed, <span className="change-add">+{added}</span>{" "}
                    <span className="change-del">−{removed}</span>
                </p>
            </div>
            {changes.length === 0 ? (
                <p className="view-empty">{scope === "turn" ? "No file changes in this turn." : "No file changes in this session."}</p>
            ) : (
                <CodeView<DiffCommentAnnotation, undefined>
                    className="review-diffs"
                    items={items}
                    selectedLines={direction}
                    onSelectedLinesChange={(selection) => {
                        setDirection(selection);
                        if (selection !== null && pending !== undefined) {
                            const resolved = resolveForItem(selection.id, selection.range);
                            if (resolved !== undefined) setPending({ ...resolved.pending, fileId: resolved.fileId, source: resolved.source });
                        }
                    }}
                    options={{
                        ...diffOptions(diffStyle, overflow),
                        disableFileHeader: false,
                        stickyHeaders: true,
                        enableLineSelection: true,
                        enableGutterUtility: true,
                        onGutterUtilityClick: (range: SelectedLineRange, context) => {
                            openEditor(context.item.id, range);
                        },
                    }}
                    renderHeaderMetadata={headerMetadata}
                    renderAnnotation={renderAnnotation}
                />
            )}
            {scope === "session" && hasOlder ? <p className="view-note">Counts only the loaded part of the conversation.</p> : null}
            {changes.length >= MAX_CHANGED_FILES ? <p className="view-note">Showing the first {MAX_CHANGED_FILES} files.</p> : null}
        </div>
    );
}
