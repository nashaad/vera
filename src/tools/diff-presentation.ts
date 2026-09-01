import { createTwoFilesPatch } from "diff";

import type { ToolPresentation } from "../model/types.ts";

const MAX_DIFF_BYTES = 64 * 1024;
const MAX_DIFF_LINES = 400;

const DESTRUCTIVE_LOSS_PERCENT = 50;

export function editDiffPresentation(
    path: string,
    before: string,
    after: string,
    stashDirectory?: string,
): ToolPresentation {
    const patch = createTwoFilesPatch(path, path, before, after, "", "", {
        context: 3,
    });
    const bytes = Buffer.byteLength(patch);
    const lines = patch.split("\n").length;
    if (bytes > MAX_DIFF_BYTES || lines > MAX_DIFF_LINES) {
        const stashPointer = stashDirectory !== undefined
            && lostPercent(before, after) >= DESTRUCTIVE_LOSS_PERCENT
            ? `; pre-image saved in ${stashDirectory}`
            : "";
        return {
            kind: "tool_notice",
            text: `Diff too large to show inline for ${path}: ${diffMagnitude(patch, before, after)}${stashPointer}.`,
        };
    }
    return { kind: "unified_diff", path, patch };
}

function lostPercent(before: string, after: string): number {
    const beforeBytes = Buffer.byteLength(before);
    const afterBytes = Buffer.byteLength(after);
    if (beforeBytes === 0 || afterBytes >= beforeBytes) {
        return 0;
    }
    return Math.round(((beforeBytes - afterBytes) / beforeBytes) * 100);
}

function diffMagnitude(patch: string, before: string, after: string): string {
    let added = 0;
    let removed = 0;
    for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
            added += 1;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
            removed += 1;
        }
    }
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
