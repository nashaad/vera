import { describe, expect, test } from "bun:test";

import { placePopover, type PopoverPlacementInput } from "../../clients/ui/src/components/placePopover.ts";

const viewport = { width: 1200, height: 800 };
const GAP = 6;
const EDGE = 8;

function input(overrides: Partial<PopoverPlacementInput>): PopoverPlacementInput {
    return {
        side: "below",
        align: "end",
        anchor: { top: 100, bottom: 130, left: 600, right: 900 },
        bound: undefined,
        viewport,
        width: 300,
        height: 200,
        gap: GAP,
        edge: EDGE,
        ...overrides,
    };
}

describe("placePopover", () => {
    test("a popover that fits on its own side stays there, placed from the anchor and the window", () => {
        expect(placePopover(input({}))).toEqual({ left: 600, top: 130, room: 800 - 130 - GAP - EDGE });
        expect(placePopover(input({ side: "above", anchor: { top: 500, bottom: 530, left: 600, right: 900 } }))).toEqual({
            left: 600,
            bottom: 800 - 500,
            room: 500 - GAP - EDGE,
        });
    });

    test("it flips above when there is too little room below and more above", () => {
        const anchor = { top: 600, bottom: 630, left: 600, right: 900 };
        const placed = placePopover(input({ anchor, height: 300 }));
        expect(placed.top).toBeUndefined();
        // The CSS margin is on the below side, so the gap moves into the inset.
        expect(placed.bottom).toBe(800 - 600 + GAP);
        expect(placed.room).toBe(600 - GAP - EDGE);
    });

    test("it flips below when a popover meant for above has no room there", () => {
        const anchor = { top: 80, bottom: 110, left: 600, right: 900 };
        const placed = placePopover(input({ side: "above", anchor, height: 300 }));
        expect(placed.bottom).toBeUndefined();
        expect(placed.top).toBe(110 + GAP);
        expect(placed.room).toBe(800 - 110 - GAP - EDGE);
    });

    test("it stays on its side when the other side has no more room", () => {
        const high = placePopover(input({ anchor: { top: 450, bottom: 480, left: 600, right: 900 }, side: "above", height: 500 }));
        expect(high.bottom).toBe(800 - 450);
        expect(high.room).toBe(450 - GAP - EDGE);
        const low = placePopover(input({ anchor: { top: 300, bottom: 330, left: 600, right: 900 }, height: 700 }));
        expect(low.top).toBe(330);
        expect(low.room).toBe(800 - 330 - GAP - EDGE);
    });

    test("an enclosing sheet bounds the room, so the popover flips though the window has more", () => {
        const sheet = { top: 72, bottom: 728, left: 150, right: 1050 };
        const anchor = { top: 600, bottom: 630, left: 700, right: 1000 };
        const inWindow = placePopover(input({ anchor, height: 150 }));
        expect(inWindow.top).toBe(630);
        const inSheet = placePopover(input({ anchor, height: 150, bound: sheet }));
        expect(inSheet.top).toBeUndefined();
        expect(inSheet.bottom).toBe(800 - 600 + GAP);
        expect(inSheet.room).toBe(600 - 72 - GAP - EDGE);
    });

    test("below room is measured to the sheet's bottom edge", () => {
        const sheet = { top: 72, bottom: 728, left: 150, right: 1050 };
        const placed = placePopover(input({ anchor: { top: 200, bottom: 230, left: 700, right: 1000 }, height: 300, bound: sheet }));
        expect(placed.top).toBe(230);
        expect(placed.room).toBe(728 - 230 - GAP - EDGE);
    });

    test("a sheet that extends past the window is cut to the window", () => {
        const sheet = { top: -40, bottom: 900, left: -20, right: 1300 };
        const placed = placePopover(input({ anchor: { top: 740, bottom: 770, left: 0, right: 100 }, height: 300, align: "start", bound: sheet }));
        expect(placed.bottom).toBe(800 - 740 + GAP);
        expect(placed.room).toBe(740 - 0 - GAP - EDGE);
        expect(placed.left).toBe(EDGE);
    });

    test("the popover is kept inside the sheet sideways", () => {
        const sheet = { top: 72, bottom: 728, left: 150, right: 1050 };
        const past = placePopover(input({ anchor: { top: 100, bottom: 130, left: 800, right: 1100 }, bound: sheet }));
        expect(past.left).toBe(1050 - 300 - EDGE);
        const before = placePopover(input({ anchor: { top: 100, bottom: 130, left: 160, right: 200 }, bound: sheet }));
        expect(before.left).toBe(150 + EDGE);
    });

    test("start alignment follows the anchor's left edge and end alignment its right edge", () => {
        expect(placePopover(input({ align: "start" })).left).toBe(600);
        expect(placePopover(input({ align: "end" })).left).toBe(900 - 300);
    });

    test("room never goes negative", () => {
        const placed = placePopover(input({ anchor: { top: 790, bottom: 799, left: 600, right: 900 }, height: 100 }));
        expect(placed.room).toBeGreaterThanOrEqual(0);
    });
});
