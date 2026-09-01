import type { RenderContext } from "@opentui/core";

import { dialogBottomOffset } from "./dialog-chrome.ts";

export const LIST_MIN_ROWS = 4;

export function dialogBoxHeight(
    renderer: RenderContext,
    top: number,
    bottom = dialogBottomOffset(renderer),
): number {
    return renderer.height - top - bottom;
}

export function listWindowRows(
    boxHeight: number,
    chrome: number,
    minimum: number = LIST_MIN_ROWS,
): number {
    return Math.max(minimum, Math.floor(boxHeight) - chrome);
}

export function listWindowSlice<T>(
    rows: readonly T[],
    cursorRow: number,
    maxRows: number,
): readonly T[] {
    if (rows.length <= maxRows) {
        return rows;
    }
    const centred = Math.max(0, cursorRow) - Math.floor(maxRows / 2);
    const start = Math.min(Math.max(0, centred), rows.length - maxRows);
    return rows.slice(start, start + maxRows);
}

export function halfPageCursor(
    cursor: number,
    length: number,
    visibleRows: number,
    direction: "up" | "down",
): number {
    const jump = Math.max(1, Math.floor(visibleRows / 2));
    return clampedCursor(cursor + (direction === "down" ? jump : -jump), length);
}

export function wheelCursor(
    cursor: number,
    length: number,
    scroll: {
        readonly direction: "up" | "down" | "left" | "right";
        readonly delta: number;
    },
): number | undefined {
    if (scroll.direction !== "up" && scroll.direction !== "down") {
        return undefined;
    }
    const rows = Math.max(1, Math.round(Math.abs(scroll.delta) || 1));
    return clampedCursor(
        cursor + (scroll.direction === "down" ? rows : -rows),
        length,
    );
}

function clampedCursor(index: number, length: number): number {
    if (length <= 0) return 0;
    return Math.min(Math.max(0, index), length - 1);
}
