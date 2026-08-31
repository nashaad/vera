import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiHelpView,
    handleTuiHelpKey,
    handleTuiHelpPaste,
    startTuiHelp,
} from "../../clients/tui/help.ts";

const commands = [{
    name: "help",
    description: "Learn Vera controls and commands",
    usage: "/help",
}, {
    name: "palette",
    description: "Search every action by name or description",
    usage: "/palette",
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
    expect(state.tab).toBe("keys");

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

test("help search accepts spaces", () => {
    let state = startTuiHelp(commands, extensions);
    state = handleTuiHelpKey(state, { name: "right" }).state ?? state;
    for (const name of ["h", "e", "l", "p", "space", "m", "e"]) {
        state = handleTuiHelpKey(state, { name }).state ?? state;
    }
    expect(state.query).toBe("help me");
});

test("help search edits at the caret without switching tabs", () => {
    let state = startTuiHelp(commands, extensions);
    state = handleTuiHelpKey(state, { name: "right" }).state ?? state;
    for (const name of "hep") {
        state = handleTuiHelpKey(state, { name }).state ?? state;
    }
    state = handleTuiHelpKey(state, { name: "left" }).state ?? state;
    state = handleTuiHelpKey(state, { name: "l" }).state ?? state;

    expect(state.tab).toBe("keys");
    expect(state.query).toBe("help");
    expect(state.queryCursor).toBe(3);
});

test("help paste filters the active tab", () => {
    let state = startTuiHelp(commands, extensions);
    state = handleTuiHelpKey(state, { name: "right" }).state ?? state;
    state = handleTuiHelpPaste(state, "ctrl+shift");
    expect(state.query).toBe("ctrl+shift");
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

        // Every chord is the Keys tab's job, and it is generated from the
        // keymap, so a binding added to the table shows up here without anyone
        // writing prose about it.
        state = handleTuiHelpKey(state, { name: "right" }).state ?? state;
        view.update(state);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("ctrl+p");
        expect(frame).toContain("Open the command palette");
        // A chord a terminal only reports under the kitty keyboard protocol
        // is labelled as such, rather than looking simply broken.
        expect(frame).toContain("ctrl+shift+m");
        expect(frame).toContain("Anywhere · kitty");
        // The Transcript scope stays on the first page: a scope that only
        // exists while one pane holds focus is not listed here, so the global
        // block does not grow past the fold.
        expect(frame).toContain("ctrl+end");
        expect(frame).toContain("Transcript");
        expect(frame).not.toContain("workspace list");

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
