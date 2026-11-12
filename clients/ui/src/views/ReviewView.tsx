import { useMemo, useState } from "react";

import { FileIcon } from "../components/Icons.tsx";
import { useActiveSession, type ActiveSession } from "../session/activeSession.ts";
import { PatchView } from "../session/DiffRollup.tsx";
import { collectChanges, fileFolder, fileName, lastTurn, MAX_CHANGED_FILES, type FileChange } from "../session/changes.ts";
import type { Block } from "../session/model.ts";
import type { ViewProps } from "./env.tsx";

type Scope = "turn" | "session";

export function ReviewView({ visible }: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its changes.</p>;
    return <ReviewBody session={session} visible={visible} />;
}

function ReviewBody({ session, visible }: { readonly session: ActiveSession; readonly visible: boolean }) {
    const [scope, setScope] = useState<Scope>("turn");
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const { history, live, hasOlder } = session.watch;

    // Hidden views skip the walk over the transcript; the memo reruns when they show again.
    const changes = useMemo(() => {
        if (!visible) return [];
        const blocks: readonly Block[] = [...history, ...live];
        return collectChanges(scope === "turn" ? lastTurn(blocks) : blocks);
    }, [visible, scope, history, live]);

    const toggle = (path: string): void => {
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const added = changes.reduce((total, change) => total + change.added, 0);
    const removed = changes.reduce((total, change) => total + change.removed, 0);
    const noun = changes.length === 1 ? "file" : "files";

    return (
        <div className="review">
            <div className="right-seg" role="group" aria-label="Changes scope">
                <button
                    type="button"
                    className="right-seg-option"
                    aria-pressed={scope === "turn"}
                    data-on={scope === "turn"}
                    onClick={() => setScope("turn")}
                >
                    Last turn
                </button>
                <button
                    type="button"
                    className="right-seg-option"
                    aria-pressed={scope === "session"}
                    data-on={scope === "session"}
                    onClick={() => setScope("session")}
                >
                    Whole session
                </button>
            </div>
            {changes.length === 0 ? (
                <p className="view-empty">
                    {scope === "turn" ? "No file changes in this turn." : "No file changes in this session."}
                </p>
            ) : (
                <>
                    <p className="right-summary">
                        {changes.length} {noun} changed, <span className="change-add">+{added}</span>{" "}
                        <span className="change-del">−{removed}</span>
                    </p>
                    <ul className="change-list">
                        {changes.map((change) => (
                            <ChangeRow
                                key={change.path}
                                change={change}
                                folderRoot={session.folder}
                                open={expanded.has(change.path)}
                                onToggle={toggle}
                            />
                        ))}
                    </ul>
                    {changes.length >= MAX_CHANGED_FILES ? (
                        <p className="view-note">Showing the first {MAX_CHANGED_FILES} files.</p>
                    ) : null}
                </>
            )}
            {scope === "session" && hasOlder ? (
                <p className="view-note">Counts only the loaded part of the conversation.</p>
            ) : null}
        </div>
    );
}

interface ChangeRowProps {
    readonly change: FileChange;
    readonly folderRoot: string | undefined;
    readonly open: boolean;
    readonly onToggle: (path: string) => void;
}

function ChangeRow({ change, folderRoot, open, onToggle }: ChangeRowProps) {
    const folder = fileFolder(change.path, folderRoot);
    return (
        <li className="change" data-scratch={change.scratch} data-open={open}>
            <button
                type="button"
                className="change-head"
                aria-expanded={open}
                title={change.path}
                onClick={() => onToggle(change.path)}
            >
                <FileIcon className="change-icon" />
                <span className="change-name">{fileName(change.path)}</span>
                {folder === "" ? null : <span className="change-folder">{folder}</span>}
                {change.scratch ? <span className="change-tag">scratch</span> : null}
                <span className="change-stat">
                    <span className="change-add">+{change.added}</span>
                    <span className="change-del">−{change.removed}</span>
                </span>
            </button>
            {open ? <PatchView patches={change.patches} /> : null}
        </li>
    );
}
