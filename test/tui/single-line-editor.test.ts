import { expect, test } from "bun:test";
import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { TuiComposer } from "../../clients/tui/composer.ts";
import {
    createTuiSingleLineTextarea,
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "../../clients/tui/single-line-editor.ts";

test("ordinary fields and the composer share OpenTUI's textarea", async () => {
    const setup = await createTestRenderer({ width: 40, height: 4 });
    const editor = createTuiSingleLineTextarea(setup.renderer, {
        id: "field",
        placeholder: "Input",
    });
    try {
        expect(editor).toBeInstanceOf(TextareaRenderable);
        expect(Object.getPrototypeOf(TuiComposer.prototype))
            .toBe(TextareaRenderable.prototype);
    } finally {
        setup.renderer.destroy();
    }
});

test("single-line fields use native cursor editing", async () => {
    const setup = await createTestRenderer({ width: 40, height: 4 });
    const editor = createTuiSingleLineTextarea(setup.renderer, {
        id: "field",
        placeholder: "Input",
    });
    setup.renderer.root.add(editor);
    try {
        editor.setText("release ntes");
        editor.cursorOffset = editor.plainText.length;
        for (let index = 0; index < 3; index += 1) {
            editor.handleKeyPress(tuiTextareaKey({ name: "left" }));
        }
        editor.handleKeyPress(tuiTextareaKey({ name: "o", sequence: "o" }));
        expect(editor.plainText).toBe("release notes");
        expect(editor.cursorOffset).toBe(10);

        editor.handleKeyPress(tuiTextareaKey({ name: "left" }));
        editor.handleKeyPress(tuiTextareaKey({ name: "backspace" }));
        expect(editor.plainText).toBe("release otes");
        editor.handleKeyPress(tuiTextareaKey({ name: "delete" }));
        expect(editor.plainText).toBe("release tes");
    } finally {
        setup.renderer.destroy();
    }
});

test("native Home, End, selection, and paste share one cursor", async () => {
    const setup = await createTestRenderer({ width: 40, height: 4 });
    const editor = createTuiSingleLineTextarea(setup.renderer, {
        id: "field",
        placeholder: "Input",
    });
    setup.renderer.root.add(editor);
    try {
        editor.focus();
        editor.setText("notes");
        editor.gotoBufferEnd();
        editor.handleKeyPress(tuiTextareaKey({ name: "home" }));
        insertTuiSingleLinePaste(editor, "release \n");
        expect(editor.plainText).toBe("release notes");
        expect(editor.cursorOffset).toBe("release ".length);

        await setup.flush();
        editor.handleKeyPress(tuiTextareaKey({ name: "end" }));
        editor.handleKeyPress(tuiTextareaKey({ name: "left", shift: true }));
        expect(editor.getSelection()).not.toBeNull();
        editor.deleteSelection();
        editor.handleKeyPress(tuiTextareaKey({ name: "x", sequence: "x" }));
        expect(editor.plainText).toBe("release notex");
    } finally {
        setup.renderer.destroy();
    }
});

test("native movement and deletion keep a grapheme whole", async () => {
    const setup = await createTestRenderer({ width: 40, height: 4 });
    const editor = createTuiSingleLineTextarea(setup.renderer, {
        id: "field",
        placeholder: "Input",
    });
    setup.renderer.root.add(editor);
    try {
        editor.setText("A👨‍👩‍👧‍👦B");
        editor.gotoBufferEnd();
        editor.handleKeyPress(tuiTextareaKey({ name: "left" }));
        editor.handleKeyPress(tuiTextareaKey({ name: "left" }));
        editor.handleKeyPress(tuiTextareaKey({ name: "delete" }));
        expect(editor.plainText).toBe("AB");
    } finally {
        setup.renderer.destroy();
    }
});
