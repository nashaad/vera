import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiCommandPaletteView,
    handleTuiCommandPaletteKey,
    startTuiCommandPalette,
    updateTuiCommandPaletteCommands,
} from "../../clients/tui/command-palette.ts";

const commands = [{
    name: "help",
    description: "Browse available commands",
    usage: "/help",
}, {
    name: "model",
    description: "Change the model",
    usage: "/model <model-id>",
}, {
    name: "rename",
    description: "Name this conversation",
    usage: "/rename [name]",
}] as const;

test("command palette searches metadata and selects the same command", () => {
    let state = startTuiCommandPalette(commands);
    for (const name of "conversation") {
        state = handleTuiCommandPaletteKey(state, { name }).state ?? state;
    }

    expect(state.commands.map((command) => command.name)).toEqual(["rename"]);
    expect(handleTuiCommandPaletteKey(state, { name: "enter" }).selection)
        .toEqual(commands[2]);
    expect(handleTuiCommandPaletteKey(state, { name: "escape" })).toEqual({
        handled: true,
    });
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

test("command palette renders command descriptions and usage", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiCommandPaletteView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(startTuiCommandPalette(commands));
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Commands");
        expect(frame).toContain("/help");
        expect(frame).toContain("Browse available commands");
        expect(frame).toContain("/model <model-id>");
        expect(frame).toContain("↑↓ move · ⏎ run · esc close");
    } finally {
        setup.renderer.destroy();
    }
});
