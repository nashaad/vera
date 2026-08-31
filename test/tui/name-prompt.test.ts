import { expect, test } from "bun:test";
import { RGBA, type TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiNamePromptView,
    handleTuiNamePromptKey,
    startTuiNamePrompt,
} from "../../clients/tui/name-prompt.ts";
import { TUI_PANEL } from "../../clients/tui/state.ts";

const session = {
    kind: "session",
    sessionId: "11111111-first-session",
} as const;
const label = "Fix the deployment race";

test("the rename prompt opens on the current name", async () => {
    const setup = await createTestRenderer({ width: 80, height: 16 });
    const view = createTuiNamePromptView(setup.renderer);
    setup.renderer.root.add(view.surface);
    const state = startTuiNamePrompt(session, label, undefined, label);
    view.update(state);
    try {
        expect(state).toMatchObject({ target: session, label, value: label });
        const edited = view.handleKey(state, { name: "backspace" }).state!;
        expect(edited.value).toBe("Fix the deployment rac");
    } finally {
        setup.renderer.destroy();
    }
});

test("an empty rename uses the shared card field chrome and cursor", async () => {
    const setup = await createTestRenderer({ width: 80, height: 16 });
    const view = createTuiNamePromptView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    view.update(startTuiNamePrompt(session, label));
    view.focus();
    try {
        await setup.flush();
        const entry = view.box.findDescendantById(
            "name-prompt-entry",
        ) as TextareaRenderable;
        const visibleLines = setup.captureCharFrame()
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        expect(visibleLines).toEqual([
            "Rename conversation",
            "New name",
            "←→ move · ⏎ save · empty clears · esc cancel",
        ]);
        expect(entry.placeholder).toBe("New name");
        expect(entry.backgroundColor.toInts())
            .toEqual(RGBA.fromHex(TUI_PANEL).toInts());
        expect(setup.renderer.currentFocusedRenderable).toBe(entry);
    } finally {
        setup.renderer.destroy();
    }
});

test("the rename prompt uses a native non-displacing cursor", async () => {
    const setup = await createTestRenderer({ width: 80, height: 16 });
    const view = createTuiNamePromptView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    let state = startTuiNamePrompt(session, label, undefined, "release ntes");
    view.update(state);
    view.focus();
    try {
        for (let index = 0; index < 3; index += 1) {
            state = view.handleKey(state, { name: "left" }).state!;
            view.update(state);
        }
        state = view.handleKey(state, { name: "o", sequence: "o" }).state!;
        view.update(state);
        expect(state.value).toBe("release notes");

        state = view.handleKey(state, { name: "home" }).state!;
        state = view.handleKey(state, { name: "delete" }).state!;
        view.update(state);
        expect(state.value).toBe("elease notes");
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain("▏");
        expect(setup.renderer.currentFocusedRenderable?.id)
            .toBe("name-prompt-entry");
    } finally {
        setup.renderer.destroy();
    }
});

test("typing builds the name and Enter submits it", async () => {
    const setup = await createTestRenderer({ width: 80, height: 16 });
    const view = createTuiNamePromptView(setup.renderer);
    let state = startTuiNamePrompt(session, label);
    view.update(state);
    try {
        for (const name of "ship itx") {
            state = view.handleKey(state, { name, sequence: name }).state!;
        }
        state = view.handleKey(state, { name: "backspace" }).state!;
        expect(state.value).toBe("ship it");
        expect(view.handleKey(state, { name: "return" }))
            .toEqual({ handled: true, submitted: "ship it" });
    } finally {
        setup.renderer.destroy();
    }
});

test("an empty submit clears the name and Escape asks for nothing", () => {
    const state = startTuiNamePrompt(session, label);
    expect(handleTuiNamePromptKey(state, { name: "enter" }))
        .toEqual({ handled: true, submitted: null });
    const spaced = { ...state, value: "  " };
    expect(handleTuiNamePromptKey(spaced, { name: "enter" }))
        .toEqual({ handled: true, submitted: null });
    expect(handleTuiNamePromptKey(state, { name: "escape" }))
        .toEqual({ handled: true });
});

test("the prompt swallows keys the pane underneath would act on", async () => {
    const setup = await createTestRenderer({ width: 80, height: 16 });
    const view = createTuiNamePromptView(setup.renderer);
    const state = startTuiNamePrompt(session, label, undefined, "ship");
    view.update(state);
    try {
        for (const key of [
            { name: "r", ctrl: true },
            { name: "down" },
            { name: "tab", sequence: "\t" },
        ]) {
            expect(view.handleKey(state, key).handled).toBeTrue();
        }
    } finally {
        setup.renderer.destroy();
    }
});

test("a pasted name drops copied line breaks", async () => {
    const setup = await createTestRenderer({ width: 80, height: 16 });
    const view = createTuiNamePromptView(setup.renderer);
    let state = startTuiNamePrompt(session, label);
    view.update(state);
    try {
        state = view.handlePaste(state, "release notes\n");
        expect(state.value).toBe("release notes");
        state = view.handlePaste(state, " v2");
        expect(state.value).toBe("release notes v2");
    } finally {
        setup.renderer.destroy();
    }
});
