import type { RenderContext } from "@opentui/core";

import { dialogBottomOffset } from "./dialog-chrome.ts";

/**
 * The windowed list every overlay is made of.
 *
 * Four surfaces show a list too long for the screen: the settings picker (and
 * the session picker inside it), the command palette, the granted-permissions
 * list, and help. Each grew its own row count, its own centring maths, and its
 * own answer to the wheel, so every capability added to one of them stopped
 * there. This module owns the four things they all need, and the surfaces keep
 * only their own geometry.
 */

/**
 * Below this a list is a peephole, so a very short terminal gets an overlay
 * that overflows rather than one showing two rows.
 */
export const LIST_MIN_ROWS = 4;

/**
 * How tall an overlay anchored `top` rows down may grow without covering the
 * composer.
 */
export function dialogBoxHeight(renderer: RenderContext, top: number): number {
    return renderer.height - top - dialogBottomOffset(renderer);
}

/**
 * How many list rows fit, given how tall the box may be and how much of it is
 * not list rows.
 */
export function listWindowRows(
    boxHeight: number,
    chrome: number,
    minimum: number = LIST_MIN_ROWS,
): number {
    return Math.max(minimum, Math.floor(boxHeight) - chrome);
}

/**
 * The slice to show, centred on the cursor and clamped at both ends.
 *
 * `cursorRow` is a position in `rows`, not in the underlying list: a list with
 * group headings interleaved has more rows than entries, and the heading above
 * the cursor has to stay on screen with it.
 */
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

/**
 * Where the cursor lands after a half-page jump.
 *
 * The cursor travels with the jump rather than the window sliding out from
 * under it, so ctrl+d is ↓ held down and nothing new has to be learned about
 * where the highlight went.
 */
export function halfPageCursor(
    cursor: number,
    length: number,
    visibleRows: number,
    direction: "up" | "down",
): number {
    const jump = Math.max(1, Math.floor(visibleRows / 2));
    return clampedCursor(cursor + (direction === "down" ? jump : -jump), length);
}

/**
 * Where the cursor lands after a wheel scroll, or `undefined` when the scroll
 * was sideways and means nothing to a list.
 *
 * Scrolling moves the cursor for the same reason the half-page keys do: these
 * surfaces window themselves around the cursor, so a window that moved on its
 * own would leave ⏎ pointing at a row that is no longer on screen.
 */
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
    // A wheel reports whole rows, a trackpad reports fractions of one, and a
    // scroll that moves nothing reads as a dead pane.
    //
    // Halved, because these panes are short: a trackpad gesture that reads as a
    // comfortable glide down a long transcript throws the cursor most of the way
    // through a picker. A single wheel click still moves one row, so only the
    // fast gestures are damped.
    const rows = Math.max(
        1,
        Math.round((Math.abs(scroll.delta) || 1) * WHEEL_ROWS_PER_DELTA),
    );
    return clampedCursor(
        cursor + (scroll.direction === "down" ? rows : -rows),
        length,
    );
}

/** How far the cursor travels per unit of reported wheel delta. */
const WHEEL_ROWS_PER_DELTA = 0.5;

function clampedCursor(index: number, length: number): number {
    if (length <= 0) return 0;
    return Math.min(Math.max(0, index), length - 1);
}
