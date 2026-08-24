import { beforeEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { resetDialogPointerTracking } from "../../clients/tui/dialog-chrome.ts";

import {
    createTuiCommandPaletteView,
    startTuiCommandPalette,
} from "../../clients/tui/command-palette.ts";
import type { TuiPaletteEntry } from "../../clients/tui/commands.ts";

// Pointer support lives in one place (`dialogOptionRow`), so these tests drive
// a real renderer and a real click rather than asserting a handler was
// assigned: what matters is that a click on the row a user can see reaches the
// index that row stands for.

const commands = [{
    name: "rename",
    label: "Rename conversation",
    description: "give this conversation a name",
    group: "Session",
    slashName: "rename",
    action: { type: "prefill_composer", text: "/rename " },
}, {
    name: "model",
    label: "Switch model",
    description: "change the model for the next turn",
    group: "Settings",
    slashName: "model",
    action: {
        type: "open_settings_destination",
        destination: { kind: "model" },
    },
}] as const satisfies readonly TuiPaletteEntry[];

// One pointer per process, so its last position outlives a test.
beforeEach(resetDialogPointerTracking);

/** The screen row a label was drawn on, so a click can aim at it. */
function rowOf(frame: string, label: string): number {
    const row = frame.split("\n").findIndex((line) => line.includes(label));
    expect(row).toBeGreaterThanOrEqual(0);
    return row;
}

test("clicking a dialog row activates that row's index", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    try {
        const activated: number[] = [];
        const view = createTuiCommandPaletteView(setup.renderer);
        view.pointer = { activate: (index) => activated.push(index) };
        setup.renderer.root.add(view.box);
        view.box.visible = true;
        view.update(startTuiCommandPalette(commands));
        await setup.flush();

        const y = rowOf(setup.captureCharFrame(), "Switch model");
        await setup.mockMouse.click(20, y);
        await setup.flush();

        // The second command, not the highlighted first one.
        expect(activated).toEqual([1]);
    } finally {
        setup.renderer.destroy();
    }
});

test("hovering a dialog row reports that row's index", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    try {
        const hovered: number[] = [];
        const view = createTuiCommandPaletteView(setup.renderer);
        view.pointer = { hover: (index) => hovered.push(index) };
        setup.renderer.root.add(view.box);
        view.box.visible = true;
        view.update(startTuiCommandPalette(commands));
        await setup.flush();

        const y = rowOf(setup.captureCharFrame(), "Switch model");
        await setup.mockMouse.moveTo(20, y);
        await setup.flush();

        expect(hovered).toEqual([1]);
    } finally {
        setup.renderer.destroy();
    }
});

test("rows sliding under a still pointer do not report a hover", async () => {
    // The runaway: these lists window around the cursor, so a hover that moves
    // the cursor re-centres the window and puts a different row under a pointer
    // that never moved. Without this, that row reports its own hover and the
    // highlight climbs the list on its own.
    const setup = await createTestRenderer({ width: 100, height: 30 });
    try {
        const hovered: number[] = [];
        const view = createTuiCommandPaletteView(setup.renderer);
        view.pointer = { hover: (index) => hovered.push(index) };
        setup.renderer.root.add(view.box);
        view.box.visible = true;
        view.update(startTuiCommandPalette(commands));
        await setup.flush();

        const y = rowOf(setup.captureCharFrame(), "Switch model");
        await setup.mockMouse.moveTo(20, y);
        await setup.flush();
        expect(hovered).toEqual([1]);

        // Rebuild the rows with a different row at that position, which is what
        // a re-centred window does, and leave the pointer where it was.
        view.update({
            ...startTuiCommandPalette(commands),
            selectedIndex: 1,
        });
        await setup.flush();

        expect(hovered).toEqual([1]);
    } finally {
        setup.renderer.destroy();
    }
});

test("a dialog row with no pointer keeps its handlers unset", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    try {
        const view = createTuiCommandPaletteView(setup.renderer);
        setup.renderer.root.add(view.box);
        view.box.visible = true;
        view.update(startTuiCommandPalette(commands));
        await setup.flush();

        // No throw, no handler: the surfaces that never opt in are untouched.
        const y = rowOf(setup.captureCharFrame(), "Switch model");
        await setup.mockMouse.click(20, y);
        await setup.flush();
    } finally {
        setup.renderer.destroy();
    }
});
