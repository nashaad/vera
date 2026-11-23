import { useState } from "react";

import { ChevronDownIcon, ChevronRightIcon, DiffIcon, FileIcon } from "../components/Icons.tsx";
import { CORE_CONTAINERS } from "../registry/core.ts";
import { useSurface } from "../state/useSurfaces.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { revealContainer } from "../workbench/reveal.ts";
import { activeSession } from "./activeSession.ts";
import { type FileChange, fileFolder, fileName } from "./changes.ts";
import { firstNewSideLine, openFileInFiles } from "./fileOpen.ts";
import { parseKeyedPatches } from "./diff/patches.ts";
import { DiffFileMenu, isAbsolutePath } from "./DiffFileMenu.tsx";
import { PatchView } from "./PatchView.tsx";

const COLLAPSED_ROWS = 5;
const MINUS = "−";

export interface DiffRollupProps {
    readonly changes: readonly FileChange[];
    readonly folder?: string;
    readonly sessionId?: string | undefined;
}

export function DiffRollup({ changes, folder, sessionId }: DiffRollupProps) {
    const workbench = useWorkbench();
    const review = useSurface("review");
    const [showAll, setShowAll] = useState(false);
    const added = changes.reduce((total, change) => total + change.added, 0);
    const removed = changes.reduce((total, change) => total + change.removed, 0);
    const shown = showAll ? changes : changes.slice(0, COLLAPSED_ROWS);
    const hidden = changes.length - shown.length;
    return (
        <div className="diff-rollup">
            <div className="diff-rollup-head">
                <DiffIcon className="diff-rollup-icon" />
                <span className="diff-rollup-title">
                    Edited {changes.length} {changes.length === 1 ? "file" : "files"}
                </span>
                <Tally added={added} removed={removed} />
                {review ? (
                    <button
                        type="button"
                        className="diff-review"
                        onClick={() => revealContainer(workbench, CORE_CONTAINERS.review)}
                    >
                        Review
                    </button>
                ) : null}
            </div>
            <div className="diff-files">
                {shown.map((change) => (
                    <FileRow key={change.path} change={change} folder={folder} sessionId={sessionId} />
                ))}
                {hidden > 0 ? (
                    <button type="button" className="diff-more" onClick={() => setShowAll(true)}>
                        Show {hidden} more {hidden === 1 ? "file" : "files"}
                        <ChevronDownIcon className="diff-chev" />
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function Tally({ added, removed }: { readonly added: number; readonly removed: number }) {
    return (
        <span className="diff-tally">
            {added > 0 ? <span className="add">+{added}</span> : null}
            {added > 0 && removed > 0 ? " " : null}
            {removed > 0 ? <span className="del">{MINUS}{removed}</span> : null}
        </span>
    );
}

function FileRow({ change, folder, sessionId }: { readonly change: FileChange; readonly folder?: string; readonly sessionId: string | undefined }) {
    const workbench = useWorkbench();
    const [open, setOpen] = useState(false);
    const folderText = fileFolder(change.path, folder);
    const reveal = activeSession()?.bridge.revealFolder;
    const openInFiles = sessionId === undefined || folder === undefined ? undefined : () => {
        const separator = folder.includes("/") || !folder.includes("\\") ? "/" : "\\";
        const fullPath = isAbsolutePath(change.path)
            ? change.path
            : folder.endsWith(separator) ? `${folder}${change.path}` : `${folder}${separator}${change.path}`;
        const hunks = parseKeyedPatches(change.patches, change.patchKeys)
            .flatMap((patch) => patch.diff?.hunks ?? []);
        openFileInFiles(workbench, sessionId, fullPath, firstNewSideLine(hunks));
    };
    return (
        <div className="diff-file" data-open={open}>
            <div className="diff-file-head">
                <button type="button" className="diff-file-open" aria-expanded={open} onClick={() => setOpen(!open)}>
                    <FileIcon className="diff-file-icon" />
                    <span className="diff-file-name">{fileName(change.path)}</span>
                    {folderText === "" ? null : <span className="diff-file-folder">{folderText}</span>}
                    {change.scratch ? <span className="diff-tag">scratch</span> : null}
                    <span className="diff-file-grow" />
                    <Tally added={change.added} removed={change.removed} />
                    {open ? <ChevronDownIcon className="diff-chev" /> : <ChevronRightIcon className="diff-chev" />}
                </button>
                <DiffFileMenu path={change.path} open={open} onToggle={() => setOpen(!open)} reveal={reveal} openInFiles={openInFiles} />
            </div>
            {open ? <PatchView
                key={sessionId}
                path={change.path}
                patches={change.patches}
                patchKeys={change.patchKeys}
                sessionId={sessionId}
            /> : null}
        </div>
    );
}
