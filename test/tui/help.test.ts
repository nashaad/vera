import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiHelpView,
    handleTuiHelpKey,
    startTuiHelp,
} from "../../clients/tui/help.ts";

const commands = [{
    name: "help",
    description: "Learn Vera controls and commands",
    usage: "/help",
}, {
    name: "commands",
    description: "Search and run available commands",
    usage: "/commands",
}] as const;

const extensions = [{
    name: "hello",
    description: "Say hello",
    usage: "/hello [name]",
    source: "test.extension",
}] as const;

test("help tabs browse slash commands without producing an action", () => {
    let state = startTuiHelp(commands, extensions);
    expect(state.tab).toBe("general");

    state = handleTuiHelpKey(state, { name: "right" }).state ?? state;
    expect(state.tab).toBe("slash_commands");
    expect(handleTuiHelpKey(state, { name: "enter" })).toEqual({
        state,
        handled: true,
    });
    expect(handleTuiHelpKey(state, {
        name: "enter",
        shift: true,
    })).toEqual({
        state,
        handled: true,
    });
    expect(handleTuiHelpKey(state, { name: "kpenter" })).toEqual({
        state,
        handled: true,
    });

    state = handleTuiHelpKey(state, { name: "right" }).state ?? state;
    expect(state.tab).toBe("extensions");
    for (const name of "hello") {
        state = handleTuiHelpKey(state, { name }).state ?? state;
    }
    expect(state.query).toBe("hello");
});

test("help renders general guidance and extension attribution", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiHelpView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    try {
        let state = startTuiHelp(commands, extensions);
        view.update(state);
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("Help");
        expect(frame).toContain("General");
        expect(frame).toContain("Slash commands");
        expect(frame).toContain("Shift+Enter newline");

        state = handleTuiHelpKey(state, { name: "right" }).state ?? state;
        state = handleTuiHelpKey(state, { name: "right" }).state ?? state;
        view.update(state);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("/hello");
        expect(frame).toContain("test.extension");
        expect(frame).toContain("←→ tabs");
    } finally {
        setup.renderer.destroy();
    }
});
