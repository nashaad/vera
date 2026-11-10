import { extname, isAbsolute, relative } from "node:path";

import { createTwoFilesPatch } from "diff";

import type { ToolPresentation } from "../model/types.ts";
import { markJustDone, parseChecklist } from "./checklist.ts";

const MAX_DIFF_BYTES = 64 * 1024;
const MAX_DIFF_LINES = 400;

const DESTRUCTIVE_LOSS_PERCENT = 50;

/**
 * Presents a file change. Writes inside the scratch directory are working
 * notes: a markdown task list there becomes a checklist, anything else a
 * diff marked as scratch.
 */
export function fileChangePresentation(
    requestedPath: string,
    resolvedPath: string,
    before: string,
    after: string,
    directories: {
        readonly stashDirectory: string | undefined;
        readonly scratchDirectory: string | undefined;
    },
): ToolPresentation {
    const diff = editDiffPresentation(
        requestedPath,
        before,
        after,
        directories.stashDirectory,
    );
    if (!isInside(resolvedPath, directories.scratchDirectory)) {
        return diff;
    }
    if (extname(resolvedPath).toLowerCase() === ".md") {
        const checklist = parseChecklist(after);
        if (checklist !== undefined) {
            // A new list was written, not ticked, so nothing in it is just done.
            const previous = parseChecklist(before);
            return {
                kind: "checklist",
                path: requestedPath,
                ...(checklist.title === undefined
                    ? {}
                    : { title: checklist.title }),
                items: previous === undefined
                    ? checklist.items
                    : markJustDone(previous.items, checklist.items),
            };
        }
    }
    return diff.kind === "unified_diff" ? { ...diff, scratch: true } : diff;
}

function isInside(path: string, directory: string | undefined): boolean {
    if (directory === undefined) return false;
    const rel = relative(directory, path);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

export function editDiffPresentation(
    path: string,
    before: string,
    after: string,
    stashDirectory?: string,
): ToolPresentation {
    const independent = oversizedIndependentDiff(path, before, after);
    if (independent !== undefined) {
        return oversizedDiffNotice(path, before, after, stashDirectory, independent);
    }
    const patch = createTwoFilesPatch(path, path, before, after, "", "", {
        context: 3,
    });
    const bytes = Buffer.byteLength(patch);
    const lines = patch.split("\n").length;
    if (bytes > MAX_DIFF_BYTES || lines > MAX_DIFF_LINES) {
        return oversizedDiffNotice(path, before, after, stashDirectory, diffCounts(patch));
    }
    return { kind: "unified_diff", path, patch };
}

interface DiffCounts {
    added: number;
    removed: number;
}

function oversizedIndependentDiff(
    path: string,
    before: string,
    after: string,
): DiffCounts | undefined {
    if (before === after || before.length + after.length < MAX_DIFF_LINES) return undefined;
    let prefix = 0;
    const limit = Math.min(before.length, after.length);
    while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
        prefix += 1;
    }
    prefix = prefix === 0 ? 0 : before.lastIndexOf("\n", prefix - 1) + 1;

    let oldEnd = before.length;
    let newEnd = after.length;
    while (oldEnd > prefix && newEnd > prefix
        && before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) {
        oldEnd -= 1;
        newEnd -= 1;
    }
    const oldAtLineStart = oldEnd === 0 || before[oldEnd - 1] === "\n";
    const newAtLineStart = newEnd === 0 || after[newEnd - 1] === "\n";
    if (oldEnd < before.length && (!oldAtLineStart || !newAtLineStart)) {
        const newline = before.indexOf("\n", oldEnd);
        const skip = (newline === -1 ? before.length : newline + 1) - oldEnd;
        oldEnd += skip;
        newEnd += skip;
    }

    const oldChanged = before.slice(prefix, oldEnd);
    const newChanged = after.slice(prefix, newEnd);
    if (oldChanged.length + newChanged.length < MAX_DIFF_LINES) return undefined;
    const oldLines = diffLineTokens(oldChanged);
    const newLines = diffLineTokens(newChanged);
    if (oldLines.length + newLines.length < MAX_DIFF_LINES
        && Buffer.byteLength(oldChanged) + Buffer.byteLength(newChanged) <= MAX_DIFF_BYTES) {
        return undefined;
    }
    const oldTokens = new Set(oldLines);
    if (newLines.some((line) => oldTokens.has(line))) return undefined;
    const changedTokens = new Set([...oldLines, ...newLines]);
    // A suffix line matching either changed block can alter the diff alignment.
    if (diffLineTokens(before.slice(oldEnd)).some((line) => changedTokens.has(line))) {
        return undefined;
    }

    const counts = diffCounts(`Index: ${path}`);
    counts.removed += oldLines.filter((line) => !line.startsWith("--")).length;
    counts.added += newLines.filter((line) => !line.startsWith("++")).length;
    return counts;
}

function diffLineTokens(text: string): string[] {
    if (text.length === 0) return [];
    const lines = text.split("\n");
    return lines.flatMap((line, index) => {
        if (index < lines.length - 1) return [`${line}\n`];
        return line.length === 0 ? [] : [line];
    });
}

function oversizedDiffNotice(
    path: string,
    before: string,
    after: string,
    stashDirectory: string | undefined,
    counts: DiffCounts,
): ToolPresentation {
    const stashPointer = stashDirectory !== undefined
        && lostPercent(before, after) >= DESTRUCTIVE_LOSS_PERCENT
        ? `; pre-image saved in ${stashDirectory}`
        : "";
    return {
        kind: "tool_notice",
        text: `Diff too large to show inline for ${path}: ${diffMagnitude(counts, before, after)}${stashPointer}.`,
    };
}

function lostPercent(before: string, after: string): number {
    const beforeBytes = Buffer.byteLength(before);
    const afterBytes = Buffer.byteLength(after);
    if (beforeBytes === 0 || afterBytes >= beforeBytes) {
        return 0;
    }
    return Math.round(((beforeBytes - afterBytes) / beforeBytes) * 100);
}

function diffCounts(patch: string): DiffCounts {
    let added = 0;
    let removed = 0;
    for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
            added += 1;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
            removed += 1;
        }
    }
    return { added, removed };
}

function diffMagnitude({ added, removed }: DiffCounts, before: string, after: string): string {
    const beforeBytes = Buffer.byteLength(before);
    const afterBytes = Buffer.byteLength(after);
    const size = `${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)}`;
    const counts = `-${removed.toLocaleString()} +${added.toLocaleString()} lines (${size})`;
    const lost = lostPercent(before, after);
    return lost >= 1 ? `${counts}, ${lost}% of file removed` : counts;
}

function formatBytes(bytes: number): string {
    return bytes < 1024
        ? `${bytes} B`
        : `${(bytes / 1024).toFixed(1)} KiB`;
}
