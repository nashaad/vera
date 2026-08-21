import { expect, test } from "bun:test";
import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiComposer,
    createTuiComposerPanel,
    TUI_COMPOSER_MIN_TEXT_ROWS,
    tuiComposerPanelRows,
} from "../../clients/tui/composer.ts";
import { applyTuiTheme } from "../../clients/tui/state.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("TUI composer takes the theme's editing surface", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const theme = { ...VERA_TUI_THEME, input: "#123456" };
    applyTuiTheme(theme);
    const composer = createTuiComposer(setup.renderer, () => {});

    try {
        const expected = RGBA.fromHex("#123456").toInts();
        expect(composer.backgroundColor.toInts()).toEqual(expected);
        composer.focusedBackgroundColor = "#123456";
        composer.focus();
        expect(composer.backgroundColor.toInts()).toEqual(expected);
    } finally {
        applyTuiTheme(VERA_TUI_THEME);
        setup.renderer.destroy();
    }
});

test("clicking composer padding focuses the textarea", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const composer = createTuiComposer(setup.renderer, () => {});
    const { panel } = createTuiComposerPanel(setup.renderer, composer);
    setup.renderer.root.add(panel);

    try {
        await setup.flush();
        expect(composer.focused).toBe(false);
        await setup.mockMouse.click(2, 1);
        expect(composer.focused).toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});

test("composer panel applies configurable geometry and boundary color", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    const composer = createTuiComposer(setup.renderer, () => {});
    const { panel, rule } = createTuiComposerPanel(setup.renderer, composer, {
        marginHorizontal: 4,
        paddingHorizontal: 2,
        boundaryColor: "#334455",
    });
    setup.renderer.root.add(panel);

    try {
        await setup.flush();
        expect(panel.screenX).toBe(4);
        expect(panel.width).toBe(32);
        expect(composer.screenX).toBe(7);
        expect(panel.borderColor.toInts()).toEqual(
            RGBA.fromHex("#334455").toInts(),
        );
        expect(rule.borderColor.toInts()).toEqual(
            RGBA.fromHex("#334455").toInts(),
        );
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI status sits below the composer with a bottom gutter", async () => {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const composer = createTuiComposer(setup.renderer, () => {});
    const { panel } = createTuiComposerPanel(setup.renderer, composer);
    const app = new BoxRenderable(setup.renderer, {
        width: "100%",
        height: "100%",
        flexDirection: "column",
    });
    const transcript = new BoxRenderable(setup.renderer, { flexGrow: 1 });
    const status = new TextRenderable(setup.renderer, {
        content: "ready",
        width: "100%",
        height: 1,
        position: "absolute",
        bottom: 1,
    });
    app.add(transcript);
    app.add(panel);
    app.add(status);
    setup.renderer.root.add(app);

    try {
        await setup.flush();
        expect(status.screenY - (panel.screenY + panel.height)).toBe(0);
        expect(setup.renderer.height - (status.screenY + status.height)).toBe(1);
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI composer edits, pastes, submits, and survives resize", async () => {
    const setup = await createTestRenderer({
        width: 40,
        height: 8,
        kittyKeyboard: true,
    });
    const submitted: string[] = [];
    let composer: ReturnType<typeof createTuiComposer>;
    composer = createTuiComposer(setup.renderer, () => {
        submitted.push(composer.plainText);
    });
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        await setup.mockInput.typeText("first");
        setup.mockInput.pressEnter({ shift: true });
        await setup.mockInput.pasteBracketedText("pasted\nblock");
        await setup.flush();

        expect(composer.plainText).toBe("first\npasted\nblock");
        expect(submitted).toEqual([]);
        expect(composer.width).toBe(40);

        setup.resize(24, 6);
        await setup.flush();

        expect(composer.width).toBe(24);
        expect(composer.plainText).toBe("first\npasted\nblock");

        setup.mockInput.pressEnter();
        expect(submitted).toEqual(["first\npasted\nblock"]);
    } finally {
        setup.renderer.destroy();
    }
});

test("extension text replaces the selection without clearing attachments", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    let submitted = 0;
    const composer = createTuiComposer(setup.renderer, () => submitted++);

    try {
        composer.setComposerText("draft text ");
        composer.attachImageChip("first");
        composer.setSelection(0, 5);
        composer.insertComposerText("revised\r\nline");

        expect(composer.plainText).toBe(
            "revised\nline text [Image 1] ",
        );
        expect(composer.imageChipRequestIds()).toEqual(["first"]);
        expect(composer.focused).toBe(false);
        expect(submitted).toBe(0);
    } finally {
        setup.renderer.destroy();
    }
});

test("extension image-marker text cannot impersonate an attachment chip", async () => {
    const setup = await createTestRenderer({ width: 60, height: 8 });
    const composer = createTuiComposer(setup.renderer, () => {});

    try {
        composer.attachImageChip("first");
        composer.cursorOffset = 0;
        composer.insertComposerText("[Image 1] literal ");

        expect(composer.imageChipRequestIds()).toEqual(["first"]);
        expect(composer.expandedText()).toBe("[Image 1] literal");
    } finally {
        setup.renderer.destroy();
    }
});

test("image renumbering follows extmarks instead of inserted lookalikes", async () => {
    const setup = await createTestRenderer({ width: 80, height: 8 });
    const composer = createTuiComposer(setup.renderer, () => {});

    try {
        composer.attachImageChip("first");
        composer.attachImageChip("second");
        composer.cursorOffset = 0;
        composer.insertComposerText("[Image 1] literal ");
        const firstRealChip = "[Image 1] literal ".length;
        composer.setSelection(firstRealChip, firstRealChip + "[Image 1]".length);
        composer.insertComposerText("removed");

        expect(composer.imageChipRequestIds()).toEqual(["second"]);
        expect(composer.plainText).toContain("[Image 1] literal removed");
        expect(composer.expandedText()).toContain("[Image 1] literal removed");
        expect(composer.expandedText()).not.toContain("[Image 2]");
    } finally {
        setup.renderer.destroy();
    }
});

test("extension paste-marker text cannot impersonate collapsed content", async () => {
    const setup = await createTestRenderer({ width: 80, height: 8 });
    const composer = createTuiComposer(setup.renderer, () => {});
    const pasted = "x".repeat(300);
    const marker = `[Pasted Content ${pasted.length} chars]`;
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        await setup.mockInput.pasteBracketedText(pasted);
        composer.cursorOffset = 0;
        composer.insertComposerText(`${marker} literal `);

        expect(composer.expandedText()).toBe(`${marker} literal ${pasted}`);
    } finally {
        setup.renderer.destroy();
    }
});

test("image removal preserves collapsed-paste identity", async () => {
    const setup = await createTestRenderer({ width: 80, height: 8 });
    const composer = createTuiComposer(setup.renderer, () => {});
    const pasted = "kept ".repeat(60);
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        await setup.mockInput.pasteBracketedText(pasted);
        composer.attachImageChip("temporary");
        composer.removeImageChip("temporary");

        expect(composer.imageChipRequestIds()).toEqual([]);
        expect(composer.expandedText()).toBe(pasted.trim());
    } finally {
        setup.renderer.destroy();
    }
});

test("ESC-prefixed Enter inserts a newline instead of submitting", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const submitted: string[] = [];
    const composer = createTuiComposer(setup.renderer, () => {
        submitted.push(composer.plainText);
    });
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        await setup.mockInput.typeText("first");
        setup.mockInput.pressKey("\x1b\r");
        await setup.mockInput.typeText("second");
        await setup.flush();

        expect(composer.plainText).toBe("first\nsecond");
        expect(submitted).toEqual([]);
    } finally {
        setup.renderer.destroy();
    }
});

test("Command-Delete clears the whole composer before word-delete handling", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const composer = createTuiComposer(setup.renderer, () => {});
    setup.renderer.root.add(composer);
    composer.setComposerText("keep none of this");
    let cleared = 0;
    composer.onCommandDelete = () => {
        cleared += 1;
        composer.clearComposer();
        return true;
    };

    try {
        expect(composer.handleKeyPress({ name: "delete", meta: true } as never)).toBe(true);
        expect(cleared).toBe(1);
        expect(composer.plainText).toBe("");
    } finally {
        setup.renderer.destroy();
    }
});

test("Alt-Delete remains a one-word edit", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const composer = createTuiComposer(setup.renderer, () => {});
    setup.renderer.root.add(composer);
    composer.setComposerText("keep this word");
    composer.cursorOffset = composer.plainText.length;

    try {
        expect(composer.handleKeyPress({ name: "backspace", option: true } as never)).toBe(true);
        expect(composer.plainText).toBe("keep this ");
    } finally {
        setup.renderer.destroy();
    }
});

test("typed lines grow the composer but pasted lines do not", async () => {
    const setup = await createTestRenderer({
        width: 40,
        height: 16,
        kittyKeyboard: true,
    });
    const composer = createTuiComposer(setup.renderer, () => {});
    const rows: number[] = [];
    composer.onTypedRowsChange = (next) => rows.push(next);
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        await setup.mockInput.typeText("one");
        setup.mockInput.pressEnter({ shift: true });
        await setup.mockInput.typeText("two");
        setup.mockInput.pressEnter({ shift: true });
        await setup.mockInput.typeText("three");
        setup.mockInput.pressEnter({ shift: true });
        await setup.mockInput.typeText("four");
        await setup.flush();
        expect(rows.at(-1)).toBe(4);

        rows.length = 0;
        await setup.mockInput.pasteBracketedText("\nfive\nsix\nseven");
        await setup.flush();
        expect(rows).toEqual([]);

        composer.setComposerText("replacement\ntext");
        expect(rows).toEqual([TUI_COMPOSER_MIN_TEXT_ROWS]);
        expect(tuiComposerPanelRows(4)).toBe(8);
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI composer collapses a large paste and expands it on submit", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 8,
        kittyKeyboard: true,
    });
    const pasted = [
        "┌────────┬────────┐",
        "│ Aspect │ Vera   │",
        "├────────┼────────┤",
        "│ Client │ TUI    │",
        "└────────┴────────┘",
    ].join("\n");
    const submitted: string[] = [];
    let composer: ReturnType<typeof createTuiComposer>;
    composer = createTuiComposer(setup.renderer, () => {
        submitted.push(composer.expandedText());
    });
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        await setup.mockInput.typeText("compare this: ");
        await setup.mockInput.pasteBracketedText(pasted);
        await setup.flush();

        expect(composer.plainText).toBe(
            `compare this: [Pasted Content ${pasted.length} chars]`,
        );
        expect(composer.expandedText()).toBe(`compare this: ${pasted}`);

        setup.mockInput.pressEnter();
        expect(submitted).toEqual([`compare this: ${pasted}`]);

        composer.clearComposer();
        expect(composer.plainText).toBe("");
        expect(composer.expandedText()).toBe("");
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI composer turns a pasted screenshot path into an attachment action", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const paths: string[] = [];
    const composer = createTuiComposer(
        setup.renderer,
        () => {},
        (path) => paths.push(path),
    );
    setup.renderer.root.add(composer);
    composer.focus();
    try {
        await setup.mockInput.pasteBracketedText(
            "/var/folders/tmp/Screenshot\\ 2026-07-22\\ at\\ 6.11.40\\ PM.png",
        );
        await setup.flush();
        expect(paths).toEqual([
            "/var/folders/tmp/Screenshot 2026-07-22 at 6.11.40 PM.png",
        ]);
        expect(composer.plainText).toBe("");
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI composer attaches a capture dropped from the macOS thumbnail", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const paths: string[] = [];
    const composer = createTuiComposer(
        setup.renderer,
        () => {},
        (path) => paths.push(path),
    );
    setup.renderer.root.add(composer);
    composer.focus();
    try {
        // Verbatim from a thumbnail drag: escaped ASCII spaces, a bare narrow
        // no-break space before the meridiem, and a trailing space.
        await setup.mockInput.pasteBracketedText(
            "/var/folders/qs/T/TemporaryItems/NSIRD_screencaptureui_zExC81"
                + "/Screenshot\\ 2026-08-19\\ at\\ 10.20.08 PM.png ",
        );
        await setup.flush();
        expect(paths).toEqual([
            "/var/folders/qs/T/TemporaryItems/NSIRD_screencaptureui_zExC81"
                + "/Screenshot 2026-08-19 at 10.20.08 PM.png",
        ]);
        expect(composer.plainText).toBe("");
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI composer keeps the caret at the end after setting text", async () => {
    const setup = await createTestRenderer({
        width: 40,
        height: 8,
        kittyKeyboard: true,
    });
    const composer = createTuiComposer(setup.renderer, () => {});
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        composer.setComposerText("/permissions");
        expect(composer.cursorOffset).toBe("/permissions".length);
    } finally {
        setup.renderer.destroy();
    }
});

test("arrow keys navigate submitted messages without wrapping", async () => {
    const setup = await createTestRenderer({
        width: 40,
        height: 8,
        kittyKeyboard: true,
    });
    const composer = createTuiComposer(setup.renderer, () => {});
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        composer.rememberSubmittedText("first prompt");
        composer.rememberSubmittedText("second prompt");
        composer.rememberSubmittedText("read the plan");
        composer.clearComposer();

        setup.mockInput.pressArrow("up");
        expect(composer.plainText).toBe("read the plan");
        expect(composer.cursorOffset).toBe("read the plan".length);
        setup.mockInput.pressArrow("up");
        expect(composer.plainText).toBe("second prompt");
        setup.mockInput.pressArrow("up");
        expect(composer.plainText).toBe("first prompt");
        setup.mockInput.pressArrow("up");
        expect(composer.plainText).toBe("first prompt");
        setup.mockInput.pressArrow("down");
        expect(composer.plainText).toBe("second prompt");
        setup.mockInput.pressArrow("down");
        expect(composer.plainText).toBe("read the plan");
        setup.mockInput.pressArrow("down");
        expect(composer.plainText).toBe("");

        composer.setComposerText("draft");
        setup.mockInput.pressArrow("up");
        expect(composer.plainText).toBe("draft");
    } finally {
        setup.renderer.destroy();
    }
});

test("Up recalls user messages loaded from a resumed session", async () => {
    const setup = await createTestRenderer({
        width: 40,
        height: 8,
        kittyKeyboard: true,
    });
    const composer = createTuiComposer(setup.renderer, () => {});
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        composer.loadSubmittedTexts([
            "message from before resume",
            "most recent resumed message",
        ]);
        setup.mockInput.pressArrow("up");
        expect(composer.plainText).toBe("most recent resumed message");
        setup.mockInput.pressArrow("up");
        expect(composer.plainText).toBe("message from before resume");
    } finally {
        setup.renderer.destroy();
    }
});

test("an attached image becomes a numbered chip at the cursor", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const composer = createTuiComposer(setup.renderer, () => {});

    try {
        composer.insertText("look ");
        composer.attachImageChip("first");
        composer.attachImageChip("second");
        expect(composer.plainText).toBe("look [Image 1] [Image 2] ");
        expect(composer.imageChipRequestIds()).toEqual(["first", "second"]);
        // The chips are the attachments, not the prompt.
        expect(composer.expandedText()).toBe("look");
    } finally {
        setup.renderer.destroy();
    }
});

test("one backspace takes a whole chip and renumbers the rest", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const removed: string[] = [];
    const composer = createTuiComposer(setup.renderer, () => {});
    composer.onImageChipRemoved = (requestId) => removed.push(requestId);

    try {
        composer.attachImageChip("first");
        composer.attachImageChip("second");
        // Past the trailing space of the second chip, then onto the chip.
        composer.handleKeyPress({ name: "backspace" } as never);
        composer.handleKeyPress({ name: "backspace" } as never);
        expect(removed).toEqual(["second"]);
        expect(composer.imageChipRequestIds()).toEqual(["first"]);
        expect(composer.plainText).toBe("[Image 1] ");
    } finally {
        setup.renderer.destroy();
    }
});

test("a refused attachment drops its chip without reporting a removal", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const removed: string[] = [];
    const composer = createTuiComposer(setup.renderer, () => {});
    composer.onImageChipRemoved = (requestId) => removed.push(requestId);

    try {
        composer.attachImageChip("first");
        composer.attachImageChip("second");
        composer.removeImageChip("first");
        expect(removed).toEqual([]);
        expect(composer.imageChipRequestIds()).toEqual(["second"]);
        expect(composer.plainText).toBe("[Image 1] ");
    } finally {
        setup.renderer.destroy();
    }
});
