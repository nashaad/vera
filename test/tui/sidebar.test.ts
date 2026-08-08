import { expect, test } from "bun:test";

import {
    clampSidebarWidth,
    DEFAULT_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    MIN_TRANSCRIPT_WIDTH,
} from "../../clients/tui/sidebar.ts";

test("the divider cannot be dragged past either side's floor", () => {
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 120)).toBe(
        DEFAULT_SIDEBAR_WIDTH,
    );
    expect(clampSidebarWidth(2, 120)).toBe(MIN_SIDEBAR_WIDTH);
    // 120 - 30 transcript - 3 divider.
    expect(clampSidebarWidth(500, 120)).toBe(87);
    expect(clampSidebarWidth(40.4, 120)).toBe(40);
});

test("a terminal too narrow to split leaves the sidebar its floor", () => {
    const narrow = MIN_SIDEBAR_WIDTH + MIN_TRANSCRIPT_WIDTH - 5;
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, narrow)).toBe(
        MIN_SIDEBAR_WIDTH,
    );
});
