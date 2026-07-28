import { expect, test } from "bun:test";

import {
    handleTuiSessionRenamePromptKey,
    handleTuiSessionRenamePromptPaste,
    startTuiSessionRenamePrompt,
} from "../../clients/tui/session-rename-prompt.ts";

const session = {
    sessionId: "11111111-first-session",
    label: "Fix the deployment race",
};

test("the rename prompt opens empty rather than offering the row text", () => {
    expect(startTuiSessionRenamePrompt(session)).toEqual({
        sessionId: session.sessionId,
        label: session.label,
        value: "",
    });
});

test("typing builds the name and Enter submits it", () => {
    let state = startTuiSessionRenamePrompt(session);
    for (const name of "ship it") {
        state = handleTuiSessionRenamePromptKey(state, { name }).state ?? state;
    }
    state = handleTuiSessionRenamePromptKey(state, { name: "x" }).state
        ?? state;
    state = handleTuiSessionRenamePromptKey(state, { name: "backspace" }).state
        ?? state;
    expect(state.value).toBe("ship it");
    expect(handleTuiSessionRenamePromptKey(state, { name: "return" }))
        .toEqual({ handled: true, submitted: "ship it" });
});

test("an empty submit clears the name and Escape asks for nothing", () => {
    const state = startTuiSessionRenamePrompt(session);
    expect(handleTuiSessionRenamePromptKey(state, { name: "enter" }))
        .toEqual({ handled: true, submitted: null });
    // Whitespace is not a name either, so it clears rather than storing "  ".
    const spaced = handleTuiSessionRenamePromptKey(state, {
        name: "space",
        sequence: "  ",
    }).state ?? state;
    expect(handleTuiSessionRenamePromptKey(spaced, { name: "enter" }))
        .toEqual({ handled: true, submitted: null });
    expect(handleTuiSessionRenamePromptKey(state, { name: "escape" }))
        .toEqual({ handled: true });
});

test("the prompt swallows keys the pane underneath would act on", () => {
    let state = startTuiSessionRenamePrompt(session);
    for (const name of "ship") {
        state = handleTuiSessionRenamePromptKey(state, { name }).state ?? state;
    }
    // ^r would otherwise reopen this prompt over itself, delete would open the
    // trash confirmation, and the arrows would move a hidden cursor.
    for (const key of [
        { name: "r", ctrl: true },
        { name: "delete" },
        { name: "down" },
        { name: "tab", sequence: "\t" },
    ]) {
        expect(handleTuiSessionRenamePromptKey(state, key))
            .toEqual({ state, handled: true });
    }
});

test("a pasted name drops the newline a copied line carries", () => {
    const state = startTuiSessionRenamePrompt(session);
    expect(handleTuiSessionRenamePromptPaste(state, "release notes\n").value)
        .toBe("release notes");
    expect(handleTuiSessionRenamePromptPaste(state, "\n\n")).toBe(state);
});
