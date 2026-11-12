import { useMemo, useState } from "react";

import { ChevronDownIcon, ChevronRightIcon, DiffIcon, FileIcon } from "../components/Icons.tsx";
import { CORE_CONTAINERS } from "../registry/core.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { revealContainer } from "../workbench/reveal.ts";
import { type FileChange, fileFolder, fileName } from "./changes.ts";

const COLLAPSED_ROWS = 5;
const MAX_PATCH_LINES = 400;
const MINUS = "−";

export interface DiffRollupProps {
    readonly changes: readonly FileChange[];
    readonly folder?: string;
}

export function DiffRollup({ changes, folder }: DiffRollupProps) {
    const workbench = useWorkbench();
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
                <button
                    type="button"
                    className="diff-review"
                    onClick={() => revealContainer(workbench, CORE_CONTAINERS.review)}
                >
                    Review
                </button>
            </div>
            <div className="diff-files">
                {shown.map((change) => (
                    <FileRow key={change.path} change={change} folder={folder} />
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

function FileRow({ change, folder }: { readonly change: FileChange; readonly folder?: string }) {
    const [open, setOpen] = useState(false);
    const folderText = fileFolder(change.path, folder);
    return (
        <div className="diff-file" data-open={open}>
            <button type="button" className="diff-file-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                <FileIcon className="diff-file-icon" />
                <span className="diff-file-name">{fileName(change.path)}</span>
                {folderText === "" ? null : <span className="diff-file-folder">{folderText}</span>}
                {change.scratch ? <span className="diff-tag">scratch</span> : null}
                <span className="diff-file-grow" />
                <Tally added={change.added} removed={change.removed} />
                {open ? <ChevronDownIcon className="diff-chev" /> : <ChevronRightIcon className="diff-chev" />}
            </button>
            {open ? <PatchView patches={change.patches} /> : null}
        </div>
    );
}

interface PatchLines {
    readonly lines: readonly string[];
    readonly cut: boolean;
}

// Reads at most MAX_PATCH_LINES + 1 lines, so a huge patch is never split whole.
// The file row already names the file, so the patch's file headers are dropped.
export function patchLines(patches: readonly string[]): PatchLines {
    const lines: string[] = [];
    for (const patch of patches) {
        const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
        for (const line of body.split("\n")) {
            if (isFileHeader(line)) continue;
            if (lines.length === MAX_PATCH_LINES) return { lines, cut: true };
            lines.push(line);
        }
    }
    return { lines, cut: false };
}

function isFileHeader(line: string): boolean {
    return line.startsWith("Index: ") || line.startsWith("===") || line.startsWith("+++ ") || line.startsWith("--- ");
}

type LineKind = "add" | "del" | "hunk" | "header" | "context";

function lineKind(line: string): LineKind {
    if (line.startsWith("+++") || line.startsWith("---")) return "header";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "context";
}

export function PatchView({ patches }: { readonly patches: readonly string[] }) {
    const { lines, cut } = useMemo(() => patchLines(patches), [patches]);
    return (
        <div className="diff-patch">
            {lines.map((line, index) => (
                <div key={index} className="diff-line" data-kind={lineKind(line)}>{line === "" ? " " : line}</div>
            ))}
            {cut ? <div className="diff-note">Patch cut at {MAX_PATCH_LINES} lines</div> : null}
        </div>
    );
}
