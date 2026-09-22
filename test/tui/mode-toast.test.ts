import { expect, test } from "bun:test";

import {
    DIALOG_CARD_Z_INDEX,
    DIALOG_SHORT_TERMINAL_HEIGHT,
    TOAST_Z_INDEX,
} from "../../clients/tui/dialog-chrome.ts";
import {
    clipToastMessage,
    layoutModeToast,
    TOAST_RIGHT_GUTTER,
} from "../../clients/tui/main/notices.ts";

test("the HUD toast paints above a dialog card", () => {
    expect(TOAST_Z_INDEX).toBeGreaterThan(DIALOG_CARD_Z_INDEX);
});

test("a long toast clips to the terminal and keeps a failure prefix", () => {
    const summary =
        "Refreshed 8 catalogs, 0 new models. Could not refresh: digitalocean, openrouter, anthropic.";
    const clipped = clipToastMessage(summary, 28);
    expect(clipped.startsWith("Could not refresh")).toBe(true);
    expect(clipped.endsWith("…")).toBe(true);
    expect(Bun.stringWidth(clipped)).toBeLessThanOrEqual(28);
    expect(clipToastMessage("Refreshed 1 catalogs, 0 new models.", 80))
        .toBe("Refreshed 1 catalogs, 0 new models.");
});

test("ordinary terminals keep a padded chip that fits the row", () => {
    const layout = layoutModeToast(
        "Refreshed 1 catalogs, 1 new models.",
        80,
        24,
    );
    expect(layout.height).toBe(3);
    expect(layout.paddingTop).toBe(1);
    expect(layout.paddingLeft).toBe(2);
    expect(layout.width).toBeLessThanOrEqual(80 - TOAST_RIGHT_GUTTER);
    expect(layout.text).toBe("Refreshed 1 catalogs, 1 new models.");
});

test("a short terminal collapses the toast to one unpadded row", () => {
    const layout = layoutModeToast(
        "Refreshed 8 catalogs, 0 new models. Could not refresh: digitalocean, openrouter.",
        40,
        DIALOG_SHORT_TERMINAL_HEIGHT,
    );
    expect(layout.height).toBe(1);
    expect(layout.paddingTop).toBe(0);
    expect(layout.paddingLeft).toBe(0);
    expect(layout.width).toBeLessThanOrEqual(40 - TOAST_RIGHT_GUTTER);
    expect(Bun.stringWidth(layout.text)).toBeLessThanOrEqual(layout.width);
    expect(layout.text.startsWith("Could not refresh")).toBe(true);
    expect(layout.text.endsWith("…")).toBe(true);
});
