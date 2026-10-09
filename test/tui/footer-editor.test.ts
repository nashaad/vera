import { expect, test } from "bun:test";

import {
    FOOTER_REFUSED_FIT,
    handleFooterEditorKey,
    startFooterEditor,
    type FooterEditorKey,
    type FooterEditorState,
} from "../../clients/tui/footer-editor.ts";
import { footerEditorBody, footerEditorHint, footerEditorTitle } from "../../clients/tui/footer-editor-view.ts";
import { DEFAULT_FOOTER_LAYOUT, footerItemSlot, type FooterItemId } from "../../clients/tui/footer-layout.ts";
import { footerSeed, type FooterSeed } from "../../clients/tui/footer-seed.ts";
import type { TuiStatusChunk } from "../../clients/tui/status.ts";

const STRIP: TuiStatusChunk[] = [..."▁▂▃▅▆▇▆▅"].map((text) => ({ text, tone: "accent" }));
const SEED = footerSeed({ ready: "ready", idleKeys: "Ctrl+P commands · Ctrl+X h keys", keys: "Ctrl+X h keys", strip: STRIP });

function press(state: FooterEditorState, ...names: (string | FooterEditorKey)[]): FooterEditorState {
    let current = state;
    for (const name of names) {
        const next = handleFooterEditorKey(current, typeof name === "string" ? { name } : name).state;
        if (next === undefined) throw new Error("the editor closed");
        current = next;
    }
    return current;
}

function on(state: FooterEditorState, item: FooterItemId): FooterEditorState {
    return { ...state, field: "slots", slot: footerItemSlot(state.layout, item) };
}

function slotOf(state: FooterEditorState, item: FooterItemId): number {
    return footerItemSlot(state.layout, item) + 1;
}

function text(state: FooterEditorState): string {
    return footerEditorBody(state).chunks.map((chunk) => chunk.text).join("");
}

const start = startFooterEditor(DEFAULT_FOOTER_LAYOUT, SEED, false);

test("the screen opens on slot 1, previewing the turn state", () => {
    expect(start.field).toBe("slots");
    expect(start.slot).toBe(0);
    expect(start.preview).toBe("idle");
    expect(startFooterEditor(DEFAULT_FOOTER_LAYOUT, SEED, true).preview).toBe("working");
});

test("arrows move the cursor through the grid, and past its edges to Preview and Reset", () => {
    expect(press(start, "right", "right", "down").slot).toBe(6);
    expect(press(start, "left").slot).toBe(0);
    expect(press(start, "up").field).toBe("preview");
    expect(press(start, "down", "down", "down").field).toBe("reset");
    expect(press(start, "tab").field).toBe("reset");
    expect(press(start, { name: "tab", shift: true }).field).toBe("preview");
});

test("Preview flips between idle and working", () => {
    expect(press(start, "up", "right").preview).toBe("working");
    expect(press(start, "up", "space", "left").preview).toBe("idle");
});

test("Space shows or hides an item, but key hints stay shown", () => {
    expect(press(on(start, "limits"), "space").layout.hidden).toEqual(["limits"]);
    expect(press(on(start, "limits"), "space", "space").layout.hidden).toEqual([]);
    const keys = press(on(start, "keys"), "space");
    expect(keys.layout.hidden).toEqual([]);
    expect(keys.refused).toBe("key hints can't be hidden");
});

test("Enter picks an item up, arrows carry it, and Enter puts it down", () => {
    const carried = press(on(start, "place"), "return");
    expect(carried.carry?.item).toBe("place");
    expect(footerEditorHint(carried)).toContain("enter put down");
    expect(footerEditorTitle(carried)).toBe("Footer layout › moving folder, branch");
    const moved = press(carried, "down", "right");
    expect(slotOf(moved, "place")).toBe(10);
    const placed = press(moved, "return");
    expect(placed.carry).toBeUndefined();
    expect(slotOf(placed, "place")).toBe(10);
    expect(placed.layout.slots[4]).toBeNull();
});

test("carrying onto a filled slot swaps the two, and passing through moves nothing else", () => {
    const swapped = press(on(start, "place"), "return", "right", "right", "return");
    expect(slotOf(swapped, "place")).toBe(7);
    expect(slotOf(swapped, "panes")).toBe(5);
    expect(swapped.layout.slots[5]).toBeNull();
});

test("Escape while carrying puts everything back", () => {
    const undone = press(on(start, "place"), "return", "right", "down", "escape");
    expect(undone.carry).toBeUndefined();
    expect(undone.layout).toEqual(DEFAULT_FOOTER_LAYOUT);
    expect(undone.slot).toBe(4);
});

test("picking up an item that only shows mid-turn switches the preview to working", () => {
    expect(press(on(start, "activity"), "return").preview).toBe("working");
    expect(press(on(start, "status"), "return").preview).toBe("idle");
});

test("putting an item down where it won't fit at 80 columns is refused", () => {
    const wide: FooterSeed = {
        idle: SEED.idle,
        working: { ...SEED.working, place: { forms: [[{ text: "~/".padEnd(60, "x"), tone: "muted" }]] } },
    };
    const state = startFooterEditor(DEFAULT_FOOTER_LAYOUT, wide, true);
    const carried = press(on(state, "keys"), "return", "down");
    const refused = press(carried, "return");
    expect(refused.refused).toBe(FOOTER_REFUSED_FIT);
    expect(refused.carry?.item).toBe("keys");
    // Moving on to a slot with room lets it go down.
    const placed = press(refused, "down", "return");
    expect(placed.refused).toBeUndefined();
    expect(slotOf(placed, "keys")).toBe(12);
});

test("Reset puts the default layout back", () => {
    const changed = press(on(start, "limits"), "space");
    const reset = press({ ...changed, field: "reset" }, "return");
    expect(reset.layout).toEqual(DEFAULT_FOOTER_LAYOUT);
});

test("Escape closes the screen, and modifier chords pass through", () => {
    expect(handleFooterEditorKey(start, { name: "escape" })).toEqual({ handled: true });
    expect(handleFooterEditorKey(start, { name: "c", ctrl: true })).toEqual({ state: start, handled: false });
    expect(handleFooterEditorKey(start, { name: "x" }).handled).toBe(true);
});

test("the screen draws the example footer, the numbered grid and the focused slot", () => {
    const body = text(start);
    expect(body).toContain("‹ idle ›");
    expect(body).toContain("5h 88% left · week 60% left");
    expect(body).toContain("~/crow-nest · plunder");
    expect(body).toContain("Ctrl+P commands · Ctrl+X h keys");
    expect(body).toContain("Drawn at 80 columns");
    expect(body).toMatch(/ 1 live status +2 limits +3 · +4 key hints/);
    expect(body).toMatch(/ 9 · +10 · +11 · +12 ·/);
    expect(body).toContain("Slot 1: live status");
    expect(text(on(start, "activity"))).toContain("Slot 8: activity strip · shows while working");
    const hidden = text(press(on(start, "limits"), "space"));
    expect(hidden).toContain("Slot 2: limits · hidden");
    expect(hidden).not.toContain("5h 88%");
    const working = text(press(start, "up", "right"));
    expect(working).toContain("thinking · 12s");
    expect(working).toContain("Ctrl+X h keys");
});
