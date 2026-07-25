import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiCommandPaletteView,
    handleTuiCommandPaletteKey,
    startTuiCommandPalette,
    updateTuiCommandPaletteCommands,
} from "../../clients/tui/command-palette.ts";
import type { TuiPaletteEntry } from "../../clients/tui/commands.ts";

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
    action: { type: "open_model_picker" },
}, {
    name: "granted_permissions",
    label: "Review granted permissions",
    description: "see and revoke what you have approved",
    group: "Settings",
    action: { type: "open_preferences_list" },
}] as const satisfies readonly TuiPaletteEntry[];

test("command palette searches labels and descriptions, not just names", () => {
    let state = startTuiCommandPalette(commands);
    // "revoke" appears in no command name or label; the palette finds it in the
    // description anyway, which is why it earns a place next to the composer's
    // prefix match.
    for (const name of "revoke") {
        state = handleTuiCommandPaletteKey(state, { name }).state ?? state;
    }

    expect(state.commands.map((command) => command.name)).toEqual([
        "granted_permissions",
    ]);
    expect(handleTuiCommandPaletteKey(state, { name: "enter" }).selection)
        .toEqual(commands[2]);
    expect(handleTuiCommandPaletteKey(state, { name: "escape" })).toEqual({
        handled: true,
    });
});

test("command palette search accepts spaces between label words", () => {
    let state = startTuiCommandPalette(commands);
    for (const name of ["r", "e", "v", "i", "e", "w", "space", "g"]) {
        state = handleTuiCommandPaletteKey(state, { name }).state ?? state;
    }

    expect(state.query).toBe("review g");
    expect(state.commands.map((command) => command.name)).toEqual([
        "granted_permissions",
    ]);
});

test("command palette orders entries by group, not registration", () => {
    const state = startTuiCommandPalette([
        commands[1],
        commands[2],
        commands[0],
    ]);

    expect(state.commands.map((command) => command.group)).toEqual([
        "Session",
        "Settings",
        "Settings",
    ]);
});

test("an open palette picks up commands loaded later", () => {
    let state = startTuiCommandPalette(commands.slice(0, 1));
    for (const name of "model") {
        state = handleTuiCommandPaletteKey(state, { name }).state ?? state;
    }
    expect(state.commands).toEqual([]);

    state = updateTuiCommandPaletteCommands(state, commands);
    expect(state.query).toBe("model");
    expect(state.commands).toEqual([commands[1]]);
});

test("command palette renders grouped action labels with slash hints", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiCommandPaletteView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(startTuiCommandPalette(commands));
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Commands");
        expect(frame).toContain("Session");
        expect(frame).toContain("Settings");
        expect(frame).toContain("Rename conversation");
        expect(frame).toContain("Switch model");
        // The right-hand column carries the slash form, so the palette teaches
        // the typed command rather than replacing it.
        expect(frame).toContain("/model");
        expect(frame).toContain("↑↓ move · ⏎ run · esc close");
    } finally {
        setup.renderer.destroy();
    }
});

test("the palette card is borderless from construction, not from its first update", async () => {
    // OpenTUI's BoxRenderable constructor treats any border styling option
    // (borderColor, borderStyle, focusedBorderColor, customBorderChars) as
    // "this box wants a border" and silently overrides `border: false`. Passing
    // a color alongside `border: false` therefore draws a box, in the default
    // focused border color rather than the theme's. Asserting before any update
    // catches it at the source instead of after a defensive reset.
    const setup = await createTestRenderer({ width: 100, height: 30 });
    try {
        const view = createTuiCommandPaletteView(setup.renderer);
        expect(view.box.border).toBe(false);
    } finally {
        setup.renderer.destroy();
    }
});

test("the palette sits below the top quarter of the terminal", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    try {
        const view = createTuiCommandPaletteView(setup.renderer);
        expect(view.box.top).toBe(7.5);
    } finally {
        setup.renderer.destroy();
    }
});
