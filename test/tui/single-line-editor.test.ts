import { expect, test } from "bun:test";

import {
    handleTuiSingleLineEditorKey,
    insertTuiSingleLineText,
    startTuiSingleLineEditor,
    tuiSingleLineText,
} from "../../clients/tui/single-line-editor.ts";

test("single-line editing inserts and deletes on either side of the caret", () => {
    let state = startTuiSingleLineEditor("release ntes");
    for (let index = 0; index < 3; index += 1) {
        state = handleTuiSingleLineEditorKey(state, { name: "left" })!;
    }
    state = handleTuiSingleLineEditorKey(state, { name: "o" })!;
    expect(state).toEqual({ value: "release notes", cursor: 10 });

    state = handleTuiSingleLineEditorKey(state, { name: "left" })!;
    state = handleTuiSingleLineEditorKey(state, { name: "backspace" })!;
    expect(state).toEqual({ value: "release otes", cursor: 8 });
    state = handleTuiSingleLineEditorKey(state, { name: "delete" })!;
    expect(state).toEqual({ value: "release tes", cursor: 8 });
});

test("Home, End, and paste use the same caret", () => {
    let state = startTuiSingleLineEditor("notes");
    state = handleTuiSingleLineEditorKey(state, { name: "home" })!;
    state = insertTuiSingleLineText(state, "release ");
    expect(tuiSingleLineText(state, "▏")).toBe("release ▏notes");
    state = handleTuiSingleLineEditorKey(state, { name: "end" })!;
    expect(tuiSingleLineText(state, "▏")).toBe("release notes▏");
});

test("movement and deletion keep a grapheme whole", () => {
    let state = startTuiSingleLineEditor("A👨‍👩‍👧‍👦B");
    state = handleTuiSingleLineEditorKey(state, { name: "left" })!;
    state = handleTuiSingleLineEditorKey(state, { name: "left" })!;
    expect(tuiSingleLineText(state, "▏")).toBe("A▏👨‍👩‍👧‍👦B");
    state = handleTuiSingleLineEditorKey(state, { name: "delete" })!;
    expect(state).toEqual({ value: "AB", cursor: 1 });
});
