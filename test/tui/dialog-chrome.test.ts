import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    DIALOG_SHORT_TERMINAL_HEIGHT,
    dialogBottomOffset,
} from "../../clients/tui/dialog-chrome.ts";

test("bottom-anchored overlays clear the status line only when there is room", async () => {
    const roomy = await createTestRenderer({ width: 80, height: 24 });
    try {
        // The status line is drawn over these overlays, so with height to spare
        // they sit one row above it rather than losing their key hints to it.
        expect(dialogBottomOffset(roomy.renderer)).toBe(2);
    } finally {
        roomy.renderer.destroy();
    }

    const short = await createTestRenderer({
        width: 42,
        height: DIALOG_SHORT_TERMINAL_HEIGHT,
    });
    try {
        // At this height the reserved row would come out of the content: the
        // question being asked scrolls off before its own hints do. So short
        // terminals keep the collision and keep the content.
        expect(dialogBottomOffset(short.renderer)).toBe(1);
    } finally {
        short.renderer.destroy();
    }

    const boundary = await createTestRenderer({
        width: 42,
        height: DIALOG_SHORT_TERMINAL_HEIGHT + 1,
    });
    try {
        expect(dialogBottomOffset(boundary.renderer)).toBe(2);
    } finally {
        boundary.renderer.destroy();
    }
});
