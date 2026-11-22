import type { AnnotationSide, FileDiffMetadata, Hunk, SelectedLineRange } from "@pierre/diffs";

import type { KeyedPatch } from "./patches.ts";

export interface PatchRange {
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
    readonly quote: readonly string[];
}

export type LineMap = ReadonlyMap<number, string>;

function lineText(line: string): string {
    return line.endsWith("\n") ? line.slice(0, -1) : line;
}

function sideLines(diff: FileDiffMetadata, side: "old" | "new"): Map<number, string> {
    const lines = new Map<number, string>();
    for (const hunk of diff.hunks) {
        let oldLine = hunk.deletionStart;
        let newLine = hunk.additionStart;
        for (const block of hunk.hunkContent) {
            if (block.type === "context") {
                for (let index = 0; index < block.lines; index += 1) {
                    const oldText = lineText(diff.deletionLines[block.deletionLineIndex + index] ?? "");
                    const newText = lineText(diff.additionLines[block.additionLineIndex + index] ?? "");
                    lines.set(oldLine + index, oldText);
                    if (side === "new") lines.set(newLine + index, newText);
                }
                oldLine += block.lines;
                newLine += block.lines;
                continue;
            }
            if (side === "old") {
                for (let index = 0; index < block.deletions; index += 1) {
                    lines.set(oldLine + index, lineText(diff.deletionLines[block.deletionLineIndex + index] ?? ""));
                }
                oldLine += block.deletions;
                newLine += block.additions;
                continue;
            }
            for (let index = 0; index < block.additions; index += 1) {
                lines.set(newLine + index, lineText(diff.additionLines[block.additionLineIndex + index] ?? ""));
            }
            oldLine += block.deletions;
            newLine += block.additions;
        }
    }
    return lines;
}

export function lineTextAt(diff: FileDiffMetadata, side: "old" | "new", line: number): string | undefined {
    return sideLines(diff, side).get(line);
}

export function rangeInPatch(diff: FileDiffMetadata, side: "old" | "new", startLine: number, endLine: number): PatchRange | undefined {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) return undefined;
    const start = Math.min(startLine, endLine);
    const end = Math.max(startLine, endLine);
    if (start < 1) return undefined;
    const lines = sideLines(diff, side);
    const quote: string[] = [];
    for (let line = start; line <= end; line += 1) {
        const text = lines.get(line);
        if (text === undefined) return undefined;
        quote.push(text);
    }
    return { side, startLine: start, endLine: end, quote };
}

export interface KeyedPatchRange {
    readonly patchKey: string;
    readonly range: PatchRange;
    readonly diff: FileDiffMetadata;
}

export function resolveKeyedRange(keyed: readonly KeyedPatch[], selection: SelectedLineRange): KeyedPatchRange | undefined {
    const side = selectionSide(selection);
    if (side === undefined) return undefined;
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    for (const entry of keyed) {
        if (entry.diff === undefined) continue;
        const range = rangeInPatch(entry.diff, side, start, end);
        if (range !== undefined) return { patchKey: entry.key, range, diff: entry.diff };
    }
    return undefined;
}

export function annotationSide(side: "old" | "new"): AnnotationSide {
    return side === "old" ? "deletions" : "additions";
}

export function selectionSide(range: { readonly side?: AnnotationSide; readonly endSide?: AnnotationSide }): "old" | "new" | undefined {
    if (range.side !== undefined && range.endSide !== undefined && range.side !== range.endSide) return undefined;
    return range.side === "deletions" ? "old" : "new";
}

export function rangeQuote(diff: FileDiffMetadata, side: "old" | "new", startLine: number, endLine: number): readonly string[] | undefined {
    return rangeInPatch(diff, side, startLine, endLine)?.quote;
}

function hunkLineSpan(hunk: Hunk, side: "old" | "new"): [number, number] | undefined {
    const start = side === "old" ? hunk.deletionStart : hunk.additionStart;
    const count = side === "old" ? hunk.deletionCount : hunk.additionCount;
    return count === 0 ? undefined : [start, start + count - 1];
}

export function patchContainsRange(diff: FileDiffMetadata, side: "old" | "new", startLine: number, endLine: number): boolean {
    const start = Math.min(startLine, endLine);
    const end = Math.max(startLine, endLine);
    return diff.hunks.some((hunk) => {
        const span = hunkLineSpan(hunk, side);
        return span !== undefined && span[0] <= start && span[1] >= end;
    });
}

export function lineOrdinal(diff: FileDiffMetadata, side: "old" | "new", line: number): number {
    const numbers = [...sideLines(diff, side).keys()].sort((left, right) => left - right);
    return Math.max(0, numbers.indexOf(line));
}
