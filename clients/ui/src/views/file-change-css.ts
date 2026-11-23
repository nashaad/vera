import type { FileLineChange } from "../protocol/bridge.ts";

const MAX_GUTTER_RANGES = 500;

function presence(ranges: readonly FileLineChange[]): string {
    if (ranges.length === 0) return "0";
    const values = ranges.map(({ start, end }) =>
        `clamp(0, min(calc(var(--files-gutter-line) - ${start - 1}), calc(${end + 1} - var(--files-gutter-line))), 1)`);
    return `max(${values.join(", ")})`;
}

export function fileChangeGutterCss(changes: readonly FileLineChange[], lineCount: number): string {
    if (!Number.isSafeInteger(lineCount) || lineCount < 1) return "";
    const valid = changes.slice(0, MAX_GUTTER_RANGES).filter((change) =>
        Number.isSafeInteger(change.start) && Number.isSafeInteger(change.end)
        && change.start >= 1 && change.end >= change.start);
    const added: FileLineChange[] = [];
    const changed: FileLineChange[] = [];
    const removedTop: FileLineChange[] = [];
    const removedBottom: FileLineChange[] = [];
    for (const change of valid) {
        if (change.kind === "added") added.push(change);
        else if (change.kind === "changed") changed.push(change);
        else if (change.kind === "removed") {
            const line = Math.min(change.start, lineCount);
            (change.start > lineCount ? removedBottom : removedTop).push({ kind: "removed", start: line, end: line });
        }
    }
    if (added.length + changed.length + removedTop.length + removedBottom.length === 0) return "";
    return `
[data-gutter] [data-column-number] {
    --files-gutter-line: attr(data-column-number type(<number>), 0);
    background-image:
        linear-gradient(var(--vera-diff-removed), var(--vera-diff-removed)),
        linear-gradient(var(--vera-diff-removed), var(--vera-diff-removed)),
        linear-gradient(var(--vera-link), var(--vera-link)),
        linear-gradient(var(--vera-diff-added), var(--vera-diff-added));
    background-position: left top, left bottom, left top, left top;
    background-repeat: no-repeat;
    background-size:
        calc(var(--vera-space) * 1.5 * ${presence(removedTop)}) calc(var(--vera-space) * 0.5),
        calc(var(--vera-space) * 1.5 * ${presence(removedBottom)}) calc(var(--vera-space) * 0.5),
        calc(var(--vera-space) * 0.75 * ${presence(changed)}) 100%,
        calc(var(--vera-space) * 0.75 * ${presence(added)}) 100%;
}`;
}
