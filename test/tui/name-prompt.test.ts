import { expect, test } from "bun:test";

import {
    handleTuiNamePromptKey,
    handleTuiNamePromptPaste,
    startTuiNamePrompt,
    tuiNamePromptEntryLine,
} from "../../clients/tui/name-prompt.ts";

const session = {
    kind: "session",
    sessionId: "11111111-first-session",
} as const;
const label = "Fix the deployment race";

test("the rename prompt opens on the current name", () => {
    const state = startTuiNamePrompt(session, label, undefined, label);
    expect(state).toEqual({
        target: session,
        label,
        value: label,
        cursor: label.length,
    });
    expect(handleTuiNamePromptKey(state, { name: "backspace" }).state?.value)
        .toBe("Fix the deployment rac");
});

test("an empty rename field shows only its cursor", () => {
    expect(tuiNamePromptEntryLine("").chunks.map((chunk) => chunk.text).join(""))
        .toBe("▏");
});

test("the rename prompt edits at a movable cursor", () => {
    let state = startTuiNamePrompt(session, label, undefined, "release ntes");
    for (let index = 0; index < 3; index += 1) {
        state = handleTuiNamePromptKey(state, { name: "left" }).state!;
    }
    state = handleTuiNamePromptKey(state, { name: "o" }).state!;
    expect(state.value).toBe("release notes");
    expect(tuiNamePromptEntryLine(state.value, state.cursor).chunks
        .map((chunk) => chunk.text).join(""))
        .toBe("release no▏tes");

    state = handleTuiNamePromptKey(state, { name: "home" }).state!;
    state = handleTuiNamePromptKey(state, { name: "delete" }).state!;
    expect(state.value).toBe("elease notes");
    expect(tuiNamePromptEntryLine(state.value, state.cursor).chunks
        .map((chunk) => chunk.text).join(""))
        .toBe("▏elease notes");
});

test("typing builds the name and Enter submits it", () => {
    let state = startTuiNamePrompt(session, label);
    for (const name of "ship it") {
        state = handleTuiNamePromptKey(state, { name }).state ?? state;
    }
    state = handleTuiNamePromptKey(state, { name: "x" }).state
        ?? state;
    state = handleTuiNamePromptKey(state, { name: "backspace" }).state
        ?? state;
    expect(state.value).toBe("ship it");
    expect(handleTuiNamePromptKey(state, { name: "return" }))
        .toEqual({ handled: true, submitted: "ship it" });
});

test("an empty submit clears the name and Escape asks for nothing", () => {
    const state = startTuiNamePrompt(session, label);
    expect(handleTuiNamePromptKey(state, { name: "enter" }))
        .toEqual({ handled: true, submitted: null });
    // Whitespace is not a name either, so it clears rather than storing "  ".
    const spaced = handleTuiNamePromptKey(state, {
        name: "space",
        sequence: "  ",
    }).state ?? state;
    expect(handleTuiNamePromptKey(spaced, { name: "enter" }))
        .toEqual({ handled: true, submitted: null });
    expect(handleTuiNamePromptKey(state, { name: "escape" }))
        .toEqual({ handled: true });
});

test("the prompt swallows keys the pane underneath would act on", () => {
    let state = startTuiNamePrompt(session, label);
    for (const name of "ship") {
        state = handleTuiNamePromptKey(state, { name }).state ?? state;
    }
    // ^r would otherwise reopen this prompt over itself, delete would open the
    // trash confirmation, and down would move a hidden list cursor.
    for (const key of [
        { name: "r", ctrl: true },
        { name: "down" },
        { name: "tab", sequence: "\t" },
    ]) {
        expect(handleTuiNamePromptKey(state, key))
            .toEqual({ state, handled: true });
    }
});

test("a pasted name drops the newline a copied line carries", () => {
    const state = startTuiNamePrompt(session, label);
    expect(handleTuiNamePromptPaste(state, "release notes\n").value)
        .toBe("release notes");
    expect(handleTuiNamePromptPaste(state, "release ").value)
        .toBe("release ");
    expect(handleTuiNamePromptPaste(state, "\n\n")).toBe(state);
});
