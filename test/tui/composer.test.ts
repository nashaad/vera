import { expect, test } from "bun:test";
import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiComposer,
    createTuiComposerPanel,
} from "../../clients/tui/composer.ts";
import { applyTuiTheme } from "../../clients/tui/state.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("TUI composer uses one theme color across its padded surface", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const theme = { ...VERA_TUI_THEME, panel: "#123456" };
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
    const panel = createTuiComposerPanel(setup.renderer, composer);
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

test("TUI status sits below the composer with a bottom gutter", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const composer = createTuiComposer(setup.renderer, () => {});
    const panel = createTuiComposerPanel(setup.renderer, composer);
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

test("Up cycles through submitted messages from an empty composer", async () => {
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
        expect(composer.plainText).toBe("read the plan");

        composer.setComposerText("draft");
        setup.mockInput.pressArrow("up");
        expect(composer.plainText).toBe("draft");
    } finally {
        setup.renderer.destroy();
    }
});
