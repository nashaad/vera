import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    dialogBoxHeight,
    halfPageCursor,
    LIST_MIN_ROWS,
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "../../clients/tui/list-window.ts";
import {
    createTuiCommandPaletteView,
    handleTuiCommandPaletteScroll,
    startTuiCommandPalette,
} from "../../clients/tui/command-palette.ts";
import {
    createTuiHelpView,
    handleTuiHelpScroll,
    startTuiHelp,
} from "../../clients/tui/help.ts";
import type {
    TuiCommandCatalogEntry,
    TuiPaletteEntry,
} from "../../clients/tui/commands.ts";

test("row count follows the terminal, and a cramped one keeps a usable list", async () => {
    const tall = await createTestRenderer({ width: 80, height: 60 });
    try {
        // The old constants were 10, 12 and 14, so a 60-row terminal showed a
        // box in the top quarter with the rest of the screen empty.
        expect(listWindowRows(dialogBoxHeight(tall.renderer, 2), 8))
            .toBeGreaterThan(14);
    } finally {
        tall.renderer.destroy();
    }

    const cramped = await createTestRenderer({ width: 42, height: 12 });
    try {
        // A list windowed to one or two rows is not a list, so the overlay is
        // allowed to overrun rather than becoming a peephole.
        expect(listWindowRows(dialogBoxHeight(cramped.renderer, 2), 8))
            .toBe(LIST_MIN_ROWS);
    } finally {
        cramped.renderer.destroy();
    }
});

test("the window centres on the cursor and stops at both ends", () => {
    const rows = Array.from({ length: 20 }, (_, index) => index);

    expect(listWindowSlice(rows, 0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(listWindowSlice(rows, 10, 5)).toEqual([8, 9, 10, 11, 12]);
    expect(listWindowSlice(rows, 19, 5)).toEqual([15, 16, 17, 18, 19]);
    // Shorter than the window means no windowing at all.
    expect(listWindowSlice([1, 2], 0, 5)).toEqual([1, 2]);
});

test("half a page is half of what is on screen, clamped at both ends", () => {
    expect(halfPageCursor(0, 100, 20, "down")).toBe(10);
    expect(halfPageCursor(95, 100, 20, "down")).toBe(99);
    expect(halfPageCursor(3, 100, 20, "up")).toBe(0);
    // A one-row window still moves, or the key reads as broken.
    expect(halfPageCursor(0, 100, 1, "down")).toBe(1);
});

test("the wheel moves whole rows and ignores a sideways scroll", () => {
    expect(wheelCursor(0, 100, { direction: "down", delta: 3 })).toBe(3);
    expect(wheelCursor(0, 100, { direction: "up", delta: 3 })).toBe(0);
    // A trackpad reports fractions of a row, and a scroll that moves nothing
    // reads as a dead pane.
    expect(wheelCursor(0, 100, { direction: "down", delta: 0.2 })).toBe(1);
    expect(wheelCursor(0, 100, { direction: "left", delta: 3 }))
        .toBeUndefined();
    expect(wheelCursor(0, 0, { direction: "down", delta: 3 })).toBe(0);
});

test("the wheel moves more than the one surface it was built for", () => {
    // The point of the extraction: a capability added to a windowed list
    // reaches every windowed list, rather than stopping at the model pane.
    const palette = startTuiCommandPalette(paletteCommands(3));
    expect(
        handleTuiCommandPaletteScroll(palette, { direction: "down", delta: 2 })
            .state?.selectedIndex,
    ).toBe(2);

    const help = {
        ...startTuiHelp(helpCommands(3), []),
        // The general tab is prose, not a list, so the wheel only means
        // something once there are commands under the cursor.
        tab: "slash_commands" as const,
        open: true,
    };
    expect(
        handleTuiHelpScroll(help, { direction: "down", delta: 1 })
            .state?.selectedIndex,
    ).toBe(1);
});

test("a tall terminal fills the palette and help with rows, not empty space", async () => {
    const setup = await createTestRenderer({ width: 100, height: 60 });
    try {
        const palette = createTuiCommandPaletteView(setup.renderer);
        palette.update(startTuiCommandPalette(paletteCommands(40)));
        // 12 was the palette's old fixed count and 14 was help's, so a row
        // count above them is the terminal being read rather than a constant.
        // Count the rendered children: the box reports its laid-out height
        // only after a frame, and the rows are what the user sees either way.
        expect(palette.box.getChildren().length).toBeGreaterThan(12);

        const help = createTuiHelpView(setup.renderer);
        help.update({
            ...startTuiHelp(helpCommands(40), []),
            tab: "slash_commands",
            open: true,
        });
        expect(help.box.getChildren().length).toBeGreaterThan(14);
    } finally {
        setup.renderer.destroy();
    }
});

function paletteCommands(count: number): readonly TuiPaletteEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        name: `command-${index}`,
        label: `Command ${index}`,
        description: "",
        group: "Settings" as const,
        action: { type: "open_theme_picker" } as const,
    }));
}

function helpCommands(count: number): readonly TuiCommandCatalogEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        name: `command-${index}`,
        description: `Command ${index}`,
        usage: `/command-${index}`,
    }));
}
