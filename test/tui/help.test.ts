import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiHelpView,
    handleTuiHelpKey,
    startTuiHelp,
    type TuiHelpState,
    type TuiHelpTab,
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

function page(tab: TuiHelpTab): TuiHelpState {
    return { ...startTuiHelp(commands, extensions), tab, open: true };
}

async function editHelp(
    state: TuiHelpState,
    keys: readonly string[],
): Promise<TuiHelpState> {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiHelpView(setup.renderer);
    view.update(state);
    try {
        for (const name of keys) {
            const editor = view.handleEditorKey(state, {
                name,
                ...(name.length === 1 ? { sequence: name } : {}),
            });
            const transition = editor.handled
                ? editor
                : handleTuiHelpKey(state, { name });
            state = transition.state ?? state;
            view.update(state);
        }
        return state;
    } finally {
        setup.renderer.destroy();
    }
}

test("help opens on a menu of pages; Enter opens one and Esc goes back", () => {
    let state = startTuiHelp(commands, extensions);
    expect(state).toMatchObject({ tab: "general", open: false });
    // The menu is one section: Left, Right, and Tab are consumed in place.
    for (const name of ["left", "right", "tab"]) {
        expect(handleTuiHelpKey(state, { name })).toEqual({ state, handled: true });
    }
    expect(handleTuiHelpKey(state, { name: "up" }).state?.tab).toBe("general");

    state = handleTuiHelpKey(state, { name: "down" }).state ?? state;
    state = handleTuiHelpKey(state, { name: "down" }).state ?? state;
    expect(state.tab).toBe("slash_commands");
    state = handleTuiHelpKey(state, { name: "enter" }).state ?? state;
    expect(state).toMatchObject({ tab: "slash_commands", open: true, focus: "search" });
    // Enter on a page is read-only.
    expect(handleTuiHelpKey(state, { name: "kpenter" })).toEqual({ state, handled: true });

    state = handleTuiHelpKey(state, { name: "escape" }).state ?? state;
    expect(state).toMatchObject({ tab: "slash_commands", open: false });
    expect(handleTuiHelpKey(state, { name: "escape" })).toEqual({ handled: true });
});

test("General is one section: arrows and Tab are consumed", () => {
    const state = page("general");
    for (const name of ["up", "down", "left", "right", "tab"]) {
        expect(handleTuiHelpKey(state, { name })).toEqual({ state, handled: true });
    }
});

test("a help page has Search and the list; unused arrows move between them", () => {
    let state = page("keys");
    // Left at the caret's edge stays in Search.
    expect(handleTuiHelpKey(state, { name: "left" })).toEqual({ state, handled: true });
    expect(handleTuiHelpKey(state, { name: "up" }).state?.focus).toBe("list");
    state = handleTuiHelpKey(state, { name: "down" }).state ?? state;
    expect(state.focus).toBe("list");
    state = handleTuiHelpKey(state, { name: "down" }).state ?? state;
    expect(state).toMatchObject({ focus: "list", selectedIndex: 1 });
    state = handleTuiHelpKey(state, { name: "up" }).state ?? state;
    state = handleTuiHelpKey(state, { name: "up" }).state ?? state;
    expect(state).toMatchObject({ focus: "list", selectedIndex: 0 });

    expect(handleTuiHelpKey(state, { name: "right" }).state?.focus).toBe("search");
    expect(handleTuiHelpKey(state, { name: "left" }).state?.focus).toBe("search");
    expect(handleTuiHelpKey(state, { name: "tab" }).state?.focus).toBe("search");
    expect(handleTuiHelpKey(state, { name: "tab", shift: true }).state?.focus).toBe("search");
});

test("typing from the help list goes to Search; space does not", async () => {
    const state = await editHelp({ ...page("slash_commands"), focus: "list" }, ["space", "p", "a"]);
    expect(state).toMatchObject({ focus: "search", query: "pa" });
});

test("typing on the help menu does not search", async () => {
    const state = await editHelp(startTuiHelp(commands, extensions), ["p"]);
    expect(state).toMatchObject({ open: false, query: "" });
});

test("help search accepts spaces", async () => {
    const state = await editHelp(page("keys"), ["h", "e", "l", "p", "space", "m", "e"]);
    expect(state.query).toBe("help me");
});

test("help search edits at the caret", async () => {
    const state = await editHelp(page("keys"), [..."hep", "left", "l"]);
    expect(state).toMatchObject({ tab: "keys", query: "help", queryCursor: 3 });
});

test("help paste filters the open page", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiHelpView(setup.renderer);
    let state = page("keys");
    view.update(state);
    try {
        state = view.handleEditorPaste(state, "ctrl+shift");
        expect(state.query).toBe("ctrl+shift");
    } finally {
        setup.renderer.destroy();
    }
});

test("help renders the menu, general guidance, and extension attribution", async () => {
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
        expect(frame).toContain("Every key, grouped by where it works");
        expect(frame).toContain("↑↓ choose · ⏎ open · esc close");

        view.update(page("general"));
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("Help › General");
        expect(frame).toContain("Shift+Enter newline");

        // Every chord is the Keys page's job, and it is generated from the
        // keymap, so a binding added to the table shows up here without anyone
        // writing prose about it.
        state = page("keys");
        view.update(state);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("Ctrl+P");
        expect(frame).toContain("Open the command palette");
        // A chord a terminal only reports under the kitty keyboard protocol
        // is labelled as such, rather than looking simply broken.
        expect(frame).toContain("Ctrl+Shift+M");
        expect(frame).toContain("Anywhere · kitty");
        expect(frame).not.toContain("workspace list");

        const keys = state;
        for (const [query, detail] of [["ctrl+end", "Transcript"], ["show all", "Browse models"], ["search and the model list", "Favorites"]]) {
            view.update(keys);
            state = view.handleEditorPaste(keys, query!);
            view.update(state);
            await setup.flush();
            expect(setup.captureCharFrame()).toContain(detail!);
        }

        view.update(page("extensions"));
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("/hello");
        expect(frame).toContain("test.extension");
        expect(frame).toContain("esc back");
    } finally {
        setup.renderer.destroy();
    }
});
