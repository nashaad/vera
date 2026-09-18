import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiCommandPaletteView,
    handleTuiCommandPaletteKey,
    startTuiCommandPalette,
    updateTuiCommandPaletteCommands,
    type TuiCommandPaletteState,
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
    action: {
        type: "open_settings_destination",
        destination: { kind: "model" },
    },
}, {
    name: "granted_permissions",
    label: "Review granted permissions",
    description: "see and revoke what you have approved",
    group: "Settings",
    action: { type: "open_preferences_list" },
}] as const satisfies readonly TuiPaletteEntry[];

async function editedPalette(
    entries: readonly TuiPaletteEntry[],
    keys: readonly string[],
): Promise<TuiCommandPaletteState> {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiCommandPaletteView(setup.renderer);
    let state = startTuiCommandPalette(entries);
    view.update(state);
    try {
        for (const name of keys) {
            const transition = view.handleEditorKey(state, {
                name,
                ...(name.length === 1 ? { sequence: name } : {}),
            });
            state = transition.state ?? state;
            view.update(state);
        }
        return state;
    } finally {
        setup.renderer.destroy();
    }
}

test("command palette searches labels and descriptions, not just names", async () => {
    // "revoke" appears in no command name or label; the palette finds it in the
    // description anyway, which is why it earns a place next to the composer's
    // prefix match.
    const state = await editedPalette(commands, [..."revoke"]);

    expect(state.commands.map((command) => command.name)).toEqual([
        "granted_permissions",
    ]);
    expect(handleTuiCommandPaletteKey(state, { name: "enter" }).selection)
        .toEqual(commands[2]);
    expect(handleTuiCommandPaletteKey(state, { name: "escape" })).toEqual({
        handled: true,
    });
});

test("command palette search accepts spaces between label words", async () => {
    const state = await editedPalette(
        commands,
        ["r", "e", "v", "i", "e", "w", "space", "g"],
    );

    expect(state.query).toBe("review g");
    expect(state.commands.map((command) => command.name)).toEqual([
        "granted_permissions",
    ]);
});

test("command palette search edits at the caret", async () => {
    const state = await editedPalette(
        commands,
        [..."revew", "left", "left", "i"],
    );

    expect(state.query).toBe("review");
    expect(state.queryCursor).toBe(4);
    expect(state.commands.map((command) => command.name)).toEqual([
        "granted_permissions",
    ]);
});

test("command palette keeps the highlight when left or right only moves the caret", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiCommandPaletteView(setup.renderer);
    let state = startTuiCommandPalette(commands);
    view.update(state);
    try {
        state = handleTuiCommandPaletteKey(state, { name: "down" }).state ?? state;
        expect(state.selectedIndex).toBe(1);
        for (const name of ["left", "right"]) {
            const transition = view.handleEditorKey(state, { name });
            state = transition.state ?? state;
            expect(state.selectedIndex).toBe(1);
        }
    } finally {
        setup.renderer.destroy();
    }
});

test("command palette consumes Tab and Shift+Tab without moving", () => {
    const state = handleTuiCommandPaletteKey(startTuiCommandPalette(commands), { name: "down" }).state!;
    for (const key of [{ name: "tab" }, { name: "tab", shift: true }]) {
        expect(handleTuiCommandPaletteKey(state, key)).toEqual({ state, handled: true });
    }
});

test("command palette paste inserts at the caret", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiCommandPaletteView(setup.renderer);
    let state = startTuiCommandPalette(commands);
    view.update(state);
    try {
        state = view.handleEditorPaste(state, "review");
        state = view.handleEditorKey(state, { name: "home" }).state ?? state;
        state = view.handleEditorPaste(state, "permissions ");
        expect(state.query).toBe("permissions review");
    } finally {
        setup.renderer.destroy();
    }
});

test("command palette finds keyboard help by common wording and key hint", async () => {
    const help = {
        name: "help",
        label: "Show keyboard shortcuts",
        description: "view hotkeys, shortcuts, and keyboard controls, including ctrl+p (control p)",
        group: "Settings",
        action: { type: "open_help", tab: "keys" },
    } as const satisfies TuiPaletteEntry;

    for (const query of [
        "hotkey",
        "shortcut",
        "keyboard",
        "ctrl+p",
        "control p",
    ]) {
        const state = await editedPalette([help], [...query]);
        expect(state.commands).toEqual([help]);
    }

    const effort = {
        name: "effort",
        label: "Change reasoning effort",
        description: "how much the model thinks",
        group: "Settings",
        keyHint: "ctrl+o reasoning",
        action: {
            type: "open_settings_destination",
            destination: { kind: "reasoning" },
        },
    } as const satisfies TuiPaletteEntry;
    const state = await editedPalette([effort], [..."ctrl+o"]);
    expect(state.commands).toEqual([effort]);
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

test("an open palette picks up commands loaded later", async () => {
    let state = await editedPalette(commands.slice(0, 1), [..."model"]);
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
        // Groups are a left column printed once, not a heading row, and the
        // title line carries the cursor against the total.
        expect(frame).toContain("session     Rename conversation");
        expect(frame).toContain("settings    Switch model");
        expect(frame).toContain("1/3");
        expect(frame).not.toContain("settings    Review granted");
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

test("the palette is vertically centered on a tall terminal", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    try {
        const view = createTuiCommandPaletteView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        view.update(startTuiCommandPalette(commands));
        await setup.flush();
        const spaceAbove = view.box.screenY;
        const spaceBelow = setup.renderer.height
            - (view.box.screenY + view.box.height);
        expect(Math.abs(spaceAbove - spaceBelow)).toBeLessThanOrEqual(1);
    } finally {
        setup.renderer.destroy();
    }
});

test("palette terms match in either order and tolerate extra spaces", async () => {
    for (const query of ["mod switch", "  switch   mod  "]) {
        const state = await editedPalette(commands, [...query].map((key) => key === " " ? "space" : key));
        expect(state.commands.map((entry) => entry.name)).toEqual(["model"]);
    }
});

test("label terms outrank incidental description matches", async () => {
    const entries: readonly TuiPaletteEntry[] = [
        { ...commands[1], name: "manage", label: "Browse models", description: "keep verified models" },
        { ...commands[1], name: "verify", label: "Verify favorites", description: "send checks" },
    ];
    const state = await editedPalette(entries, [..."ver"].map((key) => key));
    expect(state.commands[0]?.name).toBe("verify");
});
