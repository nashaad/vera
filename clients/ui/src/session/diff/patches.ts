import { parsePatchFiles, type FileDiffMetadata, type Hunk } from "@pierre/diffs";

export interface KeyedPatch {
    readonly key: string;
    readonly patch: string;
    readonly diff: FileDiffMetadata | undefined;
}

export interface KeyedPatchRun {
    readonly key: string;
    readonly patches: readonly KeyedPatch[];
    readonly diff: FileDiffMetadata;
}

function firstDiff(patch: string): FileDiffMetadata | undefined {
    try {
        return parsePatchFiles(patch, { cacheKeyPrefix: undefined })[0]?.files[0];
    } catch {
        return undefined;
    }
}

export function rawPatchText(patches: readonly string[]): string {
    return patches.join("\n");
}

// The first run keeps the file path as its item id so a scroll target that names
// the file lands on it; later runs add their first edit key.
export function reviewItemId(path: string, patches: readonly KeyedPatch[], index: number): string {
    return index === 0 ? path : JSON.stringify([path, patches[0]!.key]);
}

export function parseKeyedPatches(patches: readonly string[], keys: readonly string[]): KeyedPatch[] {
    return patches.map((patch, index) => ({
        key: keys[index] ?? `patch-${index}`,
        patch,
        diff: firstDiff(patch),
    }));
}

function offsetHunk(hunk: Hunk, unifiedStart: number, splitStart: number, deletionIndex: number, additionIndex: number): Hunk {
    return {
        ...hunk,
        unifiedLineStart: hunk.unifiedLineStart + unifiedStart,
        splitLineStart: hunk.splitLineStart + splitStart,
        deletionLineIndex: hunk.deletionLineIndex + deletionIndex,
        additionLineIndex: hunk.additionLineIndex + additionIndex,
        hunkContent: hunk.hunkContent.map((block) => block.type === "context"
            ? { ...block, deletionLineIndex: block.deletionLineIndex + deletionIndex, additionLineIndex: block.additionLineIndex + additionIndex }
            : { ...block, deletionLineIndex: block.deletionLineIndex + deletionIndex, additionLineIndex: block.additionLineIndex + additionIndex }),
    };
}

// A hunk with no lines on one side still occupies its start position for ordering.
function startsRun(prior: Hunk, next: Hunk): boolean {
    const priorDeletionEnd = prior.deletionStart + Math.max(prior.deletionCount, 1) - 1;
    const priorAdditionEnd = prior.additionStart + Math.max(prior.additionCount, 1) - 1;
    return next.deletionStart <= priorDeletionEnd || next.additionStart <= priorAdditionEnd;
}

// Pierre resolves a selection by side and line number across a whole diff, so a
// file is split where a later edit repeats line numbers already in the diff.
export function splitKeyedPatches(patches: readonly KeyedPatch[], name: string): KeyedPatchRun[] {
    const groups: KeyedPatch[][] = [];
    let current: KeyedPatch[] = [];
    let prior: Hunk | undefined;
    for (const entry of patches) {
        const first = entry.diff?.hunks[0];
        if (entry.diff === undefined || first === undefined) continue;
        if (current.length > 0 && prior !== undefined && startsRun(prior, first)) {
            groups.push(current);
            current = [];
        }
        current.push(entry);
        prior = entry.diff.hunks[entry.diff.hunks.length - 1];
    }
    if (current.length > 0) groups.push(current);
    return groups.map((group) => {
        const merged = mergeKeyedPatches(group, name);
        if (merged === undefined) throw new Error("A parsed run must merge");
        return {
            key: JSON.stringify(group.map((entry) => entry.key)),
            patches: group,
            diff: { ...merged, cacheKey: `vera-run:${group.map((entry) => entry.key).join("|")}` },
        };
    });
}

export function mergeKeyedPatches(patches: readonly KeyedPatch[], name: string): FileDiffMetadata | undefined {
    const parsed = patches.flatMap((entry) => entry.diff === undefined ? [] : [entry.diff]);
    if (parsed.length === 0) return undefined;
    if (parsed.length === 1) return { ...parsed[0]!, name };
    const files = parsed.map((diff) => ({ diff, key: patches.find((entry) => entry.diff === diff)!.key }));
    let unified = 0;
    let split = 0;
    let deletion = 0;
    let addition = 0;
    const hunks: Hunk[] = [];
    for (const { diff } of files) {
        const first = diff.hunks[0];
        const prior = hunks[hunks.length - 1];
        let unifiedOffset = unified;
        let splitOffset = split;
        let collapsedBefore: number | undefined;
        if (prior !== undefined && first !== undefined) {
            const priorEnd = prior.additionStart + prior.additionCount - 1;
            if (first.additionStart > priorEnd) {
                collapsedBefore = first.additionStart - priorEnd - 1;
                unifiedOffset = unified + collapsedBefore - first.unifiedLineStart;
                splitOffset = split + collapsedBefore - first.splitLineStart;
            }
        }
        diff.hunks.forEach((hunk, index) => {
            const offset = offsetHunk(hunk, unifiedOffset, splitOffset, deletion, addition);
            hunks.push(index === 0 && collapsedBefore !== undefined ? { ...offset, collapsedBefore } : offset);
        });
        // Hunk counts are rendered lines; diff-level counts end at the last line index.
        unified += diff.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0);
        split += diff.hunks.reduce((total, hunk) => total + hunk.splitLineCount, 0);
        deletion += diff.deletionLines.length;
        addition += diff.additionLines.length;
    }
    const additionLines = files.flatMap(({ diff }) => diff.additionLines);
    const deletionLines = files.flatMap(({ diff }) => diff.deletionLines);
    const last = hunks[hunks.length - 1];
    return {
        name,
        type: parsed[0]!.type,
        hunks,
        splitLineCount: last === undefined ? 0 : last.splitLineStart + last.splitLineCount,
        unifiedLineCount: last === undefined ? 0 : last.unifiedLineStart + last.unifiedLineCount,
        isPartial: true,
        additionLines,
        deletionLines,
        additionCharacterCount: additionLines.reduce((total, line) => total + line.length, 0),
        deletionCharacterCount: deletionLines.reduce((total, line) => total + line.length, 0),
        cacheKey: `vera:${patches.map((entry) => entry.key).join("|")}`,
    };
}

