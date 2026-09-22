import { expect, test } from "bun:test";

import {
    DIALOG_CARD_Z_INDEX,
    DIALOG_SHORT_TERMINAL_HEIGHT,
    TOAST_Z_INDEX,
} from "../../clients/tui/dialog-chrome.ts";
import {
    clipToastMessage,
    dismissModeToast,
    enqueueModeToast,
    layoutModeToast,
    MODE_TOAST_DURATION_MS,
    MODE_TOAST_FAIL_TICK,
    MODE_TOAST_FILL_ROLE,
    MODE_TOAST_HANDOFF_MS,
    MODE_TOAST_TICK,
    MODE_TOAST_TYPE_MS,
    modeToastDoneMark,
    modeToastDoneTone,
    modeToastFailureLine,
    modeToastLineComplete,
    modeToastTakesEscape,
    modeToastTypes,
    typedToastText,
} from "../../clients/tui/main/notices.ts";

test("the HUD toast paints above a dialog card", () => {
    expect(TOAST_Z_INDEX).toBeGreaterThan(DIALOG_CARD_Z_INDEX);
});

test("the HUD toast fill is the search-field element color", () => {
    expect(MODE_TOAST_FILL_ROLE).toBe("element");
});

test("a toast message types on a prefix at a time", () => {
    expect(typedToastText("asking outrider…", 0)).toBe("");
    expect(typedToastText("asking outrider…", 7)).toBe("asking ");
    expect(typedToastText("asking outrider…", 40)).toBe("asking outrider…");
    expect(modeToastTypes(0)).toBe(false);
    expect(modeToastTypes(2)).toBe(true);
    expect(MODE_TOAST_TYPE_MS).toBe(10);
});

test("a finished toast line keeps a success tick", () => {
    expect(modeToastLineComplete("asking omlx", 4)).toBe(false);
    expect(modeToastLineComplete("asking omlx", 11)).toBe(true);
    expect(MODE_TOAST_TICK).toBe(" ✓");
    expect(modeToastDoneMark("asking omlx (6/6)…")).toBe(MODE_TOAST_TICK);
    expect(modeToastDoneTone("asking omlx (6/6)…")).toBe("success");
});

test("a failed refresh is marked, not ticked green", () => {
    const failed = "Could not refresh: cerebras, ollama.";
    expect(modeToastFailureLine(failed)).toBe(true);
    expect(modeToastDoneMark(failed)).toBe(MODE_TOAST_FAIL_TICK);
    expect(modeToastDoneTone(failed)).toBe("danger");
    expect(modeToastFailureLine("asking omlx (6/6)…")).toBe(false);
});

test("a long toast clips the whole line and keeps the refresh counts", () => {
    const summary =
        "Refreshed 8 catalogs, 0 new models. Could not refresh: digitalocean, openrouter, anthropic.";
    const clipped = clipToastMessage(summary, 28);
    expect(clipped.startsWith("Refreshed 8 catalogs")).toBe(true);
    expect(clipped.endsWith("…")).toBe(true);
    expect(Bun.stringWidth(clipped)).toBeLessThanOrEqual(28);
    expect(clipToastMessage("Refreshed 1 catalogs, 0 new models.", 80))
        .toBe("Refreshed 1 catalogs, 0 new models.");
});

test("ordinary terminals keep a full-width padded band", () => {
    const layout = layoutModeToast(
        "Refreshed 1 catalogs, 1 new models.",
        80,
        24,
    );
    expect(layout.top).toBe(0);
    expect(layout.height).toBe(3);
    expect(layout.paddingTop).toBe(1);
    expect(layout.paddingLeft).toBe(2);
    expect(layout.width).toBe(80);
    expect(layout.text).toBe("Refreshed 1 catalogs, 1 new models.");
    expect(
        Bun.stringWidth(layout.text) + Bun.stringWidth(MODE_TOAST_TICK)
            + layout.paddingLeft + layout.paddingRight,
    ).toBeLessThanOrEqual(layout.width);
});

test("a short terminal collapses the band to one row", () => {
    const layout = layoutModeToast(
        "Refreshed 8 catalogs, 0 new models. Could not refresh: digitalocean, openrouter.",
        40,
        DIALOG_SHORT_TERMINAL_HEIGHT,
    );
    expect(layout.height).toBe(1);
    expect(layout.paddingTop).toBe(0);
    expect(layout.width).toBe(40);
    expect(Bun.stringWidth(layout.text)).toBeLessThanOrEqual(
        layout.width - layout.paddingLeft - layout.paddingRight
            - Bun.stringWidth(MODE_TOAST_TICK),
    );
    expect(layout.text.startsWith("Refreshed 8 catalogs")).toBe(true);
    expect(layout.text.endsWith("…")).toBe(true);
});

test("Escape closes a toast only when no overlay is open", () => {
    expect(modeToastTakesEscape(true, false)).toBe(true);
    expect(modeToastTakesEscape(true, true)).toBe(false);
    expect(modeToastTakesEscape(false, false)).toBe(false);
});

test("a later toast waits instead of replacing the one on screen", () => {
    const first = enqueueModeToast({ shown: undefined, waiting: [] }, "asking…");
    expect(first.shown).toBe("asking…");
    const second = enqueueModeToast(first, "Refreshed 1 catalogs");
    expect(second.shown).toBe("asking…");
    expect(second.waiting).toEqual(["Refreshed 1 catalogs"]);
    const next = dismissModeToast(second);
    expect(next.shown).toBe("Refreshed 1 catalogs");
    expect(next.waiting).toEqual([]);
    expect(dismissModeToast(next)).toEqual({ shown: undefined, waiting: [] });
});

test("an overlay toast expires after five seconds", () => {
    expect(MODE_TOAST_DURATION_MS).toBe(5_000);
    expect(MODE_TOAST_HANDOFF_MS).toBe(400);
    expect(MODE_TOAST_HANDOFF_MS).toBeLessThan(MODE_TOAST_DURATION_MS);
});
