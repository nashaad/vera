import type { FileDiffMetadata } from "@pierre/diffs";

export const MAX_PATCH_LINES = 400;

export interface CappedDiff {
    readonly diff: FileDiffMetadata;
    readonly cut: boolean;
}

type Hunk = FileDiffMetadata["hunks"][number];
type HunkContent = Hunk["hunkContent"][number];

function contentLines(content: HunkContent): number {
    return content.type === "context" ? content.lines : content.additions + content.deletions;
}

// Diff-level counts end at the last line index; hunk counts are the number of rendered lines.
function renderedLines(hunk: Hunk): number {
    return hunk.hunkContent.reduce((total, content) => total + contentLines(content), 0);
}

// Keeps the first `room` rendered lines so line numbers and row indexes stay put.
function trimHunk(hunk: Hunk, room: number): Hunk {
    const hunkContent: HunkContent[] = [];
    let unified = 0;
    let split = 0;
    let additions = 0;
    let deletions = 0;
    for (const content of hunk.hunkContent) {
        const lines = contentLines(content);
        if (unified + lines > room) {
            const left = room - unified;
            if (content.type === "context") {
                hunkContent.push({ ...content, lines: left });
                unified += left;
                split += left;
            } else {
                const keptDeletions = Math.min(content.deletions, left);
                const keptAdditions = Math.min(content.additions, left - keptDeletions);
                hunkContent.push({ ...content, deletions: keptDeletions, additions: keptAdditions });
                unified += keptDeletions + keptAdditions;
                split += Math.max(keptDeletions, keptAdditions);
                additions += keptAdditions;
                deletions += keptDeletions;
            }
            break;
        }
        hunkContent.push(content);
        unified += lines;
        if (content.type === "context") split += content.lines;
        else {
            split += Math.max(content.additions, content.deletions);
            additions += content.additions;
            deletions += content.deletions;
        }
    }
    return { ...hunk, hunkContent, unifiedLineCount: unified, splitLineCount: split, additionLines: additions, deletionLines: deletions };
}

// Drops whole hunks and trims one hunk so every kept line keeps its original row and line indexes.
export function capDiff(diff: FileDiffMetadata, maxLines = MAX_PATCH_LINES): CappedDiff {
    if (diff.hunks.reduce((total, hunk) => total + renderedLines(hunk), 0) <= maxLines) return { diff, cut: false };
    const hunks: FileDiffMetadata["hunks"] = [];
    let unified = 0;
    let split = 0;
    let cut = false;
    for (const hunk of diff.hunks) {
        const room = maxLines - unified;
        if (room <= 0) {
            cut = true;
            break;
        }
        const lines = renderedLines(hunk);
        if (lines > room) {
            const trimmed = trimHunk(hunk, room);
            hunks.push(trimmed);
            unified += trimmed.unifiedLineCount;
            split += trimmed.splitLineCount;
            cut = true;
            break;
        }
        hunks.push(hunk);
        unified += lines;
        split += hunk.splitLineCount;
    }
    if (!cut && hunks.length === diff.hunks.length) return { diff, cut: false };
    const first = diff.hunks[0];
    return {
        diff: {
            ...diff,
            hunks,
            unifiedLineCount: (first?.unifiedLineStart ?? 0) + unified,
            splitLineCount: (first?.splitLineStart ?? 0) + split,
            cacheKey: diff.cacheKey === undefined ? undefined : `${diff.cacheKey}:cap:${maxLines}`,
        },
        cut: true,
    };
}
