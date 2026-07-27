import { createTwoFilesPatch } from "diff";

import type { ToolPresentation } from "../model/types.ts";

const MAX_DIFF_BYTES = 64 * 1024;
const MAX_DIFF_LINES = 400;

export function editDiffPresentation(
    path: string,
    before: string,
    after: string,
): ToolPresentation {
    const patch = createTwoFilesPatch(path, path, before, after, "", "", {
        context: 3,
    });
    const bytes = Buffer.byteLength(patch);
    const lines = patch.split("\n").length;
    if (bytes > MAX_DIFF_BYTES || lines > MAX_DIFF_LINES) {
        return {
            kind: "tool_notice",
            text: `Diff not shown for ${path}: ${lines.toLocaleString()} lines (${formatBytes(bytes)}) exceeds the inline limit.`,
        };
    }
    return { kind: "unified_diff", path, patch };
}

function formatBytes(bytes: number): string {
    return bytes < 1024
        ? `${bytes} B`
        : `${(bytes / 1024).toFixed(1)} KiB`;
}
